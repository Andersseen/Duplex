# Duplex

Duplex is a lightweight way to start a private 1:1 browser call. Create a room link, send it to one person, and talk or share video. Rooms are anonymous, ephemeral, and hold at most two participants.

## Status

**Duplex supports reliable 1:1 browser calls.** A participant explicitly joins before the browser requests microphone access. Camera access is opt-in after joining. Signaling travels through the Worker and a room Durable Object. WebRTC prefers a direct connection and uses Cloudflare Realtime TURN as a relay when NAT or firewall rules block direct connectivity.

| Area                        | State                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| Monorepo, tooling, CI       | Done                                                                            |
| Web app (`/`, `/r/:roomId`) | Create a room, join, share its link, mute, use camera, share screen, and leave  |
| Worker                      | Health endpoint, validated WebSocket origins, and short-lived ICE configuration |
| `CallRoom` Durable Object   | Two-person presence and WebRTC signaling relay using WebSocket Hibernation      |
| WebRTC package              | Browser-only perfect negotiation, ICE recovery, path diagnostics, and media     |
| Helper (Tauri 2 + Angular)  | Dormant window shell; not involved in calls                                     |

Not supported yet: remote control, multi-user calls, accounts, chat, or recording.

Camera and screen share use one outgoing video source at a time. Starting a screen share temporarily replaces the camera video; stopping it resumes the camera when it is still enabled. Joining does not request camera permission.

## Signaling and media

```text
Browser A                         Worker                 CallRoom Durable Object                    Browser B
   │                                │                              │                                    │
   ├────────── WebSocket ──────────►│                              │                                    │
   │                                ├──────── WebSocket ──────────►│                                    │
   │                                │                              ├──────── WebSocket relay ─────────►│
   │                                │                              │                                    │
   ╞══════════════════════════════════ WebRTC audio + video ════════════════════════════════════════════╡
```

The Worker validates the opaque room ID and resolves the Durable Object with `idFromName(roomId)`. `CallRoom` coordinates the join/leave lifecycle, sends each joined participant temporary ICE configuration, and relays validated offer, answer, and ICE messages only to the other participant. Cloudflare's long-lived TURN key stays in Worker secrets. The object uses WebSocket Hibernation and serialized socket attachments to recover participant identity and refresh limits after hibernation. It holds no media and uses no database.

Room IDs remain cryptographically random 128-bit tokens created in the browser. A room comes into existence when its Durable Object is first addressed. The room URL is the anonymous capability to enter that ephemeral room.

Cloudflare STUN is used for direct connection setup. The browser gathers direct candidates and TURN relay candidates, then WebRTC selects a working path. When a direct path works, media stays peer-to-peer; the relay carries encrypted WebRTC traffic only when needed. If TURN is not configured locally or its credential API is temporarily unavailable, calls continue with STUN and the UI reports a useful error only if direct connectivity later fails.

See [Deployment](./DEPLOYMENT.md) for Cloudflare setup, production deploys, and forced-relay verification.

## Repository layout

```text
apps/web           Analog.js + Angular 22 browser app
apps/worker        Cloudflare Worker, Hono, and Durable Object
apps/helper        Tauri 2 + Angular shell, dormant
packages/protocol  Zod wire schemas and room IDs
packages/webrtc    Browser WebRTC logic, no Angular
packages/config    Shared TypeScript and ESLint configuration
```

Boundaries: `protocol` has no framework dependency; `webrtc` owns peer negotiation; `web` owns the UI and WebSocket adapter; `worker` owns room coordination. Apps do not import from other apps.

## Local development

Prerequisites: Node `>=22.22.3` (see `.nvmrc`) and pnpm 10 (`corepack enable`). Rust and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) are only needed for the dormant helper.

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
pnpm e2e
```

The Playwright E2E suite starts the real local Analog app, Worker, and Durable Object. It uses Chromium's fake microphone and camera. Normal E2E requires no Cloudflare credentials. For a real relay check, configure local TURN secrets and run `pnpm e2e:turn`.

`pnpm format` rewrites files with Prettier.

## UI ecosystem note

The intended UI stack is Volt UI, Quartz, Lumen Icons, and Angular Movement. The currently published Angular UI packages do not yet match this repository's Angular 22 baseline, and Volt UI and Quartz are not published. The call UI therefore uses plain Angular and Tailwind until compatible releases exist.
