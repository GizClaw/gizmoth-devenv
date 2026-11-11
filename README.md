# GizMoth Development Environments

The registry behind GizMoth's **Development Environments** page. Users install a **chip**; GizMoth resolves and maintains the SDK and toolchains behind it. Toolchains can also be installed directly or registered from a local path.

Distribution borrows Homebrew's model: package metadata lives in this Git repository, GizMoth fetches a pinned commit from GitHub, and vendor files are downloaded from upstream and verified against pinned digests. The format, directory layout and lifecycle are GizMoth's own; this is not a Homebrew tap and does not use Homebrew, the GizOS `gizos` CLI or Bun.

**Status: draft format `devenv.gizmoth.dev/v1alpha1`. GizMoth does not implement this registry or its page yet.** Only Bazelisk has a concrete release; every chip, SDK and other toolchain is `planned` and cannot be installed.

## Repository layout

```text
registry.json                                # Registry identity and the index of every entry
chips/<chip>/chip.json                       # Chips page card: vendor, SDK, target and build tools
sdks/<sdk>/sdk.json                          # SDK metadata and version index (not shown on its own)
sdks/<sdk>/versions/<version>.json           # Immutable per-host recipe with per-chip targets
toolchains/<toolchain>/toolchain.json        # Toolchains table entry and version index
toolchains/<toolchain>/versions/<version>.json
schemas/devenv.schema.json                   # Registry documents and GizMoth's local records
docs/format.md                               # Entry and recipe format
docs/lifecycle.md                            # Local storage, install, update and removal rules
docs/gizmoth-integration.md                  # Page structure and native integration boundary
scripts/validate.mjs                         # Offline registry and local-record checks
scripts/lifecycle.mjs                        # Reference removal planning
scripts/update-bazelisk.mjs                  # Pin a published upstream Bazelisk release
test/                                        # Registry and removal-rule tests
```

Current entries:

| Chips | SDKs | Toolchains |
| --- | --- | --- |
| `esp32s3`, `bk7258`, `ac707n` (planned) | `esp-idf`, `beken-bk7258`, `jieli-ac707n` (planned) | `bazelisk` 1.30.0 (published); `arm-gnu`, `xtensa-esp-elf`, `jieli` (planned) |

The Bazelisk release covers macOS, Linux and Windows on x86_64/arm64 with exact upstream URLs, sizes and SHA-256 digests cross-checked against upstream checksum files. It installs the launcher as both `bazelisk` and `bazel`; each project's `.bazelversion` selects Bazel, which Bazelisk downloads on first use. A published entry is validated metadata, not proof that a native installation has passed.

## Validate

Use Node.js 22.19 or later:

```bash
npm ci --ignore-scripts
```

```bash
npm run validate
```

```bash
npm test
```

Validation is offline and never runs vendor installers or downloaded binaries. It checks schemas, index coverage, paths, source pins, chip/SDK/toolchain references, host support, dependency cycles and version conflicts. Tests also cover local-record identity and the removal rules in [lifecycle.md](docs/lifecycle.md). Native installation, cancellation and deletion need integration tests in GizMoth once its engine exists.

## Maintain entries

Add a directory, index it in `registry.json`, and keep it `planned` until its first complete release exists. A release contains exact versions, immutable source pins and explicit platform recipes. Published releases are immutable: add a new version for any change, including a checksum or installation step. Publish a chip only after its SDK release supports its target with all required toolchains.

The Bazelisk updater requires the GitHub CLI and an explicit stable upstream version:

```bash
node scripts/update-bazelisk.mjs 1.30.0
```

It verifies GitHub asset digests against the upstream `.sha256` files, refuses to change an existing release, and updates `toolchains/bazelisk/toolchain.json`. It does not execute the assets.

See [the format](docs/format.md), [the lifecycle](docs/lifecycle.md) and [the integration contract](docs/gizmoth-integration.md).

## License

This repository's original code and documentation use the [MIT license](LICENSE). Entries name upstream licenses. Downloaded software keeps its own license and distribution terms.
