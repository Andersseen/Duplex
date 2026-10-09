# Repository settings checklist

Some of Duplex's protections are GitHub **settings**, not files, so they cannot be shipped in a pull
request. This list is the recommended configuration. Items already enabled when this document was
written (from the repository API) are marked.

| Setting                                                                                                                                                               | Why                                                                | State when written         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Branch ruleset on `main`: require a pull request                                                                                                                      | Nothing reaches `main` unreviewed or untested.                     | Not checked — set manually |
| Required status checks: `Format, lint, typecheck, test, build`, `Browser E2E (Chromium)`, `Rust (Tauri helper)`, `Rust (macOS helper)`, `CodeQL`, `Dependency review` | Merge only when CI and security pass.                              | Set manually               |
| Require branches to be up to date before merging                                                                                                                      | Avoids merging a green PR onto a moved `main`.                     | Set manually               |
| Block force pushes and branch deletion on `main`                                                                                                                      | Protects history.                                                  | Set manually               |
| Dependency graph                                                                                                                                                      | Required for Dependency Review and Dependabot.                     | Verify                     |
| Dependabot alerts                                                                                                                                                     | Advisory notifications for the lockfile and `Cargo.lock`.          | Verify                     |
| Dependabot security updates                                                                                                                                           | Automatic PRs for vulnerable dependencies.                         | **Disabled** — enable      |
| Secret scanning                                                                                                                                                       | Detects committed credentials.                                     | **Enabled**                |
| Push protection                                                                                                                                                       | Blocks pushes containing detected secrets.                         | **Enabled**                |
| Private vulnerability reporting                                                                                                                                       | Lets researchers report privately ([SECURITY.md](../SECURITY.md)). | Enable — see below         |
| Code scanning (CodeQL default setup off, advanced via workflow)                                                                                                       | The `Security` workflow already provides it; do not enable both.   | Provided by `security.yml` |
| Actions: default `GITHUB_TOKEN` permissions = read                                                                                                                    | Workflows request what they need explicitly.                       | Set manually               |
| Actions: require approval for workflows from outside contributors                                                                                                     | Prevents untrusted workflow runs on first-time contributors.       | Set manually               |
| Environments: protect the production deploy environment                                                                                                               | Optional approval gate for **Deploy production**.                  | Optional                   |

## Enabling private vulnerability reporting

Repository **Settings → Code security → Private vulnerability reporting → Enable**. Until this is
on, `SECURITY.md` falls back to asking reporters to open a minimal public issue without details.

## Suggested repository metadata

- **Description:** Private 1:1 WebRTC calls, screen sharing, P2P collaboration and consent-based remote assistance.
- **Topics:** `webrtc`, `angular`, `cloudflare-workers`, `tauri`, `rust`, `p2p`, `screen-sharing`, `remote-control`
- **Homepage:** leave empty until a production deployment has been verified.
