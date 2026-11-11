# Registry format

Draft format `devenv.gizmoth.dev/v1alpha1`. The machine-readable source of truth is [devenv.schema.json](../schemas/devenv.schema.json); semantic checks are in [validate.mjs](../scripts/validate.mjs). GizMoth must reject unsupported API versions, fields and operation types before doing any work.

## Distribution

This repository is the registry. GizMoth resolves the configured branch, initially `main` of `https://github.com/GizClaw/gizmoth-devenv`, to a full commit and reads every file from that one commit. It validates the snapshot before use, keeps the last valid snapshot when a refresh fails, and caches it for offline use. Never combine an index from one commit with files fetched from a moving branch.

A refresh changes metadata only: it never runs recipe commands or upgrades installed environments. A fork or mirror can replace the default repository URL; GizMoth uses one registry at a time.

## Entries

| File | Appears in GizMoth | Purpose |
| --- | --- | --- |
| `chips/<id>/chip.json` | Chips page card | What the user installs: one chip, its SDK and target, and build tools |
| `sdks/<id>/sdk.json` | Chip details only | A vendor SDK and its versions, shared by every chip that names it |
| `toolchains/<id>/toolchain.json` | Toolchains table | Compilers, build tools, post-build and debug tools, with their versions |

`registry.json` lists every chip, SDK and toolchain ID. Unindexed directories and release files are invalid. IDs are lowercase words separated by hyphens.

### Chips

A chip names its vendor, description, homepage, `sdk`, SDK `target` and the build `tools` it always needs, for example `bazelisk`. One SDK can serve several chips: ESP-IDF serves `esp32s3` with target `esp32s3` and could serve `esp32c3` with target `esp32c3`.

- `planned`: the card shows that a recipe is pending and has no install action.
- `published`: its SDK must be published, and the SDK's default release must support the chip's target on at least one host where all its tools are also available. Those hosts are the card's supported hosts.

Installing a chip uses the SDK's default version unless the user selects another release that supports the target. Tools use each toolchain's default version at installation time. GizMoth records the exact installed versions locally; a later registry refresh does not change them.

### SDKs and toolchains

Both have a name, description, homepage, upstream license, status and an index of releases. Toolchains also have a category: `compiler`, `build-tool`, `post-build`, `debugger` or `utility`.

- `planned`: no releases and no default version.
- `published`: at least one release and a `defaultVersion` that is one of them.

Versions are exact three-part versions with optional prerelease or build identifiers, such as `6.2.0` or `3.1.1-r6bbf627`. Vendor labels can appear in descriptive text. Releases cannot use `latest`, version ranges or Git branch names.

Each release is `versions/<version>.json` and is immutable after publication. Any change to inputs, steps or behavior needs a new version. GizMoth records each release's digest and rejects an unexpected change to a version it has seen before.

## Releases

A release lists its supported host platforms: `macos-arm64`, `macos-x86_64`, `linux-arm64`, `linux-x86_64`, `windows-arm64` and `windows-x86_64`. A missing platform is unsupported. A binary for another host is not a working local environment; translation layers such as Rosetta need an explicit prerequisite check.

Each platform recipe contains:

| Field | Meaning |
| --- | --- |
| `requires` | Host executables checked before any change; never installed globally |
| `dependencies` | Exact toolchain versions, resolved on the same host |
| `targets` | SDK releases only: each supported chip target and its additional toolchains |
| `sources` | Named immutable downloads or Git checkouts |
| `install` | Ordered installation operations |
| `environment` | Relative executable paths and process-local variables |
| `checks` | File or command checks before publication and for explicit health checks |

An SDK installation is shared by all its chips. Its install steps and checks can reference only the common `dependencies`; `targets` adds chip-specific toolchains, for example the Xtensa compiler for `esp32s3`. Toolchain releases cannot declare targets.

### Dependencies

Only toolchains are dependencies, and every dependency names an exact version. Within one chip environment, consisting of the SDK's common dependencies, its target dependencies and the chip's tools, there can be only one version of each toolchain and no cycles. Different chips can use different versions side by side.

### Sources

File sources use HTTPS, an exact SHA-256 digest and the expected byte size. Git sources use HTTPS, a full commit ID and an explicit submodule setting. URLs cannot contain credentials or fragments. At runtime, GizMoth verifies the checkout and submodule commits; submodules must also use HTTPS with fixed commits. Sources that need Git LFS or authentication need an explicit, verified implementation before a recipe can use them.

### Installation operations

| Operation | Behavior |
| --- | --- |
| `copy` | Copy one verified file to a relative installation path, with the declared executable permission |
| `extract` | Unpack a verified archive into a relative directory with an explicit format and component stripping |
| `checkout` | Materialize a pinned Git source inside a relative directory |
| `run` | Run a program with an argument array, relative working directory, declared variables and a timeout |

Destinations are relative to the installation directory. Archives must reject absolute paths, path traversal, device files, links that leave the installation and path or case collisions. GizMoth checks real paths at runtime because static validation cannot prove containment.

A program is a host executable listed in `requires`, or a path below `${prefix}`, `${work}` or a declared `${toolchain:<id>}`. Arguments go directly to the operating system without shell interpretation. A recipe that needs Bash declares it and runs the vendor script explicitly. Commands must exit with status zero; command checks may also require literal `stdoutContains` text.

Installer commands are trusted code that runs with the user's permissions. Keeping writes inside the installation is the recipe's responsibility, not an operating-system sandbox. Recipes must keep vendor tools and Python environments inside the installation and must not change shell profiles, global package stores or system installations. Releases contain no uninstall scripts: removal is GizMoth's job, based on its local records.

### Environment

Substitutions are `${prefix}` (the final installation directory), `${cache}` (this toolchain's or SDK's cache directory), `${work}` (temporary job space) and `${toolchain:<id>}` (a declared dependency's installation directory). They are string substitutions, not shell expressions.

`prependPath` entries are relative to the installation. `variables` are process-local strings and cannot set `PATH`; GizMoth builds `PATH` from the chip's whole environment. Exported values and checks cannot use `${work}`. Install steps run in the final installation directory, so tools that embed absolute paths stay valid.

File checks require a regular file inside the installation and, on Unix, its executable bit when requested. Command checks have a short timeout and cannot prove hardware compatibility. Bazelisk uses file checks because running it can download Bazel.

## Local records

`Installation` and `InstalledChip` documents describe GizMoth's local state. They are defined in the same schema so the format and removal rules can be tested together, but they never come from the registry. See [lifecycle.md](lifecycle.md).
