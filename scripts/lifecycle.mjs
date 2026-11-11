// Reference removal rules for GizMoth's local state. GizMoth's native engine must produce the same
// plans, then recheck them under its mutation lock together with active jobs and usage leases.
import { requireThat, validateInstallation, validateInstalledChip } from "./validate.mjs";

function validateState({ installations, chips }) {
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
  const installed = new Set();
  for (const chip of chips) {
    validateInstalledChip(chip);
    requireThat(!installed.has(chip.chip), `Duplicate installed chip: ${chip.chip}`);
    installed.add(chip.chip);
    requireThat(byId.get(chip.sdk)?.type === "sdk", `Chip ${chip.chip}: SDK installation ${chip.sdk} is missing`);
    for (const id of chip.toolchains) requireThat(byId.get(id)?.type === "toolchain", `Chip ${chip.chip}: toolchain installation ${id} is missing`);
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

/** Installed chips and user-requested installations are roots; everything they reach is kept. */
function kept(byId, installations, chips) {
  return closure(byId, [
    ...chips.flatMap(chipRoots),
    ...installations.filter((record) => record.requestedByUser).map((record) => record.installationId),
  ]);
}

/** Removing a chip deletes the managed installations that no other chip or user request still needs. */
export function planChipRemoval(state, chipId) {
  const byId = validateState(state);
  const chip = state.chips.find((record) => record.chip === chipId);
  requireThat(chip, `Chip is not installed: ${chipId}`);
  const remaining = kept(byId, state.installations, state.chips.filter((record) => record !== chip));
  const reached = [...closure(byId, chipRoots(chip))];
  return {
    chip: chipId,
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
  const dependants = state.installations.filter((record) => record.dependencies.includes(installationId)).map((record) => record.installationId).sort();
  if (chips.length || dependants.length) return { action: "blocked", target: installationId, chips, dependants };
  if (target.origin.type === "local") return { action: "unregister", target: installationId, delete: [] };
  const remaining = kept(byId, state.installations.filter((record) => record !== target), state.chips);
  const orphaned = [...closure(byId, target.dependencies)].filter((id) => !remaining.has(id));
  return { action: "delete", target: installationId, delete: [installationId, ...orphaned].sort() };
}
