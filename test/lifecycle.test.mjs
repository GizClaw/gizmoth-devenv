import assert from "node:assert/strict";
import test from "node:test";
import { planChipRemoval, planInstallationRemoval } from "../scripts/lifecycle.mjs";
import { validateInstallation } from "../scripts/validate.mjs";

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
  assert.deepEqual(planInstallationRemoval(state(), BAZEL), { action: "blocked", target: BAZEL, chips: ["bk7258", "esp32s3"], dependants: [] });
  assert.deepEqual(planInstallationRemoval(state(), ARM), { action: "blocked", target: ARM, chips: ["bk7258"], dependants: [BK] });
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
