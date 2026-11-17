import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  const f = {
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
  // These semantic tests publish synthetic vendor releases. Reset chip cards
  // as well, so no published chip refers to a release removed by the fixture.
  for (const id of f.read("registry.json").chips) {
    f.mutate(`chips/${id}/chip.json`, (chip) => { chip.status = "planned"; });
  }
  for (const [type, ids] of [["sdk", f.read("registry.json").sdks], ["toolchain", ["arm-gnu", "xtensa-esp-elf", "jieli"]]]) {
    for (const id of ids) {
      f.mutate(`${type}s/${id}/${type}.json`, (item) => {
        item.status = "planned";
        item.releases = [];
        delete item.defaultVersion;
      });
      rmSync(join(directory, `${type}s/${id}/versions`), { recursive: true, force: true });
    }
  }
  f.initialStats = validateRegistry(directory);
  return f;
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

test("official registry validates offline with generic tools and minimal guest formulae", () => {
  assert.deepEqual(validateRegistry(root), { chips: 9, environments: 1, sdks: 7, toolchains: 66, planned: 0, releases: 77, platforms: 119 });
});

test("SDK formulae reference upstream Git and package files without repacked releases", () => {
  const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
  for (const id of registry.sdks) {
    const item = JSON.parse(readFileSync(join(root, `sdks/${id}/sdk.json`), "utf8"));
    for (const release of item.releases) {
      const document = JSON.parse(readFileSync(join(root, `sdks/${id}/${release.manifest}`), "utf8"));
      for (const recipe of Object.values(document.platforms)) {
        const source = recipe.sources.find((source) => source.id === "sdk");
        assert.equal(source.type, "git");
        assert.match(source.url, /^https:\/\/github\.com\/GizClaw\/[A-Za-z0-9_.-]+\.git$/);
        assert.match(source.commit, /^[a-f0-9]{40}$/);
        assert.equal(source.submodules, true);
        assert.ok(recipe.requires.includes("git-lfs"));
        assert.ok(recipe.dependencies.some((dependency) => dependency.toolchain === "git-lfs" && dependency.version === "3.8.1"));
        assert.ok(!recipe.install.some((step) => step.type === "run" && step.args.includes("fetch")));
        assert.ok(recipe.install.some((step) => step.type === "checkout" && step.source === "sdk" && step.to === "payload/sdk"));
        for (const file of recipe.sources.filter((source) => source.type === "file")) {
          assert.ok(["files.pythonhosted.org", "dl.espressif.com"].includes(new URL(file.url).hostname), file.url);
          assert.ok(!file.url.includes("gizmoth-sdk-source-"));
        }
        if (id === "jieli-ac791n") assert.ok(recipe.requires.includes("git-lfs"));
      }
    }
  }
});

test("ESP Python formula uses upstream esptool source and local offline setup", () => {
  const item = JSON.parse(readFileSync(join(root, "sdks/esp-idf/sdk.json"), "utf8"));
  const release = JSON.parse(readFileSync(join(root, `sdks/esp-idf/versions/${item.defaultVersion}.json`), "utf8"));
  for (const recipe of Object.values(release.platforms)) {
    const source = recipe.sources.find((source) => source.url.endsWith("/esptool-5.6.0.tar.gz"));
    assert.equal(source.sha256, "86c7249e9cc3a824e032ede9ba20abad057a2c49e231418cc4f02b177bb36f42");
    assert.equal(source.size, 532408);
    assert.ok(recipe.install.some((step) => step.type === "run" && step.args.includes("--no-build-isolation") && step.args.includes("--no-index") && step.args.includes("--require-hashes")));
    for (const toolchain of ["xtensa-esp-elf", "riscv32-esp-elf"]) {
      assert.ok(recipe.dependencies.some((dependency) => dependency.toolchain === toolchain && dependency.version === "16.1.0+20260609"));
    }
    assert.ok(recipe.dependencies.some((dependency) => dependency.toolchain === "ninja" && dependency.version === "1.13.2"));
    const marker = recipe.install.find((step) => step.type === "run" && step.args.includes("${prefix}/tools/python_env/idf6.2_py3.12_env/idf_version.txt"));
    assert.ok(marker);
    assert.match(marker.args[2], /write_text\("6\.2"/);
    assert.equal(recipe.environment.variables.IDF_PYTHON_ENV_PATH, "${prefix}/tools/python_env/idf6.2_py3.12_env");
  }
});

// Pins and installation directory names from tools/tools.json at
// ddb3852ab5c7f9e6dbc268203ef9d612de391bf8 (SHA-256 3bb10e1936110efae9b17baad59143483d635be303535f9850d66d16a94d7a69).
// These tests use empty local executable fixtures, never downloaded payloads.
test("ESP required tool pins and SDK links match the exact upstream commit", (t) => {
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const sdk = read("sdks/esp-idf/versions/6.2.0-dev.gddb3852.json");
  assert.deepEqual(Object.keys(sdk.platforms), ["linux-arm64"]);
  const recipe = sdk.platforms["linux-arm64"];
  const required = [
    ["xtensa-esp-elf-gdb", "17.1.0+20260402", "17.1_20260402", "xtensa-esp-elf-gdb", "xtensa-esp-elf-gdb-no-python", "00290ffe21b2916ffd343fd28ac34fc8b93e99b992a3656fa09b4f2bdc564bea", 41589296],
    ["riscv32-esp-elf-gdb", "17.1.0+20260402", "17.1_20260402", "riscv32-esp-elf-gdb", "riscv32-esp-elf-gdb-no-python", "f185d924497750f254290a32c48163c08e3b2a29eb248d739d90990ebee17f44", 42035040],
    ["openocd-esp32", "0.12.0-esp32-20260831", "v0.12.0-esp32-20260831", "openocd-esp32", "openocd", "59236b2160dfcef1db3dbb0b7718e0ed9e127630dd65c5ccb6f13ef56c1e84ba", 2608313],
    ["esp-clangd", "21.1.3+20260408", "esp-21.1.3_20260408", "esp-clangd", "clangd", "468e6fa03def6bcf0c0469d25b8d8b86212e5a94716d0b3db149f21b77791c54", 14706612],
    ["esp-idf-configdep", "0.2.3", "0.2.3", "esp-idf-configdep-0.2.3", "esp-idf-configdep", "5a1491b2009c9ed805b90e8efb27704ba96cc036b7aaca343310db846a9183a9", 60457],
  ];
  const directory = mkdtempSync(join(tmpdir(), "gizmoth-idf-layout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prefix = join(directory, "SDK with spaces");
  const selected = new Map();
  for (const { toolchain, version } of recipe.dependencies) {
    const installation = join(directory, toolchain);
    selected.set(toolchain, installation);
    const dependency = read(`toolchains/${toolchain}/versions/${version}.json`).platforms["linux-arm64"];
    for (const check of dependency.checks.filter((check) => check.type === "file")) {
      const file = join(installation, check.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "", { mode: check.executable ? 0o755 : 0o644 });
    }
  }
  mkdirSync(join(prefix, "python-inputs"), { recursive: true });
  writeFileSync(join(prefix, "python-inputs/espidf.constraints.v6.2.txt"), "fixture");
  const layout = recipe.install.find((step) => step.program === "sh");
  const substitute = (value) => value.replaceAll("${prefix}", prefix).replace(/\$\{toolchain:([^}]+)\}/g, (_, id) => {
    assert.ok(selected.has(id), id);
    return selected.get(id);
  });
  execFileSync("sh", layout.args.map(substitute), { cwd: prefix });
  for (const [id, version, upstream, container, binary, sha256, size] of required) {
    assert.ok(recipe.dependencies.some((d) => d.toolchain === id && d.version === version));
    const release = read(`toolchains/${id}/versions/${version}.json`);
    assert.deepEqual(Object.keys(release.platforms), ["linux-arm64"]);
    const tool = release.platforms["linux-arm64"];
    assert.equal(tool.sources[0].sha256, sha256);
    assert.equal(tool.sources[0].size, size);
    assert.match(tool.sources[0].url, /^https:\/\/github\.com\/espressif\//);
    assert.equal(tool.install[0].stripComponents, 1);
    const path = `tools/tools/${id}/${upstream}/${container}/bin/${binary}`;
    assert.ok(recipe.checks.some((check) => check.path === path && check.executable), path);
    assert.equal(readFileSync(join(prefix, path), "utf8"), "");
  }
  const qualifier = recipe.checks.find((check) => check.args?.includes("--non-interactive") && check.args.includes("check"));
  assert.equal(qualifier.program, "${prefix}/tools/python_env/idf6.2_py3.12_env/bin/python3");
  assert.deepEqual(qualifier.args, ["${prefix}/payload/sdk/tools/idf_tools.py", "--non-interactive", "check"]);
  assert.equal(recipe.environment.variables.OPENOCD_SCRIPTS, "${prefix}/tools/tools/openocd-esp32/v0.12.0-esp32-20260831/openocd-esp32/share/openocd/scripts");
});

test("configdep qualification captures stderr versions and preserves tool failures", (t) => {
  const recipe = JSON.parse(readFileSync(join(root, "toolchains/esp-idf-configdep/versions/0.2.3.json"), "utf8")).platforms["linux-arm64"];
  const check = recipe.checks.find((entry) => entry.type === "command");
  const directory = mkdtempSync(join(tmpdir(), "gizmoth-configdep-check-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prefix = join(directory, "tool prefix with spaces");
  const tool = join(prefix, "toolchain/bin/esp-idf-configdep");
  mkdirSync(dirname(tool), { recursive: true });
  writeFileSync(tool, '#!/bin/sh\nprintf "version: 0.2.3\\n" >&2\nexit "${FIXTURE_EXIT:-0}"\n', { mode: 0o755 });
  const args = check.args.map((value) => value.replaceAll("${prefix}", prefix));
  const output = execFileSync(check.program, args, { encoding: "utf8", env: { ...process.env, FIXTURE_EXIT: "0" } });
  assert.ok(output.includes(check.stdoutContains));
  assert.throws(() => execFileSync(check.program, args, { stdio: "pipe", env: { ...process.env, FIXTURE_EXIT: "7" } }), (error) => error.status === 7);
});

test("ESP debugging declares native USB, udev, atomic and managed Python requirements", () => {
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const libs = read("toolchains/linux-esp-debug-libs/versions/12.0.0.json").platforms["linux-arm64"];
  assert.equal(libs.guestRoot, true);
  assert.deepEqual(libs.dependencies, [{ toolchain: "linux-runtime", version: "12.0.0" }]);
  assert.deepEqual(libs.sources.map((source) => [source.id, source.sha256, source.size]), [
    ["libatomic1", "1693aa13ce2b30d061a519fc28b77b9bab8c8e45804ced5969d99821e1bc2159", 9568],
    ["libusb-1-0-0", "e0648086b231c9204514d31480d517cb1b51e301ac39e69335a67d01ec785608", 59976],
    ["libudev1", "b76444b0259abfa416f8c1d9a652d208a24770667a1181aa52317b74d12a7a72", 103236],
  ]);
  for (const [id, version] of [["xtensa-esp-elf-gdb", "17.1.0+20260402"], ["riscv32-esp-elf-gdb", "17.1.0+20260402"], ["openocd-esp32", "0.12.0-esp32-20260831"]]) {
    const tool = read(`toolchains/${id}/versions/${version}.json`).platforms["linux-arm64"];
    assert.ok(tool.dependencies.some((d) => d.toolchain === "linux-esp-debug-libs" && d.version === "12.0.0"));
    if (id.endsWith("-gdb")) {
      assert.ok(tool.dependencies.some((d) => d.toolchain === "python" && d.version === "3.12.16"));
      assert.ok(tool.checks.some((check) => check.stdoutContains === "gizmoth-gdb-python (3, 12)"));
    }
  }
});

test("every GizOS embedded target resolves to a complete candidate SDK", () => {
  const mappings = {
    esp32s3: "esp-idf", esp32p4: "esp-idf", esp32s31: "esp-idf", esp32c5: "esp-idf",
    bk7258: "beken-bk7258", ac695n: "jieli-ac695n", ac707n: "jieli-ac707n", ac791n: "jieli-ac791n",
  };
  for (const [id, sdk] of Object.entries(mappings)) {
    const chip = JSON.parse(readFileSync(join(root, `chips/${id}/chip.json`), "utf8"));
    assert.equal(chip.status, "published");
    assert.equal(chip.sdk, sdk);
    assert.equal(chip.target, id);
    const item = JSON.parse(readFileSync(join(root, `sdks/${sdk}/sdk.json`), "utf8"));
    const release = JSON.parse(readFileSync(join(root, `sdks/${sdk}/versions/${item.defaultVersion}.json`), "utf8"));
    assert.ok(release.platforms["linux-arm64"]);
    for (const recipe of Object.values(release.platforms)) assert.ok(recipe.targets[id]);
  }
  const native = JSON.parse(readFileSync(join(root, "sdks/beken-bk7259/sdk.json"), "utf8"));
  assert.equal(native.status, "published");
  assert.equal(native.defaultVersion, "4.0.1+g06cb0f2d");
  const chip = JSON.parse(readFileSync(join(root, "chips/bk7259/chip.json"), "utf8"));
  assert.equal(chip.status, "published");
  assert.equal(chip.sdk, native.id);
  const release = JSON.parse(readFileSync(join(root, `sdks/${native.id}/versions/${native.defaultVersion}.json`), "utf8"));
  assert.deepEqual(Object.keys(release.platforms), ["linux-x86_64"]);
  assert.ok(release.platforms["linux-x86_64"].targets[chip.target]);
  assert.match(native.notes, /ARM64 SDK support remains planned/);
});

test("Beken Python 3.11 locks match exact native requirements and compatible original wheels", () => {
  const required = { cffi: "2.1.1", click: "8.4.2", "click-option-group": "0.5.9", cryptography: "50.0.0", pycparser: "3.0", pycryptodome: "3.23.0" };
  for (const id of ["beken-bk7258", "beken-bk-idk", "beken-bk7259"]) {
    const item = JSON.parse(readFileSync(join(root, `sdks/${id}/sdk.json`), "utf8"));
    const release = JSON.parse(readFileSync(join(root, `sdks/${id}/versions/${item.defaultVersion}.json`), "utf8"));
    for (const [host, recipe] of Object.entries(release.platforms)) {
      assert.ok(recipe.dependencies.some((dependency) => dependency.toolchain === "python" && dependency.version === "3.11.18"));
      const generator = recipe.install.find((step) => step.type === "run" && step.args[0] === "-I" && step.args[1] === "-c");
      const lock = JSON.parse(generator.args.at(-1))["requirements.lock"];
      for (const [name, version] of Object.entries(required)) assert.ok(lock.includes(`${name}==${version} --hash=sha256:`));
      for (const file of recipe.sources.filter((source) => source.type === "file")) {
        const filename = new URL(file.url).pathname.split("/").at(-1);
        assert.match(filename, /-(?:py\d(?:\.py\d)*-none-any|cp311-cp311-manylinux[^/]+|cp(?:37|311)-abi3-manylinux[^/]+)\.whl$/);
        if (!filename.includes("none-any")) assert.ok(filename.includes(host === "linux-arm64" ? "aarch64" : "x86_64"));
        assert.ok(lock.includes(`--hash=sha256:${file.sha256}`));
        assert.ok(recipe.install.some((step) => step.type === "copy" && step.source === file.id && step.to === `wheelhouse/${filename}`));
      }
      assert.ok(recipe.checks.some((check) => check.args?.some((argument) => argument.includes("import distutils,distutils.util"))));
      assert.ok(recipe.checks.some((check) => check.program === "${prefix}/python-env/bin/python3" && check.args?.includes("check")));
    }
  }
});

test("BK7259 keeps native Python and compiler selection consistent while ARM64 is unsupported", () => {
  const release = JSON.parse(readFileSync(join(root, "sdks/beken-bk7259/versions/4.0.1+g06cb0f2d.json"), "utf8"));
  assert.deepEqual(Object.keys(release.platforms), ["linux-x86_64"]);
  const recipe = release.platforms["linux-x86_64"];
  assert.equal(recipe.sources.find((source) => source.id === "sdk").commit, "06cb0f2d9cdeab571ec5be2d54398c67e097a4cc");
  assert.ok(recipe.dependencies.some((dependency) => dependency.toolchain === "arm-gnu" && dependency.version === "14.3.1"));
  assert.ok(!recipe.dependencies.some((dependency) => ["linux-qemu-user", "linux-x86-runtime"].includes(dependency.toolchain)));
  assert.equal(recipe.environment.variables.COMPILER_TOOLCHAIN_PATH, "${toolchain:arm-gnu}/toolchain/bin");
  assert.equal(recipe.environment.variables.PYTHONPATH, "${prefix}/payload/sdk/tools/env_tools/bk_py_libs");
  assert.equal(recipe.environment.variables.ARMINO_COMPONENT_MANAGER, "0");
  const generator = recipe.install.find((step) => step.type === "run" && step.args[0] === "-I" && step.args[1] === "-c");
  const lock = JSON.parse(generator.args.at(-1))["requirements.lock"];
  assert.ok(lock.includes("openpyxl==3.1.5 --hash=sha256:5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2"));
  assert.ok(lock.includes("et-xmlfile==2.0.0 --hash=sha256:7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa"));
  assert.equal(recipe.sources.filter((source) => source.type === "file").length, 15);
  const crypto = recipe.checks.find((check) => check.stdoutContains === "gizmoth-bk7259-native-crypto-ok");
  assert.ok(crypto.args.includes("${prefix}/payload/sdk/tools/env_tools/beken_utils"));
  assert.ok(crypto.args[2].includes("os.chdir(sys.argv[1])"));
  assert.ok(crypto.args[2].includes("ctypes.CDLL('./scripts/libcommon.so')"));
});

test("Arm14.3 uses verified upstream archives and preserves the published Arm10.3 manifest", () => {
  const item = JSON.parse(readFileSync(join(root, "toolchains/arm-gnu/toolchain.json"), "utf8"));
  assert.equal(item.defaultVersion, "10.3.1");
  assert.equal(createHash("sha256").update(readFileSync(join(root, "toolchains/arm-gnu/versions/10.3.1.json"))).digest("hex"), "05ff7fbab55c1922a4fe9f305f22a71f477b0f8fd7d2dbbbd5fa87053a07e84a");
  const release = JSON.parse(readFileSync(join(root, "toolchains/arm-gnu/versions/14.3.1.json"), "utf8"));
  const expected = {
    "linux-arm64": ["aarch64", 148423580, "2d465847eb1d05f876270494f51034de9ace9abe87a4222d079f3360240184d3"],
    "linux-x86_64": ["x86_64", 149789432, "8f6903f8ceb084d9227b9ef991490413014d991874a1e34074443c2a72b14dbd"],
  };
  for (const [host, [arch, size, hash]] of Object.entries(expected)) {
    const recipe = release.platforms[host];
    assert.equal(recipe.sources[0].url, `https://armkeil.blob.core.windows.net/developer/Files/downloads/gnu/14.3.rel1/binrel/arm-gnu-toolchain-14.3.rel1-${arch}-arm-none-eabi.tar.xz`);
    assert.equal(recipe.sources[0].sha256, hash);
    assert.equal(recipe.sources[0].size, size);
    assert.ok(recipe.dependencies.some((dependency) => dependency.toolchain === "linux-network-libs" && dependency.version === "12.0.0"));
    const link = recipe.checks.find((check) => check.stdoutContains === "gizmoth-arm-gnu-link-ok");
    assert.ok(link.args.at(-1).includes("-mcpu=cortex-m55"));
    assert.ok(link.args.at(-1).includes("-mcpu=cortex-m52+nodsp"));
  }
});

test("SDK clean-tree check rejects tracked, untracked and missing submodule changes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gizmoth-sdk-check-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "sdk");
  const module = join(directory, "module-source");
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Registry test", "-c", "user.email=registry@example.invalid", ...args], { cwd, stdio: "pipe" });
  for (const path of [repo, module]) {
    mkdirSync(path);
    git(path, "init");
    writeFileSync(join(path, "tracked"), "pinned source\n");
    git(path, "add", "tracked");
    git(path, "commit", "-m", "fixture");
  }
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", module, "module");
  git(repo, "commit", "-am", "add module");
  const release = JSON.parse(readFileSync(join(root, "sdks/esp-idf/versions/6.2.0-dev.gddb3852.json"), "utf8"));
  const check = release.platforms["linux-arm64"].checks.find((check) => check.stdoutContains === "gizmoth-sdk-clean");
  const run = () => execFileSync("python3", check.args.map((arg) => arg.replace("${prefix}/payload/sdk", repo)), { encoding: "utf8", stdio: "pipe" });
  assert.match(run(), /gizmoth-sdk-clean/);
  writeFileSync(join(repo, "untracked"), "unexpected\n");
  assert.throws(run);
  rmSync(join(repo, "untracked"));
  writeFileSync(join(repo, "tracked"), "changed\n");
  assert.throws(run);
  git(repo, "checkout", "--", "tracked");
  writeFileSync(join(repo, "module", "untracked"), "unexpected nested file\n");
  assert.throws(run);
  rmSync(join(repo, "module", "untracked"));
  git(repo, "submodule", "deinit", "--force", "module");
  assert.throws(run);
});

test("Linux guest roots merge deb layers, and bootstrap implies guestRoot", (t) => {
  const f = fixture(t);
  const rootRecipe = recipe(f);
  rootRecipe.bootstrap = true;
  rootRecipe.install = [
    { type: "extract", source: rootRecipe.sources[0].id, to: ".", format: "deb", stripComponents: 0 },
    { type: "extract", source: rootRecipe.sources[0].id, to: ".", format: "deb", stripComponents: 0 },
  ];
  publish(f, "toolchain", "arm-gnu", "10.3.0", { "linux-arm64": rootRecipe });
  assert.ok(validateRegistry(f.directory));
  const path = "toolchains/arm-gnu/versions/10.3.0.json";
  for (const mutate of [
    (value) => { value.platforms = { "macos-arm64": rootRecipe }; },
    (value) => { value.platforms["linux-arm64"].bootstrap = false; },
    (value) => { value.platforms["linux-arm64"].install[0].stripComponents = 1; },
    (value) => { value.platforms["linux-arm64"].install[0].format = "tar.gz"; },
    (value) => { value.platforms["linux-arm64"].install.forEach((step) => { step.to = "usr"; }); },
    (value) => { value.platforms["linux-arm64"].install[0] = { type: "copy", source: rootRecipe.sources[0].id, to: ".", executable: false }; },
  ]) {
    const original = f.read(path);
    f.mutate(path, mutate);
    assert.throws(() => validateRegistry(f.directory));
    f.write(path, original);
  }
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
  assert.equal(validateRegistry(f.directory).planned, f.initialStats.planned - 4);
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
  assert.equal(validateRegistry(f.directory).planned, f.initialStats.planned - 2);
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
  assert.equal(validateRegistry(f.directory).planned, f.initialStats.planned + 1);
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
  assert.equal(validateRegistry(f.directory).releases, f.initialStats.releases);
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

test("Linux formulae pin raw Debian payloads and isolate foreign tool paths", () => {
  const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
  const ids = registry.toolchains.filter((id) => id.startsWith("linux-"));
  assert.equal(ids.length, 50);
  for (const id of ids) {
    const release = JSON.parse(readFileSync(join(root, `toolchains/${id}/versions/12.0.0.json`), "utf8"));
    for (const [platform, recipe] of Object.entries(release.platforms)) {
      assert.match(platform, /^linux-/);
      assert.equal(recipe.guestRoot, true);
      assert.deepEqual(recipe.requires, []);
      assert.deepEqual(recipe.environment.prependPath, []);
      for (const source of recipe.sources) {
        assert.match(source.url, /^https:\/\/deb\.debian\.org\/debian\/pool\/main\/.+\.deb$/);
        assert.match(source.sha256, /^[a-f0-9]{64}$/);
        assert.ok(source.size > 0);
      }
      for (const step of recipe.install) {
        assert.equal(step.type, "extract");
        assert.equal(step.format, "deb");
        assert.equal(step.stripComponents, 0);
        assert.equal(step.to, id.startsWith("linux-x86-") || (id === "linux-jieli-libs" && platform === "linux-arm64") ? "opt/gizmoth/x86_64" : ".");
      }
      if (id === "linux-locale") {
        assert.ok(recipe.checks.some((check) => check.type === "command" && check.program === "${prefix}/usr/bin/locale" && check.stdoutContains === "UTF-8"));
      } else if (id === "linux-text-tools") {
        assert.ok(recipe.checks.some((check) => check.type === "command" && check.program === "${prefix}/usr/bin/awk" && check.stdoutContains === "gizmoth-awk-ok"));
      } else {
        assert.ok(recipe.checks.every((check) => check.type === "file"));
      }
      if (id.startsWith("linux-x86-") || id === "linux-qemu-user") assert.equal(platform, "linux-arm64");
      assert.equal(recipe.bootstrap ?? false, id === "linux-runtime");
    }
  }
});

test("JieLi postbuild adds the observed headless runtime without mutating the published release", () => {
  const load = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const oldPath = "toolchains/jieli-postbuild/versions/2026.7.28+1.json";
  assert.equal(createHash("sha256").update(readFileSync(join(root, oldPath))).digest("hex"), "b1b7f7f5545753f507e90cf0a0b674a94a910a4cfa94db68ad823beab348a6ba");
  const old = load(oldPath);
  const current = load("toolchains/jieli-postbuild/versions/2026.7.28+2.json");
  for (const platform of ["linux-arm64", "linux-x86_64"]) {
    const recipe = current.platforms[platform];
    assert.deepEqual(recipe.sources, old.platforms[platform].sources);
    assert.deepEqual(recipe.install, old.platforms[platform].install);
    assert.deepEqual(recipe.environment, old.platforms[platform].environment);
    assert.ok(recipe.dependencies.some((d) => d.toolchain === "linux-jieli-libs" && d.version === "12.0.0"));
    const check = recipe.checks.find((c) => c.type === "command");
    assert.equal(check.stdoutContains, "JIELI_POSTBUILD_LIBRARIES_OK");
    assert.match(check.args[1], /LD_TRACE_LOADED_OBJECTS=1/);
    assert.match(check.args[1], /not found/);
    assert.doesNotMatch(check.args[1], /--download|--reset|--flash/);
    const sources = new Set();
    const visited = new Set();
    function collect(id, version) {
      const key = `${id}@${version}`;
      if (visited.has(key)) return;
      visited.add(key);
      const layer = load(`toolchains/${id}/versions/${version}.json`).platforms[platform];
      for (const source of layer.sources) sources.add(source.id);
      for (const d of layer.dependencies) collect(d.toolchain, d.version);
    }
    collect("linux-jieli-libs", "12.0.0");
    for (const source of ["libsm6", "libice6", "libuuid1", "libxcb1", "libxkbcommon0", "libfontconfig1", "libfreetype6", "libgbm1", "libdrm2", "libegl1", "libgl1", "libglvnd0", "libglx0", "fonts-dejavu-core", "xkb-data"]) assert.ok(sources.has(source), `${platform}: missing ${source}`);
  }
});

test("the published Bazelisk 1.30.0 manifest is byte-for-byte unchanged", () => {
  assert.equal(createHash("sha256").update(readFileSync(join(root, bazelisk))).digest("hex"), "97d0bb300260d2562d79970714c568c5042bf1c283533c29f265d51ee35b74de");
  const toolchain = JSON.parse(readFileSync(join(root, "toolchains/bazelisk/toolchain.json"), "utf8"));
  assert.equal(toolchain.defaultVersion, "1.30.0");
  assert.deepEqual(toolchain.releases.map(({ version }) => version).sort(), ["1.29.0", "1.30.0"]);
});
