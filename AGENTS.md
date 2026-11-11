# Working on this tap

Read [README.md](README.md), [the format](docs/format.md) and [the lifecycle](docs/lifecycle.md) before changing catalog entries or the protocol.

- Keep installation recipes in this repository. GizMoth owns discovery, native execution, local state and UI. Do not invoke the GizOS environment-manager CLI.
- Published release manifests are immutable. Add a new package version when an installer or its inputs change.
- Use exact dependency versions, full Git commit IDs and verified SHA-256 digests. Never publish placeholders as installable releases.
- Keep unfinished SDKs marked `planned`, with no default version or releases. A concrete recipe is not evidence of a successful native installation.
- Changes to schemas need matching validator checks, meaningful rejection tests and documentation.
- Run `npm ci`, `npm run validate` and `npm test` before publishing.
- Never execute vendor installers or package binaries as part of catalog validation.
- Keep maintained documentation in English. Preserve upstream licenses; the repository license does not relicense downloaded software.
