# Working on this registry

Read [README.md](README.md), [the format](docs/format.md) and [the lifecycle](docs/lifecycle.md) before changing entries, schemas or rules.

- This is GizMoth's own Git registry format and lifecycle. Keep its concepts independent of external package managers.
- Users install chips, generic environments and exact toolchain versions. SDKs are resolved through chips; toolchains also appear in the Toolchains table.
- Generic environments name exact toolchain dependencies in `environments/<id>/environment.json`. They have no profile version, default or release layer. Published environments need at least one common supported host.
- Keep recipes here. GizMoth owns fetching, native execution, safe archive extraction, local records and UI. Do not invoke the GizOS environment-manager CLI.
- Published release manifests are immutable. Add a new version when any input or step changes. Preserve the published Bazelisk 1.30.0 manifest bytes.
- Use exact versions, full Git commit IDs and verified SHA-256 digests and sizes. Never publish placeholders or dynamic `latest` inputs. Python metadata comes from the explicitly selected `astral-sh/python-build-standalone` release through `scripts/update-python.mjs`.
- Dependency identity is toolchain ID plus exact version. Multiple versions can coexist in one graph; reject cycles and duplicate exact dependencies within a dependency set. Shared graph nodes are reused. Process activation chooses versions explicitly and must not replace global `PATH`.
- Keep unfinished entries `planned`; planned SDKs and toolchains have no releases. Published metadata does not prove that a native installation or firmware build works. GizOS supplies base host tools, not a full firmware SDK/compiler environment.
- Removal rules live in `scripts/lifecycle.mjs`; keep them, their tests and `docs/lifecycle.md` consistent. Installed environments, installed chips and user-requested tools are retention roots.
- Schema changes need validator checks, rejection tests and documentation. `registry.environments` is optional so older indexes remain valid under the same API version.
- Use existing dependencies when available. When dependencies need installation, use `npm ci --ignore-scripts`. Run `npm run validate` and `npm test` before publishing. Never execute vendor installers or downloaded binaries during validation, or put managed installations in this repository.
- Keep maintained documentation in English. Upstream software keeps its own license.
