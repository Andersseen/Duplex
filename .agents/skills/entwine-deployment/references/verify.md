# Verify a hosted deployment

Do these before saying docs are published. Report what you actually observed.

1. Local: `entwine check` exits 0; `entwine build` creates `dist/index.html`.
2. CI run on the default branch (not a PR) finished successfully:
   - GitHub: `gh run list --workflow entwine.yml --limit 3` and `gh run view <id>`
   - GitLab: pipeline for the default branch, job `pages:publish`
   - Bitbucket: pipeline result, then the site repo commit
3. The hosted URL returns the docs: `curl -sSI <url>` is `200`, and the page
   contains the project title. GitHub Pages can take a minute after the run.
4. If the run failed: read the failing step. Frequent causes: Pages source not set
   to "GitHub Actions"; pinned `@entwine/cli` version not on npm; `entwine check`
   errors; missing token (Bitbucket).
5. No access to CI or the URL? Say it is unverified.
