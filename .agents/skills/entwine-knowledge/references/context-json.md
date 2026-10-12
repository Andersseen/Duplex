# `entwine context --json` (schema 0.4)

Top level: `schema_version`, `documents[]`, `relationships[]`. Output is
deterministic: documents sorted by path, relationships unique and sorted.

Document fields: `id`, `title`, `route`, `metadata{title,type,status}`, `role`
(project|architecture|state|roadmap|decision|spec|other), `headings[]`
(`level,text,id`), `links[]` (`destination,line,target,href`), `backlinks[]` (ids),
`anchors[]`, `repository_references[]` (`path,source,line,destination`),
`artifact` (documentation|agent_instructions|skill), optional `agent`
(`convention,path,scope,name,description,skill_directory,resources`), and
`content` (exact original UTF-8 Markdown including frontmatter).

Relationship: `{source, target, kind}` with `kind: "references"`.

Notes:
- Agent artifacts: ids `repo:<path>`, role `other`.
- `README.md` may act as the project entry point when `docs/index.md` is absent.
- `metadata.type` is the author's original text; `role` is derived.
- The schema is experimental before 1.0; always check `schema_version`.
- The Entwine MCP server rejects any schema version it does not support instead of guessing.
