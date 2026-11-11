# GizMoth integration

This describes the next GizMoth change; this repository does not implement the page or the native engine.

## Page structure

Add a top-level **Development Environments / 开发环境** sidebar entry with two views.

**Chips / 芯片**: a grid of cards, one per chip, grouped or searchable by vendor. A card shows the chip, vendor, SDK version and local state: not installed, installing (phase and log), installed, update available, or unsupported on this computer with the reason, such as "requires Linux x86_64" or "requires Rosetta". Planned chips show that a recipe is pending and have no install action. **Install** sets up the SDK, toolchains and build tools automatically. Chip details can switch the SDK version and list the toolchains that will be installed; dependencies are shown, not chosen. Removing a chip previews what will be deleted and kept.

**Toolchains / 工具链**: a table with name, version, category, chips using it, origin (automatic, user-installed or local path), status and actions. Users can install any published toolchain version or register a toolchain they downloaded themselves. Removal follows [the lifecycle rules](lifecycle.md): toolchains in use are blocked with the reason, and local paths are only unregistered.

SDKs have no page of their own; they appear in chip details. The registry URL is a setting, not a navigation item.

## Ownership

| Owner | Responsibility |
| --- | --- |
| This repository | Chips, SDK and toolchain entries, pinned vendor inputs, exact dependencies, platform recipes and checks |
| GizMoth native backend | Fetch and validate snapshots, resolve chip environments, download and verify, run installation steps, build process environments, hold locks and usage leases, write records, recover jobs |
| GizMoth frontend | Chip cards, toolchain table, details, task logs, compatibility and removal previews |
| User projects | Source code, build targets and the chip each project uses |

Registry entries never inject code into GizMoth's interface. GizMoth needs no GizOS environment CLI, Bun or Homebrew to use this registry; recipes declare the vendor tools they need.

## Native operations

The frontend calls typed operations instead of passing shell strings:

- Refresh and read the registry snapshot; list chips and toolchains with local state and host support.
- Plan and start a chip installation, a toolchain installation or a local toolchain registration; read a job's state and events; cancel by job ID.
- Preview and confirm removal of a chip or one toolchain installation; preview and confirm cache cleanup.
- Change an installed chip's SDK version through the update flow.
- Build the process environment for a chip and run a project command while holding a usage lease.

Plans are tied to the snapshot commit, release digests, host and resolved installations. GizMoth recomputes a plan before changing anything, so a stale preview cannot authorize a different version or deletion target. Locks coordinate app windows and any future CLI or service client. Job state and logs survive frontend reloads; events carry sequence numbers so a reconnecting view resumes without starting a duplicate job.

## Implementation order

1. Native snapshot fetching and validation, with read-only Chips and Toolchains views. Test offline use and failed refreshes.
2. Bazelisk end to end in the Toolchains view: verified download, managed directory, record, environment, a real build using a project's `.bazelversion`, cancellation, restart recovery and removal. Also local toolchain registration and unregistration.
3. The first chip: ESP32-S3 with ESP-IDF and `xtensa-esp-elf`, including per-target dependencies, chip installation, update and chip removal with shared toolchains. Then Beken, then JieLi, keeping unfinished families planned.
4. Connect project creation, builds and flashing to the installed chip environment.

A card's presence does not mean an installation, health check or first build has succeeded; the app reports those states separately.
