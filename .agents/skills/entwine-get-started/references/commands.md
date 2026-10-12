# Entwine CLI quick reference

Every command takes an optional `[PROJECT]` directory (default `.`) that
contains `docs/`. Run `entwine <command> --help` for the authoritative flags of the
installed version.

## Install

- One-off: `npx --yes @entwine/cli <command>` (needs Node 18+).
- Project dev dependency: `npm install --save-dev @entwine/cli`, then `npx entwine ...`.
- Native binary archives: GitHub Releases of `Andersseen/Entwine`.
- Supported npm platforms: darwin-arm64, darwin-x64, linux-x64, win32-x64.
- The npm package installs a prebuilt native binary via optional dependencies; do not
  install with `--omit=optional`.
- Check which versions are published: `npm view @entwine/cli versions`.

## init

`entwine init [PROJECT] [--dry-run] [-y]` creates only missing recommended files:
`docs/index.md`, `architecture.md`, `state.md`, `roadmap.md`, `decisions/index.md`,
`specs/index.md`. Without `-y` it prompts. Existing files are left alone.

## check

`entwine check [PROJECT] [--strict-knowledge]`: validates internal links,
anchors, collisions, metadata, unsafe paths; reports coverage of the recommended
knowledge areas. Exit 0 = passed. Errors fail; missing areas are warnings (errors
with `--strict-knowledge`). Without `docs/` it exits 1 with
"No docs/ directory ... Create docs/index.md".

## dev / build / graph

- `entwine dev [PROJECT] [--port 4173]` compile + serve on loopback, rebuilds on change.
- `entwine build [PROJECT]` writes portable `dist/` (relative links; any static host).
- `entwine graph [PROJECT]` builds docs plus the static SVG graph.

## context

`entwine context [PROJECT] [--json]`: deterministic project knowledge on stdout.
`--json` emits versioned structured context (`schema_version`, `documents`,
`relationships`; full source in `content`). Same model as the site, no separate parser.
Reading it never writes files.

## setup

`entwine setup [PROJECT] [--dry-run] [--provider github|gitlab|bitbucket]`.
Generates CI configuration only. See the `entwine-deployment` skill.

## Not provided

No `publish`/`deploy` command, no hosting, no code-to-docs generation, no AI.
