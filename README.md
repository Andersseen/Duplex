# Duplex

A lightweight 1:1 browser call and screen-sharing tool with an optional native helper for consent-based remote control.

```
Open.
Create link.
Send link.
Talk.
Share.
Help.
```

Duplex is deliberately not a conferencing suite: no accounts, no dashboards, no chat. Rooms are ephemeral and hold at most two people.

## Status

**This iteration is the platform foundation only.** There is no working call yet.

| Area                        | State                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Monorepo, tooling, CI       | Done                                                                  |
| Web app (`/`, `/r/:roomId`) | Landing page and a truthful room shell. Nobody is connected.          |
| Worker (`GET /health`)      | Done                                                                  |
| `CallRoom` Durable Object   | Class and binding exist; every request returns `501 not_implemented`  |
| Protocol (Zod schemas)      | Signaling and control message contracts, tested                       |
| WebRTC package              | Type contracts and connection-state derivation only                   |
| Helper (Tauri 2 + Angular)  | Window shell only. No commands, no OS input, no permissions requested |

Next: room signaling over WebSocket in the Durable Object, then the WebRTC call itself.

## Architecture

```
Analog.js browser app
        │
        ├── Cloudflare Worker/Hono
        │        │
        │        └── Durable Object per room
        │
        └── future direct WebRTC P2P

Tauri helper
        │
        └── future optional OS control
```

- **Browser app** is the whole product. It works without the helper.
- **Worker** validates the room ID and forwards `/api/rooms/:roomId/*` to that room's Durable Object. It holds no state.
- **`CallRoom` Durable Object** (one per room, addressed by `idFromName(roomId)`) will own live signaling and control state, in memory only. No database, KV, D1 or any persistence by design.
- **Media** will flow directly between browsers over WebRTC. TURN (Cloudflare Realtime) is a future extension of the Worker (`/api/rooms` namespace); no credentials exist yet.
- **Helper** is a separate app, used only if a participant asks for remote control. It is not a background daemon.

### Security assumptions the code is built around

- Room IDs are 128-bit random values (`createRoomId()`, base64url, 22 chars). The Worker rejects anything else.
- Remote control must be requested, explicitly granted, temporary (`expiresAt` is mandatory) and revocable at any time.
- The helper will never accept unauthenticated input from the internet; control sessions will use short-lived scoped tokens.

## Repository layout

```
apps/web        Analog.js + Angular 22, Tailwind CSS 4        (@duplex/web)
apps/worker     Cloudflare Worker + Hono + Durable Object     (@duplex/worker)
apps/helper     Tauri 2 + Angular, Rust in src-tauri/          (@duplex/helper)
packages/protocol  Zod schemas + inferred types, room IDs      (@duplex/protocol)
packages/webrtc    Browser WebRTC contracts, no Angular        (@duplex/webrtc)
packages/config    Shared tsconfig base and ESLint configs     (@duplex/config)
```

Boundaries: `protocol` depends on nothing in the workspace (only Zod). `webrtc` is browser-only and framework-free. Apps depend on packages, never on each other. Workspace packages are consumed as TypeScript source (no build step).

## Local development

Prerequisites: Node `>=22.22.3` (see `.nvmrc`) and pnpm 10 (`corepack enable`). The helper additionally needs a Rust toolchain and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/). No environment variables or secrets are required yet.

```bash
pnpm install
pnpm dev            # web on http://localhost:5173 + worker on http://localhost:8787
```

The web dev server proxies `/health` and `/api` to the worker. Check it:

```bash
curl http://localhost:8787/health
```

Run parts individually:

```bash
pnpm --filter @duplex/web dev
pnpm --filter @duplex/worker dev
pnpm dev:helper     # opens the Tauri window (needs Rust)
```

### Checks (same as CI)

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# helper Rust side (build the helper frontend first: pnpm --filter @duplex/helper build)
pnpm rust:fmt:check
pnpm rust:check
pnpm rust:clippy
```

`pnpm format` rewrites files with Prettier.

## UI ecosystem note

The intended UI stack is Volt UI, Quartz, Lumen Icons and Angular Movement. Today only `lumen-icons` and `angular-movement` are published to npm, and `lumen-icons@0.2.0` declares an Angular `^21` peer while this repo is on Angular 22. Volt UI and Quartz are not published. Rather than guess at APIs, the UI uses plain Angular and Tailwind. Adopt them once compatible releases exist.
