#!/usr/bin/env node
// Topology-scrub gate (feature 023 follow-up) — prevents the real tailnet host from re-entering the
// tracked tree. The domain + tailnet host were scrubbed from the repo AND git history (pre-public);
// they must NEVER be committed again, yet with no gate they silently re-leaked across sessions (docs,
// HANDOFFs, ci-realm.json). This is the whole-tree guard for tailnet `*.ts.net` hosts.
//
// Pattern-based, NOT literal: the gate CANNOT hard-code the real tailnet id (that would itself re-leak
// it). Instead it flags any `<labels>.ts.net` FQDN that is not a sanitized placeholder. The repo's
// documented placeholders all carry the literal word `tailnet` (e.g. `server.tailnet.ts.net`,
// `prod-host.tailnet.ts.net`, `beelink.<tailnet>.ts.net`) or `example` (`example-host.ts.net`); a real
// Tailscale host (random tailnet id like `tailXXXXXX`) carries neither → it is flagged.
//
// Scope note: this gates the TAILNET HOST only. The public DOMAIN cannot be pattern-gated without
// embedding the literal (defeating the scrub) — it relies on the `${BASE_DOMAIN}` convention + review.
//
// Usage:
//   node scripts/check-topology-scrub.mjs            # scan tracked files; exit 1 on a real tailnet host
//   node scripts/check-topology-scrub.mjs --selftest # prove detection; exit 0/1
//
// Exit codes: 0 clean / selftest passed · 1 tailnet host found / selftest broken · 2 bad args.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/check-topology-scrub.mjs';

// A tailnet FQDN: one or more dot-separated labels ending in `.ts.net`.
const TS_NET = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/g;
// Sanitized-placeholder tokens. A matched host containing one of these (case-insensitive) is allowed;
// a real host (random tailnet id) contains neither and is flagged. These are generic English words,
// not the secret — the gate never stores the real id.
const PLACEHOLDER_TOKENS = ['tailnet', 'example'];

function isPlaceholder(host) {
  const h = host.toLowerCase();
  return PLACEHOLDER_TOKENS.some((t) => h.includes(t));
}

/** Return the flagged tailnet hosts (non-placeholder) in a text blob, with line numbers. */
function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    TS_NET.lastIndex = 0;
    let m;
    while ((m = TS_NET.exec(lines[i]))) {
      if (!isPlaceholder(m[0])) hits.push({ host: m[0], line: i + 1 });
    }
  }
  return hits;
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
    if (rel === SELF) continue; // the gate holds the pattern
    let buf;
    try {
      buf = readFileSync(resolve(REPO_ROOT, rel));
    } catch {
      continue;
    }
    if (!isProbablyText(buf)) continue;
    for (const h of scanText(buf.toString('utf8'))) findings.push({ file: rel, ...h });
  }
  if (findings.length) {
    console.error('[topology-scrub] ❌ real tailnet host(s) committed — use a placeholder (`<tailnet-host>` / `*.tailnet.ts.net`):');
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.host}`);
    console.error('[topology-scrub] The tailnet host + domain were scrubbed from the repo/history — never re-commit them.');
    process.exit(1);
  }
  console.log('[topology-scrub] ✅ no real tailnet host in committed files.');
}

function selftest() {
  const fails = [];
  // Planted REAL-looking tailnet hosts (fake ids, NOT the actual one) — must be detected.
  const planted = [
    'REGISTRY_HOST=beelink.tailz9x8w7.ts.net:3000',
    'ssh ci@myhost.tail0a1b2c.ts.net',
  ];
  for (const line of planted) {
    if (scanText(line).length === 0) fails.push(`planted real tailnet host NOT detected: ${line}`);
  }
  // Sanitized placeholders — must NOT false-positive.
  const clean = [
    'server.tailnet.ts.net:3000',
    'prod-host.tailnet.ts.net:8099',
    'example-host.ts.net',
    'beelink.<tailnet>.ts.net',
    'h.tailnet.ts.net',
    '<tailnet-host>:3000',
  ].join('\n');
  if (scanText(clean).length !== 0) {
    fails.push('placeholder(s) false-positived: ' + JSON.stringify(scanText(clean)));
  }
  if (fails.length) {
    console.error('[topology-scrub --selftest] ❌ ' + fails.join('; '));
    process.exit(1);
  }
  console.log('[topology-scrub --selftest] ✅ detects real tailnet hosts; sanitized placeholders pass.');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-topology-scrub.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
