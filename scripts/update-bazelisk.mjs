import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/update-bazelisk.mjs <exact-stable-version>");
}
const upstream = JSON.parse(execFileSync("gh", ["api", `repos/bazelbuild/bazelisk/releases/tags/v${version}`], {
  encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
}));
if (upstream.draft || upstream.prerelease || upstream.tag_name !== `v${version}`) {
  throw new Error("Expected the requested stable upstream release");
}
const hosts = {
  "macos-arm64": "darwin-arm64",
  "macos-x86_64": "darwin-amd64",
  "linux-arm64": "linux-arm64",
  "linux-x86_64": "linux-amd64",
  "windows-arm64": "windows-arm64.exe",
  "windows-x86_64": "windows-amd64.exe",
};
const platforms = Object.fromEntries(await Promise.all(Object.entries(hosts).map(async ([host, suffix]) => {
  const name = `bazelisk-${suffix}`;
  const asset = upstream.assets.find((item) => item.name === name);
  const sha256 = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  const url = `https://github.com/bazelbuild/bazelisk/releases/download/v${version}/${name}`;
  if (!asset || !sha256 || asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size < 1) {
    throw new Error(`Missing verified upstream metadata: ${name}`);
  }
  const response = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Checksum fetch failed: ${name} (${response.status})`);
  const checksum = (await response.text()).trim();
  if (checksum !== sha256) throw new Error(`Upstream digest/checksum mismatch: ${name}`);
  const extension = host.startsWith("windows-") ? ".exe" : "";
  const paths = [`bin/bazelisk${extension}`, `bin/bazel${extension}`];
  return [host, {
    requires: [],
    dependencies: [],
    sources: [{ id: "bazelisk", type: "file", url, sha256, size: asset.size }],
    install: paths.map((to) => ({ type: "copy", source: "bazelisk", to, executable: true })),
    environment: { prependPath: ["bin"], variables: { BAZELISK_HOME: "${cache}/bazel" } },
    checks: paths.map((path) => ({ type: "file", path, executable: true })),
  }];
})));
const manifest = {
  $schema: "../../../schemas/devenv.schema.json",
  apiVersion: "gizmoth.dev/v1alpha1",
  kind: "Release",
  id: "bazelisk",
  version,
  platforms,
};
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const target = resolve(root, "formulae/bazelisk/versions", `${version}.json`);
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) {
  if (readFileSync(target, "utf8") !== manifestText) throw new Error("Refusing to modify an existing release manifest");
} else {
  writeFileSync(target, manifestText, { flag: "wx" });
}
const formulaPath = resolve(root, "formulae/bazelisk/formula.json");
const formula = JSON.parse(readFileSync(formulaPath, "utf8"));
formula.status = "recipe";
formula.defaultVersion = version;
if (!formula.releases.some((release) => release.version === version)) {
  formula.releases.push({ version, manifest: `versions/${version}.json` });
}
writeFileSync(formulaPath, `${JSON.stringify(formula, null, 2)}\n`);
console.log(`Recorded Bazelisk ${version}: ${Object.keys(platforms).length} hosts, published SHA-256 files matched. No binaries executed.`);
