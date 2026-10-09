# Contributing to Duplex

Thanks for helping. Duplex is a small codebase with a strong opinion about privacy and consent, so
a little context goes a long way. Please read [docs/architecture.md](./docs/architecture.md) and
[docs/security.md](./docs/security.md) before changing anything near pairing, control sessions or
native input.

Note that Duplex has not selected a license yet (see the README). Opening a pull request means you
are happy for the maintainer to use your contribution under whatever license is eventually chosen.

## Setup

Prerequisites: Node `>=22.22.3` (`.nvmrc`), pnpm 10 (`corepack enable`). For the native helper, Rust
stable and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm dev                 # web (5173) + Worker (8787)
pnpm dev:helper          # native helper
pnpm exec playwright install chromium   # once, for E2E
```

## Branch workflow

1. Branch from an up-to-date `main`: `git fetch origin && git switch main && git pull --ff-only && git switch -c <type>/<short-topic>`.
2. Keep branches short-lived and focused on one change.
3. Commit with [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `ci:`), one reviewable change per commit.
4. Open a pull request against `main`; fill in the template. Do not push to `main`.

## Coding conventions

- TypeScript is strict; ESLint and Prettier are authoritative (`pnpm lint`, `pnpm format`).
- Angular: standalone components, signals, `input()`/`output()`, `OnPush`, zoneless, modern control flow, `viewChild()`. No NgModules, `HostBinding`/`HostListener`, NgRx or RxJS stores.
- Keep domain logic in the services (`CallSessionService`, `FileTransferService`, `CollaborationService`, `ControlService`, `RemoteInputService`) and the packages — components stay presentational.
- Tailwind 4 with the semantic tokens in `apps/web/src/styles.css` (`bg-canvas`, `text-ink-muted`, …). No raw `bg-black`; do not add an icon library while Lumen Icons is Angular-21-only.
- `packages/protocol` and `packages/webrtc` stay framework-free; apps never import from apps.
- Match the surrounding code's naming, comment density and idioms.

## Testing expectations

Add or update tests with the change — see [docs/testing.md](./docs/testing.md).

- Prefer Angular Testing Library queries by role/label and `userEvent` for components; plain Vitest with fakes for services.
- New error paths, permissions, expiry, malformed input and cleanup need tests. Security-sensitive logic should not lose coverage.
- Run before pushing: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`, plus `pnpm e2e` for UI/call changes and the Rust checks (`pnpm rust:fmt:check`, `pnpm rust:check`, `pnpm rust:clippy`, `cargo test --manifest-path apps/helper/src-tauri/Cargo.toml --locked`) for helper changes.
- Never post real operating-system input from automated tests.

## CI expectations

Every pull request must pass: JS (format, lint, typecheck, tests with coverage thresholds, build), Browser E2E (including accessibility and production headers), Rust on Linux and macOS, and the Security workflow (CodeQL, Dependency Review, audits). Do not weaken or skip a check to get a green build — fix the cause or discuss it in the PR.

## Security-sensitive changes

Treat these as high-scrutiny and call them out in the PR's _Security impact_ section: room admission, origin checks, TURN credentials, helper pairing, control grants and revocation, the input protocol, the Rust input backend, Tauri capabilities and CSP, and dependency additions. Never log or commit tokens, pairing codes, TURN credentials or control-session data. Report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).

## Pull request expectations

- Small, focused, and explained: what changed, why, how it was tested, security impact, screenshots for UI changes.
- Update docs and the README when behavior or platform support changes; keep claims honest (experimental stays experimental).
- Do not add features beyond the PR's stated scope; open an issue first for large changes.
- If you used the Agentyx agent tooling, do not hand-edit generated skill/config files; use `pnpm exec agentyx` and run `pnpm exec agentyx doctor`.
