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

// Feature 025 (prod control-tower): `vault` prefix admits the dormant Vault raft volume
// `vault-store-data`; `agent-audit-opensearch-data` already matches via the existing `agent` prefix.
const VOLUME_RE = /^(keycloak|mc-service|mcm-bff|movie-assistant|agent|observability|vault)-[a-z0-9]+(-[a-z0-9]+)*-data$/;
// FR-007 relaxed form: multi-volume vendor stacks (LangFuse) may end in -logs under the observability context.
const VOLUME_OBS_LOGS_RE = /^observability-[a-z0-9]+(-[a-z0-9]+)*-logs$/;
// Feature 020 — container_name == service key == <component>[-<role>-<technology>].
// Components are the owning subsystems (extend here when a new subsystem is added).
const IDENTIFIER_RE = /^(keycloak|mc-service|mcm-bff|movie-assistant|agent-audit|opa|unleash|vault)(-[a-z0-9]+)*$/;
// Rule 3 (vendor bundle) + Rule 3b (auxiliary / bundle-member): exempt from the format check,
// but still required to keep container_name == service key. See contracts/naming-convention.md.
const NAME_ALLOWLIST = new Set([
  // Rule 3 — third-party vendor bundles
  'langfuse-web', 'langfuse-worker', 'langfuse-postgres', 'langfuse-clickhouse',
  'langfuse-redis', 'langfuse-minio', 'langfuse-minio-init', 'otel-lgtm',
  // Rule 3b — auxiliary / bundle members
  'keycloak-mailpit', 'unleash-postgres', 'unleash-seed',
]);
// Rule 4 — a renamed service MUST NOT re-introduce its OLD service key as a network alias
// (a missed reference must fail loudly, not silently resolve).
const RETIRED_KEYS = new Set([
  'mc-db', 'rs-init', 'mcm-redis', 'mcm-bff-db', 'caddy', 'mcm-bff-dev',
  'agent-gateway', 'agent-gateway-metro', 'agent-db', 'movie-mcp', 'spreadsheet-mcp',
  'web-api-mcp', 'opa', 'unleash', 'vault', 'opensearch', 'keycloak-db',
]);
const APPROVED_NETWORKS = new Set([
  'backend-network',
  'keycloak-network',
  'mcm-bff-network',
  'movie-assistant-mcp-network',
  // Feature 023 Milestone B (prod hardening): private DB link isolating mc-service-store-mongo so only
  // mc-service (+ rs-init) can reach it — the broad backend-network is not a DB peer. Convention-compliant.
  'mc-service-network',
  // Feature 022/023 prod: shared external net the Cloudflare tunnel (cloudflared) joins to reach
  // keycloak-service:8080 / the BFF by name (keycloak/compose.prod.yaml). Convention-compliant (-network).
  'edge-network',
  // Feature 025 (prod control-tower): dedicated isolation network for the append-only audit sink
  // (FR-001) — only agent-audit-opensearch + the gateway/BFF consumers join it (opensearch/compose.prod.yaml).
  'agent-audit-network',
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
  // `.github/workflows/android-e2e.yml` removed in feature 023 (T020) — CI lives on the forge now.
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
    if (!VOLUME_RE.test(name) && !VOLUME_OBS_LOGS_RE.test(name)) {
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

// Aggregator / override files carry no container_name (services only set profiles / depends_on),
// so they are naturally skipped by the `has container_name` guard below — no file exemption needed.

function aliasList(networks) {
  // Compose `networks:` is either a list (`- backend-network`) or a map
  // (`backend-network: { aliases: [...] }`). Collect every declared alias.
  const out = [];
  if (Array.isArray(networks)) return out;
  if (networks && typeof networks === 'object') {
    for (const def of Object.values(networks)) {
      if (def && typeof def === 'object' && Array.isArray(def.aliases)) out.push(...def.aliases);
    }
  }
  return out;
}

function checkContainers(file, doc) {
  const services = doc?.services;
  if (!services || typeof services !== 'object') return;
  for (const [svc, def] of Object.entries(services)) {
    if (!def || typeof def !== 'object') continue;
    const cn = def.container_name;
    // Only services that declare a container_name are first-class definitions in scope.
    if (!cn) continue;

    // Rule 1 — container_name MUST equal the service key.
    if (cn !== svc) {
      fail(file, cn, `service key '${svc}' ≠ container_name '${cn}' — unify both to one identifier (Rule 1)`);
    }
    // Rule 2 — the unified identifier MUST match the convention, unless allowlisted (Rule 3 / 3b).
    if (!NAME_ALLOWLIST.has(cn) && !IDENTIFIER_RE.test(cn)) {
      fail(file, cn, `service '${svc}' identifier does not match <component>[-<role>-<technology>] and is not allowlisted (Rule 2/3/3b)`);
    }
    // Rule 4 — must not re-introduce a retired old key as a network alias.
    for (const alias of aliasList(def.networks)) {
      if (RETIRED_KEYS.has(alias)) {
        fail(file, alias, `service '${svc}' re-adds retired key '${alias}' as a network alias (Rule 4 — old names must not resolve)`);
      }
    }
  }
}

function checkOllama(file, text, doc) {
  // SC-004 targets the REMOVED containerized service + its volume — NOT host Ollama
  // (OLLAMA_BASE_URL / MODEL_PROVIDER=ollama / host.docker.internal:11434 are the supported path).
  if (/\bollama-models\b/.test(text)) fail(file, 'ollama-models', `removed volume 'ollama-models' still referenced`);
  // The container was reachable at DNS host `ollama` — flag only that hostname form.
  if (/\/\/ollama:\d/.test(text)) fail(file, 'http://ollama:<port>', `removed containerized 'ollama' service URL still referenced (use host Ollama)`);
  const services = doc?.services;
  if (services && typeof services === 'object') {
    if (services.ollama) fail(file, 'services.ollama', `removed 'ollama' compose service still defined`);
    for (const [svc, def] of Object.entries(services)) {
      const dep = def && typeof def === 'object' ? def.depends_on : undefined;
      const hasOllama = Array.isArray(dep)
        ? dep.includes('ollama')
        : dep && typeof dep === 'object' && Object.prototype.hasOwnProperty.call(dep, 'ollama');
      if (hasOllama) fail(file, `${svc}.depends_on.ollama`, `service depends_on the removed 'ollama' service`);
    }
  }
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
  if (sections.includes('ollama')) checkOllama(file, text, doc);
}

if (sections.includes('ollama')) {
  for (const rel of SCRIPT_FILES) {
    const abs = resolve(REPO_ROOT, rel);
    try {
      checkOllama(abs, readFileSync(abs, 'utf8'), null);
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
