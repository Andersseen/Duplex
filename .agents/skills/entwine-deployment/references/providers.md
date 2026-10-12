# Providers

Setup reads local Git remotes only (no network): current branch remote, then
`origin`, then the rest sorted; first recognized wins. HTTPS and SSH remotes work.

| Remote | Provider | Writes |
| --- | --- | --- |
| `github.com` | GitHub Pages via Actions | `.github/workflows/entwine.yml` |
| `gitlab.com`, `gitlab.*` | GitLab Pages | `.gitlab/ci/entwine.yml` + `include:` in `.gitlab-ci.yml` |
| `bitbucket.org` | Bitbucket static hosting | `bitbucket-pipelines.yml`, or `.entwine/bitbucket-pipelines.snippet.yml` if one exists |
| other | none | portable `dist/` guidance only |

Behaviour of every generated pipeline: PR/MR changing repository files runs
`entwine check`; default branch runs check, build, then publishes that build; PRs
never publish. Files carry an `entwine-managed` marker; re-running reports
"already configured".

## GitHub

Workflow permissions `contents: read`; only deploy has `pages: write`, `id-token: write`.
Required: repo Settings → Pages → Source "GitHub Actions" (private repos depend on plan).
Site URL: `https://<owner>.github.io/<repo>/` unless a custom domain is set.

## GitLab

Uses `pages:publish` (GitLab 17.10+). If `.gitlab-ci.yml` has `include`, `stages`,
`workflow` or starts with `---`, it is untouched and setup prints the lines to add.
Variable `ENTWINE_IMAGE` overrides the `node:22` image. Self-managed hosts not named
`gitlab.*` need `--provider gitlab`.

## Bitbucket Cloud

One site per workspace from repo `<workspace>.bitbucket.io`, always public, cached ~15 min.
Manual: create that repo, create a write access token, add it as secured variable
`ENTWINE_SITE_TOKEN`, enable Pipelines. Existing `bitbucket-pipelines.yml` is never edited.

## Monorepos

`entwine setup path/to/project` prefixes paths and commands. Directory names unsafe to
embed in CI are refused.
