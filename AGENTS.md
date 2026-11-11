# Working on this registry

Read [README.md](README.md), [the format](docs/format.md) and [the lifecycle](docs/lifecycle.md) before changing entries, schemas or rules.

- This is GizMoth's own registry format. Homebrew only inspired its Git-based distribution; do not reintroduce tap, formula, keg or receipt concepts.
- Chips are what users install. SDKs and toolchains are resolved behind them; toolchains are also user-visible in the Toolchains table.
- Keep recipes here. GizMoth owns fetching, native execution, local records and UI. Do not invoke the GizOS environment-manager CLI.
- Published releases are immutable. Add a new version when any input or step changes.
- Use exact versions, full Git commit IDs and verified SHA-256 digests. Never publish placeholders.
- Keep unfinished chips, SDKs and toolchains `planned`, with no releases. A recipe does not prove that a native installation works.
- Removal rules live in `scripts/lifecycle.mjs`; keep them, their tests and `docs/lifecycle.md` consistent.
- Schema changes need validator checks, rejection tests and documentation.
- Run `npm ci --ignore-scripts`, `npm run validate` and `npm test` before publishing. Never execute vendor installers or downloaded binaries during validation.
- Keep maintained documentation in English. Upstream software keeps its own license.
