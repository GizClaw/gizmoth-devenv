# GizMoth integration

This describes the registry's contract with GizMoth. The application owns its page and native engine; this repository provides metadata, schemas, offline validation and reference lifecycle rules.

## Page structure

The top-level **Development Environments / 开发环境** page exposes chip and generic environment cards, plus a Toolchains view.

**Chips / 芯片**: a grid of cards, one per chip, grouped or searchable by vendor. A card shows the chip, vendor, SDK version and local state: not installed, installing (phase and log), installed, update available, or unsupported on this computer with the reason, such as "requires Linux x86_64" or "requires Rosetta". Planned chips show that a recipe is pending and have no install action. **Install** sets up the SDK, toolchains and build tools automatically. Chip details can switch the SDK version and list the toolchains that will be installed; dependencies are shown, not chosen. Removing a chip previews what will be deleted and kept.

**Generic environments**: named collections of exact toolchain dependencies, indexed by the optional `registry.environments` field. A missing field means no generic environments. Published cards show the common supported hosts and their exact tools; planned cards have no install action. GizOS installs Bazelisk 1.30.0 and Python 3.12.16 as base host tools. It does not promise a complete firmware SDK or compiler environment. There is no environment version or release selector. Local records retain exact installation UUIDs and may store display metadata for offline use.

**Toolchains / 工具链**: a table with name, version, category, chips and environments using it, origin (automatic, user-installed or local path), status and actions. Users can install any published toolchain version or register a toolchain they downloaded themselves. Python is a `runtime` category toolchain. Multiple installed versions coexist, and process activation explicitly chooses versions without replacing global `PATH`. Removal follows [the lifecycle rules](lifecycle.md): toolchains in use are blocked with the reason, and local paths are only unregistered.

SDKs have no page of their own; they appear in chip details. The registry URL is a setting, not a navigation item.

## Ownership

| Owner | Responsibility |
| --- | --- |
| This repository | Chip, environment, SDK and toolchain entries, pinned vendor inputs, exact dependencies, platform recipes and checks |
| GizMoth native backend | Fetch and validate snapshots, resolve exact ID/version graphs, download and verify, safely extract archives, run supported installation steps, activate selected process tools, hold locks and usage leases, write records, recover jobs |
| GizMoth frontend | Chip and generic environment cards, toolchain versions, details, task logs, compatibility and removal previews |
| User projects | Source code, build targets and the chip each project uses |

Registry entries never inject code into GizMoth's interface. GizMoth needs no GizOS environment CLI, Bun or Homebrew to use this registry; recipes declare the vendor tools they need.

Linux `guestRoot`/`bootstrap` recipes remain metadata-only formulae. GizMoth fetches and verifies their raw Debian files and extracts payloads with its static Rust ar/xz/tar reader. It does not run dpkg, apt, maintainer scripts or a registry installer. `linux-runtime` is the bootstrap source set for constructing a read-only root; native Git and build tools arrive as separate formulas. Root layers select only their default release, while normal Python/Bazelisk versions remain isolated under `/opt/gizmoth/packages/<kind>/<id>/<version>`. There is no registry-built runtime artifact or base system disk.

For ARM64 x86 compatibility, GizMoth owns binfmt_misc registration for `usr/bin/qemu-x86_64-static` and sets `QEMU_LD_PREFIX=/opt/gizmoth/x86_64` when appropriate. Foreign Debian payloads stay under that prefix and have no PATH activation. The binutils proof is invoked by its full path so it cannot replace the native compiler's assembler/linker.

Local integration can seed the saved snapshot with `node scripts/export-snapshot.mjs <app-data>/compile/registry` while GizMoth is stopped. It reads validated working-tree metadata and writes `{commit, fetchedAt, files}` plus `current.json`, where `files` maps relevant relative JSON paths to their exact UTF-8 text. The synthetic development identity never changes production Git transport settings; a normal registry refresh supersedes it. GizMoth's ignored `devenv::registry::tests::development_snapshot_validates` test accepts the exported snapshot filename through `GIZMOTH_TEST_REGISTRY_SNAPSHOT`.

## Native operations

The frontend calls typed operations instead of passing shell strings:

- Refresh and read the registry snapshot; list chips, generic environments and toolchains with local state and host support.
- Plan and start a chip, generic environment or exact toolchain installation, or a local toolchain registration; read a job's state and events; cancel by job ID.
- Preview and confirm removal of a chip, generic environment or one toolchain installation; preview and confirm cache cleanup. Environments are retention roots, and blocked tool removals identify the environments that use them.
- Change an installed chip's SDK version or explicitly update a generic environment's dependency set through the checked update flow.
- Build a process environment from explicitly selected installations and run a project command while holding a usage lease.

Plans are tied to the snapshot commit, release digests, host and resolved installations. GizMoth recomputes a plan before changing anything, so a stale preview cannot authorize a different version or deletion target. Locks coordinate app windows and any future CLI or service client. Job state and logs survive frontend reloads; events carry sequence numbers so a reconnecting view resumes without starting a duplicate job.

## Implementation order

1. Native snapshot fetching and validation, with read-only Chips and Toolchains views. Test offline use and failed refreshes.
2. Bazelisk and Python in the Toolchains view: verified download, managed directory, record, selected process environment, cancellation, restart recovery and removal. Python requires safe `tar.gz` extraction, including contained links and collision checks; registry validation never executes it. Qualify both versions of each tool side by side, local registration, and GizOS installation/removal with shared toolchains. A project's `.bazelversion` selects the Bazel downloaded by Bazelisk.
3. The first chip: ESP32-S3 with ESP-IDF and `xtensa-esp-elf`, including per-target dependencies, chip installation, update and chip removal with shared toolchains. Then Beken, then JieLi, keeping unfinished families planned.
4. Connect project creation, builds and flashing to the installed chip environment.

A card's presence does not mean an installation, health check or first build has succeeded; the app reports those states separately.
