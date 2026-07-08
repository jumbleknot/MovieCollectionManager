#!/usr/bin/env node
// DAST merge gate (feature 031, T016/T023).
// Contract: specs/031-dast-zap-scanning/contracts/zap-scan-contract.md.
//
// Parses a ZAP `traditional-json` report, suppresses findings matched by security/zap/allowlist.yaml
// (the allowlist IS the baseline — no stored diff), and FAILS (exit 1) on any remaining High-risk
// finding. Medium/Low/Informational are printed as warnings and never fail. Suppression removes a
// finding from the GATE only — it stays visible in the HTML/JSON reports (FR-010).
//
// Usage:
//   node scripts/check-dast-findings.mjs --report <zap-json> [--allowlist security/zap/allowlist.yaml]
//   node scripts/check-dast-findings.mjs --selftest
//
// Exit codes: 0 pass / selftest ok · 1 un-allowlisted High present · 2 bad args / unparseable report
//             or invalid allowlist entry.
//
// MUST NOT print secrets — only finding metadata (rule, risk, URL) which ZAP already redacts.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST = resolve(REPO_ROOT, 'security/zap/allowlist.yaml');

const RISK_BY_CODE = { '0': 'Informational', '1': 'Low', '2': 'Medium', '3': 'High' };
const RISK_ORDER = ['High', 'Medium', 'Low', 'Informational'];

/** Normalize a ZAP traditional-json report into a flat finding list. */
export function parseFindings(report) {
  const findings = [];
  for (const site of report?.site ?? []) {
    for (const a of site.alerts ?? []) {
      const risk =
        RISK_BY_CODE[String(a.riskcode)] ??
        (typeof a.riskdesc === 'string' ? a.riskdesc.split(' ')[0] : 'Informational');
      const uris = (a.instances ?? []).map((i) => i.uri).filter(Boolean);
      findings.push({
        pluginId: String(a.pluginid ?? a.alertRef ?? ''),
        name: a.name ?? a.alert ?? '(unnamed)',
        riskLevel: risk,
        uris: uris.length ? uris : [site['@name']].filter(Boolean),
      });
    }
  }
  return findings;
}

/**
 * Load + validate the allowlist. Every entry MUST carry a non-empty pluginId, uriPattern,
 * justification and addedBy — a blank field is a gate error (SC-006, FR-010). Returns entries with a
 * compiled `re` RegExp.
 */
export function loadAllowlist(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return []; // no allowlist file → nothing suppressed
  }
  const parsed = parseYaml(raw) ?? [];
  if (!Array.isArray(parsed)) throw new GateError(`allowlist ${path} must be a YAML list`);
  return parsed.map((e, i) => {
    for (const field of ['pluginId', 'uriPattern', 'justification', 'addedBy']) {
      if (!e || typeof e[field] !== 'string' || e[field].trim() === '') {
        throw new GateError(`allowlist entry #${i + 1} has a missing/blank "${field}" — every suppression needs pluginId, uriPattern, justification, addedBy.`);
      }
    }
    let re;
    try {
      re = new RegExp(e.uriPattern);
    } catch (err) {
      throw new GateError(`allowlist entry #${i + 1} uriPattern is not a valid regex: ${err.message}`);
    }
    return { pluginId: String(e.pluginId), uriPattern: e.uriPattern, re, justification: e.justification, addedBy: e.addedBy };
  });
}

/**
 * Partition findings into { kept, suppressed } using the allowlist. A finding is suppressed when an
 * allowlist entry has the same pluginId AND its uriPattern matches one of the finding's URIs.
 */
export function suppressFindings(findings, allowlist) {
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    const match = allowlist.find((e) => e.pluginId === f.pluginId && f.uris.some((u) => e.re.test(u)));
    if (match) suppressed.push({ ...f, allowlist: match });
    else kept.push(f);
  }
  return { kept, suppressed };
}

class GateError extends Error {}

function printSummary(kept, suppressed) {
  const byRisk = (list, r) => list.filter((f) => f.riskLevel === r);
  console.log('── DAST gate summary ──────────────────────────────────');
  for (const r of RISK_ORDER) {
    const items = byRisk(kept, r);
    if (!items.length) continue;
    console.log(`${r}: ${items.length}`);
    for (const f of items) console.log(`  [${f.pluginId}] ${f.name} — ${f.uris[0] ?? ''}`);
  }
  if (suppressed.length) {
    console.log(`Allowlisted (still visible in reports, not gated): ${suppressed.length}`);
    for (const f of suppressed) console.log(`  [${f.pluginId}] ${f.name} — allowlisted by ${f.allowlist.addedBy}`);
  }
  console.log('───────────────────────────────────────────────────────');
}

/** Run the gate over a parsed report + allowlist entries. Returns exit code (0 pass / 1 fail). */
export function gate(report, allowlist) {
  const findings = parseFindings(report);
  const { kept, suppressed } = suppressFindings(findings, allowlist);
  printSummary(kept, suppressed);
  const highs = kept.filter((f) => f.riskLevel === 'High');
  if (highs.length) {
    console.error(`✗ DAST gate FAILED: ${highs.length} un-allowlisted High finding(s). Triage and either fix or add a justified allowlist entry (security/zap/allowlist.yaml).`);
    return 1;
  }
  console.log('✓ DAST gate passed (no un-allowlisted High findings).');
  return 0;
}

// ── Self-test (repo `--selftest`-then-scan convention) ───────────────────────
// Proves BOTH gate paths with embedded synthetic data — read-only, touches no repo file.
function selftest() {
  const high = {
    site: [{
      '@name': 'http://mc-service:3001',
      alerts: [{ pluginid: '40018', name: 'SQL Injection', riskcode: '3',
        instances: [{ uri: 'http://mc-service:3001/api/v1/collections' }] }],
    }],
  };
  const failures = [];

  // (a) un-allowlisted High → exit 1
  if (gate(high, []) !== 1) failures.push('un-allowlisted High should FAIL (exit 1)');

  // (b) same High allowlisted → exit 0 (suppressed from the gate)
  const allow = [{ pluginId: '40018', uriPattern: 'http://mc-service:3001/api/v1/.*',
    re: /http:\/\/mc-service:3001\/api\/v1\/.*/, justification: 'selftest', addedBy: 'selftest' }];
  if (gate(high, allow) !== 0) failures.push('allowlisted High should PASS (exit 0)');

  // (c) clean report → exit 0
  if (gate({ site: [{ '@name': 'x', alerts: [] }] }, []) !== 0) failures.push('clean report should PASS (exit 0)');

  // (d) blank justification → GateError
  try {
    loadAllowlistFromString('- pluginId: "1"\n  uriPattern: ".*"\n  justification: ""\n  addedBy: "x"\n');
    failures.push('blank justification should be rejected');
  } catch (e) { if (!(e instanceof GateError)) failures.push('blank justification should throw GateError'); }

  if (failures.length) {
    console.error('✗ check-dast-findings --selftest FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('✓ check-dast-findings --selftest passed (fail path, allowlist-suppress path, clean path, blank-justification rejection).');
  process.exit(0);
}

// Validate an allowlist supplied as a YAML string (used by selftest without a temp file).
function loadAllowlistFromString(yaml) {
  const parsed = parseYaml(yaml) ?? [];
  return (Array.isArray(parsed) ? parsed : []).map((e, i) => {
    for (const field of ['pluginId', 'uriPattern', 'justification', 'addedBy']) {
      if (!e || typeof e[field] !== 'string' || e[field].trim() === '') {
        throw new GateError(`allowlist entry #${i + 1} blank "${field}"`);
      }
    }
    return { ...e, re: new RegExp(e.uriPattern) };
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  let reportPath = null;
  let allowlistPath = DEFAULT_ALLOWLIST;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') reportPath = argv[++i];
    else if (argv[i] === '--allowlist') allowlistPath = argv[++i];
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  }
  if (!reportPath) { console.error('Usage: check-dast-findings.mjs --report <zap-json> [--allowlist <yaml>] | --selftest'); process.exit(2); }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e) {
    console.error(`✗ could not read/parse report ${reportPath}: ${e.message}`);
    process.exit(2);
  }
  let allowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  process.exit(gate(report, allowlist));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
