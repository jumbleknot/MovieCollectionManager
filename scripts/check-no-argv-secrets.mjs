#!/usr/bin/env node
// Keyless argv-secret gate for feature 027 (keep E2E secrets off the test-runner command line).
// Fails the build if any in-scope tracked file passes a credential-NAMED argument to the Maestro
// test runner on the command line (`(--env|-e) <KEY>=…` where <KEY> matches KEY|PASSWORD|SECRET|TOKEN).
// Such an argument re-serialises the secret onto `argv`, where `ps`/`/proc` leak it on the shared CI
// host. The sanctioned path is scripts/maestro-run.sh (secrets via the MAESTRO_-prefixed env channel).
// Modeled on scripts/secret-scan.mjs / scripts/check-no-inline-secrets.mjs. See
// specs/027-ci-maestro-secrets/contracts/argv-secret-guard.md.
//
// Usage:
//   node scripts/check-no-argv-secrets.mjs            # scan in-scope git-tracked files; exit 1 on any hit
//   node scripts/check-no-argv-secrets.mjs --selftest # validate detection (planted line → hit; clean → none)
//
// Exit codes: 0 clean / selftest passed · 1 flagged argument / selftest broken · 2 bad args.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/check-no-argv-secrets.mjs';

// --- Detection ---------------------------------------------------------------
// A credential-shaped env-var NAME (case-insensitive substring). E2E_TEST_USER (username) and
// COLLECTION_NAME / MOVIE_TITLE / SRC_NAME / OLLAMA_BASE_URL (non-secret per-run values) do NOT match.
const SECRET_KEY = /KEY|PASSWORD|SECRET|TOKEN/i;
// A `--env <NAME>=` / `-e <NAME>=` argument. Tolerant of an optional opening quote before NAME
// (`--env "FOO=…"`); the value shape is irrelevant — the argument PATTERN is the violation.
const ENV_ARG = /(?:--env|-e)\s+["']?([A-Za-z_][A-Za-z0-9_]*)=/g;

// Flag a credential-named --env arg that appears in a `maestro` invocation context (covers both
// `maestro test …` and the `scripts/maestro-run.sh …` wrapper — forwarding a secret to the wrapper
// re-exposes it on argv too). Backslash line-continuations are joined first, so a flag split across
// lines (the CI runner's multi-line `--env FOO="$FOO" \` shape) is still associated with `maestro`.
function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; ) {
    const startLine = i;
    let joined = lines[i];
    while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
      joined = joined.replace(/\\\s*$/, ' ') + lines[++i];
    }
    i++;
    if (!/maestro/.test(joined)) continue;
    ENV_ARG.lastIndex = 0;
    let m;
    while ((m = ENV_ARG.exec(joined))) {
      if (SECRET_KEY.test(m[1])) hits.push({ line: startLine + 1, key: m[1] });
    }
  }
  return hits;
}

// --- Scope / allowlist -------------------------------------------------------
function inScope(rel) {
  if (rel === SELF) return false; // the guard holds the pattern as regex source
  if (rel.startsWith('specs/')) return false; // historical spec records (clarification)
  if (rel.startsWith('docs/proposals/')) return false; // design/proposal records (same rationale as specs)
  return (
    rel.startsWith('scripts/') ||
    /^frontend\/mcm-app\/tests\/e2e\/mobile\/[^/]*\.ya?ml$/.test(rel) ||
    rel.startsWith('docs/') ||
    rel === 'CLAUDE.md'
  );
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map((p) => posix.normalize(p));
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function runScan() {
  const findings = [];
  for (const rel of trackedFiles()) {
    if (!inScope(rel)) continue;
    let buf;
    try {
      buf = readFileSync(resolve(REPO_ROOT, rel));
    } catch {
      continue;
    }
    if (!isProbablyText(buf)) continue;
    for (const hit of scanText(buf.toString('utf8'))) findings.push({ file: rel, ...hit });
  }
  if (findings.length) {
    console.error('❌ argv-secret gate FAILED — credential-named --env arguments to the test runner:\n');
    for (const f of findings) console.error(`  ${f.file}:${f.line} — --env ${f.key}=`);
    console.error(
      '\nSecrets must reach Maestro via the MAESTRO_-prefixed env channel, not argv. Use ' +
        'scripts/maestro-run.sh <flow> and put the value in the job env / gitignored .env.e2e.local.'
    );
    process.exit(1);
  }
  console.log('✅ no argv-secret arguments to the test runner');
}

function selftest() {
  const POS = [
    ['single-line', 'maestro test flow.yaml --env E2E_TEST_PASSWORD="$P"'],
    ['multi-line', 'maestro test x.yaml \\\n    --env ANTHROPIC_API_KEY=abc'],
  ];
  const NEG = [
    ['wrapper', 'scripts/maestro-run.sh tests/e2e/mobile/x.yaml'],
    ['non-secret env', 'maestro test x.yaml --env COLLECTION_NAME="t-1"'],
    ['username env', 'maestro test x.yaml --env E2E_TEST_USER="$U"'],
  ];
  const fails = [];
  for (const [label, text] of POS) {
    if (scanText(text).length === 0) fails.push(`positive '${label}' NOT detected`);
  }
  for (const [label, text] of NEG) {
    if (scanText(text).length !== 0) fails.push(`negative '${label}' false-positived`);
  }
  if (fails.length) {
    console.error('❌ argv-secret gate --selftest FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('✅ detects planted --env SECRET=; clean tree passes');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-no-argv-secrets.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
