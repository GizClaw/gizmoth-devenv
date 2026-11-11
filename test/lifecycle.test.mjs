import assert from "node:assert/strict";
import test from "node:test";
import { planChipRemoval, planEnvironmentRemoval, planInstallationRemoval } from "../scripts/lifecycle.mjs";
import { validateInstallation, validateInstalledEnvironment } from "../scripts/validate.mjs";

// Synthetic local-state records: they exercise removal rules, not real installations.
const apiVersion = "devenv.gizmoth.dev/v1alpha1";
const host = "macos-arm64";
const installedAt = "2026-11-11T00:00:00.000Z";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [IDF, BK, JL, XTENSA, ARM, BAZEL, LOCAL] = [10, 11, 12, 20, 21, 22, 30].map(uuid);

function managed(installationId, type, id, version, { dependencies = [], requestedByUser = false } = {}) {
  return {
    apiVersion, kind: "Installation", installationId, type, id, version, platform: host,
    origin: {
      type: "managed",
      registry: { repository: "https://github.com/GizClaw/gizmoth-devenv", commit: "a".repeat(40) },
      manifest: { path: `${type}s/${id}/versions/${version}.json`, sha256: "b".repeat(64) },
      prefix: `installs/${type}s/${id}/${version}/${host}/${installationId}`,
      sourceDigests: [],
    },
    requestedByUser, dependencies, installedAt,
  };
}

function local(installationId, id, version, path) {
  return {
    apiVersion, kind: "Installation", installationId, type: "toolchain", id, version, platform: host,
    origin: { type: "local", path }, requestedByUser: true, dependencies: [], installedAt,
  };
}

const chip = (id, sdk, toolchains) => ({ apiVersion, kind: "InstalledChip", chip: id, sdk, toolchains, installedAt });

function state() {
  return {
    installations: [
      managed(IDF, "sdk", "esp-idf", "6.2.0"),
      managed(BK, "sdk", "beken-bk7258", "3.1.1-r6bbf627", { dependencies: [ARM] }),
      managed(XTENSA, "toolchain", "xtensa-esp-elf", "14.2.0"),
      managed(ARM, "toolchain", "arm-gnu", "10.3.0"),
      managed(BAZEL, "toolchain", "bazelisk", "1.30.0"),
    ],
    chips: [chip("esp32s3", IDF, [XTENSA, BAZEL]), chip("bk7258", BK, [BAZEL])],
  };
}

test("managed installation paths derive from their identity", () => {
  const record = managed(BAZEL, "toolchain", "bazelisk", "1.30.0");
  assert.equal(validateInstallation(record).id, "bazelisk");
  for (const prefix of [`installs/toolchains/arm-gnu/1.30.0/${host}/${BAZEL}`, "../external-sdk", "/Users/example/sdk"]) {
    assert.throws(() => validateInstallation({ ...record, origin: { ...record.origin, prefix } }));
  }
  assert.throws(() => validateInstallation({ ...record, version: "latest" }), /exact registry version/);
  assert.throws(() => validateInstallation({ ...record, dependencies: [BAZEL] }), /itself/);
});

test("local paths can only register user-added toolchains", () => {
  assert.equal(validateInstallation(local(LOCAL, "arm-gnu", "10.3-2021.10", "/opt/arm-gnu")).origin.type, "local");
  assert.ok(validateInstallation(local(LOCAL, "arm-gnu", "10.3.0", "C:\\Tools\\arm-gnu")));
  assert.throws(() => validateInstallation(local(LOCAL, "arm-gnu", "10.3.0", "tools/arm-gnu")), /Installation:/);
  assert.throws(() => validateInstallation({ ...local(LOCAL, "esp-idf", "6.2.0", "/opt/esp-idf"), type: "sdk" }), /Only toolchains/);
  assert.throws(() => validateInstallation({ ...local(LOCAL, "arm-gnu", "10.3.0", "/opt/arm-gnu"), requestedByUser: false }), /user-added/);
});

test("removing a chip deletes only what no other chip or user request needs", () => {
  assert.deepEqual(planChipRemoval(state(), "esp32s3"), { chip: "esp32s3", delete: [IDF, XTENSA], keep: [BAZEL] });
  assert.deepEqual(planChipRemoval(state(), "bk7258").delete, [BK, ARM]);
  const requested = state();
  requested.installations[2].requestedByUser = true;
  assert.deepEqual(planChipRemoval(requested, "esp32s3"), { chip: "esp32s3", delete: [IDF], keep: [XTENSA, BAZEL] });
});

test("toolchains still used by a chip or another installation cannot be removed", () => {
  assert.deepEqual(planInstallationRemoval(state(), BAZEL), { action: "blocked", target: BAZEL, chips: ["bk7258", "esp32s3"], environments: [], dependants: [] });
  assert.deepEqual(planInstallationRemoval(state(), ARM), { action: "blocked", target: ARM, chips: ["bk7258"], environments: [], dependants: [BK] });
});

test("removing a user-installed toolchain also removes dependencies nothing else needs", () => {
  const s = state();
  const [TOOL, HELPER] = [23, 24].map(uuid);
  s.installations.push(
    managed(HELPER, "toolchain", "helper", "1.0.0"),
    managed(TOOL, "toolchain", "tool", "1.0.0", { dependencies: [HELPER, ARM], requestedByUser: true }),
  );
  assert.deepEqual(planInstallationRemoval(s, TOOL), { action: "delete", target: TOOL, delete: [TOOL, HELPER] });
});

test("local toolchains are never deleted, only unregistered when unused", () => {
  const s = state();
  s.installations.push(managed(JL, "sdk", "jieli-ac707n", "1.0.0"), local(LOCAL, "jieli", "1.0.0", "/opt/jieli"));
  s.chips.push(chip("ac707n", JL, [LOCAL, BAZEL]));
  assert.deepEqual(planChipRemoval(s, "ac707n"), { chip: "ac707n", delete: [JL], keep: [BAZEL, LOCAL] });
  assert.equal(planInstallationRemoval(s, LOCAL).action, "blocked");
  s.chips.pop();
  assert.deepEqual(planInstallationRemoval(s, LOCAL), { action: "unregister", target: LOCAL, delete: [] });
});

test("inconsistent local state is rejected before any plan", () => {
  const wrongType = state();
  wrongType.chips[0].sdk = ARM;
  assert.throws(() => planChipRemoval(wrongType, "esp32s3"), /SDK installation/);
  const missing = state();
  missing.installations[1].dependencies = [uuid(99)];
  assert.throws(() => planChipRemoval(missing, "bk7258"), /missing toolchain dependency/);
});

const environment = (id, toolchains) => ({ apiVersion, kind: "InstalledEnvironment", environment: id, toolchains, installedAt });
const [PYTHON, OLD_PYTHON, TOOL] = [40, 41, 42].map(uuid);

function withEnvironment() {
  const s = state();
  s.installations.push(managed(PYTHON, "toolchain", "python", "3.12.16", { dependencies: [ARM] }));
  s.environments = [environment("gizos", [BAZEL, PYTHON])];
  return s;
}

test("environment roots retain direct and transitive tools when a chip is removed", () => {
  const s = withEnvironment();
  assert.deepEqual(planChipRemoval(s, "bk7258"), { chip: "bk7258", delete: [BK], keep: [ARM, BAZEL] });
  assert.deepEqual(planInstallationRemoval(s, PYTHON), {
    action: "blocked", target: PYTHON, chips: [], environments: ["gizos"], dependants: [],
  });
  assert.deepEqual(planInstallationRemoval(s, ARM), {
    action: "blocked", target: ARM, chips: ["bk7258"], environments: ["gizos"], dependants: [BK, PYTHON],
  });
});

test("environment removal collects only unshared dependencies and keeps other roots", () => {
  const s = withEnvironment();
  assert.deepEqual(planEnvironmentRemoval(s, "gizos"), { environment: "gizos", delete: [PYTHON], keep: [ARM, BAZEL] });
  s.environments.push(environment("other", [PYTHON]));
  assert.deepEqual(planEnvironmentRemoval(s, "gizos"), { environment: "gizos", delete: [], keep: [ARM, BAZEL, PYTHON] });
  s.environments.pop();
  s.installations.find((record) => record.installationId === PYTHON).requestedByUser = true;
  assert.deepEqual(planEnvironmentRemoval(s, "gizos"), { environment: "gizos", delete: [], keep: [ARM, BAZEL, PYTHON] });
  assert.throws(() => planEnvironmentRemoval(s, "missing"), /not installed/);
});

test("removing an environment never deletes local toolchain paths", () => {
  const s = withEnvironment();
  s.installations.push(local(LOCAL, "python", "3.11.18", "/opt/python"));
  s.environments[0].toolchains.push(LOCAL);
  assert.deepEqual(planEnvironmentRemoval(s, "gizos"), { environment: "gizos", delete: [PYTHON], keep: [ARM, BAZEL, LOCAL] });
  assert.equal(planInstallationRemoval(s, LOCAL).action, "blocked");
  s.environments = [];
  assert.deepEqual(planInstallationRemoval(s, LOCAL), { action: "unregister", target: LOCAL, delete: [] });
});

test("multiple versions are independent local installations and retention roots", () => {
  const s = withEnvironment();
  s.installations.push(managed(OLD_PYTHON, "toolchain", "python", "3.11.18"));
  s.environments.push(environment("legacy", [OLD_PYTHON]));
  assert.deepEqual(planEnvironmentRemoval(s, "legacy"), { environment: "legacy", delete: [OLD_PYTHON], keep: [] });
  assert.deepEqual(planEnvironmentRemoval(s, "gizos"), { environment: "gizos", delete: [PYTHON], keep: [ARM, BAZEL] });
  s.environments[0].toolchains.push(OLD_PYTHON);
  assert.deepEqual(planEnvironmentRemoval(s, "legacy"), { environment: "legacy", delete: [], keep: [OLD_PYTHON] });
});

test("removing a user-installed tool preserves dependencies retained by an environment", () => {
  const s = withEnvironment();
  s.installations.push(managed(TOOL, "toolchain", "tool", "1.0.0", { dependencies: [PYTHON], requestedByUser: true }));
  assert.deepEqual(planInstallationRemoval(s, TOOL), { action: "delete", target: TOOL, delete: [TOOL] });
  assert.deepEqual(planEnvironmentRemoval(s, "gizos"), { environment: "gizos", delete: [], keep: [ARM, BAZEL, PYTHON] });
});

test("installed environment metadata is optional and preserves offline names without a release layer", () => {
  const record = environment("gizos", [BAZEL, PYTHON]);
  assert.equal(validateInstalledEnvironment(record), record);
  record.metadata = { name: "GizOS", description: "Base host tools", homepage: "https://github.com/GizClaw/GizOS", notes: null };
  assert.equal(validateInstalledEnvironment(record).metadata.name, "GizOS");
  record.metadata.notes = "Kept offline";
  assert.ok(validateInstalledEnvironment(record));
  assert.throws(() => validateInstalledEnvironment({ ...record, version: "1.0.0" }), /InstalledEnvironment:/);
  assert.throws(() => validateInstalledEnvironment({ ...record, toolchains: [PYTHON, PYTHON] }), /InstalledEnvironment:/);
  assert.throws(() => validateInstalledEnvironment({ ...record, metadata: { ...record.metadata, unknown: true } }), /InstalledEnvironment:/);
  assert.throws(() => validateInstalledEnvironment({ ...record, metadata: { name: "GizOS" } }), /InstalledEnvironment:/);
});

test("invalid environment references and duplicate roots fail before any removal plan", () => {
  const s = withEnvironment();
  s.environments[0].toolchains.push(uuid(99));
  assert.throws(() => planEnvironmentRemoval(s, "gizos"), /toolchain installation .* is missing/);
  s.environments[0].toolchains = [IDF];
  assert.throws(() => planEnvironmentRemoval(s, "gizos"), /toolchain installation .* is missing/);
  s.environments[0].toolchains = [PYTHON];
  s.environments.push(environment("gizos", [PYTHON]));
  assert.throws(() => planChipRemoval(s, "esp32s3"), /Duplicate installed environment/);
});

test("local dependency cycles are rejected before computing retention", () => {
  const s = withEnvironment();
  s.installations.find((record) => record.installationId === ARM).dependencies = [PYTHON];
  assert.throws(() => planEnvironmentRemoval(s, "gizos"), /dependency cycle/);
});
