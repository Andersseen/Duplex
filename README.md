# Duplex

Duplex is a lightweight way to start a private 1:1 browser call. Create a room link, send it to one person, and talk or share video. Rooms are anonymous, ephemeral, and hold at most two participants.

## Status

**Duplex supports 1:1 browser calls, screen sharing, peer-to-peer file transfer, live screen collaboration, and temporary Assist sessions with native macOS pointer control.** A participant explicitly joins before the browser requests microphone access. Camera access is opt-in after joining. Signaling travels through the Worker and a room Durable Object. WebRTC prefers a direct connection and uses Cloudflare Realtime TURN as a relay when NAT or firewall rules block direct connectivity.

| Area                        | State                                                                            |
| --------------------------- | -------------------------------------------------------------------------------- |
| Monorepo, tooling, CI       | Done                                                                             |
| Web app (`/`, `/r/:roomId`) | Create a room, join, share its link, audio, mute, camera, screen, and send files |
| Worker                      | Health endpoint, validated WebSocket origins, and short-lived ICE configuration  |
| `CallRoom` Durable Object   | Two-person presence and WebRTC signaling relay using WebSocket Hibernation       |
| WebRTC package              | Perfect negotiation, ICE recovery, path diagnostics, and dedicated DataChannels  |
| Network                     | Direct WebRTC with Cloudflare STUN and TURN relay fallback                       |
| File transfer               | Explicit receiver consent, progress, cancellation, and browser download          |
| Screen collaboration        | Peer pointer, laser pointer, and shared-screen annotations                       |
| Assist                      | Explicit request/allow/reject, scoped temporary sessions tied to a screen ID     |
| Native pointer control      | macOS only: move, left/right click, drag, scroll through the paired helper       |
| Native helper pairing       | One-use room and participant scoped credential over authenticated WebSocket      |
| Helper (Tauri 2 + Angular)  | Rust-owned secure WebSocket, Accessibility and display setup, pointer execution  |

| Platform | Native pointer control | Native keyboard control |
| -------- | ---------------------- | ----------------------- |
| macOS    | **Supported**          | Not yet                 |
| Windows  | Not yet                | Not yet                 |
| Linux    | Not yet                | Not yet                 |

On Windows and Linux the helper still pairs and the permission protocol still works, but it never advertises a native capability, so a peer cannot request control. Keyboard control, clipboard sync, recording, chat, multi-user calls, and accounts are unsupported. There is **no unattended access**: no background startup, saved room credentials, persistent pairing, "always allow", or trusted contacts. Every session is user-present and explicitly authorized.

### Native pointer control (macOS)

Pointer control needs all of the following at once:

- the sharer shares an **entire monitor** (the browser must report `displaySurface === 'monitor'`; tab, window, or unknown sources never qualify);
- a paired Duplex Helper;
- local **Accessibility** permission, granted by the user from the helper's _Enable Accessibility_ button (the helper never prompts on launch or pairing);
- an explicit **target display** chosen in the helper (a lone display is selected automatically; with several, nothing is advertised until the user picks one);
- an explicit, temporary control grant (**Allow**) from the sharer.

The helper reports only the scopes it can execute right now (`availableScopes`, currently `['pointer']` or `[]`) — never display IDs, names, or sizes. The controller can only request an advertised scope, and the controlled browser never grants one its helper cannot execute. Losing Accessibility, losing the selected display, changing the target display, expiry, the helper's own **Stop control** button, or a disconnect ends the session and releases any held mouse button.

```text
Controller browser ─ duplex-input (reliable, ordered) ─▶ Controlled browser ─ room WebSocket ─▶ CallRoom ─▶ paired helper ─▶ Quartz
   normalized x/y, RAF-coalesced           validates session, surface, scope       owner-only route         re-validates every event
```

Input is normalized (`0..1`) until the final mapping to the selected display's native bounds, so negative origins, mixed resolutions, and Retina scaling need no special handling. Pointer motion is coalesced to one update per animation frame and dropped when the DataChannel backs up; button and scroll events are never dropped for backpressure. The helper authorizes every event itself (session, surface, scope, expiry, sequence, rate limit, Accessibility, display) before calling Quartz, and keeps the latest move plus a small bounded action queue so a flood cannot grow memory.

The helper asks only for Accessibility. It needs no Input Monitoring, Screen Recording, microphone, or camera permission, because the browser owns screen capture and the helper only posts pointer events.

Helper pairing and control permission are separate. Pairing identifies the local native helper; it does not grant the peer permission. A control session requires a peer request, the screen sharer's explicit **Allow**, an active matching shared-screen surface, and a temporary scoped grant that expires automatically. Either participant can stop or release it. Each helper pairing code is a two-minute, one-use secret; only its SHA-256 hash is retained in the Durable Object attachment. The helper connects over secure WebSocket and receives session metadata only after browser consent.

File contents travel directly between peers over a reliable WebRTC DataChannel. Duplex servers do not receive or store file contents. The receiver must accept each offer before bytes are sent. Browser-memory assembly limits transfers to 256 MiB. Transfers cannot resume after a disconnect.

Pointer, laser, and annotation events also travel directly between browsers over dedicated WebRTC DataChannels. Assist negotiation uses its own reliable, ordered `duplex-control` DataChannel and carries no input events. Collaboration and control are ephemeral and bound to a cryptographically identified screen-sharing surface. The screen overlay never changes the outgoing media stream.

Camera and screen share use one outgoing video source at a time. Starting a screen share temporarily replaces the camera video; stopping it resumes the camera when it is still enabled. Joining does not request camera permission.

## Signaling and media

```text
Browser A                         Worker                 CallRoom Durable Object                    Browser B
   │                                │                              │                                    │
   ├────────── WebSocket ──────────►│                              │                                    │
   │                                ├──────── WebSocket ──────────►│                                    │
   │                                │                              ├──────── WebSocket relay ─────────►│
   │                                │                              │                                    │
   ╞════════════ WebRTC media + file, collaboration, and pointer DataChannels ════════════════════════════╡
```

The Worker validates the opaque room ID and resolves the Durable Object with `idFromName(roomId)`. `CallRoom` coordinates the join/leave lifecycle, sends each joined participant temporary ICE configuration, and relays validated offer, answer, and ICE messages only to the other participant. Cloudflare's long-lived TURN key stays in Worker secrets. The object uses WebSocket Hibernation and serialized socket attachments to recover participant identity and refresh limits after hibernation. It holds no media and uses no database.

Room IDs remain cryptographically random 128-bit tokens created in the browser. A room comes into existence when its Durable Object is first addressed. The room URL is the anonymous capability to enter that ephemeral room.

Cloudflare STUN is used for direct connection setup. The browser gathers direct candidates and TURN relay candidates, then WebRTC selects a working path. When a direct path works, media stays peer-to-peer; the relay carries encrypted WebRTC traffic only when needed. If TURN is not configured locally or its credential API is temporarily unavailable, calls continue with STUN and the UI reports a useful error only if direct connectivity later fails.

See [Deployment](./DEPLOYMENT.md) for Cloudflare setup, production deploys, and forced-relay verification.

## Repository layout

```text
apps/web           Analog.js + Angular 22 browser app
apps/worker        Cloudflare Worker, Hono, and Durable Object
apps/helper        Tauri 2 + Angular UI and Rust-owned helper WebSocket
packages/protocol  Zod wire schemas and room IDs
packages/webrtc    Browser WebRTC logic, no Angular
packages/config    Shared TypeScript and ESLint configuration
```

Boundaries: `protocol` has no framework dependency; `webrtc` owns peer negotiation; `web` owns the UI and WebSocket adapter; `worker` owns room coordination. Apps do not import from other apps.

## Local development

Prerequisites: Node `>=22.22.3` (see `.nvmrc`) and pnpm 10 (`corepack enable`). Rust and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) are only needed for the native helper.

```bash
pnpm install
pnpm dev            # web on http://localhost:5173 + worker on http://localhost:8787
```

The web dev server proxies `/health` and `/api` to the Worker, including WebSocket upgrades. Check the Worker with:

```bash
curl http://localhost:8787/health
```

Run parts individually:

```bash
pnpm --filter @duplex/web dev
pnpm --filter @duplex/worker dev
pnpm dev:helper
```

### Checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @duplex/helper build
pnpm rust:fmt:check
pnpm rust:check
pnpm rust:clippy
cargo test --manifest-path apps/helper/src-tauri/Cargo.toml --locked
pnpm e2e
```

The Playwright E2E suite starts the real local Analog app, Worker, and Durable Object. It uses Chromium's fake microphone and camera. The Assist E2E opens an authenticated test helper WebSocket, announces pointer capability, then exercises request, allow, authorization, normalized move/click/drag/scroll relay, rejection of stale-session, wrong-surface, keyboard-like and out-of-range input, revoke, a fresh surface, and token replay rejection. It never posts real operating-system input. Normal E2E requires no Cloudflare credentials. For a real relay check, configure local TURN secrets and run `pnpm e2e:turn`.

CI also compiles, lints, and tests the helper on `macos-latest` so the Quartz and Accessibility bindings are checked. Those tests never post input or move the runner's mouse.

`pnpm format` rewrites files with Prettier.

### Manual macOS verification

Automated tests cannot prove real OS input. To check it by hand on a Mac with two browsers (or two machines):

```bash
pnpm dev            # web + worker
pnpm dev:helper     # native helper
```

1. Join the room in browser A, share an **entire screen**, and create a pairing code; paste it into the helper.
2. In the helper click **Enable Accessibility**, approve the helper (in `tauri dev` this is the dev binary) in System Settings, then **Re-check**. Pick the display you are sharing if you have several.
3. In browser B (second browser or machine) click **Request control**, then **Allow** in browser A.
4. From B move, click, right-click, drag, and scroll over the shared screen; A's real cursor should follow.
5. Click **Stop control** in the helper and confirm the cursor stops responding immediately and no button stays held.

This flow was not executed as part of the automated change; scroll direction in particular should be confirmed on hardware.

## UI ecosystem note

The intended UI stack is Volt UI, Quartz, Lumen Icons, and Angular Movement. The currently published Angular UI packages do not yet match this repository's Angular 22 baseline, and Volt UI and Quartz are not published. The call UI therefore uses plain Angular and Tailwind until compatible releases exist.
