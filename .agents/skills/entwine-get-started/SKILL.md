---
name: entwine-get-started
description: Adopt Entwine (repository-native project knowledge compiler) in a repository for the first time. Use when a repo has no Entwine setup, when the user asks to "add Entwine", scaffold docs/, check whether the entwine CLI is installed, or asks what init, check, dev, build, context and setup do.
license: MIT
compatibility: Needs the entwine CLI (npx @entwine/cli, or a release binary) and Node 18+ for npx. Works without the Entwine MCP server.
metadata:
  author: Andersseen
  version: "1.0"
---

# Get started with Entwine

Entwine compiles the Markdown already in a repository (`docs/`) into one knowledge
model: static docs, a graph, and structured context for agents. It does **not**
generate documentation from code and has no `publish` command. Never invent
facts: write only what the repository itself supports.

## Steps

1. **Detect the CLI and version.**
   `entwine --version`, else `npx --yes @entwine/cli --version`.
   If neither works, stop and tell the user how to install it
   ([install options](references/commands.md#install)). If the version is older than the
   features you need, say so rather than guessing flags (`entwine <cmd> --help` is authoritative).
2. **Inspect before proposing.** Read `README.md`, list `docs/`, look for
   `AGENTS.md`/`CLAUDE.md`/`SKILL.md`, `entwine.toml`, and CI config. Existing
   Markdown under `docs/` compiles as-is; no renames are needed.
3. **Preview, never write first.** `entwine init --dry-run` lists the files it
   would create. Show the user. `init` never overwrites existing files.
4. **Ask, then scaffold.** Run `entwine init` only after the user agrees
   (`--yes` skips the prompt).
5. **Fill with verified facts.** Replace scaffold placeholders using what you can
   confirm from the repository. Mark unknowns plainly; do not fabricate APIs,
   architecture, or deployment details.
6. **Validate.** `entwine check`. Fix real errors (broken links/anchors,
   collisions). Missing recommended areas are warnings unless `--strict-knowledge`.
7. **Preview locally (optional).** `entwine dev` serves on loopback port 4173;
   `entwine build` writes `dist/`.
8. **Publishing is a separate step.** Use the `entwine-deployment` skill; do not
   run `entwine setup` here.

## What is discovered automatically

Markdown under `docs/` (roles derived from path or frontmatter `type`). With an
`entwine.toml` that enables discovery, also `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`
and `SKILL.md`. See the `entwine-knowledge` skill.

## Command cheat sheet

| Command | Writes files? | Purpose |
| --- | --- | --- |
| `init [--dry-run] [--yes]` | `docs/` scaffold only | recommended knowledge files |
| `check [--strict-knowledge]` | no | validate + coverage; exit 1 on errors |
| `dev [--port N]` | no (serves) | local live preview |
| `build` / `graph` | `dist/` | static HTML + graph |
| `context [--json]` | no (stdout) | deterministic context for agents |
| `setup [--dry-run] [--provider P]` | CI config | validation + publishing automation |

Details and failure modes: [references/commands.md](references/commands.md),
[references/troubleshooting.md](references/troubleshooting.md).

## Good and bad

- Good: "`entwine init --dry-run` would create docs/index.md, architecture.md, state.md,
  roadmap.md, decisions/, specs/. OK to run `entwine init`?"
- Bad: running `entwine init --yes` immediately, or writing an "Architecture"
  page describing services you never read.
