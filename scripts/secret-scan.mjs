#!/usr/bin/env node
/**
 * secret-scan.mjs — feature 018 (T049, FR-025 / NFR-Sec-4).
 *
 * Fails the build if a credential-shaped string is committed anywhere in the tree, or if a recorded
 * golden cassette carries an auth header / api-key field. Feature 018 makes every provider/TMDB key
 * a per-user secret that is encrypted at rest and injected per-run in memory — none should EVER land
 * in a committed file, log, span, trace, or cassette (SC-006). This is the committed-tree guard.
 *
 * Patterns (deliberately narrow to avoid false positives on commit hashes / placeholders):
 *   - Anthropic API key:  sk-ant-<40+ key chars>  (real keys are ~100 chars; the test markers like
 *     `sk-ant-definitely-not-a-real-key` and the `sk-ant-…` doc placeholder are far shorter → ignored).
 *   - TMDB v3 key:        an `api_key` / `tmdb_key` assignment to a 32-hex value (a bare 32-hex would
 *     false-positive on git SHAs, so we only flag it when bound to a key-named field).
 *   - TMDB v4 token:      a `Bearer eyJ…` JWT bound to TMDB context (read-access-token style).
 *   - Cassettes:          must contain no `authorization` / `x-api-key` / `api_key` field.
 *
 * Usage:
 *   node scripts/secret-scan.mjs            # scan all git-tracked files; exit 1 on any hit
 *   node scripts/secret-scan.mjs --selftest # validate detection (planted key → hit; clean → none)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/secret-scan.mjs';

// --- Detection rules ---------------------------------------------------------
const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]{40,}/;
const TMDB_V3 = /\b(?:tmdb[_-]?key|tmdb_api_key|api_key)["'\s]*[:=>][\s"']*[0-9a-f]{32}\b/i;
const TMDB_V4 = /\b(?:tmdb|themoviedb)[\s\S]{0,40}?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i;
// MCM dev-credential placeholder shapes (features 021/022): the historical inline dev passwords/tokens
// that were externalized + history-scrubbed. This rule is a TREE-WIDE regression guard — the compose
// inline-secret gate only scans compose files, so a hardcoded dev cred in a shell script, test, or doc
// (exactly how the feature-022 literals hid) would otherwise slip through. Matches the `Mcm-dev-…!`
// complex passwords and the `mcm-dev-…-{token,password,secret,salt}` tokens; NOT the LangFuse fixtures
// `pk-lf-mcm-dev-0000…` / `sk-lf-mcm-dev-0000…` (no such suffix) which are deterministic, non-secret.
const MCM_DEV_CRED = /Mcm-dev-[A-Za-z0-9-]+!|mcm-dev-[a-z0-9-]*(?:token|password|secret|salt)|\bminiosecret\b/;
const RULES = [
  { name: 'anthropic-api-key', re: ANTHROPIC_KEY },
  { name: 'tmdb-v3-api-key', re: TMDB_V3 },
  { name: 'tmdb-v4-token', re: TMDB_V4 },
  { name: 'mcm-dev-credential', re: MCM_DEV_CRED },
];
const CASSETTE_FIELD = /"(authorization|x-api-key|api_key|apikey)"\s*:/i;

// Feature 027 US4 — no consumer may hardcode a live E2E credential as a fallback default, and the
// known test-user password must appear nowhere in the tree.
//   Rule A: the exact known password literal. Assembled from fragments so the joined value never
//           appears in THIS file (so a tree-wide grep for it finds zero — SC-008; the scanner is also
//           SELF-excluded from the scan).
//   Rule B: a NON-empty literal fallback default for one of the E2E credential env vars the feature
//           manages via .env.e2e.local / the job env. Two idioms:
//             • JS `??` / `||`:  `process.env.NAME ?? 'x'`  /  `process.env['NAME'] || 'x'`
//             • getter-default:  `get/getenv/cfg/_cfg("NAME", "x")`  (READ-with-default form)
//           Deliberately keyed on a CURATED NAME SET (not a generic PASSWORD|SECRET|TOKEN substring)
//           — a tree-wide grep proved a generic rule false-positives on `*_CLIENT_ID` / `*_AUDIENCE`
//           / `*_TTL_SECONDS` (public, non-secret), the deterministic LangFuse `sk-lf-mcm-dev-*`
//           fixtures, and the documented feature-023 throwaway CI-realm client secrets (`CI_*_SECRET`,
//           deliberately OUT of scope — see spec §Deferred). The getter-default idiom is READ-only, so
//           `monkeypatch.setenv("TMDB_API_KEY", "x")` (which SETS env, not a default) is NOT matched.
//           An empty `?? ''` / no-default form is allowed (fail-clean sentinel).
const E2E_PW_LITERAL = 'TestPass1' + '!' + 'ok';
const CRED_NAMES = 'E2E_TEST_PASSWORD|ANTHROPIC_API_KEY|TMDB_API_KEY';
const CRED_FALLBACK_JS = new RegExp(`(?:${CRED_NAMES})["'\\]]*\\s*(?:\\?\\?|\\|\\|)\\s*["'][^"']+["']`);
const CRED_FALLBACK_GET = new RegExp(`(?:get|getenv|cfg|_cfg)\\(\\s*["'](?:${CRED_NAMES})["']\\s*,\\s*["'][^"']+["']`);

// Intentional NON-key markers used by tests/docs (e.g. the revoked-credential leak-marker, the
// bad-key E2E value, doc placeholders). A real provider key never contains these English tokens,
// so a match carrying one is a deliberate placeholder, not a leaked secret.
const PLACEHOLDER = /MARKER|do-not-surface|definitely-not-a-real|not-a-real-key|EXAMPLE|PLACEHOLDER|FAKE|REVOKED|spoiled|bad-key/i;

/** Scan a single file's text for any rule hit; cassette files additionally check auth fields. */
function scanText(relPath, text) {
  const hits = [];
  for (const { name, re } of RULES) {
    const m = re.exec(text);
    if (m && !PLACEHOLDER.test(m[0])) hits.push({ rule: name, sample: m[0].slice(0, 16) + '…' });
  }
  if (relPath.includes('tests/golden/cassettes/')) {
    const m = CASSETTE_FIELD.exec(text);
    if (m) hits.push({ rule: 'cassette-auth-field', sample: m[1] });
  }
  // Feature 027 US4 — Rule A (known live password literal) + Rule B (E2E-credential fallback shape).
  if (text.includes(E2E_PW_LITERAL)) {
    hits.push({ rule: 'e2e-test-password-literal', sample: E2E_PW_LITERAL.slice(0, 8) + '…' });
  }
  const mFallback = CRED_FALLBACK_JS.exec(text) || CRED_FALLBACK_GET.exec(text);
  if (mFallback) hits.push({ rule: 'e2e-credential-fallback-literal', sample: mFallback[0].slice(0, 40) });
  return hits;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map((p) => posix.normalize(p));
}

function isProbablyText(buf) {
  // Skip binaries: a NUL byte in the first 8 KB is a reliable binary signal.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function runScan() {
  const findings = [];
  for (const rel of trackedFiles()) {
    if (rel === SELF) continue; // the scanner holds the patterns as regex source
    let buf;
    try {
      buf = readFileSync(resolve(REPO_ROOT, rel));
    } catch {
      continue; // deleted/unreadable
    }
    if (!isProbablyText(buf)) continue;
    const hits = scanText(rel, buf.toString('utf8'));
    for (const h of hits) findings.push({ file: rel, ...h });
  }
  if (findings.length) {
    console.error('[secret-scan] ❌ credential-shaped strings found in committed files:');
    for (const f of findings) console.error(`  ${f.file}: ${f.rule} (${f.sample})`);
    console.error('[secret-scan] Secrets are per-user, encrypted at rest, injected per-run — never commit one (SC-006).');
    process.exit(1);
  }
  console.log('[secret-scan] ✅ no credential-shaped strings in committed files.');
}

function selftest() {
  // Build a realistic planted Anthropic key at runtime (no long key-shaped literal in this file).
  const planted = 'sk-ant-api03-' + 'A'.repeat(95);
  const plantedTmdb = 'TMDB_API_KEY=' + 'a'.repeat(32);
  // A hardcoded MCM dev credential in a shell script / test (the feature-022 hole).
  const plantedMcm = 'AUDIT_PASS="${OPENSEARCH_AUDIT_WRITER_PASS:-Mcm-dev-AuditWriter-1!}"';
  const plantedMcmToken = '_ADMIN_TOKEN = "*:*.mcm-dev-unleash-admin-token"';
  // Clean tree: a sha-like hash AND the deterministic LangFuse fixtures must NOT false-positive.
  const clean =
    'const x = "sk-ant-…"; // placeholder\nconst h = "0123456789abcdef0123456789abcdef"; // a sha-like hash\n' +
    'LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-mcm-dev-0000000000000000\n' +
    'LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-mcm-dev-0000000000000000';
  // Feature 027 US4: the known live E2E password literal + the E2E-credential fallback shape across
  // the curated name set. Built from fragments so the joined password never appears in this file (SC-008).
  const plantedE2ePw = 'const P = "' + 'TestPass1' + '!' + 'ok";';
  const plantedFallbackJs = "const P = process.env.E2E_TEST_PASSWORD ?? 'someLiteral';";
  const plantedFallbackPy = 'TEST_PASSWORD = _cfg("E2E_TEST_PASSWORD", "someLiteral")';
  const plantedAnthropicJs = "const K = process.env.ANTHROPIC_API_KEY || 'sk-ant-fallback';";
  const plantedTmdbGet = 'key = os.environ.get("TMDB_API_KEY", "abcdef")';
  // Clean negatives for the new rules: fail-clean forms and non-secret look-alikes that MUST NOT flag.
  const cleanE2e =
    "const a = process.env.E2E_TEST_PASSWORD ?? '';\n" + // empty sentinel — allowed
    "const b = requireEnv('E2E_TEST_PASSWORD');\n" + // no literal default
    'TEST_PASSWORD = _cfg("E2E_TEST_PASSWORD")\n' + // no default
    'monkeypatch.setenv("TMDB_API_KEY", "stray-env-key")\n' + // SETS env (test injection) — not a default
    "const s = process.env.CI_KEYCLOAK_CLIENT_SECRET ?? 'ci-throwaway-x';\n" + // 023 throwaway — out of name set
    "const id = process.env.AGENT_SUBJECT_TOKEN_CLIENT_ID ?? 'agent-subject-token';\n" + // *_CLIENT_ID public
    "const ttl = Number(process.env.EXCHANGED_TOKEN_TTL_SECONDS ?? '60');"; // *_TTL_SECONDS number
  const fails = [];
  if (scanText('x.ts', planted).length === 0) fails.push('planted anthropic key NOT detected');
  if (scanText('config.env', plantedTmdb).length === 0) fails.push('planted TMDB v3 key NOT detected');
  if (scanText('init.sh', plantedMcm).length === 0) fails.push('planted MCM dev password NOT detected');
  if (scanText('test_x.py', plantedMcmToken).length === 0) fails.push('planted MCM dev token NOT detected');
  if (scanText('setup.ts', plantedE2ePw).length === 0) fails.push('planted E2E password literal NOT detected');
  if (scanText('setup.ts', plantedFallbackJs).length === 0) fails.push('planted E2E JS fallback NOT detected');
  if (scanText('conftest.py', plantedFallbackPy).length === 0) fails.push('planted E2E py fallback NOT detected');
  if (scanText('client.ts', plantedAnthropicJs).length === 0) fails.push('planted ANTHROPIC_API_KEY fallback NOT detected');
  if (scanText('conftest.py', plantedTmdbGet).length === 0) fails.push('planted TMDB_API_KEY getter-default NOT detected');
  if (scanText('setup.ts', cleanE2e).length !== 0) fails.push('E2E clean forms false-positived (empty/no-default/setenv/CI-throwaway/CLIENT_ID/TTL)');
  if (scanText('x.ts', clean).length !== 0) fails.push('clean tree false-positived (incl. LangFuse fixtures)');
  if (scanText('tests/golden/cassettes/x.json', '{"authorization":"Bearer y"}').length === 0) {
    fails.push('cassette auth field NOT detected');
  }
  if (fails.length) {
    console.error('[secret-scan --selftest] ❌ ' + fails.join('; '));
    process.exit(1);
  }
  console.log('[secret-scan --selftest] ✅ detects planted keys + cassette auth fields; clean tree passes.');
}

if (process.argv.includes('--selftest')) selftest();
else runScan();
