# Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `entwine: command not found` | not installed | `npx --yes @entwine/cli --version` or install per commands.md |
| `no prebuilt binary for <platform>` | unsupported OS/arch | build from source (Rust 1.85+): `cargo install --path crates/entwine-cli` in the Entwine repo |
| `@entwine/cli-<platform> is not installed` | `--omit=optional` | reinstall with optional dependencies |
| `No docs/ directory at ...` | nothing scaffolded yet | `entwine init --dry-run`, then ask before `entwine init` |
| `No Markdown documents found` | `docs/` empty | add `docs/index.md` (init does) |
| `Broken internal link "x.md"` | link target missing | fix the link or the file; do not delete the check |
| `Symbolic links are not supported inside docs/` | symlink in `docs/` | replace with a regular file |
| `Invalid entwine.toml: ...` | unknown key or wrong type | keys: `[discovery] agent_instructions, skills`; `[site] include_agent_knowledge, public_agent_paths` |
| Port in use for `dev` | 4173 taken | `entwine dev --port 0` picks a free port |
| `npm error 404` for the latest version | that version is not published yet | check `npm view @entwine/cli versions`; use a published version or a release binary |
