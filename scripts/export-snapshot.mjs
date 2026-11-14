import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegistry } from "./validate.mjs";

// Explicit development-only seed. It includes working-tree changes and never
// changes GizMoth's production registry URL, branch or Git checkout.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/export-snapshot.mjs <compile/registry directory>");
validateRegistry(root);
const files = {};
function collect(relative) {
  const path = join(root, relative);
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collect(name);
    else if (entry.isFile() && entry.name.endsWith(".json")) files[name] = readFileSync(join(root, name), "utf8");
    else throw new Error(`Unsupported registry entry: ${name}`);
  }
}
files["registry.json"] = readFileSync(join(root, "registry.json"), "utf8");
for (const directory of ["chips", "environments", "sdks", "toolchains"]) collect(directory);
// A content-derived development identity, not an upstream Git commit. A normal
// registry refresh supersedes this seed; stop the app before writing it.
const commit = createHash("sha1").update(JSON.stringify(files)).digest("hex");
const output = resolve(destination);
mkdirSync(output, { recursive: true });
writeFileSync(join(output, `${commit}.json`), JSON.stringify({ commit, fetchedAt: Date.now(), files }));
writeFileSync(join(output, "current.json"), `${JSON.stringify({ commit })}\n`);
console.log(`Seeded ${Object.keys(files).length} files in ${output}; development snapshot ${commit}`);
