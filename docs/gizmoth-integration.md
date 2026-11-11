# GizMoth integration contract

This describes the next application change; the current catalog repository does not implement the UI or native engine.

## Navigation and discovery

Add a top-level **Development Environments / 开发环境** sidebar entry. Use the plugin-catalog pattern with **Discover / 发现**, **Installed / 已安装** and **Sources / 来源** views.

Discover shows searchable package cards grouped by SDK, toolchain, build tool, runtime or utility. A card shows its source, description, recipe/default version, local state and host compatibility. Planned entries show that a recipe is pending, with no installation action. Unsupported hosts show a clear reason. Downloading a Linux executable on macOS must not become a "ready" badge.

Opening a recipe shows exact versions, inputs, prerequisites, dependencies, installation path and available checks. Install starts a native job and displays its phases and logs. Existing versions remain visible. Installed uses local receipts, so it works without the network and can expose check, select, remove and dependency details. Removal previews dependent packages and profile references before confirmation.

Sources contains the official `GizClaw/gizmoth-devenv` tap and explicitly added GitHub repositories. Adding a source validates and binds its origin; refresh changes metadata only. Do not offer arbitrary package names or shell commands in the source input. Removing a source does not remove its installed packages.

## Ownership boundary

| Owner | Responsibility |
| --- | --- |
| Tap repository | Catalog, pinned vendor inputs, exact dependency declarations, platform recipes and checks |
| GizMoth Rust backend | Fetch/validate snapshots, resolve dependencies, download/verify, execute operations, compose process environments, hold locks/leases, persist receipts and recover jobs |
| GizMoth frontend | Discovery, details, user actions, task logs, compatibility and removal previews |
| User projects | Source code, build targets and explicit environment/version selection |

This is a development-environment package system. Formulae do not inject JavaScript into GizMoth or modify its frontend. There is no runtime dependency on the GizOS environment CLI and no requirement to install Bun merely to use this catalog. The app may use ordinary vendor build tools declared by each recipe.

## Native API expectations

The frontend should call typed, allowlisted operations rather than accepting shell strings. The exact IPC names can follow GizMoth's existing conventions, but the operations need these semantics:

- List sources and catalog packages from validated snapshots; add, refresh or remove a bound source.
- Inspect installed environments and run explicit health checks.
- Resolve an installation plan, start it, inspect its current state/events, and request cancellation by job ID.
- Preview and execute removal of an explicit installation-ID set; preview and execute pruning/cache cleanup separately.
- Read and change a profile's exact environment selections.
- Compose a process environment and launch a selected project command with a usage lease held for its lifetime.

Plans and jobs are native records tied to the resolved commit, manifest digest, host and dependency graph. Revalidate a preview before mutation; a stale frontend object cannot authorize a different package version, repository or deletion target. Cross-process locks coordinate app windows and any future CLI/API client.

Keep receipt state and logs queryable after frontend reloads. Stream sequenced events with job IDs and support resuming from an event cursor; dropped UI connections must not launch duplicate jobs. Client-generated idempotency keys or an equivalent native reservation must protect retries after ambiguous IPC failures.

## Implementation order and acceptance

1. Implement schema/semantic validation in the native backend and read-only source/discovery/installed views. Pin one catalog commit per refresh; test offline and failed-refresh behavior.
2. Implement the Bazelisk file recipe end to end: verified download, owned prefix, receipt, process environment, real project-selected Bazel execution, cancellation, restart recovery and removal. Exercise platform-specific filesystem and process behavior in native tests; catalog validation is insufficient.
3. Add SDK/compiler recipes one family at a time, with pinned inputs, actual host checks, explicit vendor prerequisites and installation-side-effect tests. Keep incomplete families planned.
4. Connect project creation/build/run flows to exact environment profiles after the environment manager is verified.

No installer success, health check or first-build success should be inferred from the presence of a catalog card. Report these states separately in the app.
