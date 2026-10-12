# Architecture

Duplex is a pnpm + Turborepo monorepo with two deployable Cloudflare Workers, one native helper and
two framework-free packages. This page describes what is implemented today.

## System overview

```mermaid
flowchart TB
  subgraph browser["Browser (Analog.js + Angular 22, zoneless)"]
    CS["CallSessionService<br/>room lifecycle, media, signaling socket"]
    FT["FileTransferService"]
    CO["CollaborationService"]
    CT["ControlService"]
    RI["RemoteInputService"]
    CS --> FT & CO & CT & RI
    CS --> WR["@duplex/webrtc<br/>perfect negotiation, ICE restart,<br/>DataChannel registry"]
    CS --> PR["@duplex/protocol<br/>Zod schemas"]
  end

  subgraph cf["Cloudflare"]
    WK["apps/worker — Hono Worker"] --> RM["CallRoom Durable Object"]
    WEB["apps/web — Analog SSR Worker"]
  end

  subgraph native["Native helper (macOS)"]
    UI["Angular UI"] --> RS["Rust: WebSocket, validation,<br/>input backend (Quartz)"]
  end

  CS -- "signaling WebSocket" --> WK
  WR <== "WebRTC media + DataChannels" ==> PEER["Peer browser"]
  RS -- "helper WebSocket (Bearer token)" --> RM
  browser -. "HTML/JS" .- WEB
```

## Ownership boundaries

| Unit                | Owns                                                                                              | Must not                                  |
| ------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/protocol` | Wire schemas, protocol versions, room ID format, helper pairing bundle, size and rate limits      | Depend on a framework or the DOM          |
| `packages/webrtc`   | `RTCPeerConnection` wrapper: perfect negotiation, ICE recovery, path stats, labelled DataChannels | Know about Angular, rooms or UI           |
| `apps/web`          | UI, the browser-side domain services below, the signaling WebSocket adapter                       | Put protocol or media logic in components |
| `apps/worker`       | Origin checks, room routing, `CallRoom`, TURN credential issuance, helper routing                 | Touch media, file bytes or input contents |
| `apps/helper`       | Pairing UI; Rust-owned helper socket, validation and the native input backend                     | Trust the browser or the network          |

Apps never import from other apps. Everything shared lives in `packages/*`.

### Browser services (`apps/web/src/app/services`)

- **`CallSessionService`** — join/leave lifecycle, microphone/camera/screen capture, signaling socket,
  peer creation, TURN credential refresh, helper pairing state. Provided per room page.
- **`FileTransferService`** — framing, consent, progress and cancellation over `duplex-file-transfer`.
- **`CollaborationService`** — pointer, laser and strokes bound to the shared-screen surface.
- **`ControlService`** — the Assist consent state machine over `duplex-control`: request, allow/reject,
  expiry, revoke, surface binding and helper capability.
- **`RemoteInputService`** — turns controller gestures into validated, rate-limited, sequence-numbered
  normalized input over `duplex-input`.
- **`ClipboardService`** — manual, text-only clipboard transfer inside a `clipboard` grant: typed
  `clipboard-*` messages over `duplex-input`, per-operation authorization, controlled-side approval
  of reads, and relay to the paired helper.

Components are presentation only. Shared controls and cards come from Volt UI; application-specific room
panels live in `room/`, and the route components read state from the services without recreating shared
UI atoms.

## Signaling and rooms

The Worker validates the opaque 128-bit room ID and resolves the Durable Object with
`idFromName(roomId)`. `CallRoom`:

- admits at most two participants and assigns complementary `polite`/`impolite` roles;
- relays offer, answer and ICE only to the other participant;
- sends each joined participant temporary ICE servers, refreshing at most once a minute;
- uses **WebSocket Hibernation**; identity, pairing hash and limits live in serialized socket
  attachments so the object can hibernate and recover without a database.

A room exists only while its Durable Object is being addressed. There is no persistent room record.

## Media and data plane

WebRTC prefers a direct path. Cloudflare STUN helps direct setup; Cloudflare Realtime TURN relays
_encrypted_ traffic when NAT blocks it. The five DataChannels are created by the impolite peer with
purpose-specific delivery:

| Label                  | Delivery                  | Carries                                                               |
| ---------------------- | ------------------------- | --------------------------------------------------------------------- |
| `duplex-file-transfer` | reliable, ordered         | File offers, consent, chunks                                          |
| `duplex-collaboration` | reliable, ordered         | Media-source state, strokes, clear                                    |
| `duplex-pointer`       | unordered, no retransmits | Pointer / laser position                                              |
| `duplex-control`       | reliable, ordered         | Assist request / grant / revoke                                       |
| `duplex-input`         | reliable, ordered         | Pointer/keyboard input and `clipboard-*` text messages for the helper |

Camera and screen share one outgoing video sender (`replaceTrack`); starting a share replaces the
camera and stopping it resumes the camera when still enabled.

## Why it is built this way

**Media is not sent through the Worker.** A Worker is a request/response edge runtime, not a media
server; relaying media would add cost and latency, and make Cloudflare a party to the content.
WebRTC already provides encrypted peer-to-peer transport, with TURN as an encrypted last resort.

**File contents are not stored server-side.** Files travel over a DataChannel between the two
browsers. The receiver must accept each offer first, and the 256 MiB limit exists because the
receiver assembles the file in browser memory. Transfers cannot resume after a disconnect.

**The Worker rate-limits every connection.** `CallRoom` keeps in-memory token buckets per WebSocket
(frame bucket before parsing, then per-category buckets; helper traffic is separate). Excess messages
are dropped and sustained flooding closes the socket with code `4008`, which also tears down any
paired helper or control session. Revocation, leave and Stop have their own buckets. Details in
[docs/security.md](./security.md).

**The web CSP is hash-based.** SSR and prerendered pages authorize only Angular's own inline
event-replay scripts by SHA-256 (`src/server/csp.ts`, applied by a Nitro plugin for SSR and by
`scripts/apply-static-csp.mjs` for static pages).

**Native input requires a helper.** Browsers cannot move the operating-system cursor. The helper is
a separate, narrowly-scoped native process that the user installs, pairs and grants OS permission to,
and that re-validates everything it is sent.

## Native helper

```mermaid
sequenceDiagram
  participant C as Controller browser
  participant S as Sharer browser
  participant R as CallRoom DO
  participant H as Helper (Rust)
  participant Q as Quartz

  C->>S: duplex-control: request (scopes, surfaceId)
  S->>S: user clicks Allow
  S->>C: duplex-control: granted (controlSessionId, expiry)
  S->>R: helper-session-authorized
  R->>H: helper-session-authorized (owner's helper only)
  C->>S: duplex-input: normalized move/click/scroll
  S->>R: helper-input
  R->>H: helper-input (owner's helper only)
  H->>H: validate session, surface, scope, expiry, sequence, rate, Accessibility, display
  H->>Q: post pointer event
```

The Rust crate (`apps/helper/src-tauri`) owns the helper WebSocket, the pairing bundle decoder, the
protocol validation and an `input` module with a `NativeInput` backend. macOS uses
CoreGraphics/Accessibility through narrow `objc2` bindings; other platforms use a backend that never
advertises a capability, and tests use a fake backend. The Angular UI only displays state and sends
a few explicit commands (`connect_helper`, `select_display`, `request_accessibility`, `stop_control`, …).

### Clipboard flow

```mermaid
sequenceDiagram
  participant C as Controller browser
  participant S as Sharer browser
  participant R as CallRoom DO
  participant H as Helper (Rust)
  participant P as Pasteboard

  Note over C,S: Granted scope: clipboard (its own opt-in)
  C->>C: user clicks Send, browser asks to read clipboard
  C->>S: duplex-input: clipboard-write (typed, bounded)
  S->>S: re-check session, surface, scope, sequence, transfer id
  S->>R: helper-clipboard-write
  R->>H: helper-clipboard-write (owner's helper only, not stored)
  H->>H: re-check session, surface, scope, expiry, transfer id
  H->>P: write text
  H->>R: helper-clipboard-result (no content)
  R->>S: helper-clipboard-result
  S->>C: clipboard-status (delivered)
  C->>S: duplex-input: clipboard-read-request
  S->>S: user clicks Share once
  S->>R: helper-clipboard-read
  R->>H: helper-clipboard-read
  H->>P: read text
  H->>R: helper-clipboard-result (text)
  R->>S: helper-clipboard-result
  S->>C: clipboard-text
  C->>C: user clicks Copy to my clipboard
```

`clipboard.ts` in `packages/protocol` holds the schemas and limits shared by the browser, the Worker
and (by mirrored constants) the Rust parser. In Rust, `input/clipboard.rs` extends the existing
`NativeInput` and `NativePointerBackend` boundary — a backend that cannot service the clipboard (every
non-macOS platform) is never advertised and every request is refused. Clipboard capability is
separate from pairing and from Accessibility: it needs neither a selected display nor input trust.

## Web delivery

`apps/web` is an Analog SSR app built with Nitro's `cloudflare_module` preset. `/` is the landing route;
`/call/:roomId` is the canonical call route and `/r/:roomId` is retained for compatibility. They are
separate lazy chunks, and Angular Movement is loaded on demand only inside a call, so the landing page
ships none of the call or animation code. Production responses carry the security headers described in
[security.md](./security.md#web-security-headers).

Entwine treats `docs/` as the source of truth and produces the static docs site, graph and structured
context. `entwine.toml` discovers repository instructions and skills for agent context while keeping them
out of the public site.
