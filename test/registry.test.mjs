import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { safeRelative, validateRegistry } from "../scripts/validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiVersion = "devenv.gizmoth.dev/v1alpha1";
const bazelisk = "toolchains/bazelisk/versions/1.30.0.json";
const host = "macos-arm64";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gizmoth-devenv-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, "registry.json"), join(directory, "registry.json"));
  for (const entry of ["chips", "sdks", "toolchains"]) cpSync(join(root, entry), join(directory, entry), { recursive: true });
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

test("official registry validates offline: one published toolchain, everything else planned", () => {
  assert.deepEqual(validateRegistry(root), { chips: 3, sdks: 3, toolchains: 4, planned: 9, releases: 1, platforms: 6 });
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

test("rejects two versions of one toolchain in a chip environment", (t) => {
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
  assert.throws(() => validateRegistry(f.directory), /version conflict for arm-gnu/);
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
