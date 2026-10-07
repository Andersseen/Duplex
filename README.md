# Duplex

Duplex is a lightweight way to start a private 1:1 browser audio call. Create a room link, send it to one person, and talk. Rooms are anonymous, ephemeral, and hold at most two participants.

## Status

**Duplex supports real 1:1 audio calls.** A participant explicitly joins before the browser requests microphone access. Signaling travels through the Worker and a room Durable Object; audio travels directly between browsers over WebRTC.

| Area                        | State                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| Monorepo, tooling, CI       | Done                                                                       |
| Web app (`/`, `/r/:roomId`) | Create a room, join, share its link, mute, and leave                       |
| Worker                      | Health endpoint and validated room WebSocket routing                       |
| `CallRoom` Durable Object   | Two-person presence and WebRTC signaling relay using WebSocket Hibernation |
| WebRTC package              | Browser-only perfect negotiation, ICE exchange, and direct audio           |
| Helper (Tauri 2 + Angular)  | Dormant window shell; not involved in calls                                |

Not supported yet: camera, screen sharing, TURN fallback, remote control, accounts, chat, or recording.

## Signaling and media

```text
Browser A                         Worker                 CallRoom Durable Object                    Browser B
   │                                │                              │                                    │
   ├────────── WebSocket ──────────►│                              │                                    │
   │                                ├──────── WebSocket ──────────►│                                    │
   │                                │                              ├──────── WebSocket relay ─────────►│
   │                                │                              │                                    │
   ╞══════════════════════════════════════ WebRTC audio ════════════════════════════════════════════════╡
```

The Worker validates the opaque room ID and resolves the Durable Object with `idFromName(roomId)`. `CallRoom` coordinates the join/leave lifecycle and relays validated offer, answer, and ICE messages only to the other participant. The object uses Cloudflare's WebSocket Hibernation API and serialized socket attachments to recover participant identity after hibernation. It holds no media and uses no database; microphone audio flows peer-to-peer.

Room IDs remain cryptographically random 128-bit tokens created in the browser. A room comes into existence when its Durable Object is first addressed. The room URL is the anonymous capability to enter that ephemeral room.

STUN is used for direct connection setup. There is no TURN fallback yet, so some network combinations may not connect.

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
```

`pnpm format` rewrites files with Prettier.

## UI ecosystem note

The intended UI stack is Volt UI, Quartz, Lumen Icons, and Angular Movement. The currently published Angular UI packages do not yet match this repository's Angular 22 baseline, and Volt UI and Quartz are not published. The call UI therefore uses plain Angular and Tailwind until compatible releases exist.
