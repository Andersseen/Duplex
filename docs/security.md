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
- **Scoped permissions.** Scopes are `pointer` and `keyboard`. The macOS helper advertises only what it can execute right now, the controller can request only advertised scopes, and the controlled browser never grants more than that. The sharer sees each requested scope and must explicitly Allow it.
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

## Server-directed and peer-directed messages

| Kind            | Examples                                                              | Who may send / who receives                                                               |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Server-directed | `join`, `leave`, `refresh-rtc-config`, `helper-pairing-create`        | Participant → Worker. Answered with `joined`, `rtc-config`, `helper-pairing-created`, …   |
| Peer-directed   | `offer`, `answer`, `ice-candidate`                                    | Participant → Worker → **only** the other participant.                                    |
| Helper-directed | `helper-session-authorized`, `helper-session-revoked`, `helper-input` | Participant → Worker → **only that participant's own helper**. Never relayed to the peer. |
| Peer-to-peer    | file, collaboration, control and input DataChannel messages           | Browser ↔ browser. The Worker never sees them.                                            |

A helper can send only `helper-ready`, `helper-capabilities` and `helper-stop-control`; anything
else (including attempts to inject participant traffic) closes it. Messages are size-limited
(128 KiB for participants, 4 KiB for helpers, 1 KiB for `helper-input`, 512 B for input envelopes).

## Threat model

| Threat                              | Mitigation today                                                                                                                                                   | Residual risk                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen or leaked room link**      | 128-bit ID; two-seat cap; `no-referrer`; visible presence (you see when someone joins); anything powerful needs Allow plus a paired helper.                        | While a seat is free, whoever has the link can take it. Share links privately and watch for an unexpected participant. No lock or knock feature yet. |
| **Pairing-token replay**            | One-time, two-minute, hashed at rest; cleared on first use; cleared on leave/disconnect.                                                                           | An attacker who sees the code in the sharer's browser within two minutes before the helper uses it can win the race.                                 |
| **Cross-room pairing**              | Token is checked against the room's own participants; a token for room A returns `401` in room B (tested).                                                         | —                                                                                                                                                    |
| **Cross-participant helper access** | Helper traffic is routed by `ownerParticipantId`; helpers cannot inject participant messages; peer browsers never receive `helper-*` traffic.                      | —                                                                                                                                                    |
| **Stale surface input**             | Grants bind to a surface ID; the helper rejects mismatches; a new share invalidates the old grant (tested in the web services, E2E and Rust).                      | —                                                                                                                                                    |
| **Stale control session**           | `controlSessionId` check; expiry; strictly increasing sequence numbers reject replays and reordering.                                                              | —                                                                                                                                                    |
| **Malformed protocol payload**      | Zod validation in browsers and the Worker; strict schemas; size caps; Rust re-parses and validates; malformed helper/participant frames close the socket.          | The Worker enforces size, not message rate (see gaps).                                                                                               |
| **Dependency compromise**           | Frozen lockfile in CI; Dependabot (grouped, weekly); Dependency Review blocks new high/critical advisories on PRs; `pnpm audit`; RustSec; CodeQL.                  | A malicious release of a trusted dependency can still land before an advisory exists. Review dependency bumps.                                       |
| **Secret leakage**                  | TURN secrets only in Worker secrets; failure logs omit them; pairing codes are dropped when used; screenshots use only synthetic content.                          | Secrets entered into a shell or `.dev.vars` are the developer's responsibility; secret scanning + push protection recommended.                       |
| **Input flooding**                  | Browser coalesces motion to one update per frame and drops motion under backpressure; helper rate-limits (240/s), bounds its queue and keeps only the latest move. | A hostile controller can still consume up to the rate limit while a grant is live; the sharer can stop at any time.                                  |
| **Peer disconnect during input**    | Browser releases held input on blur and revoke; the helper ends the session and releases held keys and buttons on disconnect, expiry and exit.                     | —                                                                                                                                                    |
| **Malicious peer requests control** | Needs the sharer's explicit Allow, an entire-monitor share, a paired helper, Accessibility and a chosen display; grants expire and are revocable.                  | A user can be socially engineered into clicking Allow. The dialog names the scopes and says access expires.                                          |

## Web security headers

Production responses (SSR and static assets) ship:

- `Content-Security-Policy` — `default-src 'self'`, no remote scripts, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, and `connect-src` limited to the app and the configured signaling origin (HTTP and WS forms).
- `Permissions-Policy` — camera, microphone and display capture only for the app itself; geolocation, payment, USB and clipboard read denied.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

These are exercised by `pnpm e2e:production`, which builds the real Worker output and runs a full call
(hydration, signaling WebSocket, microphone, WebRTC, screen share) failing on any CSP violation. The
protocol package runs Zod with code generation disabled so the policy needs no `'unsafe-eval'`.

**Known gap:** `script-src` still allows `'unsafe-inline'`, because Angular's server renderer embeds
two inline bootstrap scripts (event-replay contract and hydration state) without a nonce. A
nonce- or hash-based policy is future work; the rest of the policy still blocks remote script
loading, plugins, framing and unexpected network destinations.

## Tauri helper boundary

The helper window has a single capability granting `core:default` and its eight own commands. There
are no shell, filesystem, process, HTTP or opener plugins, no remote capabilities and no global
Tauri object; its CSP forbids eval, remote origins, framing and form posts. `pnpm check:tauri`
fails CI if any of that widens without a reviewed change.

## Known gaps

- No per-message rate limit in the Worker (size limits only).
- CSP `script-src 'unsafe-inline'` (above).
- No room lock or admission prompt: whoever arrives first with the link takes a free seat.
- Pairing tokens are visible in the sharer's browser for up to two minutes.
- Native control is macOS-only and has not been audited by a third party.
