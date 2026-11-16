# GizMoth Development Environments

GizMoth's own Git registry for its **Development Environments** page. Users install a **chip**, a generic **environment**, or an exact **toolchain** version. GizMoth resolves and maintains the SDKs and tools behind them. Existing toolchains can also be registered from a local path.

GizMoth clones and synchronizes this Git registry, pins one revision, and reads its JSON download formulae. The application then downloads dependencies from the upstream Git repositories or file URLs named in those formulae, verifies their pinned identities, and manages installation and activation locally. Application releases contain GizMoth and its minimal Linux boot environment. This registry contains download configuration, not SDK payloads, LFS objects or repackaged releases; it requires no Homebrew, GizOS `gizos` CLI or Bun.

**Status: draft format `devenv.gizmoth.dev/v1alpha1`.** Metadata includes Bazelisk, Python, Debian Bookworm guest layers, native Arm/ESP compilers, explicit x86 compatibility for JieLi tools, and seven pinned ESP/Beken/JieLi SDKs. SDK sources refer directly to exact public Git commits; Python inputs refer to original upstream wheels, source distributions and constraint files. The schema's `published` status describes a complete recipe, not successful installation. GizMoth has verified direct-upstream acquisition and offline installation of six SDKs in an isolated Linux ARM64 guest. Firmware/package qualification remains separate, and the additional native x86_64 BK7259 candidate is unqualified.

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
| Chip candidates | `esp32s3`, `esp32p4`, `esp32s31`, `esp32c5`, `bk7258`, `ac695n`, `ac707n`, `ac791n`, `bk7259` (native Linux x86_64 only) |
| SDK candidates | `esp-idf` 6.2.0-dev.gddb3852; `beken-bk7258` 3.1.1+g6bbf6274; `beken-bk-idk` 2.0.1+g650e754e; `beken-bk7259` 4.0.1+g06cb0f2d; `jieli-ac707n` 2.0.0+gd0167685; `jieli-ac695n` 0.1.0+g76b95777; `jieli-ac791n` 0.1.0+geb04f196 |
| Toolchains | `bazelisk` 1.30.0 (default), 1.29.0; `python` 3.12.16 (default), 3.11.18; Linux guest formulae 12.0.0; `arm-gnu` 10.3.1 (default), 14.3.1; `xtensa-esp-elf` and `riscv32-esp-elf` 16.1.0+20260609; `esp32ulp-elf` 2.38.0+20240113; `jieli` 4.0.1+20250805.1; `jieli-postbuild` 2026.7.28+1; `git-lfs` 3.8.1; `ninja` 1.13.2; `esp-rom-elfs` 2026.5.28 (upstream 20260528) |

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
| `linux-esp-debug-libs` | 172,780 | — | Native libatomic, libusb-1.0 and libudev for ESP GDB and OpenOCD; depends on runtime |

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

SDK release JSON names the original public GizClaw Git repository, full commit and recursive submodule policy through a `git` source and `checkout` operation. GizMoth fetches all pinned Git links and detects, downloads and verifies LFS objects on the host. Its guest checkout materializes those verified inputs offline and retains `.git` plus the verified local LFS objects. All seven SDK candidates depend on managed Git LFS 3.8.1 so the guest installer can configure the clean filter, including AC695N/AC791N and LFS files in nested repositories. Recipes perform no Git LFS network fetching. Health checks reject tracked/untracked changes and uninitialized or mismatched recursive submodules. SDK source files, Git object history, LFS objects and generated source archives do not belong in this registry or in additional SDK distribution releases.

Python input records name the original PyPI wheel or source-distribution URL, SHA-256 and size. ESP's constraints file comes directly from Espressif with a pinned digest. Recipe commands generate lock files locally from these JSON records, create Python environments outside the SDK Git tree, and install with `--no-index --no-deps --require-hashes`. The esptool source distribution uses pinned upstream build dependencies with build isolation disabled; no locally built wheel is uploaded for distribution.

The ESP candidate covers `esp32s3`, `esp32p4`, `esp32s31` and `esp32c5`, with compiler 16.1.0+20260609, Ninja 1.13.2 and an IDF 6.2 venv under `tools/python_env/idf6.2_py3.12_env` including its `idf_version.txt` marker. Beken candidates select managed Python 3.11.18 and check `distutils`; their locks match GizOS's native `cffi` 2.1.1, `click` 8.4.2, `click-option-group` 0.5.9, `cryptography` 50.0.0, `pycparser` 3.0 and `pycryptodome` 3.23.0 requirements. ESP/BK7258/BK IDK currently support the Linux ARM64 guest; JieLi also has Linux x86_64 recipes. BK7259 currently supports native Linux x86_64 only.

The ESP ARM64 candidate includes every `install: always` tool from `tools/tools.json` at exact commit `ddb3852ab5c7f9e6dbc268203ef9d612de391bf8` (metadata SHA-256 `3bb10e1936110efae9b17baad59143483d635be303535f9850d66d16a94d7a69`). In addition to the compilers and ROM data, it selects `xtensa-esp-elf-gdb` and `riscv32-esp-elf-gdb` 17.1.0+20260402 (upstream `17.1_20260402`), `openocd-esp32` 0.12.0-esp32-20260831 (upstream `v0.12.0-esp32-20260831`), `esp-clangd` 21.1.3+20260408 (upstream `esp-21.1.3_20260408`) and `esp-idf-configdep` 0.2.3. All five original upstream archives were downloaded into separate empty temporary directories, byte-verified against this metadata, and inspected for layout, executable modes and ELF requirements without execution. The SDK links their stripped installation roots into the exact upstream version and export-path layout and exports `OPENOCD_SCRIPTS`. File checks and `idf_tools.py --non-interactive check` gate readiness before the SDK installation record is written. Offline regression tests exercise those links using empty local fixtures; registry validation never invokes the qualification commands.

`linux-esp-debug-libs` 12.0.0 adds original Bookworm ARM64 `libatomic1` 12.2.0-14+deb12u1, `libusb-1.0-0` 2:1.0.26-1 and `libudev1` 252.39-1~deb12u2. These three downloads were verified against the official Release/Packages index and their ELF dependencies inspected. OpenOCD needs libusb and libudev even for its version probe, plus the existing network layer's zlib. Clangd uses the existing native C++ runtime. GDB's upstream version probe uses `*-gdb-no-python`; Python debugging qualification additionally uses each shipped launcher with managed Python 3.12.16 and libatomic. The Xtensa archive supplies target launchers such as `xtensa-esp32s3-elf-gdb`, with no generic `xtensa-esp-elf-gdb` launcher. Other bundled Python ABI variants, USB forwarding and hardware debugging remain unqualified. Existing optional CMake 3.25.1 and Ninja 1.13.2 are retained; the upstream ARM64 recommendations for those `on_request` tools are 4.0.3 and 1.12.1. Isolated GizMoth integration has now executed these tools successfully as the build user with installed programs mounted read-only, including both GDB launchers with Python 3.12 and the complete upstream ESP-IDF tool check. All-toolchain qualification passed in 115.55 seconds; the subsequent direct-upstream six-SDK installation passed in 875.83 seconds and published 46 SDK/tool/runtime packages. Configdep reports its version on stderr, so its check captures that stream while retaining nonzero exit failures. These are application integration results, separate from offline registry validation and firmware qualification.

BK7259 SDK 4.0.1 pins `06cb0f2d9cdeab571ec5be2d54398c67e097a4cc` and exact GNU Arm 14.3.rel1/compiler 14.3.1. Both original compiler archives were downloaded into separate empty temporary directories and byte-verified: aarch64 is 148,423,580 bytes, SHA-256 `2d465847eb1d05f876270494f51034de9ace9abe87a4222d079f3360240184d3`; x86_64 is 149,789,432 bytes, SHA-256 `8f6903f8ceb084d9227b9ef991490413014d991874a1e34074443c2a72b14dbd`. ELF dependency inspection includes the existing `linux-network-libs` closure for `libzstd.so.1`; recipe checks cover the AP Cortex-M55 hard-float and CP Cortex-M52 soft-float toolchain flags. Arm 10.3.1 remains unchanged and is still the default. No compiler binary was executed during this registry audit.

BK7259's native Linux x86_64 recipe locks 15 original, byte-verified PyPI wheels. An independent source audit of its firmware tools, vendored `bk_py_libs` and Python OTA packager confirmed the Beken base requirements; hdrgen additionally needs `openpyxl` 3.1.5 and `et_xmlfile` 2.0.0. The recipe selects `COMPILER_TOOLCHAIN_PATH`, includes the vendored Python module path and disables the optional online component manager. Documentation generation and the broken legacy `convert_to_cmake.py` utility are outside this firmware-tool recipe. Legacy secure-boot/compression commands reference upstream `tools/packager_tools` and security executables absent at this commit; those commands are not qualified by this candidate.

ARM64 BK7259 SDK support remains planned. The SDK's `beken_utils/scripts/libcommon.so` is x86_64; `encrypt.func_enc()`, `generator.func_enc()` and `xts_aes.func_enc()` use `ctypes.CDLL('./scripts/libcommon.so')` and call its `encrypt`/`xts_aes` APIs. A native ARM64 Python cannot load that foreign library. Supporting the complete AES/XTS surface needs an exact x86 Python and wheel environment running through QEMU, plus GizOS Python locator integration; QEMU executable support alone does not change native Python's `dlopen`. Default prebuild runs `beken_utils/main.py gen all` and only imports these classes: `gen_code()` generates PPC/MPC/security/OTA/OTP headers without calling `func_enc()`. Default OTA packaging uses `rtt_ota/ota-rbl/ota_packager_python.py` with PyCryptodome and a separate pure-Python XTS implementation. The existing BK7258/BK IDK candidates contain the same x86 ctypes library and were left unchanged for separate integration qualification.

JieLi keeps its exact compiler/post-build releases; Qt runtime additions await evidence from the real guest checkout and firmware builds rather than an inferred library closure.

Direct-upstream Git, recursive submodules and actual LFS data have been acquired, independently rehashed, restored offline and qualified for ESP-IDF, BK7258 SMP, BK IDK, AC695N, AC707N and AC791N through GizMoth. The AC695N upstream soundbox example also linked an ELF in the Linux worker; its ELF/map/header were collected and independently rehashed. This does not qualify a GizOS H2Loader package, BK7259, Beken native AES/XTS, USB debugging or physical hardware. Earlier locally repacked-source tests are excluded from these results. Keep the SDK change unmerged until representative firmware/package builds are verified. The registry supplies configuration only; downloading, building, caching and cleanup remain application responsibilities.

See [the format](docs/format.md), [the lifecycle](docs/lifecycle.md) and [the integration contract](docs/gizmoth-integration.md).

## License

This repository's original code and documentation use the [MIT license](LICENSE). Entries name upstream licenses. CPython and its bundled libraries retain the licenses shipped in their distributions, including the Python Software Foundation license; the registry license does not relicense downloaded software.
