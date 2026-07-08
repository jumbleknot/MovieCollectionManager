#!/usr/bin/env node
// Prod restart-policy gate (feature 030).
//
// Why this exists: the 2026-07-08 reboot failure proved that `restart: unless-stopped` does NOT bring
// prod containers back after a reboot on this rootless-Docker host — the graceful-shutdown drain unit
// stops every container to Exited(0), and `unless-stopped` declines to restart a stopped container on
// daemon start. Feature 030 switched every prod service to `restart: always`. Without a gate, config-as-
// code silently drifts back: a future prod service added with the "obvious" `unless-stopped` default
// reintroduces the outage. This gate makes `restart: always` a REQUIRED, self-enforcing property.
//
// Rule (per service in every infrastructure-as-code/docker/**/compose.prod.yaml):
//   - Long-running services MUST declare `restart: always`.
//   - `restart: unless-stopped` is FORBIDDEN (the regression this feature fixes).
//   - `restart: "no"` / `restart: on-failure*` are ALLOWED only for genuine one-shot containers
//     (name/key matches /-(init|seed|rs-init)$/ or /createbucket/) — they exit 0 by design and their
//     effect is persisted in volumes; `always` would restart-loop them.
//   - A missing `restart:` is FORBIDDEN (defaults to `no` → won't survive a reboot).
//
// Usage:
//   node scripts/check-prod-restart-policy.mjs            # scan; exit 0 clean / 1 violation
//   node scripts/check-prod-restart-policy.mjs --selftest # prove detection; exit 0/1
//
// Exit codes: 0 clean / selftest passed · 1 violation / selftest broken · 2 bad args / unparseable.

import { readFileSync, globSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f) => f.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', '').split('\\').join('/');

// A service that legitimately runs once and exits 0 (its effect persists in a volume). `always` would
// restart-loop it, so `no` / `on-failure` is allowed for these ONLY.
const ONESHOT = /(?:^|[-_])(?:init|seed|rs-init)$|createbucket/i;

/** Return an array of {service, policy} violations for one parsed compose doc. */
function violationsOf(doc) {
  const out = [];
  const services = doc?.services;
  if (!services || typeof services !== 'object') return out;
  for (const [name, def] of Object.entries(services)) {
    const policy = def?.restart == null ? null : String(def.restart).replace(/^["']|["']$/g, '');
    const oneshot = ONESHOT.test(name);
    if (policy === 'always') continue; // always is the required happy path
    if (policy === 'unless-stopped') {
      out.push({ service: name, policy, why: 'unless-stopped does not survive a reboot here — use always (feature 030)' });
    } else if (policy === null) {
      out.push({ service: name, policy: '(none)', why: 'no restart policy — defaults to "no", will not return after reboot' });
    } else if ((policy === 'no' || policy.startsWith('on-failure')) && !oneshot) {
      out.push({ service: name, policy, why: `"${policy}" only allowed for one-shot init/seed containers; this is long-running — use always` });
    }
    // one-shot with no/on-failure → allowed (fall through)
  }
  return out;
}

function loadProdDocs() {
  const files = globSync('infrastructure-as-code/docker/**/compose.prod.yaml', { cwd: REPO_ROOT });
  const docs = [];
  for (const f of files) {
    const abs = resolve(REPO_ROOT, f);
    try {
      docs.push({ file: abs, doc: parse(readFileSync(abs, 'utf8')) });
    } catch (e) {
      console.error(`✗ failed to parse ${rel(abs)}: ${e.message}`);
      process.exit(2);
    }
  }
  return docs;
}

function runScan() {
  const docs = loadProdDocs();
  let services = 0;
  const bad = [];
  for (const { file, doc } of docs) {
    services += Object.keys(doc?.services ?? {}).length;
    for (const v of violationsOf(doc)) bad.push({ file: rel(file), ...v });
  }
  if (bad.length) {
    console.error('✗ prod restart-policy gate FAILED — every prod service must declare `restart: always`:\n');
    for (const v of bad) console.error(`  ${v.file} → ${v.service}: ${v.policy}\n      ${v.why}`);
    console.error(
      `\n${bad.length} violation(s). See docs/runbooks/prod-reboot-resilience.md Part 5 (feature 030). ` +
        `One-shot init/seed containers may use restart: "no"; everything else must be always.`
    );
    process.exit(1);
  }
  console.log(`✓ prod restart-policy gate passed (${services} prod service(s); all long-running are restart: always)`);
}

function selftest() {
  const fails = [];
  const check = (doc, wantCount, label) => {
    const got = violationsOf(doc).length;
    if (got !== wantCount) fails.push(`${label}: got ${got} violation(s), want ${wantCount}`);
  };
  // clean: always svc + a one-shot on "no"
  check({ services: { web: { restart: 'always' }, 'langfuse-minio-init': { restart: 'no' } } }, 0, 'clean');
  // planted: unless-stopped is caught
  check({ services: { web: { restart: 'unless-stopped' } } }, 1, 'planted unless-stopped');
  // planted: missing policy is caught
  check({ services: { web: { image: 'x' } } }, 1, 'planted missing');
  // planted: long-running service on "no" is caught (not a one-shot name)
  check({ services: { 'mc-service': { restart: 'no' } } }, 1, 'planted long-running no');
  // allowed: genuine one-shot on "no" / quoted
  check({ services: { 'mc-service-store-mongo-rs-init': { restart: 'no' }, 'minio-createbucket': { restart: '"no"' } } }, 0, 'one-shot exempt');

  if (fails.length) {
    console.error('✗ prod restart-policy gate --selftest FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('✓ prod restart-policy gate --selftest passed (catches unless-stopped/missing/long-running-no; exempts one-shots)');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-prod-restart-policy.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
