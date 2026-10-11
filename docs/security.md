# Security

This document describes the security architecture Duplex implements today, the threats it was
designed around, and the gaps that remain. It does not promise more than the code does. To report a
vulnerability, see [SECURITY.md](../SECURITY.md).

## Principles

1. **Capability, not identity.** There are no accounts. Possessing a room link is the only credential for entering a room.
2. **Least data on the server.** The server relays negotiation and routes helper messages. It never receives media, file contents, or pointer/keyboard payloads meant for the peer.
3. **Consent before power.** Remote control needs an explicit, temporary, scoped Allow from the person being controlled.
4. **Every layer re-validates.** The Worker, the browsers and the native helper each validate what they receive; none trusts another's checks.
5. **No unattended access.** There is no background start, saved room credential, persistent pairing, "always allow" or trusted-contact list.

## Rooms

| Property              | Implementation                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Room URL as a secret  | The link `/r/<id>` is an anonymous capability. Anyone holding it can try to join while a seat is free.                |
| Unguessable IDs       | IDs are 128 random bits (16 bytes, base64url, 22 characters), created in the browser with `crypto.getRandomValues`.   |
| Two-person limit      | `CallRoom` admits at most two participants (`MAX_ROOM_PARTICIPANTS`). A third gets `room-full` and is closed.         |
| Ephemeral             | A room exists only while its Durable Object is addressed. No database, no message history, no recordings.             |
| Validated at the edge | The Worker rejects any ID that is not a well-formed token (`400 invalid_room_id`) before it reaches a Durable Object. |
| Origin validation     | Production WebSocket upgrades require an exact match in `ALLOWED_ORIGINS`. Development accepts only loopback origins. |
| Referrer isolation    | Production responses send `Referrer-Policy: no-referrer`, so the room URL cannot leak through a `Referer` header.     |

## TURN credentials

- The long-lived Cloudflare TURN key ID and API token live only in Worker secrets. They are never in the web bundle, `.env` files consumed by the web build, room links or signaling messages.
- The Worker calls Cloudflare's credential API and sends only the generated **short-lived** ICE username and credential (12-hour TTL, refreshed an hour before expiry through the joined WebSocket, at most once a minute per participant) to **joined** participants.
- The response is validated: only Cloudflare STUN and `turn(s):turn.cloudflare.com` URLs with credentials are accepted; anything else degrades to STUN-only.
- Failures are logged without the token or any credential (covered by a test).

## Helper pairing

| Property               | Implementation                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Token entropy          | 32 random bytes (256 bits) from `crypto.getRandomValues`, base64url (43 characters).                                                    |
| Server storage         | Only the **SHA-256 hash** is kept, in the owner's WebSocket attachment. The raw token exists in the owner's browser and the bundle.     |
| Lifetime               | Two minutes (`helperPairingExpiresAt`). Expired tokens return `401`.                                                                    |
| One-time               | A successful helper connection clears the hash from the attachment; replay returns `401`.                                               |
| Bound to a room        | The bundle (`duplex-pair-v1.…`) carries API origin, room ID and token; a token for room A is rejected for room B.                       |
| Bound to a participant | The token authorizes a helper only for the participant that created it. Helper traffic is routed by `ownerParticipantId`.               |
| One helper             | A second helper for the same owner gets `409 helper_already_connected`.                                                                 |
| Never rendered twice   | The browser drops the code when the helper pairs, when it expires and when the call ends; the helper UI never displays what was pasted. |
| Not a permission       | Pairing identifies a helper. It grants no control (see [assist.md](./assist.md)).                                                       |

## Control sessions

A control session is created only after the peer's `control-request` and the controlled user's explicit **Allow**.

- **Surface-bound.** Each shared screen has a cryptographically random surface ID. A grant names one surface; a new share is a new surface and any previous grant is dead.
- **`controlSessionId`.** Every grant has its own random ID. The helper rejects input for any other ID (`WrongSession`).
- **Scoped permissions.** Scopes are `pointer`, `keyboard` and `clipboard`; none implies another. The macOS helper advertises only what it can execute right now, the controller can request only advertised scopes, and the controlled browser never grants more than that. The sharer sees each requested scope and must explicitly Allow it.
- **Expiry.** A grant expires automatically (maximum `CONTROL_SESSION_MAX_AGE_MS`, 10 minutes); an unanswered request times out after 30 seconds.
- **Revocation.** The session ends on: either browser releasing, the helper's own **Stop control** button, expiry, the shared screen ending or changing, loss of Accessibility or the selected display, peer disconnect, or helper disconnect.
- **Native hold safety.** Ending a session, quitting the helper, or a revoke calls `release_all`, which releases every held mouse button and key. A failed release is not retried; held state is cleared as the session ends.

## Helper independent validation

The helper is the last line of defense and does not trust the browser or the room server. Before
posting any event it checks, in this order: message size and shape (`is_valid`), active session,
`controlSessionId`, `surfaceId`, expiry, the matching pointer or keyboard scope, strictly increasing
sequence, macOS Accessibility trust (re-checked on a short interval), a selected display, and a rate
limit (240 events/s; button-up and key-up releases are exempt so a release is never dropped). Pointer
coordinates are normalized `0..1` and mapped to the selected display only at the last step. Keyboard
events accept only an explicit physical-key allowlist; system and application shortcuts are blocked
except common text-editing shortcuts. Accessibility is required, and the helper never prompts for it
on launch or pairing — only from an explicit button.

## Clipboard text

Clipboard sync is an independent scope with its own checks at every layer.

- **Consent.** The controller must name `clipboard` in the request. The sharer's dialog describes it and starts it unticked; `ControlService.allow()` with no explicit choice never includes it. Pointer or keyboard grants cannot authorize it, and a clipboard grant cannot move the pointer or press a key (tested in the browser and in Rust).
- **Per-operation checks, controlled browser.** Active `controlled` session, matching session and surface IDs, unexpired, `clipboard` in the granted scopes, helper connected, local capability still advertised, strictly increasing sequence, a transfer ID not seen before, and a 500 ms minimum interval with one operation in flight.
- **Per-operation checks, helper.** `is_valid` (UUIDs, size, text rules), active session, session, surface, expiry, `clipboard` scope, backend support, a transfer ID not seen in this session (64 remembered) and a minimum interval. A read is also re-authorized after the OS call returns, so a stop during the call returns no text.
- **Reading the sharer's clipboard** additionally needs the sharer's click on **Share once**, every time. An unanswered request is declined after 30 seconds.
- **Bounded, text-only payload.** 4096 UTF-8 bytes, no control characters except tab/CR/LF, well-formed Unicode. The same rules are enforced by the shared Zod schema, the browser service and the Rust parser.
- **Transport.** Controller ↔ sharer travels over the reliable `duplex-input` DataChannel (frames ≤ 16 KiB). The sharer's browser hands the text to **its own** helper through the Worker, which only relays it (≤ 16 KiB, only to the owner's helper, only the helper's answer back to the owner) and never stores, logs or forwards it to the peer. The text never enters analytics; there is none.
- **No content in status.** Status replies (`delivered`, `declined`, `denied`, …) carry no clipboard content. The sharer's UI shows lengths, never text.
- **Lifecycle.** Revocation, expiry, a changed share, a closed channel or a peer change clear pending requests, approvals and any received-but-not-copied text, and reset the sequence and replay windows.
- **Capability.** The helper advertises `clipboard` only where a backend exists (macOS). Other platforms never advertise it, and a request for it is rejected.

The helper reads and writes the pasteboard with `/usr/bin/pbpaste` and `/usr/bin/pbcopy` by absolute
path, with a cleared environment, a 3-second timeout and a size cap on reads. Nothing watches the
clipboard, keeps history or logs content.

## Server-directed and peer-directed messages

| Kind            | Examples                                                                                                                 | Who may send / who receives                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Server-directed | `join`, `leave`, `refresh-rtc-config`, `helper-pairing-create`                                                           | Participant → Worker. Answered with `joined`, `rtc-config`, `helper-pairing-created`, …   |
| Peer-directed   | `offer`, `answer`, `ice-candidate`                                                                                       | Participant → Worker → **only** the other participant.                                    |
| Helper-directed | `helper-session-authorized`, `helper-session-revoked`, `helper-input`, `helper-clipboard-write`, `helper-clipboard-read` | Participant → Worker → **only that participant's own helper**. Never relayed to the peer. |
| Peer-to-peer    | file, collaboration, control and input DataChannel messages                                                              | Browser ↔ browser. The Worker never sees them.                                            |

A helper can send only `helper-ready`, `helper-capabilities`, `helper-stop-control` and
`helper-clipboard-result` (text only with a successful read); anything else (including attempts to
inject participant traffic) closes it. Messages are size-limited (128 KiB for participants, 4 KiB for
helpers, 1 KiB for `helper-input`, 512 B for input envelopes, 16 KiB for clipboard frames).

## Threat model

| Threat                                  | Mitigation today                                                                                                                                                                                                                               | Residual risk                                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen or leaked room link**          | 128-bit ID; two-seat cap; `no-referrer`; visible presence (you see when someone joins); anything powerful needs Allow plus a paired helper.                                                                                                    | While a seat is free, whoever has the link can take it. Share links privately and watch for an unexpected participant. No lock or knock feature yet.                                                                                                            |
| **Pairing-token replay**                | One-time, two-minute, hashed at rest; cleared on first use; cleared on leave/disconnect.                                                                                                                                                       | An attacker who sees the code in the sharer's browser within two minutes before the helper uses it can win the race.                                                                                                                                            |
| **Cross-room pairing**                  | Token is checked against the room's own participants; a token for room A returns `401` in room B (tested).                                                                                                                                     | —                                                                                                                                                                                                                                                               |
| **Cross-participant helper access**     | Helper traffic is routed by `ownerParticipantId`; helpers cannot inject participant messages; peer browsers never receive `helper-*` traffic.                                                                                                  | —                                                                                                                                                                                                                                                               |
| **Stale surface input**                 | Grants bind to a surface ID; the helper rejects mismatches; a new share invalidates the old grant (tested in the web services, E2E and Rust).                                                                                                  | —                                                                                                                                                                                                                                                               |
| **Stale control session**               | `controlSessionId` check; expiry; strictly increasing sequence numbers reject replays and reordering.                                                                                                                                          | —                                                                                                                                                                                                                                                               |
| **Malformed protocol payload**          | Zod validation in browsers and the Worker; strict schemas; size caps; Rust re-parses and validates; malformed helper/participant frames close the socket.                                                                                      | The Worker enforces size and per-connection message rate (see above).                                                                                                                                                                                           |
| **Dependency compromise**               | Frozen lockfile in CI; Dependabot (grouped, weekly); Dependency Review blocks new high/critical advisories on PRs; `pnpm audit`; RustSec; CodeQL.                                                                                              | A malicious release of a trusted dependency can still land before an advisory exists. Review dependency bumps.                                                                                                                                                  |
| **Secret leakage**                      | TURN secrets only in Worker secrets; failure logs omit them; pairing codes are dropped when used; screenshots use only synthetic content.                                                                                                      | Secrets entered into a shell or `.dev.vars` are the developer's responsibility; secret scanning + push protection recommended.                                                                                                                                  |
| **Input flooding**                      | Browser coalesces motion to one update per frame and drops motion under backpressure; helper rate-limits (240/s), bounds its queue and keeps only the latest move.                                                                             | A hostile controller can still consume up to the rate limit while a grant is live; the sharer can stop at any time.                                                                                                                                             |
| **Peer disconnect during input**        | Browser releases held input on blur and revoke; the helper ends the session and releases held keys and buttons on disconnect, expiry and exit.                                                                                                 | —                                                                                                                                                                                                                                                               |
| **Clipboard exfiltration or injection** | Own scope, unticked in the dialog; every remote read needs **Share once**; text-only, 4 KiB, no control characters; checks at the browser and helper for every operation; replays, stale sessions and wrong surfaces rejected; no persistence. | A sharer can still approve a read they should not, and a peer with the scope can put misleading text on the clipboard — the sharer is told when text arrives, but not shown it. Anything copied into the clipboard before Share once is readable once approved. |
| **Malicious peer requests control**     | Needs the sharer's explicit Allow, an entire-monitor share, a paired helper, Accessibility and a chosen display; grants expire and are revocable.                                                                                              | A user can be socially engineered into clicking Allow. The dialog names the scopes and says access expires.                                                                                                                                                     |

## Web security headers

Production responses (SSR and static assets) ship:

- `Content-Security-Policy` — `default-src 'self'`, no remote scripts, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, and `connect-src` limited to the app and the configured signaling origin (HTTP and WS forms).
- `Permissions-Policy` — camera, microphone and display capture only for the app itself; geolocation, payment and USB denied. Clipboard read and write are allowed for the app itself only because the manual clipboard actions need them; browsers still prompt, and nothing reads the clipboard outside a click.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

These are exercised by `pnpm e2e:production`, which builds the real Worker output and runs a full call
(hydration, signaling WebSocket, microphone, WebRTC, screen share) failing on any CSP violation. The
protocol package runs Zod with code generation disabled so the policy needs no `'unsafe-eval'`.

### Script CSP: hashes, no `'unsafe-inline'`

`script-src` is `'self'` plus SHA-256 hashes, never `'unsafe-inline'` or `'unsafe-eval'`. Angular's
renderer emits two inline executable scripts (the event-replay contract and the
`window.__jsaction_bootstrap(...)` call that registers event types); the hydration state is a
non-executable `application/json` block that CSP does not apply to.

- **Why hashes, not a nonce.** The landing page is prerendered and served by Cloudflare static assets
  without running the Worker, so it cannot carry a per-response nonce. A static nonce would be
  reusable and therefore worthless. Hashes cover prerendered and SSR pages with one mechanism.
- **SSR responses:** a Nitro plugin (`apps/web/src/server/plugins/csp-script-hashes.ts`) hashes the
  scripts in the rendered HTML and appends them to that response's `Content-Security-Policy`.
- **Prerendered pages:** `scripts/apply-static-csp.mjs` runs after the build and writes the hashes of
  every prerendered page into `_headers`.
- **Only Angular's scripts are hashed.** The extractor accepts exactly the contract script (by its
  `id`) and a strictly shaped bootstrap call. Any other inline script, including one injected into
  the markup, is not hashed and the browser blocks it (verified in `pnpm e2e:production`).
- `style-src` still allows `'unsafe-inline'` because Angular applies component styles inline. That is
  a separate, weaker gap: it cannot execute script.

## Worker message rate limiting

Each WebSocket gets in-memory token buckets inside the `CallRoom` Durable Object
(`apps/worker/src/rate-limit.ts`). Nothing is stored, shared between connections, keyed by address or
user, or logged beyond which kind of connection hit which limit. State is dropped when the socket
closes; hibernation resets a bucket to full, which only happens to idle sockets.

| Bucket (per connection) | Burst | Sustained | Traffic                                                              |
| ----------------------- | ----: | --------: | -------------------------------------------------------------------- |
| Participant frame       |   500 |     400/s | **Every** frame, charged before parsing (malformed, binary, unknown) |
| `signaling`             |   100 |      30/s | join, offer, answer, ICE candidates, config refresh, pairing create  |
| `input`                 |   480 |     300/s | `helper-input` (browser already caps at 240/s)                       |
| `clipboard`             |    10 |       2/s | clipboard write / read (manual actions)                              |
| `control`               |    20 |       5/s | leave, `helper-session-authorized`, `helper-session-revoked`         |
| Helper frame            |   100 |      50/s | every helper frame, charged before parsing                           |
| Helper `status`         |    20 |       5/s | `helper-capabilities`                                                |
| Helper `clipboard`      |    10 |       2/s | clipboard results                                                    |
| Helper `control`        |    20 |       5/s | `helper-stop-control`                                                |

Rejection is predictable: a message over its category budget is **dropped**; 25 consecutive drops, or
any frame past the frame bucket, **closes the connection with code `4008`** (`Rate limit exceeded`).
Closing a participant also closes its helper and notifies the peer; closing a helper tells its owner
(`helper-disconnected`), so a flood always ends with control revoked, never left running. Revocation,
leave and the helper's Stop have their own buckets that bulk traffic cannot drain, and a legitimate
ICE gathering fits inside the signaling burst. Malformed and unknown messages already closed the
socket and are additionally charged to the frame bucket. No protocol change: clients see an ordinary
close.

## Tauri helper boundary

The helper window has a single capability granting exactly ten permissions: `core:event:allow-listen`,
`core:event:allow-unlisten` (the UI only listens for state pushes) and `allow-*` for its eight own
commands. It no longer inherits `core:default`, so the page cannot call window, webview, app, path,
menu, tray, resource or image APIs. There are no shell, filesystem, process, HTTP, opener or other
plugins, no remote capabilities and no global Tauri object; its CSP forbids eval, `unsafe-inline`
scripts, remote origins, `connect-src`, framing and form posts. `pnpm check:tauri` audits this
(including the command lists in `build.rs` and `lib.rs`) and its tests in
`scripts/check-tauri-security.test.mjs` prove each loosening is rejected. CI compiles the crate on
Linux and macOS, which validates the capability against the real command manifest; it cannot prove
the packaged UI works with the narrower grant, and that still needs the manual macOS check in
[docs/testing.md](./testing.md).

## Known gaps

- Rate limits are per connection, not per room or per client: someone who reconnects gets a fresh budget. The Worker still bounds frame size, room capacity and join admission.
- No room lock or admission prompt: whoever arrives first with the link takes a free seat.
- Pairing tokens are visible in the sharer's browser for up to two minutes.
- Native control is macOS-only and has not been audited by a third party.
- Clipboard text moves through the Worker (transiently, to the owner's own helper) between the sharer's browser and helper; it is not stored, but it is not end-to-end encrypted beyond TLS on that hop.
- The macOS clipboard backend has not been verified on hardware.
