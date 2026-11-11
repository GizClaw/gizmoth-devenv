# Tap and formula format

This is a draft protocol, `gizmoth.dev/v1alpha1`. The machine-readable source of truth is [devenv.schema.json](../schemas/devenv.schema.json); semantic checks are in [validate.mjs](../scripts/validate.mjs). A client must reject unsupported API versions and operation types before doing any work. The GizMoth engine is not implemented yet.

## Identity and discovery

A GitHub repository is one tap. `tap.json` contains its canonical repository URL, a suggested alias, display metadata and an explicit list of `formulae/<id>/formula.json` paths. The initial source is `https://github.com/GizClaw/gizmoth-devenv`, alias `gizclaw`.

The client binds each configured alias to one repository origin. A downloaded tap cannot claim or replace another origin's alias. Source URLs and IDs are compared against that binding; third-party taps need explicit addition by the user. Adding or refreshing a tap never runs recipe commands.

Refresh resolves the selected Git ref, initially `main`, to a full commit. Read all catalog files from that same immutable snapshot. Keep the previous valid snapshot if fetching or validation fails. Never mix an index from one commit with a manifest fetched from a moving branch. Cache snapshots for offline discovery and existing installations.

Package references are `<tap-alias>/<formula-id>`, for example `gizclaw/esp-idf`. Version references are exact normalized three-part versions, optionally with prerelease/build identifiers: `6.2.0`, `3.1.1-r6bbf627`. Vendor version labels can be recorded in descriptive text. No implicit `latest`, version ranges, Git branch names or unpinned dependency resolution is allowed in a release.

## Formula and release

A formula provides its ID, name, description, category, homepage, upstream license and status. Categories are `sdk`, `toolchain`, `build-tool`, `runtime` and `utility`.

- `planned`: no releases or default version; discovery can show it, installation is disabled.
- `recipe`: one or more concrete releases and a default version. Native qualification is reported separately by the client; this status does not imply that testing occurred.

Each release reference points to `versions/<version>.json`. Its ID and version must match the formula and filename. A published release manifest is immutable. Change the package version, using a prerelease/build suffix if necessary, when any input, recipe or behavior changes. A client records a manifest digest and rejects an unexpected mutation of a previously observed version instead of silently replacing it.

A release explicitly lists its supported platform recipes: `macos-arm64`, `macos-x86_64`, `linux-arm64`, `linux-x86_64`, `windows-arm64`, `windows-x86_64`. Missing means unsupported. A binary downloaded for a different host is not an executable local environment. Translation layers such as Rosetta require an explicit prerequisite check before a relevant SDK can be enabled.

## Platform recipes

Each platform owns these fields:

| Field | Meaning |
| --- | --- |
| `requires` | Host executable names resolved and checked before mutation; never installed globally without a separate action |
| `dependencies` | Exact package/version dependencies, resolved on this same host |
| `sources` | Named immutable downloads or Git checkouts |
| `install` | Ordered installation operations |
| `environment` | Relative executable search paths and process-local variable exports |
| `checks` | Required file or command checks before publication and for explicit health checks |

Dependency packages may live in another configured, trusted tap. Validate the graph as a whole: reject missing versions, missing hosts, cycles, duplicate dependencies and conflicting versions within one root environment. Independent environments may use different versions. A client lock records exact dependency installation IDs; a refreshed catalog does not alter an installed environment's graph.

File sources require HTTPS, an exact SHA-256 digest and expected byte size. Git sources require HTTPS, a full commit ID and an explicit submodule setting. Reject credential-bearing URLs and mutable Git ref names. Verify Git checkout/submodule commits and transport policy at runtime; submodules must also use HTTPS and immutable gitlinks. LFS-backed sources need an explicit, verified implementation before shipping a recipe that needs them.

### Installation operations

| Operation | Semantics |
| --- | --- |
| `copy` | Copy one verified file source to a relative prefix path; set the declared executable permission |
| `extract` | Unpack a verified file source into a relative prefix directory with explicit format and component stripping |
| `checkout` | Materialize a pinned Git source inside a relative prefix directory |
| `run` | Execute a program with an argument array, relative working directory, declared variables and a timeout |

`copy`, `extract` and `checkout` destinations are relative to the candidate installation prefix. They never name global installation directories. Archives must reject absolute paths, traversal, special device files, links escaping the prefix and path/case collisions. Check actual resolved paths and filesystem ownership at runtime; lexical validation alone cannot establish containment. Use safe library extraction rather than blindly invoking an archive tool.

For `run` and command checks, a program is either a named executable in `requires`, an absolute `${prefix}/...` path or a declared dependency executable `${dependency:gizclaw/arm-gnu}/...`. Pass the arguments directly to the operating system, without implicit shell interpolation. A recipe that needs Bash must declare it and explicitly invoke its vendor script. Commands must finish with exit status zero; checks may additionally require literal `stdoutContains` text. Each child inherits the composed dependency environment, platform variables and host baseline, plus any per-step variables.

Installer commands are trusted code running with the user's permissions. Prefix-only writes are a recipe obligation, not an OS sandbox guarantee. Recipes must configure vendor installers to keep tools and Python environments under their owned prefix; they must not change global shell files, package stores or system installations. New installers need native verification of these side effects before qualification. There is no arbitrary remote uninstall command in this protocol.

### Environment values

Supported substitutions are `${prefix}`, `${cache}`, `${work}` and `${dependency:<tap>/<id>}`. They are typed string substitutions, not shell expressions. `prefix` is the stable final installation directory; `work` is private temporary job space; `cache` is this package's cache root. Dependency substitutions must name direct, declared dependencies.

`prependPath` entries are relative to the prefix. `variables` exports process-local strings. Do not set `PATH` through `variables`; the client composes it from the selected dependency graph, current package and host baseline. Never persist `${work}` into exported environment values or health checks. Runtime assembly must also reject conflicting dependency variable exports and duplicate executables unless the root package explicitly resolves the conflict.

Install hooks run at their final prefix: Python virtual environments and other tools can embed absolute paths. Do not run them in a staging location and then rename the completed environment.

File checks require the named regular file inside the prefix and, on Unix, its executable permission if requested. Windows checks validate the declared executable file without relying on Unix permission bits. Command checks have a bounded timeout and cannot establish hardware compatibility. The Bazelisk recipe intentionally uses file checks because invoking it can download Bazel; qualification of a project build is a separate action.

## Receipts

An installed package has a `Receipt`, written by the native client after successful checks. It records:

- A client-generated installation UUID, package/version/host and final relative prefix.
- The bound tap origin, full catalog commit and exact release-manifest path/digest.
- Whether the user explicitly requested it, exact dependency installation UUIDs and file-source digests.
- Ownership (`managed`) and installation timestamp.

The required prefix is `packages/<tap>/<id>/<version>/<platform>/<installation-id>`. The runtime verifies this identity, its configured data root, symlink containment and ownership before mutation. Receipts are local manager state, never supplied or overwritten by a tap. They are not executable uninstall instructions. Unknown, external or manually discovered SDKs do not get managed receipts and cannot be recursively removed by the manager.

The schema and `validateReceipt()` establish document shape and identity consistency. Only a native engine can prove actual filesystem ownership, dependency liveness, locks and the installed bytes.
