# Local storage and package lifecycle

This specifies the intended native GizMoth engine. No installer or removal engine is implemented in this repository.

## Local layout

Choose a user-level data root independently from application resources, source checkouts and worktrees. The UI may let the user change it after verifying ownership and ensuring no jobs or leases are active. Defaults should use normal OS data/cache locations; do not hardcode a maintainer's Workspace path.

```text
<devenv-data>/
  config.json                                   # Tap alias/origin bindings and root settings
  taps/<alias>/snapshots/<full-commit>/           # Immutable, validated catalog snapshots
  packages/<alias>/<id>/<version>/<platform>/
    <installation-id>/                          # One owned payload with a stable absolute path
  receipts/<installation-id>.json                # Ready package identity and dependency records
  profiles/<profile-id>.json                     # Exact installation IDs selected for a project/session
  jobs/<job-id>/
    journal.json                                # Recoverable transaction and reserved prefix
    events.ndjson                               # Sequenced log/progress and terminal events
    work/                                       # Private temporary install files
  locks/                                        # Cross-process mutation and usage locks
  trash/<job-id>/                               # Detached payload pending deletion/retry

<devenv-cache>/
  downloads/sha256/<digest>                      # Content-addressed, verified source archives/files
  packages/<alias>/<id>/                         # Vendor cache; e.g. Bazelisk's Bazel downloads
```

All identities are generated or validated by the native engine. Tap JSON cannot choose the data root, receipts, profile paths, work directory or removal target. Installation IDs distinguish reinstalls and recipe revisions while preserving stable prefix paths. A user project never belongs inside a disposable managed prefix.

## Install

1. Select a formula, exact version and compatible host from one validated tap snapshot. Resolve prerequisites and exact dependency versions; validate the whole graph before changing files.
2. Acquire cross-process mutation locks and reuse only healthy, matching existing dependency installations. Reserve an operation UUID and journal, with an owned final prefix per new installation. Do not overwrite an existing prefix or receipt.
3. Download to private temporary files. Check expected size and SHA-256 before atomically publishing file sources to the shared download cache. Recheck cached entries before use; materialize Git sources at the pinned commits.
4. Run operations with each candidate's final prefix, dependency prefixes, private work directory and package cache. A candidate is not exposed to normal profiles or commands while installation is in progress. Do not rename a prefix after a hook has embedded its absolute path.
5. Run all checks. Persist manifest provenance and dependency receipts. Journal the publication, publish ready receipts atomically and update the requested profile only after all packages are ready. Recover interrupted multi-file commits through the journal; there is no assumption that renaming multiple files is one atomic operation.
6. Report a terminal result. On failure or cancellation, stop and reap the process group and its children before releasing locks or cleaning owned candidates. Preserve completed dependencies and usable existing installations. Never delete a candidate while a child could still be writing to it.

Jobs continue when the user navigates to another page. Each has an ID, ordered events, a queryable current state and exactly one terminal outcome: `succeeded`, `failed` or `cancelled`. Activity phases include resolving, downloading, materializing, running, checking, committing and cleaning. Report byte progress where available; do not invent a percentage for opaque vendor scripts.

Before shutdown/update, either wait for active jobs or cancel them and await child termination. Recover abandoned reservations under an exclusive ownership lock at next launch; a PID alone is not proof that the old job is dead. A recovery attempt never marks a partially installed prefix ready.

## Update and version selection

Refreshing a tap only refreshes metadata. It never upgrades installed SDKs. Updating installs the selected new version alongside the old one, checks it and then explicitly switches a chosen profile. Projects retain their exact selections until changed by the user.

A reinstall gets a new installation ID and final prefix. Existing applications and leases can continue using the old installation; remove it only after it is unused. If a previously observed version's manifest changes, reject the mutation and require a new package version.

The installed view reads receipts and current health, not the remote catalog's latest version. Source refresh failures cannot make an installed environment disappear.

## Remove

Removal is based entirely on the local receipt and dependency graph; it does not fetch or execute remote uninstall code.

1. Validate the receipt, its identity-derived prefix, data-root containment, real filesystem paths and ownership. Unknown paths and external SDKs cannot be recursively deleted. Stop on inconsistent or corrupted state.
2. Build a removal preview showing the exact package/version, profiles selecting it and installed dependants. Refuse removal while a live lease or job uses it. Refuse a dependency that other installed packages still need; dependent removal must be a separately explicit set.
3. Require explicit deselection or reassignment of profiles before removing their selected installation. Keep these changes in the transaction journal so a failure does not silently switch environments.
4. Under the mutation lock, recheck leases, references and the target identity. Journal detachment, move only the owned installation directory into `trash/<job-id>`, and retire the receipt. Use a recoverable transaction so a crash does not leave a live receipt claiming a missing payload.
5. Clean the detached directory after all handles/children are released. If deletion fails, retain the journal and trash path for retry; report the state truthfully. Do not restore it as a healthy installation automatically.

Removing an SDK does not recursively remove shared toolchains, other versions, source projects or caches. Manual changes inside an owned prefix may be lost on explicit removal; the UI must make the exact owned path visible. External resources are never converted into owned payloads merely because detection found them.

## Prune and source removal

`prune` first previews unreferenced, automatically installed dependencies (`requested: false`). Keep anything explicitly installed, selected by a profile, depended on by another receipt, in use or whose ownership is uncertain. The user confirms the preview before deletion; recompute it under the mutation lock.

Cache cleanup is a separate preview/action, never a side effect of ordinary removal. Keep downloads referenced by installed receipts or active jobs. Vendor caches can be cleared only while no leased command uses them. Unknown cache content is retained unless explicitly recognized and selected.

Removing a tap stops future discovery/updates from that source. Keep installed packages, receipts and the pinned metadata needed to explain them. They can still be inspected, used and removed offline. Removing the app or updating it must not implicitly delete this independent environment store.
