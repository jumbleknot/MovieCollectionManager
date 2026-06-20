#!/usr/bin/env node
// Static naming gate for feature 019 (resource-naming).
// Enforces contracts/naming-convention.md: every external/declared Docker volume name,
// external network name, and container_name follows <context>-<role>-<engine> grammar,
// only the BFF carries the `mcm-` qualifier, and no removed `ollama`/`agent-mcp` objects remain.
//
// Usage: node scripts/check-resource-naming.mjs [--section=volumes|networks|containers|ollama|all]
// Exits non-zero with the offending file + token on any violation in the selected section(s).

import { readFileSync, globSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VOLUME_RE = /^(keycloak|mc-service|mcm-bff|movie-assistant|agent|observability)-[a-z0-9]+(-[a-z0-9]+)*-data$/;
const CONTAINER_RE = /^(keycloak|mc-service|mcm-bff|movie-assistant)(-[a-z0-9]+)*$/;
const APPROVED_NETWORKS = new Set([
  'backend-network',
  'keycloak-network',
  'mcm-bff-network',
  'movie-assistant-mcp-network',
]);
// A `name:` carrying a compose-project prefix (`<project>_<name>`) or the auto `mcm_` form.
const LEGACY_NAME_RE = /_/;

const ALL_SECTIONS = ['volumes', 'networks', 'containers', 'ollama'];

function parseArgs(argv) {
  const arg = argv.find((a) => a.startsWith('--section='));
  const raw = arg ? arg.split('=')[1] : 'all';
  if (raw === 'all') return ALL_SECTIONS;
  const requested = raw.split(',').map((s) => s.trim());
  const bad = requested.filter((s) => !ALL_SECTIONS.includes(s));
  if (bad.length) {
    console.error(`Unknown --section value(s): ${bad.join(', ')}. Valid: ${ALL_SECTIONS.join(', ')}, all.`);
    process.exit(2);
  }
  return requested;
}

function composeFiles() {
  const files = globSync('infrastructure-as-code/docker/**/compose*.yaml', { cwd: REPO_ROOT });
  files.push('compose.yaml');
  return [...new Set(files)].map((f) => resolve(REPO_ROOT, f));
}

// Live (non-historical) scripts/CI scanned for removed-object references.
const SCRIPT_FILES = [
  'scripts/agent-stack.mjs',
  'scripts/agent-gateway-local.ps1',
  '.github/workflows/android-e2e.yml',
];

const violations = [];
function fail(file, token, reason) {
  violations.push({ file: file.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', ''), token, reason });
}

function checkVolumes(file, doc) {
  const vols = doc?.volumes;
  if (!vols || typeof vols !== 'object') return;
  for (const [key, def] of Object.entries(vols)) {
    // Only declared/externally-named volumes are in scope (a no-`name:` managed volume is transient).
    const name = def && typeof def === 'object' ? def.name : undefined;
    if (!name) continue;
    // `ollama-models` is a removed object — governed solely by the `ollama` section, not grammar.
    if (name === 'ollama-models') continue;
    if (LEGACY_NAME_RE.test(name)) {
      fail(file, name, `volume '${key}' carries a compose-project-prefixed name (underscore) — not convention-compliant`);
      continue;
    }
    if (!VOLUME_RE.test(name)) {
      fail(file, name, `volume '${key}' name does not match <context>-<role>-<engine>-data`);
      continue;
    }
    if (name.startsWith('mcm-') && !name.startsWith('mcm-bff-')) {
      fail(file, name, `only the BFF (mcm-bff-*) may carry the mcm- qualifier`);
    }
  }
}

function checkNetworks(file, doc) {
  const nets = doc?.networks;
  if (!nets || typeof nets !== 'object') return;
  for (const [key, def] of Object.entries(nets)) {
    const obj = def && typeof def === 'object' ? def : {};
    const external = obj.external === true || (obj.external && obj.external.name);
    const name = obj.name || (external ? key : undefined);
    if (!name) continue; // purely compose-managed, no explicit name → out of scope
    if (name === 'agent-mcp') {
      fail(file, name, `legacy network 'agent-mcp' must be 'movie-assistant-mcp-network'`);
      continue;
    }
    if (!/^[a-z0-9-]+-network$/.test(name)) {
      fail(file, name, `network '${key}' name must end with -network`);
      continue;
    }
    if (!APPROVED_NETWORKS.has(name)) {
      fail(file, name, `network '${name}' is not in the approved set (extend contracts/naming-convention.md to add one)`);
    }
  }
}

function checkContainers(file, doc) {
  const services = doc?.services;
  if (!services || typeof services !== 'object') return;
  for (const [svc, def] of Object.entries(services)) {
    const cn = def && typeof def === 'object' ? def.container_name : undefined;
    if (!cn) continue;
    if (!CONTAINER_RE.test(cn)) {
      fail(file, cn, `service '${svc}' container_name does not match <context>[-<role>...]`);
    }
  }
}

function checkOllama(file, text) {
  if (/\bollama-models\b/.test(text)) fail(file, 'ollama-models', `removed volume 'ollama-models' still referenced`);
  // Match the service/host token but not unrelated words; `ollama` as a bare identifier.
  if (/\bollama\b/.test(text)) fail(file, 'ollama', `removed containerized 'ollama' service still referenced`);
}

const sections = parseArgs(process.argv.slice(2));
const files = composeFiles();

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  let doc;
  try {
    doc = parse(text);
  } catch (e) {
    fail(file, 'YAML', `failed to parse: ${e.message}`);
    continue;
  }
  if (sections.includes('volumes')) checkVolumes(file, doc);
  if (sections.includes('networks')) checkNetworks(file, doc);
  if (sections.includes('containers')) checkContainers(file, doc);
  if (sections.includes('ollama')) checkOllama(file, text);
}

if (sections.includes('ollama')) {
  for (const rel of SCRIPT_FILES) {
    const abs = resolve(REPO_ROOT, rel);
    try {
      checkOllama(abs, readFileSync(abs, 'utf8'));
    } catch {
      /* file absent — fine */
    }
  }
}

if (violations.length) {
  console.error(`✗ resource-naming gate FAILED (sections: ${sections.join(', ')})\n`);
  for (const v of violations) {
    console.error(`  ${v.file}\n    token: ${v.token}\n    ${v.reason}\n`);
  }
  console.error(`${violations.length} violation(s). Rename to the convention or extend the approved set in contracts/naming-convention.md.`);
  process.exit(1);
}
console.log(`✓ resource-naming gate passed (sections: ${sections.join(', ')}; ${files.length} compose files scanned)`);
