// T015 / T022 — DAST gate (scripts/check-dast-findings.mjs) — feature 031.
// Feeds synthetic ZAP traditional-json reports through the gate CLI and asserts exit codes:
//   T015 (US2): un-allowlisted High → exit 1, finding named in the summary (SC-004).
//   T022 (US3): matching allowlist entry → exit 0; a different High still → exit 1;
//               blank justification → error (SC-006, FR-010).
// Runs the real CLI as a subprocess (contract-level), no Docker/network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-dast-findings.mjs');

function highReport(uri = 'http://mc-service:3001/api/v1/collections', pluginid = '40018', name = 'SQL Injection') {
  return {
    site: [
      {
        '@name': 'http://mc-service:3001',
        alerts: [
          {
            pluginid,
            alert: name,
            name,
            riskcode: '3', // High
            riskdesc: 'High (Medium)',
            instances: [{ uri, method: 'GET' }],
          },
        ],
      },
    ],
  };
}

function runGate(report, allowlistYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'dast-gate-'));
  try {
    const reportPath = join(dir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));
    const args = ['--report', reportPath];
    if (allowlistYaml !== undefined) {
      const alPath = join(dir, 'allowlist.yaml');
      writeFileSync(alPath, allowlistYaml);
      args.push('--allowlist', alPath);
    }
    const r = spawnSync('node', [GATE, ...args], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('T015: un-allowlisted High fails the gate (exit 1) and names the finding', () => {
  const { code, out } = runGate(highReport(), '[]\n');
  assert.equal(code, 1, 'a High finding with an empty allowlist must fail the gate');
  assert.match(out, /SQL Injection/, 'the High finding must appear in the summary');
});

test('T015: a clean report passes the gate (exit 0)', () => {
  const { code } = runGate({ site: [{ '@name': 'http://mc-service:3001', alerts: [] }] }, '[]\n');
  assert.equal(code, 0);
});

test('--selftest proves both the fail and pass paths (exit 0)', () => {
  const r = spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, '--selftest must exit 0 when the gate logic is correct');
});

// ── US3 (T022) — allowlist suppression ───────────────────────────────────────
const MATCHING_ALLOWLIST = `
- pluginId: "40018"
  uriPattern: "http://mc-service:3001/api/v1/.*"
  justification: "Accepted: parameter is server-generated, not user-controlled (triaged)."
  addedBy: "steve"
`;

test('T022(a): a High matched by the allowlist passes the gate (exit 0)', () => {
  const { code } = runGate(highReport(), MATCHING_ALLOWLIST);
  assert.equal(code, 0, 'an allowlisted High must be suppressed from the gate');
});

test('T022(b): a different un-allowlisted High still fails (exit 1)', () => {
  const other = highReport('http://mcm-bff-service-nonsecure:3000/bff-api/collections', '40012', 'XSS');
  const { code, out } = runGate(other, MATCHING_ALLOWLIST);
  assert.equal(code, 1, 'a High not covered by the allowlist must still fail');
  assert.match(out, /XSS/);
});

test('T022(c): an allowlist entry with a blank justification is a gate error', () => {
  const bad = `
- pluginId: "40018"
  uriPattern: "http://mc-service:3001/api/v1/.*"
  justification: ""
  addedBy: "steve"
`;
  const { code } = runGate(highReport(), bad);
  assert.notEqual(code, 0, 'a blank justification must be rejected, not silently honored');
});
