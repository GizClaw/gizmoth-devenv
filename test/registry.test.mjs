import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { safeRelative, validateDocument, validateRegistry } from "../scripts/validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiVersion = "devenv.gizmoth.dev/v1alpha1";
const bazelisk = "toolchains/bazelisk/versions/1.30.0.json";
const host = "macos-arm64";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gizmoth-devenv-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, "registry.json"), join(directory, "registry.json"));
  for (const entry of ["chips", "sdks", "toolchains", "environments"]) cpSync(join(root, entry), join(directory, entry), { recursive: true });
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

// Synthetic fixtures reuse the verified Bazelisk recipe shape; nothing is downloaded or installed.
function recipe(f, dependencies = []) {
  return { ...structuredClone(f.read(bazelisk).platforms[host]), dependencies };
}

function publish(f, type, id, version, platforms) {
  const directory = `${type}s/${id}`;
  f.write(`${directory}/versions/${version}.json`, {
    apiVersion, kind: type === "sdk" ? "SdkRelease" : "ToolchainRelease", id, version, platforms,
  });
  f.mutate(`${directory}/${type}.json`, (item) => {
    item.status = "published";
    item.defaultVersion ??= version;
    item.releases.push({ version, manifest: `versions/${version}.json` });
  });
}

test("official registry validates offline with GizOS, two Python versions and two Bazelisk versions", () => {
  assert.deepEqual(validateRegistry(root), { chips: 3, environments: 1, sdks: 3, toolchains: 5, planned: 9, releases: 4, platforms: 24 });
});

test("rejects traversal, absolute paths, Windows paths and reserved device names", () => {
  for (const path of ["../sdk", "/tmp/sdk", "C:/sdk", "bin\\bazel.exe", "bin/../sdk", "bin//sdk", "CON", "bin/nul.exe", "bin/tool."]) {
    assert.throws(() => safeRelative(path), /Unsafe/);
  }
  assert.equal(safeRelative("sdk/.venv/bin/python3"), "sdk/.venv/bin/python3");
});

test("rejects a symlinked release even when its JSON is valid", (t) => {
  const f = fixture(t);
  const path = join(f.directory, bazelisk);
  rmSync(path);
  symlinkSync(join(root, bazelisk), path);
  assert.throws(() => validateRegistry(f.directory), /Symlink/);
});

test("rejects unindexed releases and chips", (t) => {
  const f = fixture(t);
  f.write("toolchains/bazelisk/versions/9.9.9.json", f.read(bazelisk));
  assert.throws(() => validateRegistry(f.directory), /Unindexed entry: toolchains\/bazelisk\/versions\/9\.9\.9\.json/);
  rmSync(join(f.directory, "toolchains/bazelisk/versions/9.9.9.json"));
  f.write("chips/esp32c3/chip.json", f.read("chips/esp32s3/chip.json"));
  assert.throws(() => validateRegistry(f.directory), /Unindexed entry: chips\/esp32c3/);
});

test("planned entries cannot advertise installable releases", (t) => {
  const f = fixture(t);
  f.mutate("toolchains/bazelisk/toolchain.json", (item) => { item.status = "planned"; });
  assert.throws(() => validateRegistry(f.directory), /Toolchain:/);
});

test("rejects an unpublished default version and a mismatched release identity", (t) => {
  const f = fixture(t);
  f.mutate("toolchains/bazelisk/toolchain.json", (item) => { item.defaultVersion = "9.9.9"; });
  assert.throws(() => validateRegistry(f.directory), /defaultVersion is not published/);
  f.mutate("toolchains/bazelisk/toolchain.json", (item) => { item.defaultVersion = "1.30.0"; });
  f.mutate(bazelisk, (release) => { release.id = "arm-gnu"; });
  assert.throws(() => validateRegistry(f.directory), /release identity mismatch/);
});

test("rejects credential-bearing sources and placeholder checksums", (t) => {
  const f = fixture(t);
  f.mutate(bazelisk, (release) => { release.platforms[host].sources[0].url = "https://user:token@example.com/tool"; });
  assert.throws(() => validateRegistry(f.directory), /Invalid HTTPS source/);
  f.mutate(bazelisk, (release) => {
    release.platforms[host].sources[0].url = "https://example.com/tool";
    release.platforms[host].sources[0].sha256 = "0".repeat(64);
  });
  assert.throws(() => validateRegistry(f.directory), /placeholder/);
});

test("rejects undeclared sources and incompatible source operations", (t) => {
  const f = fixture(t);
  f.mutate(bazelisk, (release) => { release.platforms[host].install[0].source = "missing"; });
  assert.throws(() => validateRegistry(f.directory), /unknown source/);
  f.mutate(bazelisk, (release) => { release.platforms[host].install[0] = { type: "checkout", source: "bazelisk", to: "sdk" }; });
  assert.throws(() => validateRegistry(f.directory), /incompatible source/);
});

test("rejects missing toolchains and toolchains unavailable on the host", (t) => {
  const f = fixture(t);
  f.mutate(bazelisk, (release) => { release.platforms[host].dependencies = [{ toolchain: "arm-gnu", version: "10.3.0" }]; });
  assert.throws(() => validateRegistry(f.directory), /unresolved toolchain arm-gnu@10\.3\.0/);
  publish(f, "toolchain", "arm-gnu", "10.3.0", { "linux-x86_64": recipe(f) });
  assert.throws(() => validateRegistry(f.directory), /does not support macos-arm64/);
});

test("rejects dependency cycles", (t) => {
  const f = fixture(t);
  publish(f, "toolchain", "arm-gnu", "10.3.0", { [host]: recipe(f, [{ toolchain: "bazelisk", version: "1.30.0" }]) });
  f.mutate(bazelisk, (release) => { release.platforms[host].dependencies = [{ toolchain: "arm-gnu", version: "10.3.0" }]; });
  assert.throws(() => validateRegistry(f.directory), /dependency cycle/);
});

test("resolves two versions of one toolchain in a published chip environment", (t) => {
  const f = fixture(t);
  publish(f, "toolchain", "arm-gnu", "10.3.0", { [host]: recipe(f) });
  publish(f, "toolchain", "arm-gnu", "14.3.0", { [host]: recipe(f) });
  publish(f, "toolchain", "xtensa-esp-elf", "14.2.0", { [host]: recipe(f, [{ toolchain: "arm-gnu", version: "14.3.0" }]) });
  publish(f, "sdk", "esp-idf", "6.2.0", {
    [host]: { ...recipe(f), targets: { esp32s3: { dependencies: [
      { toolchain: "arm-gnu", version: "10.3.0" },
      { toolchain: "xtensa-esp-elf", version: "14.2.0" },
    ] } } },
  });
  f.mutate("chips/esp32s3/chip.json", (chip) => { chip.status = "published"; });
  assert.equal(validateRegistry(f.directory).planned, 5);
});

test("rejects undeclared toolchain templates and temporary exported paths", (t) => {
  const f = fixture(t);
  f.mutate(bazelisk, (release) => { release.platforms[host].environment.variables.SDK_ROOT = "${toolchain:arm-gnu}/sdk"; });
  assert.throws(() => validateRegistry(f.directory), /undeclared template/);
  f.mutate(bazelisk, (release) => { release.platforms[host].environment.variables.SDK_ROOT = "${work}/sdk"; });
  assert.throws(() => validateRegistry(f.directory), /template/);
});

test("rejects undeclared host commands and remote uninstall scripts", (t) => {
  const f = fixture(t);
  f.mutate(bazelisk, (release) => {
    release.platforms[host].install.push({ type: "run", program: "bash", args: [], cwd: "bin", environment: {}, timeoutSeconds: 60 });
  });
  assert.throws(() => validateRegistry(f.directory), /must be declared/);
  f.mutate(bazelisk, (release) => {
    release.platforms[host].install.pop();
    release.uninstall = { program: "rm", args: ["-rf", "/"] };
  });
  assert.throws(() => validateRegistry(f.directory), /ToolchainRelease:/);
});

test("a published chip needs a published SDK release that supports its target", (t) => {
  const f = fixture(t);
  f.mutate("chips/esp32s3/chip.json", (chip) => { chip.status = "published"; });
  assert.throws(() => validateRegistry(f.directory), /SDK esp-idf is not published/);
  publish(f, "sdk", "esp-idf", "6.2.0", { [host]: { ...recipe(f), targets: { esp32c3: { dependencies: [] } } } });
  assert.throws(() => validateRegistry(f.directory), /does not support target esp32s3/);
  f.mutate("sdks/esp-idf/versions/6.2.0.json", (release) => { release.platforms[host].targets = { esp32s3: { dependencies: [] } }; });
  assert.equal(validateRegistry(f.directory).planned, 7);
});

test("SDK releases need chip targets; toolchain releases cannot declare them", (t) => {
  const f = fixture(t);
  publish(f, "sdk", "esp-idf", "6.2.0", { [host]: recipe(f) });
  assert.throws(() => validateRegistry(f.directory), /SdkRelease:/);
  f.mutate(bazelisk, (release) => { release.platforms[host].targets = { esp32s3: { dependencies: [] } }; });
  f.mutate("sdks/esp-idf/versions/6.2.0.json", (release) => { release.platforms[host].targets = { esp32s3: { dependencies: [] } }; });
  assert.throws(() => validateRegistry(f.directory), /ToolchainRelease:/);
});

const environmentPath = "environments/gizos/environment.json";

test("old registry indexes remain valid without environments", (t) => {
  const f = fixture(t);
  f.mutate("registry.json", (registry) => { delete registry.environments; });
  assert.throws(() => validateRegistry(f.directory), /Unindexed entry: environments\/gizos/);
  rmSync(join(f.directory, "environments"), { recursive: true });
  assert.equal(validateRegistry(f.directory).environments, 0);
});

test("environment entries must be indexed, match their ID and contain no release layer", (t) => {
  const f = fixture(t);
  f.write("environments/extra/environment.json", f.read(environmentPath));
  assert.throws(() => validateRegistry(f.directory), /Unindexed entry: environments\/extra/);
  rmSync(join(f.directory, "environments/extra"), { recursive: true });
  f.mutate(environmentPath, (item) => { item.id = "wrong"; });
  assert.throws(() => validateRegistry(f.directory), /id mismatch/);
  f.mutate(environmentPath, (item) => { item.id = "gizos"; item.defaultVersion = "1.0.0"; });
  assert.throws(() => validateRegistry(f.directory), /Environment:/);
  f.mutate(environmentPath, (item) => { delete item.defaultVersion; });
  f.write("environments/gizos/versions/1.0.0.json", {});
  assert.throws(() => validateRegistry(f.directory), /Unindexed entry: environments\/gizos\/versions/);
});

test("published environments require exact published dependencies; planned environments can be empty", (t) => {
  const f = fixture(t);
  f.mutate(environmentPath, (item) => { item.dependencies = []; });
  assert.throws(() => validateRegistry(f.directory), /Environment:/);
  f.mutate(environmentPath, (item) => { item.status = "planned"; });
  assert.equal(validateRegistry(f.directory).planned, 10);
  f.mutate(environmentPath, (item) => { item.status = "ready"; });
  assert.throws(() => validateRegistry(f.directory), /Environment:/);
  f.mutate(environmentPath, (item) => { item.status = "published"; item.dependencies = [{ toolchain: "python", version: "latest" }]; });
  assert.throws(() => validateRegistry(f.directory), /Environment:/);
  f.mutate(environmentPath, (item) => { item.dependencies[0].version = "9.9.9"; });
  assert.throws(() => validateRegistry(f.directory), /unresolved toolchain python@9\.9\.9/);
  f.mutate(environmentPath, (item) => { item.dependencies = [{ toolchain: "arm-gnu", version: "10.3.0" }]; });
  assert.throws(() => validateRegistry(f.directory), /unresolved toolchain arm-gnu@10\.3\.0/);
});

test("an environment's supported hosts are the intersection of exact dependency releases", (t) => {
  const f = fixture(t);
  publish(f, "toolchain", "arm-gnu", "10.3.0", { "linux-arm64": recipe(f) });
  publish(f, "toolchain", "jieli", "1.0.0", { "windows-x86_64": recipe(f) });
  f.mutate(environmentPath, (item) => { item.dependencies = [
    { toolchain: "arm-gnu", version: "10.3.0" }, { toolchain: "jieli", version: "1.0.0" },
  ]; });
  assert.throws(() => validateRegistry(f.directory), /no common supported host/);
  f.mutate("toolchains/jieli/versions/1.0.0.json", (release) => { release.platforms["linux-arm64"] = recipe(f); });
  assert.equal(validateRegistry(f.directory).environments, 1);
});

test("multiple exact versions coexist directly and transitively, with shared graph nodes deduplicated", (t) => {
  const f = fixture(t);
  f.mutate("toolchains/python/versions/3.11.18.json", (release) => {
    release.platforms[host].dependencies = [{ toolchain: "python", version: "3.12.16" }];
  });
  f.mutate(environmentPath, (item) => { item.dependencies.push({ toolchain: "python", version: "3.11.18" }); });
  assert.equal(validateRegistry(f.directory).releases, 4);
  // A cycle through two versions of the same tool is still a cycle.
  f.mutate("toolchains/python/versions/3.12.16.json", (release) => {
    release.platforms[host].dependencies = [{ toolchain: "python", version: "3.11.18" }];
  });
  assert.throws(() => validateRegistry(f.directory), /dependency cycle.*python@3\./);
});

test("rejects duplicate exact dependencies in environments, recipes and combined SDK target dependencies", (t) => {
  const f = fixture(t);
  f.mutate(environmentPath, (item) => { item.dependencies.push({ toolchain: "python", version: "3.12.16" }); });
  assert.throws(() => validateRegistry(f.directory), /duplicate dependency python@3\.12\.16/);
  f.mutate(environmentPath, (item) => { item.dependencies.pop(); });
  const dependency = { toolchain: "python", version: "3.12.16" };
  f.mutate(bazelisk, (release) => { release.platforms[host].dependencies = [dependency, dependency]; });
  assert.throws(() => validateRegistry(f.directory), /duplicate dependency python@3\.12\.16/);
  f.mutate(bazelisk, (release) => { release.platforms[host].dependencies = []; });
  publish(f, "sdk", "esp-idf", "6.2.0", {
    [host]: { ...recipe(f, [dependency]), targets: { esp32s3: { dependencies: [dependency] } } },
  });
  assert.throws(() => validateRegistry(f.directory), /duplicate dependency python@3\.12\.16/);
});

test("Python recipes use pinned six-host archives, isolated paths and file checks only", () => {
  const triples = {
    "macos-arm64": "aarch64-apple-darwin", "macos-x86_64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x86_64": "x86_64-unknown-linux-gnu",
    "windows-arm64": "aarch64-pc-windows-msvc", "windows-x86_64": "x86_64-pc-windows-msvc",
  };
  for (const version of ["3.11.18", "3.12.16"]) {
    const manifest = JSON.parse(readFileSync(join(root, `toolchains/python/versions/${version}.json`), "utf8"));
    assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(triples).sort());
    for (const [platform, entry] of Object.entries(manifest.platforms)) {
      const windows = platform.startsWith("windows-");
      assert.deepEqual(entry.requires, []);
      assert.deepEqual(entry.install, [{ type: "extract", source: "python", to: "python", format: "tar.gz", stripComponents: 1 }]);
      assert.deepEqual(entry.environment, { prependPath: [windows ? "python" : "python/bin"], variables: {} });
      assert.deepEqual(entry.checks, [{ type: "file", path: windows ? "python/python.exe" : "python/bin/python3", executable: !windows }]);
      assert.equal(entry.sources.length, 1);
      assert.equal(entry.sources[0].url, `https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-${version}%2B20261110-${triples[platform]}-install_only_stripped.tar.gz`);
      assert.match(entry.sources[0].sha256, /^[a-f0-9]{64}$/);
      assert.notEqual(entry.sources[0].sha256, "0".repeat(64));
      assert.ok(entry.sources[0].size > 20_000_000);
    }
  }
  const toolchain = JSON.parse(readFileSync(join(root, "toolchains/python/toolchain.json"), "utf8"));
  assert.equal(toolchain.category, "runtime");
  assert.equal(toolchain.defaultVersion, "3.12.16");
  assert.ok(validateDocument(toolchain));
  assert.throws(() => validateDocument({ ...toolchain, category: "interpreter" }), /Toolchain:/);
});

test("the published Bazelisk 1.30.0 manifest is byte-for-byte unchanged", () => {
  assert.equal(createHash("sha256").update(readFileSync(join(root, bazelisk))).digest("hex"), "97d0bb300260d2562d79970714c568c5042bf1c283533c29f265d51ee35b74de");
  const toolchain = JSON.parse(readFileSync(join(root, "toolchains/bazelisk/toolchain.json"), "utf8"));
  assert.equal(toolchain.defaultVersion, "1.30.0");
  assert.deepEqual(toolchain.releases.map(({ version }) => version).sort(), ["1.29.0", "1.30.0"]);
});
