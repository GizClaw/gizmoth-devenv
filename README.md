# GizMoth Development Environments

GizMoth's own Git registry for its **Development Environments** page. Users install a **chip**, a generic **environment**, or an exact **toolchain** version. GizMoth resolves and maintains the SDKs and tools behind them. Existing toolchains can also be registered from a local path.

GizMoth clones and synchronizes this Git registry, pins one revision, and reads its JSON download formulae. The application then downloads dependencies from the upstream Git repositories or file URLs named in those formulae, verifies their pinned identities, and manages installation and activation locally. Application releases contain GizMoth and its minimal Linux boot environment. This registry contains download configuration, not SDK payloads, LFS objects or repackaged releases; it requires no Homebrew, GizOS `gizos` CLI or Bun.

**Status: draft format `devenv.gizmoth.dev/v1alpha1`.** Metadata includes Bazelisk, Python, Debian Bookworm guest layers, native Arm/ESP compilers, explicit x86 compatibility for JieLi tools, and six pinned ESP/Beken/JieLi SDKs. SDK sources refer directly to exact public Git commits; Python inputs refer to original upstream wheels, source distributions and constraint files. The schema's `published` status describes a complete recipe, not successful installation. The SDK changes remain a draft until GizMoth implements and verifies their Git/submodule/LFS download and checkout requirements.

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
scripts/export-snapshot.mjs                  # Export a validated local development snapshot
test/                                        # Registry, SDK policy and removal-rule tests
```

Current entries:

| Kind | Entries |
| --- | --- |
| Environments | `gizos`: Bazelisk 1.30.0 and Python 3.12.16 (published) |
| Chips | `esp32s3`, `bk7258`, `ac707n` (planned) |
| SDK candidates | `esp-idf` 6.2.0-dev.gddb3852; `beken-bk7258` 3.1.1+g6bbf6274; `beken-bk-idk` 2.0.1+g650e754e; `jieli-ac707n` 2.0.0+gd0167685; `jieli-ac695n` 0.1.0+g76b95777; `jieli-ac791n` 0.1.0+geb04f196 |
| Toolchains | `bazelisk` 1.30.0 (default), 1.29.0; `python` 3.12.16 (default), 3.11.18; Linux guest formulae 12.0.0; `arm-gnu` 10.3.1; `xtensa-esp-elf` and `riscv32-esp-elf` 16.1.0+20260609; `esp32ulp-elf` 2.38.0+20240113; `jieli` 4.0.1+20250805.1; `jieli-postbuild` 2026.7.28+1; `git-lfs` 3.8.1; `ninja` 1.13.2; `esp-rom-elfs` 2026.5.28 (upstream 20260528) |

Bazelisk and Python cover macOS, Linux and Windows on x86_64/arm64. Bazelisk installs the launcher as both `bazelisk` and `bazel`; each project's `.bazelversion` selects Bazel, which Bazelisk downloads on first use. Python uses CPython `install_only_stripped` archives from `astral-sh/python-build-standalone` release `20261110`, with GitHub asset SHA-256 digests and byte sizes. Python recipes only unpack the archive and check its executable file; no installation commands run.

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
| `linux-cxx-runtime` | 556,608 | 612,604 | Native libstdc++ closure for vendor compilers; depends on runtime |
| `linux-locale` | 534,528 | 609,144 | Matching glibc `libc-bin` with compiled `C.utf8` data; verifies `locale charmap` returns UTF-8 |
| `linux-text-tools` | 112,492 | 119,144 | Native mawk for JieLi pre-build rules; verifies the managed `awk` alias with an actual array/loop program |

The table gives each bundle's own source bytes, excluding dependency downloads, except for the explicitly combined x86 runtime/library row. The runtime pins glibc `2.36-9+deb12u14`, Bash `5.2.15-2+b13`, Dash `0.5.12-2`, erofs-utils `1.5-1` and e2fsprogs `1.47.0-2+b2`. Build tools include GCC `12.2.0-14+deb12u1`, Make `4.3-4.1`, CMake `3.25.1-1`, Ninja `1.11.1-2~deb12u1`, pkgconf `1.8.1-1`, ccache `4.8+really4.7.5-1` and binutils `2.40-2`. Git is `2.39.5-0+deb12u3`; static QEMU is `7.2+dfsg-7+deb12u18+b3`. Debian epoch prefixes are retained by the upstream metadata where applicable; they do not appear in `.deb` filenames.

Payload file checks use `/bin/bash`, `/bin/dash`, `/sbin/mke2fs` and `/usr/bin/mkfs.erofs`. GizMoth creates `/bin/sh` and other required aliases, account files and the concatenated certificate bundle. No apt/dpkg runtime is installed. The QEMU package retains all upstream static interpreters because the registry does not repackage inputs or define extraction filters.

To test unmerged metadata, export this working tree to a temporary directory or the data directory of an isolated test instance:

```bash
node scripts/export-snapshot.mjs '/absolute/isolated-test-data/compile/registry'
```

The script validates first and writes `<content-derived-development-id>.json` plus `current.json` using GizMoth's saved-snapshot format. The development identity is not an upstream Git commit. It leaves the production repository and `main` branch unchanged; a normal refresh replaces the seed. Keep candidate catalogs out of the user's normal application data.

## Validate

Use Node.js 22.19 or later. Fixture tests also use local Git, POSIX `awk` and Python 3; they do not execute downloaded payloads. Install development dependencies when needed:

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

### SDK source and Python download formulae

SDK release JSON names the original public GizClaw Git repository, full commit and submodule policy through a `git` source and `checkout` operation. GizMoth owns fetching those repositories and resolving their pinned submodules. AC791 also declares Git LFS as an installation prerequisite. SDK source files, Git object history, LFS objects and generated source archives do not belong in this registry or in additional SDK distribution releases.

Python input records name the original PyPI wheel or source-distribution URL, SHA-256 and size. ESP's constraints file comes directly from Espressif with a pinned digest. Recipe commands generate lock files locally from these JSON records, create Python environments outside the SDK Git tree, and install with `--no-index --no-deps --require-hashes`. The esptool source distribution uses pinned upstream build dependencies with build isolation disabled; no locally built wheel is uploaded for distribution.

GizMoth must implement and verify the declared Git, submodule and Git LFS operations before advertising these SDK recipes as usable. Earlier tests using locally repacked source inputs do not qualify the direct-upstream installation route. Keep the SDK change unmerged until that route and representative firmware builds are verified. The registry supplies configuration only; downloading, building, caching and cleanup remain application responsibilities.

See [the format](docs/format.md), [the lifecycle](docs/lifecycle.md) and [the integration contract](docs/gizmoth-integration.md).

## License

This repository's original code and documentation use the [MIT license](LICENSE). Entries name upstream licenses. CPython and its bundled libraries retain the licenses shipped in their distributions, including the Python Software Foundation license; the registry license does not relicense downloaded software.
