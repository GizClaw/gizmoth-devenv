# GizMoth Development Environments

GizMoth's own Git registry for its **Development Environments** page. Users install a **chip**, a generic **environment**, or an exact **toolchain** version. GizMoth resolves and maintains the SDKs and tools behind them. Existing toolchains can also be registered from a local path.

GizMoth fetches a pinned Git commit, then downloads vendor files from upstream and verifies their pinned digests and sizes. All recipes and local lifecycle rules belong to this registry format. It requires no Homebrew, GizOS `gizos` CLI or Bun.

**Status: draft format `devenv.gizmoth.dev/v1alpha1`.** Bazelisk, Python, Debian Bookworm minimal guest formulae and the GizOS base host-tools environment have published metadata. Every chip, SDK and target compiler remains `planned`. A published entry means its metadata validates; native installation and firmware builds need qualification in GizMoth.

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
scripts/export-snapshot.mjs                  # Seed a validated local development snapshot
test/                                        # Registry and removal-rule tests
```

Current entries:

| Kind | Entries |
| --- | --- |
| Environments | `gizos`: Bazelisk 1.30.0 and Python 3.12.16 (published) |
| Chips | `esp32s3`, `bk7258`, `ac707n` (planned) |
| SDKs | `esp-idf`, `beken-bk7258`, `jieli-ac707n` (planned) |
| Toolchains | `bazelisk` 1.30.0 (default), 1.29.0; `python` 3.12.16 (default), 3.11.18; Linux guest formulae 12.0.0 (published); `arm-gnu`, `xtensa-esp-elf`, `jieli` (planned) |

Both published tools cover macOS, Linux and Windows on x86_64/arm64. Bazelisk installs the launcher as both `bazelisk` and `bazel`; each project's `.bazelversion` selects Bazel, which Bazelisk downloads on first use. Python uses CPython `install_only_stripped` archives from `astral-sh/python-build-standalone` release `20261110`, with GitHub asset SHA-256 digests and byte sizes. Python recipes only unpack the archive and check its executable file; no installation commands run.

GizOS provides base host tools. It does not include a vendor SDK or target compiler and does not by itself constitute a complete firmware build environment. Exact toolchain versions coexist, including within one dependency graph. Process activation explicitly selects installed versions and never replaces the user's global `PATH`.

## Minimal Linux guest formulae

This repository registers upstream files and installation metadata only. GizMoth downloads, verifies and manages those files; the registry has no package-producing CI, bundled runtime, installer or system disk. Linux root recipes are inputs to GizMoth's read-only guest image. Normal Python/Bazelisk packages keep their isolated, versioned installation paths.

The initial root-bundle release is `12.0.0`; each source URL carries its exact Debian package version. These sources come from Debian Bookworm `main`, release 12.15 dated 2026-07-11. The ARM64 and amd64 `Packages.xz` files were checked against the SHA-256 values in the official `https://deb.debian.org/debian/dists/bookworm/Release`: `2ddb1737692e8c45c53e8d57c0ce4cd21c78c5703b830c3226b1423566a06c00` and `9e0b5aabb2465b3d2e7a7fe27f9913846277833f7a2826e7767acccff5b588c5`, respectively. All 280 unique source files were downloaded, their sizes and SHA-256 digests verified, and their data-tar file inventories inspected without executing payloads or maintainer scripts. Mirrors may be used to retrieve identical bytes during maintenance; published URLs remain canonical `https://deb.debian.org/debian/` URLs.

| Formula at 12.0.0 | ARM64 raw download bytes | x86_64 raw download bytes | Contents |
| --- | ---: | ---: | --- |
| `linux-runtime` | 17,454,432 | 18,592,628 | 39 sources: Bash/Dash, basic utilities, glibc/loader, certs, erofs-utils and e2fsprogs with runtime dependencies |
| `linux-network-libs` | 5,495,184 | 5,810,420 | Shared Git/CMake library closure; depends on runtime |
| `linux-git` | 18,255,228 | 18,710,928 | Git/Perl helpers; depends on runtime and network libraries |
| `linux-build-tools` | 79,671,840 | 89,422,984 | Native GCC/G++, Make, CMake, Ninja, pkg-config, ccache, patch, file and unzip; depends on runtime and network libraries |
| `linux-qemu-user` | 56,490,396 | — | Complete upstream static QEMU package; ARM64 `qemu-x86_64-static` interpreter |
| `linux-x86-runtime` and its library layers | 7,990,952 | — | amd64 glibc and exact binutils runtime closure under `/opt/gizmoth/x86_64` on an ARM64 host |
| `linux-x86-binutils` | 2,245,848 | — | Real amd64 GNU binutils executables for translation qualification; no PATH entries |

The table gives each bundle's own source bytes, excluding dependency downloads, except for the explicitly combined x86 runtime/library row. The runtime pins glibc `2.36-9+deb12u14`, Bash `5.2.15-2+b13`, Dash `0.5.12-2`, erofs-utils `1.5-1` and e2fsprogs `1.47.0-2+b2`. Build tools include GCC `12.2.0-14+deb12u1`, Make `4.3-4.1`, CMake `3.25.1-1`, Ninja `1.11.1-2~deb12u1`, pkgconf `1.8.1-1`, ccache `4.8+really4.7.5-1` and binutils `2.40-2`. Git is `2.39.5-0+deb12u3`; static QEMU is `7.2+dfsg-7+deb12u18+b3`. Debian epoch prefixes are retained by the upstream metadata where applicable; they do not appear in `.deb` filenames.

Payload file checks use `/bin/bash`, `/bin/dash`, `/sbin/mke2fs` and `/usr/bin/mkfs.erofs`. GizMoth creates `/bin/sh` and other required aliases, account files and the concatenated certificate bundle. No apt/dpkg runtime is installed. The QEMU package retains all upstream static interpreters because the registry does not repackage inputs or define extraction filters.

To test unmerged metadata locally, stop GizMoth and seed its saved catalog from this working tree:

```bash
node scripts/export-snapshot.mjs '/absolute/app-data/compile/registry'
```

The script validates first and writes `<content-derived-development-id>.json` plus `current.json` using GizMoth's saved-snapshot format. The development identity is not an upstream Git commit. It leaves the production repository and `main` branch unchanged; a normal refresh replaces the seed. Tests can export to a temporary directory instead of application data.

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
