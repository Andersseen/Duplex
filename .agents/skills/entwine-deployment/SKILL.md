---
name: entwine-deployment
description: Set up and verify Entwine documentation publishing through the repository's Git provider (GitHub Pages, GitLab Pages, Bitbucket) using `entwine setup`. Use when the user wants Entwine docs published or validated in CI, asks what `entwine setup` generates, or needs to preserve an existing CI or deployment workflow.
license: MIT
compatibility: Needs the entwine CLI and a Git repository with a remote. Verifying a hosted deployment needs access to the provider's CI and the published URL.
metadata:
  author: Andersseen
  version: "1.0"
---

# Publish Entwine docs

`entwine setup` generates CI configuration. It does **not** publish, deploy, push
or store credentials; the provider's CI does the publishing after the user
commits and pushes. There is no `entwine publish`.

## Steps

1. **Validate first.** `entwine check` must pass. If there is no `docs/`, use the
   `entwine-get-started` skill.
2. **Inspect existing automation.** `git remote -v`; list `.github/workflows/`,
   `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, and any existing Pages/deploy job.
   Note what already publishes or deploys. Do not replace, merge or reorder it.
3. **Preview.** `entwine setup --dry-run` (add `--provider github|gitlab|bitbucket`
   for self-hosted or unrecognized hosts). Show the user the provider, files and
   triggers. If the provider is "Unknown", the only output is `entwine build`
   to a portable `dist/`.
4. **Check the pinned version exists.** Generated CI installs `@entwine/cli` at
   the version that wrote it. Run `npm view @entwine/cli@<that version> version`;
   if it is not published, CI will fail. Tell the user instead of pushing.
5. **Ask, then apply.** `entwine setup` only with approval. It never overwrites
   a file it did not create (reported and skipped) and is idempotent.
6. **Provider one-time steps** ([details](references/providers.md)):
   GitHub: Settings → Pages → Source = "GitHub Actions". Bitbucket: site repo,
   access token as secured variable `ENTWINE_SITE_TOKEN`, enable Pipelines.
   GitLab: 17.10+ for `pages:publish`.
7. **Hand off.** Committing/pushing is the user's choice. Do not push for them
   unless asked.
8. **Verify before claiming success.** Confirm the CI run on the default branch
   succeeded and the hosted URL serves the docs ([checklist](references/verify.md)).
   Until then say "configured", not "deployed".

## Portable alternative

`entwine build` produces `dist/` for any static host (relative links, works under
a subpath). Choosing this and skipping `setup` is valid.

## Never

- Replace or silently edit an existing CI/deploy configuration.
  (`setup` edits only `.gitlab-ci.yml`, and only to prepend an `include` when it has
  no `include`, `stages` or `workflow`.)
- Add tokens to files, or claim a deployment you did not observe.
- Publish agent instructions: `[site] include_agent_knowledge` stays `false` unless
  the user explicitly wants them public. To publish only some files, prefer
  `[site] public_agent_paths = ["<exact repo-relative path>"]` (newer CLIs; check
  `entwine setup --help`) and never list an `AGENTS.md` the user calls internal.
- Edit the README on your own. `entwine setup --readme-link` (newer CLIs only) is opt-in:
  run it with `--dry-run`, show the user the exact change, and never commit or push it.
  It derives a GitHub Pages URL only for an unambiguous GitHub remote and calls it
  unverified; for any other host ask for `--site-url`.

## Good and bad

- Good: "Dry run shows `.github/workflows/entwine.yml`. Your existing
  `pages.yml` already deploys Pages; two Pages deployers will conflict, so which
  one should own it?"
- Bad: "Setup done, your docs are live!" before any workflow has run.
