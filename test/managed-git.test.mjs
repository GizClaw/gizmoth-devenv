import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const gitPath = "toolchains/linux-git/versions/12.0.1.json";
const git = read(gitPath);
const legacyGit = read("toolchains/linux-git/versions/12.0.0.json");
const lfs = read("toolchains/git-lfs/versions/3.8.1+gizmoth.1.json");
const legacyLfs = read("toolchains/git-lfs/versions/3.8.1.json");

// Never download or execute upstream files here. The shell recipe runs only on
// synthetic payloads; actual Linux command checks belong to GizMoth integration.
test("managed Git and Git LFS defaults preserve published manifests and upstream pins", () => {
  for (const [path, digest] of [
    ["toolchains/linux-git/versions/12.0.0.json", "e4a2878331da0460a0e4e0e312468f4f864ff58125fe50411dc0669a06d72100"],
    ["toolchains/git-lfs/versions/3.8.1.json", "69129e2949812ee29be68c9cc7ec6583a8adbd957f652d5e2a66d7d978654d9e"],
  ]) assert.equal(createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), digest);
  assert.equal(read("toolchains/linux-git/toolchain.json").defaultVersion, git.version);
  assert.equal(read("toolchains/git-lfs/toolchain.json").defaultVersion, lfs.version);
  assert.deepEqual(Object.keys(git.platforms).sort(), ["linux-arm64", "linux-x86_64"]);
  for (const [platform, recipe] of Object.entries(git.platforms)) {
    assert.equal(recipe.guestRoot, false);
    assert.equal(recipe.bootstrap ?? false, false);
    assert.deepEqual(recipe.sources, legacyGit.platforms[platform].sources);
    assert.deepEqual(recipe.dependencies, legacyGit.platforms[platform].dependencies);
    assert.deepEqual(recipe.requires, []);
    assert.deepEqual(recipe.environment.prependPath, ["usr/bin"]);
    assert.deepEqual(lfs.platforms[platform].dependencies, [{ toolchain: "linux-git", version: git.version }]);
    const { dependencies, ...newLfsRecipe } = lfs.platforms[platform];
    const { dependencies: oldDependencies, ...oldLfsRecipe } = legacyLfs.platforms[platform];
    assert.deepEqual(newLfsRecipe, oldLfsRecipe);
    for (const dependency of recipe.dependencies) {
      const runtime = read(`toolchains/${dependency.toolchain}/versions/${dependency.version}.json`).platforms[platform];
      assert.equal(runtime.guestRoot, true);
    }
  }
});

for (const [platform, recipe] of Object.entries(git.platforms)) {
  test(`${platform} exports private Git, library and Perl paths from its selected prefix`, () => {
    const triplet = platform === "linux-arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
    const variables = recipe.environment.variables;
    assert.equal(variables.GIT_EXEC_PATH, "${prefix}/usr/lib/git-core");
    assert.equal(variables.GIT_TEMPLATE_DIR, "${prefix}/usr/share/git-core/templates");
    assert.equal(variables.GITPERLLIB, "${prefix}/usr/share/perl5");
    assert.equal(variables.GIT_TEXTDOMAINDIR, "${prefix}/usr/share/locale");
    assert.equal(variables.LD_LIBRARY_PATH, `\${prefix}/usr/lib/${triplet}`);
    assert.deepEqual(variables.PERL5LIB.split(":"), [
      `\${prefix}/usr/lib/${triplet}/perl-base`,
      `\${prefix}/usr/lib/${triplet}/perl/5.36.0`,
      "${prefix}/usr/share/perl/5.36.0",
      "${prefix}/usr/share/perl5",
    ]);
    assert.ok(!("PATH" in variables));
    const commands = recipe.checks.filter(check => check.type === "command");
    assert.ok(commands.some(check => check.program === "${prefix}/usr/bin/git" && check.args[0] === "--version"));
    assert.ok(commands.some(check => check.args[0] === "--exec-path" && check.stdoutContains === variables.GIT_EXEC_PATH));
    assert.ok(commands.some(check => check.program === "${prefix}/usr/bin/perl" && check.args.includes("-MGit") && check.args.includes("-MGDBM_File")));
    for (const step of [...recipe.install, ...commands].filter(step => step.args?.[0] === "-euc")) {
      execFileSync("bash", ["-n", "-c", step.args[1]]);
    }
  });

  test(`${platform} merges synthetic Debian trees and relocates Perl shebangs inside its prefix`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "gizmoth-managed-git-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // Spaces catch missing shell quoting; data and scripts stay inside this fixture.
    const prefix = join(directory, "managed git");
    const write = (path, bytes, mode = 0o644) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { mode });
    };
    const extracts = recipe.install.filter(step => step.type === "extract");
    assert.equal(new Set(extracts.map(step => step.to)).size, recipe.sources.length);
    for (const step of extracts) {
      assert.equal(step.to, `payloads/${step.source}`);
      assert.equal(step.format, "deb");
      assert.equal(step.stripComponents, 0);
      write(join(prefix, step.to, `usr/share/doc/${step.source}/copyright`), step.source);
    }
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff, 10]);
    write(join(prefix, "payloads/git/usr/bin/git"), binary, 0o755);
    symlinkSync("git", join(prefix, "payloads/git/usr/bin/git-upload-pack"));
    const helper = "usr/lib/git-core/git-add--interactive";
    const template = "usr/share/git-core/templates/hooks/fsmonitor-watchman.sample";
    const script = "#!/usr/bin/perl -w\nprint qq(synthetic helper);\n";
    write(join(prefix, "payloads/git", helper), script, 0o755);
    write(join(prefix, "payloads/git", template), script, 0o755);
    write(join(prefix, "payloads/perl-base/usr/bin/perl"), binary, 0o755);
    write(join(prefix, "payloads/perl/usr/bin/prove"), "#!/usr/bin/perl\n# synthetic Perl tool\n", 0o755);
    write(join(prefix, "payloads/git/usr/lib/git-core/git-sh-setup"), "#!/bin/sh\n# keep system shell\n", 0o755);
    const runs = recipe.install.filter(step => step.type === "run");
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.equal(run.program, "${toolchain:linux-runtime}/bin/bash");
    execFileSync("bash", run.args.map(arg => arg.replaceAll("${prefix}", prefix)), {
      cwd: join(prefix, run.cwd), env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    assert.equal(existsSync(join(prefix, "payloads")), false);
    for (const step of extracts) assert.equal(readFileSync(join(prefix, `usr/share/doc/${step.source}/copyright`), "utf8"), step.source);
    assert.deepEqual(readFileSync(join(prefix, "usr/bin/git")), binary);
    assert.deepEqual(readFileSync(join(prefix, "usr/bin/perl")), binary);
    assert.equal(readlinkSync(join(prefix, "usr/bin/git-upload-pack")), "git");
    for (const path of [helper, template]) {
      assert.equal(readFileSync(join(prefix, path), "utf8"), script.replace("#!/usr/bin/perl", `#!${prefix}/usr/bin/perl`));
      assert.equal(statSync(join(prefix, path)).mode & 0o777, 0o755);
      assert.equal(existsSync(join(prefix, `${path}.gizmoth`)), false);
    }
    assert.match(readFileSync(join(prefix, "usr/bin/prove"), "utf8"), new RegExp(`^#!${prefix}/usr/bin/perl\\n`));
    assert.match(readFileSync(join(prefix, "usr/lib/git-core/git-sh-setup"), "utf8"), /^#!\/bin\/sh\n/);
    assert.deepEqual(Object.keys(recipe.environment.variables).sort(), ["GITPERLLIB", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_TEXTDOMAINDIR", "LD_LIBRARY_PATH", "PERL5LIB"]);
  });
}
