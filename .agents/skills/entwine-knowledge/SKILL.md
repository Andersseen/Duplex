---
name: entwine-knowledge
description: Write, review and validate project knowledge using the Entwine Knowledge Convention and `entwine context --json`. Use when editing docs/ in an Entwine repository, deciding where architecture, state, roadmap, decision or spec content belongs, tracing links and backlinks, fixing `entwine check` errors, or when AGENTS.md, CLAUDE.md or SKILL.md files must be kept out of published docs.
license: MIT
compatibility: Needs the entwine CLI. If the Entwine MCP server is registered, its entwine_* tools give the same data without shell access.
metadata:
  author: Andersseen
  version: "1.0"
---

# Work with Entwine knowledge

Markdown is the source of truth. Entwine derives roles, links and backlinks from
it; there is no separate agent parser. Read the model, do not re-derive it.

## Read the model

- With MCP: `entwine_project_overview`, `entwine_list_documents`,
  `entwine_read_document`, `entwine_related_documents`.
- Without MCP: `entwine context --json` (full source in `content`). Check
  `schema_version` first; this guide describes `"0.4"`. If it differs, read
  `docs/specs/context-schema.md` of that Entwine version instead of guessing.
- Document ids are paths relative to `docs/` (`architecture.md`). Discovered agent files have
  ids prefixed `repo:`.

## Where content goes

| Role | Answers | Path or `type:` |
| --- | --- | --- |
| project | what is this, where is knowledge | `index.md` |
| architecture | how is it structured **today** | `architecture.md` |
| state | what is true **now** | `state.md` |
| roadmap | what is intended **next** | `roadmap.md` |
| decision | what was decided and why | `decisions/*.md` |
| spec | what a capability durably does | `specs/*.md` |

A finished milestone moves from roadmap to state. Roles come from frontmatter
`type:` first, then the canonical path; unknown types become `other`. Existing
files need no renames: add `type: architecture` instead.

## Editing rules

1. Link with relative Markdown links (`[state](state.md#release-status)`); links
   become relationships and backlinks. Run `entwine check` after edits.
2. Write only facts verifiable in the repository. Unknown stays marked unknown.
3. Decisions use: Context, Decision, Why, Consequences, Alternatives.
4. Links to existing non-knowledge files are "repository references", not relationships.

## Documentation vs agent instructions vs skills

`AGENTS.md`/`CLAUDE.md`/`GEMINI.md` instruct agents; `SKILL.md` holds procedures;
`docs/` holds durable knowledge. Entwine only discovers the first two kinds when
`entwine.toml` sets `[discovery] agent_instructions = true` / `skills = true`.
Discovered files are always in `entwine context` but are published in the site only
if `[site] include_agent_knowledge = true` (default `false`) or when listed in
`[site] public_agent_paths` (exact repository-relative paths, newer CLIs only; it
contradicts `include_agent_knowledge = true`). Never enable publication, or copy agent instructions into `docs/`, without the user's explicit
approval; they may contain private operating rules.

## Diagnose

Run `entwine check`. Fix the cause; never delete content or links just to pass.
Messages, causes and fixes: [references/validation.md](references/validation.md).
Context field details: [references/context-json.md](references/context-json.md).

## Good and bad

- Good: "`state.md` claims auth is session-based but the code uses tokens. I
  could not confirm which is current; I left a TODO and asked."
- Bad: inventing a Decision record to make a coverage warning disappear.
