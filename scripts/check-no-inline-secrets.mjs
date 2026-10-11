#!/usr/bin/env node
// Static inline-secret gate for feature 021 (externalize-compose-secrets).
// Asserts that no tracked Docker Compose file holds a literal credential: every secret-shaped
// key / password-bearing URL / command·healthcheck·entrypoint auth literal MUST be a pure
// `${VAR}` / `${VAR:?msg}` interpolation reference (an inline `${VAR:-default}` re-leaks plaintext
// and FAILS). Complementary to scripts/secret-scan.mjs (which hunts real-key *shapes* tree-wide);
// this asserts a *structural* property of compose files. See
// specs/021-externalize-compose-secrets/contracts/inline-secret-gate.md.
//
// Usage:
//   node scripts/check-no-inline-secrets.mjs            # scan tracked compose files; exit 0 clean / 1 dirty
//   node scripts/check-no-inline-secrets.mjs --selftest # prove the detector flags a planted literal; exit 0/1
//
// Exit codes: 0 clean / selftest passed · 1 inline credential found / selftest broken · 2 bad args / unparseable.

import { readFileSync, globSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- Detection rules ---------------------------------------------------------

// A secret-shaped env-var name. Case-insensitive substring match.
const SECRET_KEY = /PASSWORD|SECRET|TOKEN|SALT|ENCRYPTION_KEY|_AUTH|REQUIREPASS/i;

// Non-secret keys that match SECRET_KEY but are not credentials — explicitly allowlisted,
// mirroring check-resource-naming.mjs's NAME_ALLOWLIST.
//   *_FILE          → a path to a Docker secret file, not the secret itself (POSTGRES_PASSWORD_FILE).
//   *_USER          → an account name, not a credential.
//   *ACCESS_KEY_ID  → the public half of an S3 key pair (= "langfuse", a non-secret identifier).
//   *_CLIENT_ID     → an OAuth client identifier (public by definition), e.g. AGENT_SUBJECT_TOKEN_CLIENT_ID.
//   *_AUDIENCE      → an OAuth token audience name (public), e.g. AGENT_SUBJECT_TOKEN_AUDIENCE.
//   AGENT_GATEWAY_CLIENT_SECRET → out of scope: injected at deploy as ${...:-} (data-model.md).
function isAllowlistedKey(key) {
  const k = String(key).toUpperCase();
  return (
    k.endsWith('_FILE') ||
    k.endsWith('_USER') ||
    k.endsWith('ACCESS_KEY_ID') ||
    k.endsWith('_CLIENT_ID') ||
    k.endsWith('_AUDIENCE') ||
    k === 'AGENT_GATEWAY_CLIENT_SECRET'
  );
}

// A value is a PURE interpolation reference: ${VAR} or ${VAR:?message}. The :?-message may contain
// anything except a closing brace. A ${VAR:-default} / ${VAR:+x} form is intentionally NOT matched
// (an inline default re-introduces a literal — spec AC2).
const PURE_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:\?[^}]*)?\}$/;

// Replace every ${...} reference with a single sentinel so the literal-detection regexes below can
// run over the rest of the string without the interpolation (and its possibly space/`/`-bearing
// :?-message) confusing them. The sentinel is non-space, so \S+ / [^\s@]+ match it as one token.
// \u0000 as an escape, never a raw NUL byte: a raw one makes grep treat this whole file as
// binary and silently print no matching lines at all (item #448).
const SENTINEL = '\u0000';
const stripVars = (s) => String(s).replace(/\$\{[^}]*\}/g, SENTINEL);

// A password-bearing connection URL: scheme://user:<pw>@host. After stripVars, a fully-externalized
// password is exactly the sentinel; any other content is a literal.
const URL_PW = /:\/\/[^\s:/@]+:([^\s@]+)@/g;
// command / healthcheck / entrypoint auth literals.
const REQUIREPASS = /--requirepass[\s=]+(\S+)/g;
const REDIS_A = /(?:^|\s)-a[\s=]+(\S+)/g; // redis-cli -a <pw> (guarded by a redis-cli presence check)
const CURL_U = /(?:^|\s)-u[\s=]+[^\s:]+:(\S+)/g; // curl -u user:<pw>

const violations = [];
function fail(file, token, reason) {
  violations.push({
    file: file.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', ''),
    token,
    reason,
  });
}

/** Iterate `environment` (map or `- KEY=VALUE` list form) yielding [key, value] string pairs. */
function* envEntries(env) {
  if (!env) return;
  if (Array.isArray(env)) {
    for (const item of env) {
      const s = String(item);
      const eq = s.indexOf('=');
      if (eq === -1) yield [s, ''];
      else yield [s.slice(0, eq), s.slice(eq + 1)];
    }
  } else if (typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) yield [k, v == null ? '' : String(v)];
  }
}

/** Join a command/healthcheck.test/entrypoint field (string or list) into one scannable string. */
function asText(field) {
  if (field == null) return '';
  if (Array.isArray(field)) return field.map((x) => String(x)).join(' ');
  return String(field);
}

/** Scan one stripped text blob for URL / requirepass / -a / -u literals. */
function scanAuthText(file, where, rawText) {
  const text = stripVars(rawText);
  for (const re of [URL_PW, REQUIREPASS, CURL_U]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] !== SENTINEL) fail(file, `${where}: ${rawText.trim().slice(0, 60)}`, `inline credential in ${where} (must be a \${VAR} reference)`);
    }
  }
  if (/redis-cli/.test(text)) {
    REDIS_A.lastIndex = 0;
    let m;
    while ((m = REDIS_A.exec(text))) {
      if (m[1] !== SENTINEL) fail(file, `${where}: redis-cli -a`, `inline redis password in ${where} (must be a \${VAR} reference)`);
    }
  }
}

function scanDoc(file, doc) {
  const services = doc?.services;
  if (!services || typeof services !== 'object') return;
  for (const [svc, def] of Object.entries(services)) {
    if (!def || typeof def !== 'object') continue;

    // environment: secret-shaped keys must be pure ${VAR}; any value may carry a password URL.
    for (const [key, value] of envEntries(def.environment)) {
      if (SECRET_KEY.test(key) && !isAllowlistedKey(key)) {
        if (!PURE_REF.test(value.trim())) {
          fail(file, `${svc}.environment.${key}`, `secret-shaped key holds a literal (must be \${${key}:?…})`);
        }
      }
      // URL password embedded in any env value (DATABASE_URL, AGENT_DB_URL, …).
      scanAuthText(file, `${svc}.environment.${key}`, value);
    }

    // command / healthcheck / entrypoint auth literals.
    scanAuthText(file, `${svc}.command`, asText(def.command));
    scanAuthText(file, `${svc}.healthcheck`, asText(def.healthcheck?.test));
    scanAuthText(file, `${svc}.entrypoint`, asText(def.entrypoint));
  }
}

function composeFiles() {
  const globs = [
    'infrastructure-as-code/docker/**/compose*.yaml', // component files (compose.yaml)
    'infrastructure-as-code/docker/stacks/*.compose.yaml', // stack aggregators
  ];
  const files = new Set();
  for (const g of globs) for (const f of globSync(g, { cwd: REPO_ROOT })) files.add(f);
  files.add('compose.yaml'); // retired root pointer — should stay clean
  return [...files].map((f) => resolve(REPO_ROOT, f));
}

function runScan() {
  const files = composeFiles();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // root compose.yaml may not exist (retired) — fine
    }
    let doc;
    try {
      doc = parse(text);
    } catch (e) {
      console.error(`✗ failed to parse ${file}: ${e.message}`);
      process.exit(2);
    }
    scanDoc(file, doc);
  }
  if (violations.length) {
    console.error('✗ inline-secret gate FAILED — clear-text credentials in tracked compose files:\n');
    for (const v of violations) console.error(`  ${v.file}\n    ${v.token}\n    ${v.reason}\n`);
    console.error(
      `${violations.length} inline credential(s). Replace each with \${VAR:?set in stacks/<stack>.env} and add the var to the stack's .env.example (see specs/021-externalize-compose-secrets).`
    );
    process.exit(1);
  }
  console.log(`✓ inline-secret gate passed (${files.length} compose files scanned; no clear-text credentials)`);
}

function selftest() {
  const cases = [
    // [label, doc, expectViolation]
    ['planted env password', { services: { x: { environment: { POSTGRES_PASSWORD: 'hunter2' } } } }, true],
    ['planted URL password', { services: { x: { environment: { DATABASE_URL: 'postgres://u:hunter2@h:5432/db' } } } }, true],
    ['planted requirepass', { services: { x: { command: ['redis-server', '--requirepass', 'hunter2'] } } }, true],
    ['planted curl -u', { services: { x: { healthcheck: { test: ['CMD-SHELL', 'curl -u admin:hunter2 https://h'] } } } }, true],
    ['planted :- default', { services: { x: { environment: { API_SECRET: '${API_SECRET:-hunter2}' } } } }, true],
    ['clean ${VAR}', { services: { x: { environment: { POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?set in stacks/x.env}' } } } }, false],
    ['clean URL ${VAR}', { services: { x: { environment: { DATABASE_URL: 'postgres://u:${PG_PW:?msg with spaces}@h:5432/db' } } } }, false],
    ['clean requirepass ${VAR}', { services: { x: { command: ['redis-server', '--requirepass', '${R:?m}'] } } }, false],
    ['allowlisted _FILE', { services: { x: { environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/pw' } } } }, false],
    ['allowlisted _USER', { services: { x: { environment: { POSTGRES_USER: 'langfuse' } } } }, false],
  ];
  const fails = [];
  for (const [label, doc, expect] of cases) {
    violations.length = 0;
    scanDoc('selftest.yaml', doc);
    const got = violations.length > 0;
    if (got !== expect) fails.push(`${label}: expected ${expect ? 'violation' : 'clean'}, got ${got ? 'violation' : 'clean'}`);
  }
  violations.length = 0;
  if (fails.length) {
    console.error('✗ inline-secret gate --selftest FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('✓ inline-secret gate --selftest passed (detects planted literals; clean ${VAR} samples pass)');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-no-inline-secrets.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
