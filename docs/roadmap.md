# Roadmap

Coarse phases, in rough order. This is a statement of direction, not a commitment: there are no
dates and nothing here is promised.

| Phase                     | Status                 | Notes                                                                                   |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| Live foundation           | Done                   | 1:1 audio, camera, screen sharing, STUN/TURN, ICE recovery, path diagnostics.           |
| P2P file transfer         | Done                   | Receiver consent, progress, cancel; 256 MiB limit; no server storage.                   |
| Collaboration             | Done                   | Pointer, laser and annotations on the shared screen.                                    |
| Assist consent            | Done                   | Request / Allow / scoped, expiring, revocable sessions; helper pairing.                 |
| macOS pointer control     | Done, **experimental** | Needs more hardware verification and an external security review.                       |
| Professional foundation   | Done                   | Docs, security model, testing and coverage gates, CI hardening, a11y checks.            |
| macOS keyboard            | Done, **experimental** | Separate scope, physical-key allowlist, shortcut restrictions and key release safety.   |
| Secure clipboard          | Done, **experimental** | Separate `clipboard` scope, manual text-only send/copy, approval for every remote read. |
| Security hardening (v0.5) | Done                   | Worker per-connection rate limits, hash-based script CSP, minimal Tauri capability.     |
| Windows helper            | Later                  | Native backend behind the existing `NativeInput` boundary.                              |
| Linux helper              | Later                  | Same boundary; display-server differences make this the hardest.                        |
| Capture / Loom mode       | Later                  | Local recording of a call or screen; needs its own privacy design.                      |

## Hardening candidates

Not features, but known follow-ups: macOS clipboard hardware verification (nothing here claims it was done), rich clipboard types (images, files — out of scope until they have their own privacy design), per-room (not only per-connection) abuse limits, an
optional room lock or admission prompt, Rust coverage, moving `style-src` off `'unsafe-inline'`, manual macOS validation of the narrowed Tauri capability, and adopting the Andersseen UI libraries (Volt UI, Quartz, Lumen Icons) once they publish
Angular 22-compatible releases.

## Explicitly out of scope

Accounts, multi-user rooms, chat, unattended access, persistent pairing and "always allow".
