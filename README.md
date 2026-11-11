# GizMoth Development Environments

The official GitHub tap for GizMoth's development-environment packages: SDKs, toolchains and build tools. Each formula describes a package; immutable release manifests describe its exact inputs, host support, dependencies, installation steps and exported environment.

GizMoth will read this catalog and execute recipes through its native backend. This protocol has no dependency on the GizOS `gizos` CLI, Bun, or a globally installed package manager. Node.js is used only for maintaining and validating this repository.

**Status: protocol and catalog bootstrap, `gizmoth.dev/v1alpha1`. GizMoth does not yet implement this package protocol or the Development Environments page.** A `recipe` entry has concrete, validated metadata; it does not claim that a native installation has passed. `planned` entries have no install action.

## Repository layout

```text
tap.json                          # Tap identity and formula index
schemas/devenv.schema.json         # Tap, Formula, Release and Receipt schemas
formulae/
  bazelisk/
    formula.json                  # Display metadata, default and version index
    versions/1.30.0.json           # Immutable, platform-specific recipe
  esp-idf/formula.json             # Planned SDK
  beken-bk7258/formula.json         # Planned SDK
  jieli-ac707n/formula.json         # Planned SDK
  arm-gnu/formula.json             # Planned shared compiler
  jieli-toolchain/formula.json     # Planned shared compiler/post-build tools
docs/
  format.md                       # Package identity and recipe semantics
  lifecycle.md                    # Local layout, install, update, remove and prune
  gizmoth-integration.md           # Intended UI and native integration boundary
scripts/
  validate.mjs                    # Offline schema, reference and dependency checks
  update-bazelisk.mjs              # Pin a published upstream Bazelisk release
test/catalog.test.mjs              # Invalid catalog and deletion-boundary tests
```

The first concrete recipe is **Bazelisk 1.30.0**, for macOS, Linux and Windows on x86_64/arm64. The release uses exact upstream asset URLs, sizes and SHA-256 digests, cross-checked against upstream checksum files. It installs the launcher as both `bazelisk` and `bazel`. Bazel itself is selected by the consuming project's `.bazelversion` and downloaded by Bazelisk on first use. This is not a preinstalled or prequalified Bazel SDK.

ESP-IDF, Beken, JieLi and compiler entries remain planned until their pinned inputs, host restrictions, prerequisites and native checks are implemented and qualified. Do not treat the catalog as evidence of host or board support.

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

Validation is offline and does not run vendor installers or downloaded binaries. It checks schemas, catalog coverage, normalized paths, source identities, exact dependencies, host compatibility, cycles, version conflicts and receipt ownership boundaries. Native installation, cancellation and deletion need integration tests in GizMoth once its engine exists.

To validate multiple taps and their cross-tap dependencies together:

```bash
node scripts/validate.mjs /path/to/official-tap /path/to/another-tap
```

## Maintain packages

Add a formula directory and index it in `tap.json`. Keep it `planned` until its first complete release is ready. A release must contain exact versions, immutable source pins and explicit platform recipes. Add a new version for any published recipe change; do not rewrite a published version, including a checksum or installation step.

The Bazelisk updater requires the GitHub CLI. Supply an explicit stable upstream version:

```bash
node scripts/update-bazelisk.mjs 1.30.0
```

It verifies GitHub asset digests against the upstream `.sha256` files, refuses to overwrite a different existing manifest, and updates the formula index. It does not execute the assets or qualify the recipe. Run validation and tests before publishing.

See [the format](docs/format.md), [the lifecycle](docs/lifecycle.md) and [the integration contract](docs/gizmoth-integration.md).

## License

This repository's original code and documentation use the [MIT license](LICENSE). Package metadata names upstream licenses. Downloaded software retains its own license and distribution terms; this repository does not relicense it.
