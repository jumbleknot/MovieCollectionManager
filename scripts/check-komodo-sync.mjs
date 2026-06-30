#!/usr/bin/env node
// Topology gate for the Komodo config-as-code sync (feature 023, T032 / work order §8).
//
// The committed `infrastructure-as-code/komodo/*.toml` Stacks must NOT carry an infra-topology literal
// (the scrub rule, plan.md Addendum): the tailnet host, the public domain, the Tailscale admin IP, or a
// hardcoded webhook/host URL. Everything sensitive is a Komodo Variable token `[[NAME]]` resolved at
// deploy. This asserts that property statically so a real host/IP/URL can't slip past the `[[var]]`
// discipline. Credential SHAPES are caught tree-wide by scripts/secret-scan.mjs; this is the
// topology complement, scoped to the komodo/ sync dir.
//
// Usage:
//   node scripts/check-komodo-sync.mjs            # scan komodo/*.toml; exit 0 clean / 1 on a leak
//   node scripts/check-komodo-sync.mjs --selftest # prove the detector flags planted literals; exit 0/1
//
// Exit codes: 0 clean / selftest passed · 1 topology literal found / selftest broken · 2 bad args.

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_GLOB = 'infrastructure-as-code/komodo/**/*.toml';

// --- Detection rules ---------------------------------------------------------
// A `*.ts.net` tailnet host literal (the homelab Forgejo/registry host lives here in real life).
const TS_NET_HOST = /[A-Za-z0-9-]+\.ts\.net/;
// A Tailscale CGNAT address (100.64.0.0/10) — the admin/host IP must be [[TS_ADMIN_IP]], never inline.
const TAILSCALE_IP = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;
// A hardcoded URL whose authority is NOT a [[var]] token — catches a real domain or webhook host.
// The negative lookahead lets `http://[[TAILNET_HOST]]:8099` (var-host) pass while flagging a literal.
const HARDCODED_URL_HOST = /\bhttps?:\/\/(?![^\s/"']*\[\[)[^\s/"']+/;

const RULES = [
  { name: 'tailnet-host', re: TS_NET_HOST },
  { name: 'tailscale-ip', re: TAILSCALE_IP },
  { name: 'hardcoded-url-host', re: HARDCODED_URL_HOST },
];

/** Scan one TOML text blob; return [{rule, sample, line}]. Scans comments too — a real host in a
 *  comment is still a leak. */
function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of RULES) {
      const m = re.exec(lines[i]);
      if (m) hits.push({ rule: name, sample: m[0].slice(0, 40), line: i + 1 });
    }
  }
  return hits;
}

function runScan() {
  const files = globSync(SCAN_GLOB, { cwd: REPO_ROOT });
  const findings = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const h of scanText(text)) findings.push({ file: rel, ...h });
  }
  if (findings.length) {
    console.error('[komodo-sync] ❌ infra-topology literal(s) in komodo/*.toml — use a [[Variable]] token:');
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.rule} (${f.sample})`);
    console.error('[komodo-sync] Host/domain/IP/webhook must be Komodo Variables ([[NAME]]) — never committed (scrub rule).');
    process.exit(1);
  }
  console.log(`[komodo-sync] ✅ no topology literals (${files.length} komodo TOML file(s) scanned).`);
}

function selftest() {
  // Planted literals (generic, NOT the real homelab values) — each must be detected.
  const fails = [];
  const planted = [
    ['tailnet host', 'env = "REGISTRY_HOST=example-host.ts.net:3000"'],
    ['tailscale ip', 'KC_ADMIN_BIND_IP=100.101.102.103'],
    ['hardcoded url', 'KOMODO_WEBHOOK=https://komodo.example.com/hook/abc'],
  ];
  for (const [label, line] of planted) {
    if (scanText(line).length === 0) fails.push(`planted ${label} NOT detected`);
  }
  // Clean: every sensitive value is a [[var]] token (incl. a var-host URL) — must NOT false-positive.
  const clean = [
    'REGISTRY_HOST=[[TAILNET_HOST]]:3000',
    'KC_HOSTNAME_ADMIN=http://[[TAILNET_HOST]]:8099',
    'KC_ADMIN_BIND_IP=[[TS_ADMIN_IP]]',
    'branch = "022-prod-public-hostname-auth"',
    'PROD_REALM_FILE=/home/prod/keycloak/prod-realm.rendered.json',
    'run_directory = "infrastructure-as-code/docker/bff"',
  ].join('\n');
  if (scanText(clean).length !== 0) {
    fails.push('clean [[var]] sample false-positived: ' + JSON.stringify(scanText(clean)));
  }
  if (fails.length) {
    console.error('[komodo-sync --selftest] ❌ ' + fails.join('; '));
    process.exit(1);
  }
  console.log('[komodo-sync --selftest] ✅ detects planted host/IP/URL literals; [[var]] tokens pass.');
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--selftest');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-komodo-sync.mjs [--selftest]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan();
