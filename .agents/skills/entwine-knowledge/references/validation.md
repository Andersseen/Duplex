# Validation messages

| Message (abridged) | Meaning | Fix |
| --- | --- | --- |
| `Broken internal link "x.md"` | no document or asset at that path | correct the link or create the file |
| broken anchor | heading id missing in target | use an existing heading id (lowercase-hyphenated) |
| `Symbolic links are not supported inside docs/` | symlink under docs/ | use a regular file |
| `No incoming document relationships` (warning) | orphan page | link to it from a related page, e.g. index |
| type/path disagreement (warning) | frontmatter `type` differs from canonical path | keep the explicit type or move the file |
| missing recommended area (warning) | convention coverage | add the document only if you can state real facts |
| `Invalid entwine.toml: ...` | config typo | allowed: `[discovery] agent_instructions, skills`; `[site] include_agent_knowledge, public_agent_paths` (invalid, contradictory or undiscovered `public_agent_paths` entries are errors; never widen them silently) |
| agent file link to missing file (warning) | stale link in AGENTS.md/SKILL.md | fix link; warning only |

Rules: errors fail `check`; warnings do not (except coverage with `--strict-knowledge`).
Report the exact output to the user; do not claim a pass you have not run.
