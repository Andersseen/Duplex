# Testing

Duplex tests behavior at the cheapest level that can prove it, and keeps the slow, real-browser
layer small. There is **no Python and no pytest** in this repository.

## The pyramid

| Layer                          | Tooling                                                  | Where                                                     | What it proves                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol / schema              | Vitest                                                   | `packages/protocol`                                       | Wire contracts, limits, room IDs, pairing bundles; Zod never generates code (CSP-safe).                                                                                        |
| Framework-independent services | Vitest with fakes                                        | `packages/webrtc`, `apps/web/src/app/services`            | Perfect negotiation, ICE recovery, DataChannels, file transfer, control and input state machines.                                                                              |
| Angular components             | Vitest + Angular Testing Library + user-event + jest-dom | `apps/web/src/app/{pages,room,ui}`, `apps/helper/src/app` | What a user sees and can do: roles, names, `aria-pressed`, dialogs, keyboard.                                                                                                  |
| Worker / Durable Object        | `@cloudflare/vitest-plugin` (real workerd)               | `apps/worker/test`                                        | Room admission, origin checks, pairing, helper routing, TURN credential handling.                                                                                              |
| Rust helper                    | `cargo test` (+ a fake native backend)                   | `apps/helper/src-tauri`                                   | Pairing parsing, protocol validation, session/surface/scope/expiry/sequence/rate checks, release, clipboard authorization.                                                     |
| Browser E2E                    | Playwright (Chromium, fake media)                        | `e2e/*.spec.ts`                                           | Real calls, collaboration, Assist negotiation with a test helper socket (incl. the full clipboard consent and transfer flow in `e2e/clipboard.spec.ts`), file bytes, journeys. |
| Accessibility                  | `@axe-core/playwright`                                   | `e2e/accessibility.spec.ts`                               | No serious/critical axe violations on landing, ready-to-join and a connected call, light and dark.                                                                             |
| Production headers             | Playwright against the built Worker                      | `e2e/production`                                          | The shipped CSP / Permissions-Policy allow hydration, signaling, mic, WebRTC and screen share.                                                                                 |
| Optional TURN relay            | Playwright, real Cloudflare credentials                  | `scripts/e2e-turn.mjs`                                    | Both peers select a relay candidate. Skipped without secrets.                                                                                                                  |
| Manual macOS verification      | A person with two browsers or machines                   | below                                                     | Real operating-system input.                                                                                                                                                   |

## Commands

```bash
pnpm test                # fast: every package's unit/component/integration tests
pnpm test:coverage       # same tests + coverage reports + enforced thresholds
pnpm coverage:summary    # Markdown table of the last coverage run
pnpm e2e                 # call, collaboration, Assist, file, journeys, responsive, axe
pnpm e2e:production      # build + run the production Worker with real security headers
pnpm e2e:turn            # optional: forced relay (needs apps/worker/.dev.vars TURN secrets)

cargo test --manifest-path apps/helper/src-tauri/Cargo.toml --locked
pnpm check:tauri         # audits the helper's capabilities, commands and CSP, then runs its own tests
```

`pnpm test` stays quick for local iteration; coverage is a separate, CI-quality command.

## Coverage

| Package             | Provider            | Statements | Lines | Functions | Branches | Why this bar                                                                                    |
| ------------------- | ------------------- | ---------: | ----: | --------: | -------: | ----------------------------------------------------------------------------------------------- |
| `packages/protocol` | V8                  |         90 |    90 |        85 |       80 | Security-critical: validation and limits.                                                       |
| `apps/worker`       | **Istanbul**        |         90 |    90 |        90 |       80 | Security-critical: admission, origin, pairing, routing.                                         |
| `packages/webrtc`   | V8                  |         90 |    90 |        85 |       75 | Branches sit just under 80: the rest is defensive parsing of browser stats.                     |
| `apps/web`          | V8                  |         85 |    88 |        85 |       75 | General application code; `ControlService` and `RemoteInputService` are individually above 90%. |
| `apps/helper` (UI)  | V8 (Angular runner) |         90 |    90 |        85 |       80 | Small, security-relevant UI (pairing, Stop control, no secrets shown).                          |

Thresholds are set just under the measured baseline after adding tests for error paths,
disconnects, permission denial, expiry, malformed payloads and cleanup — not lowered to fit. Reports
(`text`, `json-summary`, `lcov`, `html`) are written to each package's ignored `coverage/` directory
and uploaded as a CI artifact; the table above is also printed to the CI job summary. No external
coverage service is used.

**Why the Worker uses Istanbul.** Cloudflare's Vitest integration runs tests inside `workerd`, which
does not support V8's native coverage. Istanbul instruments the source instead. Every other package
runs in Node/jsdom where V8 coverage is faster and more accurate.

**Rust coverage is intentionally deferred.** `cargo test` is mandatory in CI on Linux and macOS, but
`cargo llvm-cov` would add toolchain components and platform-specific numbers (the macOS backend
cannot run without Accessibility). Platform-independent logic is already covered by the fake-backend
tests; revisit if the helper grows.

## Security regression tests

| Guarantee                                                                                                                                                                                               | Where                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Token-bucket math, fake clock (stall, backwards time, abuse threshold)                                                                                                                                  | `apps/worker/test/rate-limit.test.ts`                        |
| ICE bursts pass; participant, helper and malformed floods close with 4008                                                                                                                               | `apps/worker/test/rate-limit-room.test.ts`                   |
| Per-connection isolation, reconnect with a fresh budget, cleanup on close                                                                                                                               | same                                                         |
| Revocation and helper Stop delivered while bulk traffic is throttled                                                                                                                                    | same                                                         |
| Clipboard text never appears in logs; size bounds still enforced                                                                                                                                        | same                                                         |
| CSP hash extraction only accepts Angular's own scripts                                                                                                                                                  | `apps/web/src/server/csp.spec.ts`                            |
| Shipped CSP has no `unsafe-inline`/`unsafe-eval` and hashes every inline script; injected inline script is blocked; event replay, lazy chunks, signaling, media, screen share and clipboard policy work | `e2e/production/headers.spec.ts`                             |
| Tauri allowlist, commands, CSP, plugins, remote origins and windows                                                                                                                                     | `pnpm check:tauri` (`scripts/check-tauri-security.test.mjs`) |

These run in CI. None of them exercise real macOS Accessibility, input or the packaged Tauri
window; the narrowed capability has only been validated by compilation (`tauri-build` checks the
capability against the command manifest). **Before relying on the narrower grant, run the helper on
macOS (`pnpm dev:helper`), pair it, and confirm the status, display list, Stop and live state
updates still work.** Native control remains experimental.

## What cannot be automated safely

Posting a real mouse event requires macOS **Accessibility** permission granted by a person, and would
move the CI runner's cursor. Automated tests therefore cover everything up to the native call: the
helper validates real messages against a **fake input backend**, E2E drives a test helper WebSocket
and asserts the exact validated envelopes, and the macOS CI job compiles and tests the Quartz code
read-only. Physical input is verified by hand:

### Manual macOS checklist

1. `pnpm dev` and `pnpm dev:helper` on a Mac; open the call in two browsers (or two machines).
2. In browser A share an **entire screen**, create a pairing code, paste it into the helper.
3. In the helper click **Enable Accessibility**, approve the helper in System Settings, **Re-check**, and pick the shared display if you have several.
4. In browser B click **Request control**; **Allow** in browser A.
5. From B move, click, right-click, drag and scroll over the shared screen; A's cursor should follow (confirm scroll direction on hardware).
6. Click **Stop control** in the helper: the cursor must stop responding immediately and no button may stay held.
7. Repeat after changing the shared screen, after revoking Accessibility, and after closing a browser mid-drag.

#### Clipboard (not executed as part of the automated change set)

1. Pair as above; the helper's **Clipboard text** row should read _Ready_ even before Accessibility is granted.
2. As B, tick **Clipboard text** and request control. In A's dialog the clipboard box must be **unticked**; tick it and Allow. The helper should show the clipboard grant.
3. Copy text on B, click **Send my clipboard text** (accept Chromium's prompt). Paste on A's Mac: the text must match exactly, including accents, emoji and newlines. A shows the character count, not the text.
4. Copy text on A's Mac, click **Get remote clipboard text** as B. A must see **Share once / Decline** and nothing may reach B before A clicks. After Share once, click **Copy to my clipboard** on B and paste.
5. Try text over 4 KiB and text with a control character: B must refuse it with an explanation and A's clipboard must be unchanged.
6. Decline a read; deny the browser's clipboard prompt; stop control from the helper mid-request. Each must show an accurate message and leave A's clipboard unchanged.
7. Grant only pointer and confirm the clipboard buttons never appear. With a non-text clipboard (an image) a read must report "no text".
8. To exercise the real pasteboard code on the Mac running the tests: `cargo test --manifest-path apps/helper/src-tauri/Cargo.toml -- --ignored macos_clipboard_round_trip` (this **replaces your clipboard**).

This checklist was not executed as part of the automated change set.

## Regenerating screenshots

README images are real renderings produced by Playwright with a clearly synthetic shared screen and
a mocked Tauri bridge for the helper window. They never contain pairing codes or real desktop content.

```bash
pnpm docs:screenshots    # writes docs/assets/*.png
```

It is not part of `pnpm test` or CI.

## Conventions

- Prefer `getByRole`, `getByLabelText`, `findByRole` and `userEvent` over selectors, manual `click()` and manual `detectChanges()`.
- Test services directly with Vitest and fakes; use Angular Testing Library for what a user experiences.
- A new error path, permission, expiry or protocol message needs a test. Do not write tests that restate the implementation.
- E2E stays few and critical; do not turn Playwright into a unit-test runner.
