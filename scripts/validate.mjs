import Ajv2020 from "ajv/dist/2020.js";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(projectRoot, "schemas/devenv.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validators = Object.fromEntries(["Tap", "Formula", "Release", "Receipt"].map((kind) => [
  kind, ajv.getSchema(`${schema.$id}#/$defs/${kind}`),
]));

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function safeRelative(value) {
  requireThat(typeof value === "string" && /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(value), `Unsafe relative path: ${value}`);
  for (const segment of value.split("/")) {
    requireThat(segment !== "." && segment !== ".." && !segment.endsWith(".") &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment), `Unsafe path segment: ${segment}`);
  }
  return value;
}

function load(root, relative) {
  safeRelative(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    requireThat(!lstatSync(current).isSymbolicLink(), `Symlink is not a catalog file: ${relative}`);
  }
  const stat = lstatSync(current);
  requireThat(stat.isFile() && stat.size <= 2 * 1024 * 1024, `Invalid catalog file: ${relative}`);
  return JSON.parse(readFileSync(current, "utf8"));
}

export function validateDocument(document, expectedKind = document.kind) {
  const validate = validators[expectedKind];
  requireThat(validate, `Unknown document kind: ${expectedKind}`);
  requireThat(validate(document), `${expectedKind}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  return document;
}

function validateUrl(value) {
  const url = new URL(value);
  requireThat(url.protocol === "https:" && !url.username && !url.password && !url.hash, `Invalid HTTPS source: ${value}`);
}

function validateTemplates(value, dependencies, allowWork = true) {
  for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
    const name = match[1];
    if (name === "prefix" || name === "cache" || (allowWork && name === "work")) continue;
    requireThat(name.startsWith("dependency:") && dependencies.has(name.slice("dependency:".length)), `Unknown or undeclared template: ${match[0]}`);
  }
  requireThat(!value.replace(/\$\{[^}]*\}/g, "").includes("${"), `Unclosed template: ${value}`);
}

function validateVariables(variables, dependencies, allowWork = true) {
  requireThat(!Object.keys(variables).some((name) => name.toLowerCase() === "path"), "Use prependPath instead of setting PATH");
  for (const value of Object.values(variables)) validateTemplates(value, dependencies, allowWork);
}

function validateProgram(program, recipe, dependencies) {
  validateTemplates(program, dependencies);
  const owned = program.match(/^\$\{(?:prefix|dependency:[^}]+)\}\/(.+)$/);
  if (owned) safeRelative(owned[1]);
  else requireThat(recipe.requires.includes(program), `Host program must be declared in requires: ${program}`);
}

function validateRecipe(recipe, location) {
  const sources = new Map();
  for (const source of recipe.sources) {
    requireThat(!sources.has(source.id), `${location}: duplicate source ${source.id}`);
    sources.set(source.id, source);
    validateUrl(source.url);
    const digest = source.type === "file" ? source.sha256 : source.commit;
    requireThat(!/^0+$/.test(digest), `${location}: placeholder source digest`);
  }
  const dependencies = new Set();
  for (const dependency of recipe.dependencies) {
    requireThat(!dependencies.has(dependency.package), `${location}: duplicate dependency ${dependency.package}`);
    dependencies.add(dependency.package);
  }
  const destinations = new Set();
  for (const step of recipe.install) {
    if (step.type === "run") {
      validateProgram(step.program, recipe, dependencies);
      safeRelative(step.cwd);
      step.args.forEach((arg) => validateTemplates(arg, dependencies));
      validateVariables(step.environment, dependencies);
      continue;
    }
    safeRelative(step.to);
    const destination = step.to.toLowerCase();
    requireThat(!destinations.has(destination), `${location}: duplicate destination ${step.to}`);
    destinations.add(destination);
    const source = sources.get(step.source);
    requireThat(source, `${location}: unknown source ${step.source}`);
    requireThat(source.type === (step.type === "checkout" ? "git" : "file"), `${location}: incompatible source for ${step.type}`);
  }
  recipe.environment.prependPath.forEach(safeRelative);
  validateVariables(recipe.environment.variables, dependencies, false);
  for (const check of recipe.checks) {
    if (check.type === "file") safeRelative(check.path);
    else {
      validateProgram(check.program, recipe, dependencies);
      check.args.forEach((arg) => validateTemplates(arg, dependencies, false));
      requireThat(!check.program.includes("${work}"), `${location}: temporary work path in health check`);
    }
  }
}

export function validateReceipt(receipt) {
  validateDocument(receipt, "Receipt");
  safeRelative(receipt.manifest.path);
  safeRelative(receipt.prefix);
  const expectedPrefix = `packages/${receipt.tap.id}/${receipt.id}/${receipt.version}/${receipt.platform}/${receipt.installationId}`;
  requireThat(receipt.prefix === expectedPrefix, "Receipt prefix does not match its installation identity");
  requireThat(receipt.manifest.path === `formulae/${receipt.id}/versions/${receipt.version}.json`, "Receipt manifest path does not match its package version");
  requireThat(!receipt.dependencies.includes(receipt.installationId), "Receipt cannot depend on itself");
  requireThat(Number.isFinite(Date.parse(receipt.installedAt)) && new Date(receipt.installedAt).toISOString().slice(0, 10) === receipt.installedAt.slice(0, 10), "Invalid installation date");
  validateUrl(receipt.tap.repository);
  return receipt;
}

/** Validate one or more configured taps together, including exact cross-tap dependencies. */
export function validateCatalog(roots = [projectRoot]) {
  const taps = new Map();
  const releases = new Map();
  const formulae = [];
  for (const input of roots) {
    const root = realpathSync(input);
    const tap = validateDocument(load(root, "tap.json"), "Tap");
    requireThat(!taps.has(tap.id), `Duplicate tap alias: ${tap.id}`);
    validateUrl(tap.repository);
    taps.set(tap.id, tap);
    const indexedFormulae = new Set();
    for (const path of tap.formulae) {
      const formula = validateDocument(load(root, path), "Formula");
      requireThat(path === `formulae/${formula.id}/formula.json`, `Formula path/id mismatch: ${path}`);
      requireThat(!indexedFormulae.has(formula.id), `Duplicate formula: ${formula.id}`);
      indexedFormulae.add(formula.id);
      validateUrl(formula.homepage);
      const base = dirname(path);
      const versions = new Set();
      for (const reference of formula.releases) {
        requireThat(!versions.has(reference.version), `${formula.id}: duplicate version ${reference.version}`);
        versions.add(reference.version);
        requireThat(reference.manifest === `versions/${reference.version}.json`, `${formula.id}: version path mismatch`);
        const manifest = validateDocument(load(root, `${base}/${reference.manifest}`), "Release");
        requireThat(manifest.id === formula.id && manifest.version === reference.version, `${formula.id}: release identity mismatch`);
        for (const [host, recipe] of Object.entries(manifest.platforms)) validateRecipe(recipe, `${tap.id}/${formula.id}@${manifest.version}:${host}`);
        releases.set(`${tap.id}/${formula.id}@${manifest.version}`, manifest);
      }
      if (formula.status === "recipe") requireThat(versions.has(formula.defaultVersion), `${formula.id}: defaultVersion is not published`);
      const entries = readdirSync(join(root, base));
      if (entries.includes("versions")) {
        const versionsPath = join(root, base, "versions");
        requireThat(!lstatSync(versionsPath).isSymbolicLink(), `${formula.id}: symlinked versions directory`);
        for (const entry of readdirSync(versionsPath)) {
          requireThat(entry.endsWith(".json") && versions.has(entry.slice(0, -5)), `${formula.id}: unindexed release ${entry}`);
        }
      }
      formulae.push({ tap: tap.id, ...formula });
    }
    const formulaRoot = join(root, "formulae");
    requireThat(!lstatSync(formulaRoot).isSymbolicLink(), "Symlinked formulae directory");
    for (const entry of readdirSync(formulaRoot)) requireThat(indexedFormulae.has(entry), `Unindexed formula: ${entry}`);
  }

  // Each root environment must resolve to one version of every dependency on its host.
  // Different root environments can still install different versions side by side.
  for (const [rootKey, rootRelease] of releases) {
    for (const host of Object.keys(rootRelease.platforms)) {
      const visiting = new Set();
      const visited = new Set();
      const versions = new Map();
      function visit(key) {
        requireThat(!visiting.has(key), `Dependency cycle: ${[...visiting, key].join(" -> ")}`);
        if (visited.has(key)) return;
        const manifest = releases.get(key);
        requireThat(manifest, `Unresolved dependency: ${key}`);
        requireThat(manifest.platforms[host], `Dependency ${key} does not support ${host}`);
        const packageKey = key.slice(0, key.lastIndexOf("@"));
        requireThat(!versions.has(packageKey) || versions.get(packageKey) === manifest.version, `Dependency version conflict: ${packageKey}`);
        versions.set(packageKey, manifest.version);
        visiting.add(key);
        for (const dependency of manifest.platforms[host].dependencies) visit(`${dependency.package}@${dependency.version}`);
        visiting.delete(key);
        visited.add(key);
      }
      visit(rootKey);
    }
  }
  return {
    taps: taps.size,
    formulae: formulae.length,
    planned: formulae.filter((formula) => formula.status === "planned").length,
    releases: releases.size,
    platforms: [...releases.values()].reduce((count, release) => count + Object.keys(release.platforms).length, 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = validateCatalog(process.argv.length > 2 ? process.argv.slice(2) : [projectRoot]);
    console.log(`Validated ${result.taps} tap(s), ${result.formulae} formulae, ${result.releases} release(s), ${result.platforms} platform recipes; ${result.planned} planned. No installers executed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
