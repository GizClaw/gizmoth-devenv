# GizMoth Development Environments

GizMoth's own Git registry for its **Development Environments** page. Users install a **chip**, a generic **environment**, or an exact **toolchain** version. GizMoth resolves and maintains the SDKs and tools behind them. Existing toolchains can also be registered from a local path.

GizMoth fetches a pinned Git commit, then downloads vendor files from upstream and verifies their pinned digests and sizes. All recipes and local lifecycle rules belong to this registry format. It requires no Homebrew, GizOS `gizos` CLI or Bun.

**Status: draft format `devenv.gizmoth.dev/v1alpha1`.** Bazelisk, Python and the GizOS base host-tools environment have published metadata. Every chip, SDK and target compiler remains `planned`. A published entry means its metadata validates; native installation and firmware builds need qualification in GizMoth.

## Repository layout

```text
registry.json                                # Registry identity and the index of every entry
environments/<id>/environment.json           # Named collection of exact toolchain dependencies
chips/<chip>/chip.json                       # Chip card: vendor, SDK, target and build tools
sdks/<sdk>/sdk.json                          # SDK metadata and version index
sdks/<sdk>/versions/<version>.json           # Immutable per-host recipe with per-chip targets
toolchains/<toolchain>/toolchain.json        # Toolchain metadata, category and version index
toolchains/<toolchain>/versions/<version>.json
schemas/devenv.schema.json                   # Registry documents and GizMoth's local records
docs/format.md                               # Entry and recipe format
docs/lifecycle.md                            # Local storage, install, update and removal rules
docs/gizmoth-integration.md                  # Native integration boundary
scripts/validate.mjs                         # Offline registry and local-record checks
scripts/lifecycle.mjs                        # Reference removal planning
scripts/update-bazelisk.mjs                  # Pin a published upstream Bazelisk release
scripts/update-python.mjs                    # Pin an exact Python version and upstream build release
test/                                        # Registry and removal-rule tests
```

Current entries:

| Kind | Entries |
| --- | --- |
| Environments | `gizos`: Bazelisk 1.30.0 and Python 3.12.16 (published) |
| Chips | `esp32s3`, `bk7258`, `ac707n` (planned) |
| SDKs | `esp-idf`, `beken-bk7258`, `jieli-ac707n` (planned) |
| Toolchains | `bazelisk` 1.30.0 (default), 1.29.0; `python` 3.12.16 (default), 3.11.18 (published); `arm-gnu`, `xtensa-esp-elf`, `jieli` (planned) |

Both published tools cover macOS, Linux and Windows on x86_64/arm64. Bazelisk installs the launcher as both `bazelisk` and `bazel`; each project's `.bazelversion` selects Bazel, which Bazelisk downloads on first use. Python uses CPython `install_only_stripped` archives from `astral-sh/python-build-standalone` release `20261110`, with GitHub asset SHA-256 digests and byte sizes. Python recipes only unpack the archive and check its executable file; no installation commands run.

GizOS provides base host tools. It does not include a vendor SDK or target compiler and does not by itself constitute a complete firmware build environment. Exact toolchain versions coexist, including within one dependency graph. Process activation explicitly selects installed versions and never replaces the user's global `PATH`.

## Validate

Use Node.js 22.19 or later. Install development dependencies when needed:

```bash
npm ci --ignore-scripts
```

```bash
npm run validate
```

```bash
npm test
```

Validation is offline and never runs vendor installers or downloaded binaries. It checks schemas, index coverage, paths, source pins, references, exact dependency identities, host intersections and cycles. Tests cover local-record identity, environment retention roots, removal with shared or multiple tool versions, and the immutable Bazelisk 1.30.0 manifest. Native installation, cancellation, archive link safety and deletion need integration tests in GizMoth.

## Maintain entries

Add a directory, index it in `registry.json`, and keep it `planned` until its complete recipe or dependency set exists. A release contains exact versions, immutable source pins and explicit platform recipes. Published release manifests are immutable: add a new version for any change, including a checksum or installation step. Publish a chip only after its SDK supports its target with all required toolchains. Publish a generic environment only when its exact dependencies share a supported host; environments have no version, default or release layer.

The maintainers' updaters require the GitHub CLI and explicit upstream inputs:

```bash
node scripts/update-bazelisk.mjs 1.29.0
```

```bash
node scripts/update-python.mjs 3.12.16 20261110
```

The Bazelisk updater verifies GitHub asset digests against upstream `.sha256` files. The Python updater requests only the six exact assets for the supplied version and release and verifies their identity, HTTPS URLs, SHA-256 digests and byte sizes. Neither updater downloads or executes binaries. Both refuse to change existing release manifests. The Bazelisk updater selects its supplied version as default; restore the intended default when adding an older release. The Python updater preserves an existing default. Review the version index before publication; a later Python build release cannot overwrite the same published Python version.

See [the format](docs/format.md), [the lifecycle](docs/lifecycle.md) and [the integration contract](docs/gizmoth-integration.md).

## License

This repository's original code and documentation use the [MIT license](LICENSE). Entries name upstream licenses. CPython and its bundled libraries retain the licenses shipped in their distributions, including the Python Software Foundation license; the registry license does not relicense downloaded software.
