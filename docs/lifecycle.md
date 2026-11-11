# Local storage and lifecycle

This specifies GizMoth's native engine. [lifecycle.mjs](../scripts/lifecycle.mjs) is the reference for the removal rules and is covered by tests; installation itself is not implemented here.

## Local layout

The data root is a user-level directory separate from application resources, source checkouts and worktrees. Use the operating system's normal data and cache locations by default. Changing the root requires that no job or build is using it.

```text
<devenv-data>/
  registry/<commit>/                                   # Validated registry snapshots
  installs/
    sdks/<id>/<version>/<platform>/<installation-id>/
    toolchains/<id>/<version>/<platform>/<installation-id>/
  records/<installation-id>.json                       # Installation: one managed or local SDK/toolchain
  chips/<chip-id>.json                                 # InstalledChip: the SDK and toolchains a chip uses
  jobs/<job-id>/
    journal.json                                       # Recoverable transaction state
    events.ndjson                                      # Ordered progress, log and result events
    work/                                              # Temporary job files
  locks/                                               # Cross-process change and usage locks
  trash/<job-id>/                                      # Detached installations awaiting deletion

<devenv-cache>/
  downloads/sha256/<digest>                            # Verified downloads, addressed by content
  sdks/<id>/                                           # SDK caches
  toolchains/<id>/                                     # Toolchain caches, such as Bazel downloads
```

GizMoth generates every local path. Registry files cannot choose the data root, record paths, job directories or deletion targets.

There are two kinds of `Installation`:

- **Managed**: GizMoth installed it from a registry release into `installs/<type>s/<id>/<version>/<platform>/<installation-id>`. The path is derived from the record's identity and GizMoth owns the directory.
- **Local**: a toolchain the user downloaded and registered by absolute path. GizMoth checks it and adds it to the environment but never writes to it or deletes it. Local SDKs are not supported.

`requestedByUser` marks a toolchain the user installed or registered directly, rather than one installed for a chip.

## Install a chip

1. From one registry snapshot, resolve the chip's SDK version, the SDK's common and target dependencies and the chip's tools to exact versions for this host. Check host prerequisites and validate the whole set before changing anything.
2. Reuse healthy installations with the same ID and version, including local toolchains. Install what is missing, toolchains before the SDK. Each new installation gets a new ID and its final directory; existing directories and records are never overwritten.
3. Download to temporary files and verify size and SHA-256 before adding them to the download cache. Recheck cached files before use. Check out Git sources at their pinned commits.
4. Run install steps in the final directory with its dependencies, cache and temporary job space. A directory is not used for builds until its checks pass and its record is written. It is never renamed after a step has run.
5. Write each new `Installation` record after its checks pass, then write the `InstalledChip` record last. The journal recovers an interrupted commit.
6. End with exactly one result: `succeeded`, `failed` or `cancelled`. On failure or cancellation, stop the process group and its children before removing unfinished directories. Keep installations that completed.

Jobs continue when the user leaves the page. Each job has an ID, ordered events and a current phase: resolving, downloading, unpacking, running, checking, committing or cleaning. Show byte progress where available rather than inventing a percentage for vendor scripts. Before quitting or updating GizMoth, wait for jobs or cancel them and wait for their processes to exit. At the next launch, recover abandoned jobs under an exclusive lock; a partially installed directory is never marked ready.

## Toolchains table

The table lists every toolchain `Installation`, whether installed for a chip, by the user or from a local path, and shows which chips use it.

- **Install a toolchain**: install a release directly with `requestedByUser: true`. It stays when chips are removed.
- **Add a local toolchain**: the user selects an existing directory. GizMoth runs the matching release's checks against it, or checks the selected executable, and records the version the user confirms. A chip uses it only when its toolchain ID and version match the required dependency exactly.

## Removal

Removal uses only local records. It never downloads metadata or runs remote code, so it works offline and after the registry changes.

Installed chips and `requestedByUser` installations are the roots. Every installation they reach, through a chip's SDK and toolchains or an installation's dependencies, is kept.

- **Remove a chip**: delete its `InstalledChip` record, then delete the managed installations it reached that nothing else reaches. Toolchains shared with another chip, toolchains the user installed and local toolchains stay.
- **Remove a toolchain from the table**: if a chip uses it or another installation depends on it, refuse and show which. Otherwise delete it, along with dependencies that nothing else needs. A local toolchain is only unregistered: its files stay where the user put them.

Every removal shows a preview first: the exact installations and directories to delete or keep and why. On confirmation, GizMoth:

1. Recomputes the plan under the change lock and refuses if a job or build is using any target.
2. Checks each target's record, its identity-derived path, its real path inside the data root and its ownership. It stops if the state is inconsistent.
3. Journals the removal, moves each managed directory to `trash/<job-id>`, then removes the records. A crash cannot leave a record for a missing directory.
4. Deletes the trash after processes and file handles are released. If deletion fails, it keeps the journal and trash for a retry and reports the actual state.

Never deleted: local toolchain paths, user projects, other installed versions, caches (cleared separately), and anything whose ownership is uncertain. Changes the user made inside a managed directory are lost when it is removed, so the preview shows the full path.

Cache cleanup is a separate preview and action. It keeps downloads referenced by installed records or active jobs, and clears tool caches only when no build is using them.

## Updates

A registry refresh only updates metadata. When a newer SDK version supports an installed chip, its card shows that an update is available. Updating installs the new SDK and its toolchains alongside the current ones, checks them, and switches the `InstalledChip` record. Old installations are then removed by the chip-removal rules once no build is using them.

Changing the registry URL or deleting a snapshot never removes installations. Records keep enough metadata to use, inspect and remove them offline.
