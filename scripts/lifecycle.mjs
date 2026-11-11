// Reference removal rules for GizMoth's local state. GizMoth's native engine must produce the same
// plans, then recheck them under its mutation lock together with active jobs and usage leases.
import { requireThat, validateInstallation, validateInstalledChip, validateInstalledEnvironment } from "./validate.mjs";

function validateState({ installations, chips, environments = [] }) {
  const byId = new Map();
  for (const record of installations) {
    validateInstallation(record);
    requireThat(!byId.has(record.installationId), `Duplicate installation: ${record.installationId}`);
    byId.set(record.installationId, record);
  }
  for (const record of installations) {
    for (const dependency of record.dependencies) {
      requireThat(byId.get(dependency)?.type === "toolchain", `Installation ${record.installationId}: missing toolchain dependency ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    requireThat(!visiting.has(id), `Installation dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id).dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  const installed = new Set();
  for (const chip of chips) {
    validateInstalledChip(chip);
    requireThat(!installed.has(chip.chip), `Duplicate installed chip: ${chip.chip}`);
    installed.add(chip.chip);
    requireThat(byId.get(chip.sdk)?.type === "sdk", `Chip ${chip.chip}: SDK installation ${chip.sdk} is missing`);
    for (const id of chip.toolchains) requireThat(byId.get(id)?.type === "toolchain", `Chip ${chip.chip}: toolchain installation ${id} is missing`);
  }
  const installedEnvironments = new Set();
  for (const environment of environments) {
    validateInstalledEnvironment(environment);
    requireThat(!installedEnvironments.has(environment.environment), `Duplicate installed environment: ${environment.environment}`);
    installedEnvironments.add(environment.environment);
    for (const id of environment.toolchains) {
      requireThat(byId.get(id)?.type === "toolchain", `Environment ${environment.environment}: toolchain installation ${id} is missing`);
    }
  }
  return byId;
}

function closure(byId, roots) {
  const seen = new Set();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...byId.get(id).dependencies);
  }
  return seen;
}

const chipRoots = (chip) => [chip.sdk, ...chip.toolchains];

/** Chips, environments and user-requested installations are roots; everything they reach is kept. */
function kept(byId, installations, chips, environments = []) {
  return closure(byId, [
    ...chips.flatMap(chipRoots),
    ...environments.flatMap((environment) => environment.toolchains),
    ...installations.filter((record) => record.requestedByUser).map((record) => record.installationId),
  ]);
}

/** Removing a chip deletes only installations that no remaining retention root needs. */
export function planChipRemoval(state, chipId) {
  const byId = validateState(state);
  const chip = state.chips.find((record) => record.chip === chipId);
  requireThat(chip, `Chip is not installed: ${chipId}`);
  const remaining = kept(byId, state.installations, state.chips.filter((record) => record !== chip), state.environments);
  const reached = [...closure(byId, chipRoots(chip))];
  return {
    chip: chipId,
    delete: reached.filter((id) => !remaining.has(id)).sort(),
    keep: reached.filter((id) => remaining.has(id)).sort(),
  };
}

/** Removing a generic environment drops its root, then collects only its unshared dependencies. */
export function planEnvironmentRemoval(state, environmentId) {
  const byId = validateState(state);
  const environment = (state.environments ?? []).find((record) => record.environment === environmentId);
  requireThat(environment, `Environment is not installed: ${environmentId}`);
  const remaining = kept(byId, state.installations, state.chips, state.environments.filter((record) => record !== environment));
  const reached = [...closure(byId, environment.toolchains)];
  return {
    environment: environmentId,
    delete: reached.filter((id) => !remaining.has(id)).sort(),
    keep: reached.filter((id) => remaining.has(id)).sort(),
  };
}

/** Removing one row from the Toolchains table. Local paths are unregistered, never deleted. */
export function planInstallationRemoval(state, installationId) {
  const byId = validateState(state);
  const target = byId.get(installationId);
  requireThat(target, `Unknown installation: ${installationId}`);
  const chips = state.chips.filter((chip) => closure(byId, chipRoots(chip)).has(installationId)).map((chip) => chip.chip).sort();
  const environments = (state.environments ?? []).filter((environment) => closure(byId, environment.toolchains).has(installationId))
    .map((environment) => environment.environment).sort();
  const dependants = state.installations.filter((record) => record.dependencies.includes(installationId)).map((record) => record.installationId).sort();
  if (chips.length || environments.length || dependants.length) return { action: "blocked", target: installationId, chips, environments, dependants };
  if (target.origin.type === "local") return { action: "unregister", target: installationId, delete: [] };
  const remaining = kept(byId, state.installations.filter((record) => record !== target), state.chips, state.environments);
  const orphaned = [...closure(byId, target.dependencies)].filter((id) => !remaining.has(id));
  return { action: "delete", target: installationId, delete: [installationId, ...orphaned].sort() };
}
