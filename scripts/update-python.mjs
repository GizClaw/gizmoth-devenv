import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument } from "./validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [version, release] = process.argv.slice(2);
if (process.argv.length !== 4 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? "") || !/^20[0-9]{6}$/.test(release ?? "")) {
  throw new Error("Usage: node scripts/update-python.mjs <exact-stable-version> <YYYYMMDD-release>");
}
const hosts = {
  "macos-arm64": "aarch64-apple-darwin",
  "macos-x86_64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x86_64": "x86_64-unknown-linux-gnu",
  "windows-arm64": "aarch64-pc-windows-msvc",
  "windows-x86_64": "x86_64-pc-windows-msvc",
};
const assetName = (triple) => `cpython-${version}+${release}-${triple}-install_only_stripped.tar.gz`;
const names = Object.values(hosts).map(assetName);
// Filter at the API boundary: this release has many unrelated Python versions and build variants.
const query = `{tag_name,draft,prerelease,assets:[.assets[] | select(.name as $name | ${JSON.stringify(names)} | index($name)) | {name,size,digest,browser_download_url}]}`;
const upstream = JSON.parse(execFileSync("gh", ["api", `repos/astral-sh/python-build-standalone/releases/tags/${release}`, "--jq", query], {
  encoding: "utf8", maxBuffer: 128 * 1024,
}));
if (upstream.draft || upstream.prerelease || upstream.tag_name !== release || upstream.assets.length !== names.length) {
  throw new Error("Expected the exact published upstream release and all six unique host assets");
}
const platforms = Object.fromEntries(Object.entries(hosts).map(([host, triple]) => {
  const name = assetName(triple);
  const matches = upstream.assets.filter((item) => item.name === name);
  const asset = matches[0];
  const sha256 = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${encodeURIComponent(name)}`;
  if (matches.length !== 1 || !sha256 || /^0+$/.test(sha256) || asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size < 1) {
    throw new Error(`Missing verified upstream metadata: ${name}`);
  }
  const windows = host.startsWith("windows-");
  return [host, {
    requires: [],
    dependencies: [],
    sources: [{ id: "python", type: "file", url, sha256, size: asset.size }],
    install: [{ type: "extract", source: "python", to: "python", format: "tar.gz", stripComponents: 1 }],
    environment: { prependPath: [windows ? "python" : "python/bin"], variables: {} },
    checks: [{ type: "file", path: windows ? "python/python.exe" : "python/bin/python3", executable: !windows }],
  }];
}));
const manifest = validateDocument({
  $schema: "../../../schemas/devenv.schema.json",
  apiVersion: "devenv.gizmoth.dev/v1alpha1",
  kind: "ToolchainRelease",
  id: "python",
  version,
  platforms,
});
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const target = resolve(root, "toolchains/python/versions", `${version}.json`);
const toolchainPath = resolve(root, "toolchains/python/toolchain.json");
const toolchain = JSON.parse(readFileSync(toolchainPath, "utf8"));
toolchain.status = "published";
// Adding an older release must not change the currently selected default.
toolchain.defaultVersion ??= version;
if (!toolchain.releases.some((item) => item.version === version)) {
  toolchain.releases.push({ version, manifest: `versions/${version}.json` });
}
validateDocument(toolchain);
if (existsSync(target)) {
  if (readFileSync(target, "utf8") !== manifestText) throw new Error("Refusing to modify a published release manifest");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, manifestText, { flag: "wx" });
}
writeFileSync(toolchainPath, `${JSON.stringify(toolchain, null, 2)}\n`);
console.log(`Recorded Python ${version} from python-build-standalone ${release}: ${Object.keys(platforms).length} hosts with GitHub asset SHA-256 and size metadata. No binaries downloaded or executed.`);
