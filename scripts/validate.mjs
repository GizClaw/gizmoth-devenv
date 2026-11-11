import Ajv2020 from "ajv/dist/2020.js";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(projectRoot, "schemas/devenv.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const KINDS = ["Registry", "Chip", "Environment", "Sdk", "Toolchain", "SdkRelease", "ToolchainRelease", "Installation", "InstalledChip", "InstalledEnvironment"];
const validators = Object.fromEntries(KINDS.map((kind) => [kind, ajv.getSchema(`${schema.$id}#/$defs/${kind}`)]));
const EXACT_VERSION = new RegExp(schema.$defs.version.pattern);
const ITEM_TYPES = [
  { type: "toolchain", directory: "toolchains", kind: "Toolchain", release: "ToolchainRelease" },
  { type: "sdk", directory: "sdks", kind: "Sdk", release: "SdkRelease" },
];

export function requireThat(condition, message) {
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
    requireThat(!lstatSync(current).isSymbolicLink(), `Symlink is not a registry file: ${relative}`);
  }
  const stat = lstatSync(current);
  requireThat(stat.isFile() && stat.size <= 2 * 1024 * 1024, `Invalid registry file: ${relative}`);
  return JSON.parse(readFileSync(current, "utf8"));
}

/** Every visible entry in a registry directory must be indexed; clients read indexed paths only. */
function requireIndexed(root, relative, indexed) {
  const path = join(root, relative);
  requireThat(!lstatSync(path).isSymbolicLink(), `Symlinked directory: ${relative}`);
  for (const entry of readdirSync(path)) {
    if (!entry.startsWith(".")) requireThat(indexed.has(entry), `Unindexed entry: ${relative}/${entry}`);
  }
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

function validateTemplates(value, toolchains, allowWork = true) {
  for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
    const name = match[1];
    if (name === "prefix" || name === "cache" || (allowWork && name === "work")) continue;
    requireThat(name.startsWith("toolchain:") && toolchains.has(name.slice("toolchain:".length)), `Unknown or undeclared template: ${match[0]}`);
  }
  requireThat(!value.replace(/\$\{[^}]*\}/g, "").includes("${"), `Unclosed template: ${value}`);
}

function validateVariables(variables, toolchains, allowWork = true) {
  requireThat(!Object.keys(variables).some((name) => name.toLowerCase() === "path"), "Use prependPath instead of setting PATH");
  for (const value of Object.values(variables)) validateTemplates(value, toolchains, allowWork);
}

function validateProgram(program, recipe, toolchains, allowWork) {
  validateTemplates(program, toolchains, allowWork);
  const owned = program.match(/^\$\{(?:prefix|work|toolchain:[^}]+)\}\/(.+)$/);
  if (owned) safeRelative(owned[1]);
  else requireThat(!program.includes("${") && recipe.requires.includes(program), `Host program must be declared in requires: ${program}`);
}

function dependencyNames(dependencies, location) {
  const identities = new Set();
  for (const { toolchain, version } of dependencies) {
    const key = `${toolchain}@${version}`;
    requireThat(!identities.has(key), `${location}: duplicate dependency ${key}`);
    identities.add(key);
  }
  return new Set(dependencies.map(({ toolchain }) => toolchain));
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
  // Install steps and checks see only the common dependencies: one SDK installation serves all its targets.
  const toolchains = dependencyNames(recipe.dependencies, location);
  for (const [target, extra] of Object.entries(recipe.targets ?? {})) {
    dependencyNames([...recipe.dependencies, ...extra.dependencies], `${location}/${target}`);
  }
  const destinations = new Set();
  for (const step of recipe.install) {
    if (step.type === "run") {
      validateProgram(step.program, recipe, toolchains, true);
      safeRelative(step.cwd);
      step.args.forEach((arg) => validateTemplates(arg, toolchains));
      validateVariables(step.environment, toolchains);
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
  validateVariables(recipe.environment.variables, toolchains, false);
  for (const check of recipe.checks) {
    if (check.type === "file") safeRelative(check.path);
    else {
      validateProgram(check.program, recipe, toolchains, false);
      check.args.forEach((arg) => validateTemplates(arg, toolchains, false));
    }
  }
}

/** Resolve exact identities on one host. Different versions coexist; cycles cannot. */
function resolveToolchains(releases, roots, host, label) {
  const visiting = [];
  const visited = new Set();
  function visit({ toolchain, version }) {
    const key = `${toolchain}@${version}`;
    requireThat(!visiting.includes(key), `${label}: dependency cycle ${[...visiting, key].join(" -> ")}`);
    if (visited.has(key)) return;
    const manifest = releases.get(key);
    requireThat(manifest, `${label}: unresolved toolchain ${key}`);
    requireThat(manifest.platforms[host], `${label}: ${key} does not support ${host}`);
    visiting.push(key);
    manifest.platforms[host].dependencies.forEach(visit);
    visiting.pop();
    visited.add(key);
  }
  roots.forEach(visit);
}

/** Validate a registry checkout offline. Nothing is downloaded or executed. */
export function validateRegistry(input = projectRoot) {
  const root = realpathSync(input);
  const registry = validateDocument(load(root, "registry.json"), "Registry");
  validateUrl(registry.repository);
  const items = { toolchain: new Map(), sdk: new Map() };
  const releases = { toolchain: new Map(), sdk: new Map() };
  let planned = 0;
  let platforms = 0;

  for (const { type, directory, kind, release } of ITEM_TYPES) {
    requireIndexed(root, directory, new Set(registry[directory]));
    for (const id of registry[directory]) {
      const base = `${directory}/${id}`;
      const item = validateDocument(load(root, `${base}/${type}.json`), kind);
      requireThat(item.id === id, `${base}: id mismatch`);
      validateUrl(item.homepage);
      if (item.status === "planned") planned += 1;
      const versions = new Set();
      for (const reference of item.releases) {
        requireThat(!versions.has(reference.version), `${type} ${id}: duplicate version ${reference.version}`);
        versions.add(reference.version);
        requireThat(reference.manifest === `versions/${reference.version}.json`, `${type} ${id}: version path mismatch`);
        const manifest = validateDocument(load(root, `${base}/${reference.manifest}`), release);
        requireThat(manifest.id === id && manifest.version === reference.version, `${type} ${id}: release identity mismatch`);
        for (const [host, recipe] of Object.entries(manifest.platforms)) validateRecipe(recipe, `${type} ${id}@${manifest.version}:${host}`);
        platforms += Object.keys(manifest.platforms).length;
        releases[type].set(`${id}@${manifest.version}`, manifest);
      }
      if (item.status === "published") requireThat(versions.has(item.defaultVersion), `${type} ${id}: defaultVersion is not published`);
      requireIndexed(root, base, new Set([`${type}.json`, ...(versions.size ? ["versions"] : [])]));
      if (versions.size) requireIndexed(root, `${base}/versions`, new Set([...versions].map((version) => `${version}.json`)));
      items[type].set(id, item);
    }
  }

  for (const [key, manifest] of releases.toolchain) {
    for (const host of Object.keys(manifest.platforms)) {
      resolveToolchains(releases.toolchain, [{ toolchain: manifest.id, version: manifest.version }], host, `toolchain ${key}:${host}`);
    }
  }
  for (const [key, manifest] of releases.sdk) {
    for (const [host, recipe] of Object.entries(manifest.platforms)) {
      for (const [target, extra] of Object.entries(recipe.targets)) {
        resolveToolchains(releases.toolchain, [...recipe.dependencies, ...extra.dependencies], host, `sdk ${key}:${host}/${target}`);
      }
    }
  }

  requireIndexed(root, "chips", new Set(registry.chips));
  const targets = new Set();
  for (const id of registry.chips) {
    const chip = validateDocument(load(root, `chips/${id}/chip.json`), "Chip");
    requireThat(chip.id === id, `chips/${id}: id mismatch`);
    requireIndexed(root, `chips/${id}`, new Set(["chip.json"]));
    validateUrl(chip.homepage);
    const sdk = items.sdk.get(chip.sdk);
    requireThat(sdk, `chip ${id}: unknown SDK ${chip.sdk}`);
    requireThat(!targets.has(`${chip.sdk}/${chip.target}`), `chip ${id}: duplicate SDK target ${chip.sdk}/${chip.target}`);
    targets.add(`${chip.sdk}/${chip.target}`);
    for (const tool of chip.tools) requireThat(items.toolchain.has(tool), `chip ${id}: unknown toolchain ${tool}`);
    if (chip.status === "planned") {
      planned += 1;
      continue;
    }
    requireThat(sdk.status === "published", `chip ${id}: SDK ${chip.sdk} is not published`);
    const tools = chip.tools.map((tool) => {
      const toolchain = items.toolchain.get(tool);
      requireThat(toolchain.status === "published", `chip ${id}: toolchain ${tool} is not published`);
      return { toolchain: tool, version: toolchain.defaultVersion };
    });
    // A card is installable on hosts where the default SDK supports its target and every tool is available.
    let hosts = 0;
    for (const [host, recipe] of Object.entries(releases.sdk.get(`${chip.sdk}@${sdk.defaultVersion}`).platforms)) {
      const target = recipe.targets[chip.target];
      if (!target || tools.some(({ toolchain, version }) => !releases.toolchain.get(`${toolchain}@${version}`).platforms[host])) continue;
      resolveToolchains(releases.toolchain, [...recipe.dependencies, ...target.dependencies, ...tools], host, `chip ${id}:${host}`);
      hosts += 1;
    }
    requireThat(hosts > 0, `chip ${id}: ${chip.sdk}@${sdk.defaultVersion} does not support target ${chip.target} on any host with its tools`);
  }

  const environments = registry.environments ?? [];
  // Older indexes may omit this directory, but present entries must always be indexed.
  if (environments.length || existsSync(join(root, "environments"))) {
    requireIndexed(root, "environments", new Set(environments));
  }
  for (const id of environments) {
    const base = `environments/${id}`;
    const environment = validateDocument(load(root, `${base}/environment.json`), "Environment");
    requireThat(environment.id === id, `${base}: id mismatch`);
    requireIndexed(root, base, new Set(["environment.json"]));
    validateUrl(environment.homepage);
    dependencyNames(environment.dependencies, `environment ${id}`);
    const dependencies = environment.dependencies.map(({ toolchain, version }) => {
      const manifest = releases.toolchain.get(`${toolchain}@${version}`);
      requireThat(manifest, `environment ${id}: unresolved toolchain ${toolchain}@${version}`);
      return manifest;
    });
    if (environment.status === "planned") {
      planned += 1;
      continue;
    }
    const hosts = Object.keys(dependencies[0].platforms).filter((host) => dependencies.every((manifest) => manifest.platforms[host]));
    requireThat(hosts.length > 0, `environment ${id}: dependencies have no common supported host`);
    for (const host of hosts) resolveToolchains(releases.toolchain, environment.dependencies, host, `environment ${id}:${host}`);
  }

  return {
    chips: registry.chips.length,
    environments: environments.length,
    sdks: items.sdk.size,
    toolchains: items.toolchain.size,
    planned,
    releases: releases.sdk.size + releases.toolchain.size,
    platforms,
  };
}

/** Shape and identity checks for GizMoth's local installation records. */
export function validateInstallation(record) {
  validateDocument(record, "Installation");
  requireThat(!record.dependencies.includes(record.installationId), "An installation cannot depend on itself");
  if (record.origin.type === "managed") {
    requireThat(EXACT_VERSION.test(record.version), "A managed installation needs an exact registry version");
    const directory = `${record.type}s/${record.id}`;
    safeRelative(record.origin.prefix);
    requireThat(record.origin.prefix === `installs/${directory}/${record.version}/${record.platform}/${record.installationId}`, "Installation prefix does not match its identity");
    requireThat(record.origin.manifest.path === `${directory}/versions/${record.version}.json`, "Installation manifest does not match its version");
    validateUrl(record.origin.registry.repository);
  } else {
    requireThat(record.type === "toolchain", "Only toolchains can be added from a local path");
    requireThat(record.requestedByUser && record.dependencies.length === 0, "A local toolchain is user-added and has no managed dependencies");
  }
  return record;
}

export function validateInstalledChip(record) {
  validateDocument(record, "InstalledChip");
  requireThat(!record.toolchains.includes(record.sdk), "A chip SDK cannot also be listed as a toolchain");
  return record;
}

export function validateInstalledEnvironment(record) {
  validateDocument(record, "InstalledEnvironment");
  if (record.metadata) validateUrl(record.metadata.homepage);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = validateRegistry(process.argv[2] ?? projectRoot);
    console.log(`Validated ${result.chips} chips, ${result.environments} environments, ${result.sdks} SDKs, ${result.toolchains} toolchains; ${result.releases} release(s), ${result.platforms} platform recipes, ${result.planned} planned. No installers executed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
