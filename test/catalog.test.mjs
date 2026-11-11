import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { safeRelative, validateCatalog, validateDocument, validateReceipt } from "../scripts/validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releasePath = "formulae/bazelisk/versions/1.30.0.json";
const host = "macos-arm64";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gizmoth-tap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, "tap.json"), join(directory, "tap.json"));
  cpSync(join(root, "formulae"), join(directory, "formulae"), { recursive: true });
  return {
    directory,
    read(path) { return JSON.parse(readFileSync(join(directory, path), "utf8")); },
    write(path, value) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), `${JSON.stringify(value, null, 2)}\n`);
    },
    mutate(path, change) {
      const value = this.read(path);
      change(value);
      this.write(path, value);
    },
  };
}

function addSdk(f, version = "1.0.0") {
  const manifest = structuredClone(f.read(releasePath));
  manifest.id = "esp-idf";
  manifest.version = version;
  f.write(`formulae/esp-idf/versions/${version}.json`, manifest);
  f.mutate("formulae/esp-idf/formula.json", (formula) => {
    formula.status = "recipe";
    formula.defaultVersion = version;
    formula.releases.push({ version, manifest: `versions/${version}.json` });
  });
  return manifest;
}

function receipt() {
  // Synthetic manager-state fixture, not evidence that software was installed.
  const installationId = "42fdf318-dac7-4566-9a75-e61dd4e296c4";
  return {
    apiVersion: "gizmoth.dev/v1alpha1", kind: "Receipt", installationId,
    tap: { id: "gizclaw", repository: "https://github.com/GizClaw/gizmoth-devenv", commit: "a".repeat(40) },
    id: "bazelisk", version: "1.30.0", platform: host,
    manifest: { path: releasePath, sha256: "b".repeat(64) },
    prefix: `packages/gizclaw/bazelisk/1.30.0/${host}/${installationId}`,
    ownership: "managed", requested: true, dependencies: [], sourceDigests: [],
    installedAt: "2026-11-11T00:00:00.000Z",
  };
}

test("official tap validates offline with one concrete release and planned SDKs", () => {
  assert.deepEqual(validateCatalog([root]), { taps: 1, formulae: 6, planned: 5, releases: 1, platforms: 6 });
});

test("rejects traversal, absolute paths, Windows paths and reserved device names", () => {
  for (const path of ["../sdk", "/tmp/sdk", "C:/sdk", "bin\\bazel.exe", "bin/../sdk", "bin//sdk", "CON", "bin/nul.exe", "bin/tool."]) {
    assert.throws(() => safeRelative(path), /Unsafe/);
  }
  assert.equal(safeRelative("sdk/.venv/bin/python3"), "sdk/.venv/bin/python3");
});

test("rejects a symlinked manifest even when its JSON is valid", (t) => {
  const f = fixture(t);
  const path = join(f.directory, releasePath);
  rmSync(path);
  symlinkSync(join(root, releasePath), path);
  assert.throws(() => validateCatalog([f.directory]), /Symlink/);
});

test("rejects unindexed release files", (t) => {
  const f = fixture(t);
  f.write("formulae/bazelisk/versions/9.9.9.json", f.read(releasePath));
  assert.throws(() => validateCatalog([f.directory]), /unindexed release/);
});

test("planned entries cannot advertise installable releases", (t) => {
  const f = fixture(t);
  f.mutate("formulae/bazelisk/formula.json", (formula) => { formula.status = "planned"; });
  assert.throws(() => validateCatalog([f.directory]), /Formula:/);
});

test("rejects an unpublished default version and mismatched release identity", (t) => {
  const f = fixture(t);
  f.mutate("formulae/bazelisk/formula.json", (formula) => { formula.defaultVersion = "9.9.9"; });
  assert.throws(() => validateCatalog([f.directory]), /defaultVersion/);
  f.mutate("formulae/bazelisk/formula.json", (formula) => { formula.defaultVersion = "1.30.0"; });
  f.mutate(releasePath, (release) => { release.id = "esp-idf"; });
  assert.throws(() => validateCatalog([f.directory]), /release identity mismatch/);
});

test("rejects credential-bearing sources and placeholder checksums", (t) => {
  const f = fixture(t);
  f.mutate(releasePath, (release) => { release.platforms[host].sources[0].url = "https://user:token@example.com/tool"; });
  assert.throws(() => validateCatalog([f.directory]), /Invalid HTTPS source/);
  f.mutate(releasePath, (release) => {
    release.platforms[host].sources[0].url = "https://example.com/tool";
    release.platforms[host].sources[0].sha256 = "0".repeat(64);
  });
  assert.throws(() => validateCatalog([f.directory]), /placeholder/);
});

test("rejects undeclared sources and incompatible source operations", (t) => {
  const f = fixture(t);
  f.mutate(releasePath, (release) => { release.platforms[host].install[0].source = "missing"; });
  assert.throws(() => validateCatalog([f.directory]), /unknown source/);
  f.mutate(releasePath, (release) => {
    release.platforms[host].install[0] = { type: "checkout", source: "bazelisk", to: "sdk" };
  });
  assert.throws(() => validateCatalog([f.directory]), /incompatible source/);
});

test("rejects missing dependencies and dependencies without matching host support", (t) => {
  const f = fixture(t);
  f.mutate(releasePath, (release) => {
    release.platforms[host].dependencies = [{ package: "gizclaw/esp-idf", version: "1.0.0" }];
  });
  assert.throws(() => validateCatalog([f.directory]), /Unresolved dependency/);
  const sdk = addSdk(f);
  sdk.platforms[host].dependencies = [];
  delete sdk.platforms[host];
  f.write("formulae/esp-idf/versions/1.0.0.json", sdk);
  assert.throws(() => validateCatalog([f.directory]), /does not support/);
});

test("rejects dependency cycles", (t) => {
  const f = fixture(t);
  const sdk = addSdk(f);
  sdk.platforms[host].dependencies = [{ package: "gizclaw/bazelisk", version: "1.30.0" }];
  f.write("formulae/esp-idf/versions/1.0.0.json", sdk);
  f.mutate(releasePath, (release) => {
    release.platforms[host].dependencies = [{ package: "gizclaw/esp-idf", version: "1.0.0" }];
  });
  assert.throws(() => validateCatalog([f.directory]), /Dependency cycle/);
});

test("rejects conflicting transitive versions within a root environment", (t) => {
  const f = fixture(t);
  addSdk(f, "1.0.0");
  const sdk = addSdk(f, "2.0.0");
  const helper = structuredClone(sdk);
  helper.id = "arm-gnu";
  helper.version = "1.0.0";
  helper.platforms[host].dependencies = [{ package: "gizclaw/esp-idf", version: "2.0.0" }];
  f.write("formulae/arm-gnu/versions/1.0.0.json", helper);
  f.mutate("formulae/arm-gnu/formula.json", (formula) => {
    formula.status = "recipe";
    formula.defaultVersion = "1.0.0";
    formula.releases = [{ version: "1.0.0", manifest: "versions/1.0.0.json" }];
  });
  f.mutate(releasePath, (release) => {
    release.platforms[host].dependencies = [
      { package: "gizclaw/esp-idf", version: "1.0.0" },
      { package: "gizclaw/arm-gnu", version: "1.0.0" },
    ];
  });
  assert.throws(() => validateCatalog([f.directory]), /version conflict/);
});

test("rejects undeclared dependency templates and temporary exported paths", (t) => {
  const f = fixture(t);
  f.mutate(releasePath, (release) => {
    release.platforms[host].environment.variables.SDK_ROOT = "${dependency:gizclaw/esp-idf}/sdk";
  });
  assert.throws(() => validateCatalog([f.directory]), /undeclared template/);
  f.mutate(releasePath, (release) => {
    release.platforms[host].environment.variables.SDK_ROOT = "${work}/sdk";
  });
  assert.throws(() => validateCatalog([f.directory]), /template/);
});

test("rejects undeclared host commands and remote uninstall operations", (t) => {
  const f = fixture(t);
  f.mutate(releasePath, (release) => {
    release.platforms[host].install.push({ type: "run", program: "bash", args: [], cwd: "bin", environment: {}, timeoutSeconds: 60 });
  });
  assert.throws(() => validateCatalog([f.directory]), /must be declared/);
  f.mutate(releasePath, (release) => {
    release.platforms[host].install.pop();
    release.uninstall = { program: "rm", args: ["-rf", "/"] };
  });
  assert.throws(() => validateCatalog([f.directory]), /Release:/);
});

test("cannot replace another configured tap alias", () => {
  assert.throws(() => validateCatalog([root, root]), /Duplicate tap alias/);
});

test("managed receipt identity is independent from a remote source", () => {
  assert.equal(validateReceipt(receipt()).id, "bazelisk");
  const altered = receipt();
  altered.prefix = "packages/gizclaw/esp-idf/1.30.0/macos-arm64/42fdf318-dac7-4566-9a75-e61dd4e296c4";
  assert.throws(() => validateReceipt(altered), /installation identity/);
});

test("receipts cannot own external paths, caches or themselves as dependencies", () => {
  for (const prefix of ["../external-sdk", "cache/downloads", "/Users/example/sdk"]) {
    const altered = receipt();
    altered.prefix = prefix;
    assert.throws(() => validateReceipt(altered));
  }
  const external = receipt();
  external.ownership = "external";
  assert.throws(() => validateDocument(external, "Receipt"), /Receipt:/);
  const self = receipt();
  self.dependencies.push(self.installationId);
  assert.throws(() => validateReceipt(self), /depend on itself/);
});
