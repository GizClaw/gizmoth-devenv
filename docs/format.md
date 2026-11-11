# Registry format

Draft format `devenv.gizmoth.dev/v1alpha1`. The machine-readable source of truth is [devenv.schema.json](../schemas/devenv.schema.json); semantic checks are in [validate.mjs](../scripts/validate.mjs). GizMoth must reject unsupported API versions, fields and operation types before doing any work.

## Distribution

This repository is the registry. GizMoth resolves the configured branch, initially `main` of `https://github.com/GizClaw/gizmoth-devenv`, to a full commit and reads every file from that one commit. It validates the snapshot before use, keeps the last valid snapshot when a refresh fails, and caches it for offline use. Never combine an index from one commit with files fetched from a moving branch.

A refresh changes metadata only: it never runs recipe commands or upgrades installed environments. A fork or mirror can replace the default repository URL; GizMoth uses one registry at a time.

## Entries

| File | Appears in GizMoth | Purpose |
| --- | --- | --- |
| `chips/<id>/chip.json` | Chip card | One chip, its SDK and target, and build tools |
| `environments/<id>/environment.json` | Generic environment card | Named collection of exact toolchain versions, without a chip or SDK |
| `sdks/<id>/sdk.json` | Chip details only | A vendor SDK and its versions, shared by every chip that names it |
| `toolchains/<id>/toolchain.json` | Toolchains table | Compilers, build tools, post-build and debug tools, with their versions |

`registry.json` lists every chip, SDK and toolchain ID. Its optional `environments` array indexes generic environments; older indexes without this field remain valid under the same API version. Unindexed directories and release files are invalid, including environment directories. IDs are lowercase words separated by hyphens.

### Generic environments

An `Environment` document contains `apiVersion`, `kind: "Environment"`, `id`, `name`, `description`, `homepage`, `status`, optional `notes` and `dependencies: [{toolchain, version}]`. There is no profile version, default version, release index or installation recipe at this level. Every dependency names an indexed, published toolchain release at an exact version.

- `planned`: may have an empty dependency list and has no install action. Any listed dependencies must still resolve exactly.
- `published`: has at least one dependency and at least one host supported by every dependency. Its supported hosts are the intersection of the exact releases' hosts, including their transitive dependencies.

GizOS is a published generic environment with `bazelisk` 1.30.0 and `python` 3.12.16. These are base host tools; a project still needs its vendor SDK, target compiler and any other prerequisites for firmware builds. Installing this environment does not run a GizOS CLI.

Changing an environment's dependency list affects future installation plans only. Existing installations retain the exact installation UUIDs in their local `InstalledEnvironment` record until an explicit install or update switches that record.

### Chips

A chip names its vendor, description, homepage, `sdk`, SDK `target` and the build `tools` it always needs, for example `bazelisk`. One SDK can serve several chips: ESP-IDF serves `esp32s3` with target `esp32s3` and could serve `esp32c3` with target `esp32c3`.

- `planned`: the card shows that a recipe is pending and has no install action.
- `published`: its SDK must be published, and the SDK's default release must support the chip's target on at least one host where all its tools are also available. Those hosts are the card's supported hosts.

Installing a chip uses the SDK's default version unless the user selects another release that supports the target. Tools use each toolchain's default version at installation time. GizMoth records the exact installed versions locally; a later registry refresh does not change them.

### SDKs and toolchains

Both have a name, description, homepage, upstream license, status and an index of releases. Toolchains also have a category: `compiler`, `build-tool`, `post-build`, `debugger`, `utility` or `runtime` (such as Python).

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

Only toolchains are dependencies, and every dependency names an exact version. Graph identity is the pair `toolchain ID + version`. Multiple versions of one toolchain may coexist within a chip, generic environment or toolchain graph. Reject dependency cycles and duplicate exact pairs within a declared dependency list or the combined SDK common/target list. Reaching the same pair through separate graph edges is valid and reuses one resolved node.

Resolution and installation do not activate all installed versions at once. A process explicitly selects the installed tool versions it uses; installing a second Python or Bazelisk version never replaces global `PATH`.

### Sources

File sources use HTTPS, an exact SHA-256 digest and the expected byte size. Git sources use HTTPS, a full commit ID and an explicit submodule setting. URLs cannot contain credentials or fragments. At runtime, GizMoth verifies the checkout and submodule commits; submodules must also use HTTPS with fixed commits. Sources that need Git LFS or authentication need an explicit, verified implementation before a recipe can use them.

Python 3.11.18 and 3.12.16 use the `astral-sh/python-build-standalone` release `20261110` and six exact `cpython-<version>+20261110-<triple>-install_only_stripped.tar.gz` assets. `scripts/update-python.mjs <exact-version> <exact-release>` verifies GitHub release identity and each exact asset's download URL, SHA-256 digest and size. Published manifests contain these fixed values and never resolve a moving release. Each recipe extracts to `python` with `stripComponents: 1`, prepends `python/bin` on Unix or `python` on Windows, and performs a file check for `python/bin/python3` or `python/python.exe`. Unix checks require the executable bit. There are no `run` steps. Distribution licenses and third-party notices remain part of the unpacked software.

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

The legacy `${toolchain:<id>}` syntax does not select a version when several are installed. This format change adds no execution support for that syntax. Clients must reject unsupported or ambiguous substitutions before installation and explicitly choose the installations used for process activation.

`prependPath` entries are relative to the installation. `variables` are process-local strings and cannot set `PATH`; GizMoth builds a process's `PATH` from its explicitly selected installations. Exported values and checks cannot use `${work}`. Install steps run in the final installation directory, so tools that embed absolute paths stay valid.

File checks require a regular file inside the installation and, on Unix, its executable bit when requested. Command checks have a short timeout and cannot prove hardware compatibility. Bazelisk uses file checks because running it can download Bazel.

## Local records

`Installation`, `InstalledChip` and `InstalledEnvironment` documents describe GizMoth's local state. They are defined in the same schema so the format and removal rules can be tested together, but they never come from the registry.

An `InstalledEnvironment` has `apiVersion`, `kind: "InstalledEnvironment"`, `environment` (the environment ID), `toolchains` (unique installation UUIDs) and `installedAt`. Its optional `metadata` object stores `name`, `description`, `homepage` and optional `notes` (string or null), preserving display information offline even if the registry entry disappears. It has no environment version or release digest: the referenced installation records pin each actual tool version. It is a retention root alongside installed chips and user-requested tools. See [lifecycle.md](lifecycle.md).
