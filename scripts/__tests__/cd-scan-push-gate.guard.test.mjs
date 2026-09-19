// Item #499 — cd-deploy's built-image scan had no retry, and its exit code could not tell a
// vulnerability-DB blip from a blocking Critical.
//
// WHAT WAS THERE:
//
//   trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed --no-progress "$local_tag"
//
// `--exit-code 1` sets the code Trivy returns when it FINDS something. Trivy also exits 1 on an
// ERROR. So the step could not tell the operator which had happened, and the obvious reading ("a
// fixable Critical blocked the deploy") was the wrong one roughly half the time it fired — measured
// on the sibling path in item #495, runs 3619/3622/3625/3628 (PR #494, 2026-09-19): the same commit
// passed and failed nine minutes apart on a `[vulndb] Failed to download artifact`.
//
// THE FIX IS STRUCTURAL, NOT A BIGGER FLAG. The step now runs the same two commands minio-image.yml
// has run since feature 069:
//
//   node scripts/infra-image-scan.mjs --image "$local_tag"   → findings as JSON; non-zero = ERROR
//   node scripts/check-infra-image-findings.mjs              → non-zero = un-allowlisted BLOCKING finding
//
// Because the scanner is invoked with `--format json` and NO `--exit-code`, a non-zero status from
// the first command can only be a failure to scan, and the verdict comes from the second. The two
// meanings are carried by two different commands rather than by one integer. Retry, the severity
// map and the allowlist are all inherited from that shared pipeline rather than reimplemented in
// bash — the outcome item #499 names as the one to avoid is a second signature list.
//
// Pure-function + static-text tests. No Docker, no Trivy, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTrivy, loadSeverityMap } from '../infra-image-scan.mjs';
import { gate } from '../check-infra-image-findings.mjs';
import { isTransientScannerFailure } from '../lib/scanner-retry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_PUSH = readFileSync(resolve(REPO_ROOT, 'scripts/cd/scan-push.sh'), 'utf8');
/**
 * The EXECUTABLE lines only — comments stripped.
 *
 * The header comment quotes the old `trivy image --exit-code 1 …` invocation verbatim, because the
 * defect is not obvious from the replacement alone and a reader needs to see what was wrong. A guard
 * that matched the whole file would fire on that explanation and push the next author into deleting
 * the explanation to get green, which is the wrong repair.
 */
const SCAN_PUSH_CODE = SCAN_PUSH.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

// ── The step's shape ─────────────────────────────────────────────────────────────────────────────

test('(#499) the conflated bare `trivy --exit-code` form is gone from the deploy path', () => {
  // The whole defect in one line. --exit-code makes Trivy's FINDING code collide with its ERROR
  // code, and no amount of retry around it recovers the distinction.
  assert.doesNotMatch(
    SCAN_PUSH_CODE,
    /trivy\s+image[^\n]*--exit-code/,
    'scan-push.sh is back to a bare `trivy image --exit-code` — findings and transport errors then ' +
      'share one exit status again',
  );
});

test('(#499) the deploy path scans through the SHARED pipeline, so it inherits the retry', () => {
  assert.match(SCAN_PUSH_CODE, /scripts\/infra-image-scan\.mjs --image/, 'no --image scan in scan-push.sh');
  assert.match(SCAN_PUSH_CODE, /scripts\/check-infra-image-findings\.mjs/, 'no findings gate in scan-push.sh');
});

test('(#499) FAIL-CLOSED: the gate runs BEFORE the push, for every image', () => {
  // The assertion that actually protects production. A scan that runs after `docker push` has
  // already shipped the image it was meant to stop; a gate that runs after it gates nothing.
  const lines = SCAN_PUSH_CODE.split(/\r?\n/);
  const idx = (re) => lines.findIndex((l) => re.test(l));
  const scanAt = idx(/infra-image-scan\.mjs --image/);
  const gateAt = idx(/check-infra-image-findings\.mjs/);
  const pushAt = idx(/^\s*docker push/);
  assert.ok(scanAt >= 0 && gateAt >= 0 && pushAt >= 0, 'scan, gate and push must all be present');
  assert.ok(scanAt < pushAt, 'the scan must precede the push');
  assert.ok(gateAt < pushAt, 'the FINDINGS GATE must precede the push — otherwise it gates nothing');
});

test('(#499) the scan and the gate are inside the per-image loop, not run once for six images', () => {
  // infra-image-scan.mjs writes ONE findings.json per invocation and the gate reads that file, so a
  // single scan outside the loop would gate only the last image — and silently.
  const body = SCAN_PUSH_CODE.slice(SCAN_PUSH_CODE.indexOf('for pair in $map; do'), SCAN_PUSH_CODE.indexOf('\ndone'));
  assert.ok(body.length > 0, 'the per-image loop has moved — re-check this guard');
  assert.match(body, /infra-image-scan\.mjs --image/, 'the scan must be inside the per-image loop');
  assert.match(body, /check-infra-image-findings\.mjs/, 'the gate must be inside the per-image loop');
});

test('(#499) `set -euo pipefail` still governs the step', () => {
  // Fail-closed depends on it: without -e a non-zero scan or gate would be logged and walked past.
  assert.match(SCAN_PUSH, /^set -euo pipefail$/m);
});

test('(#499) an ERROR and a FINDING are reported in words, not left to an exit code', () => {
  // The item's second acceptance criterion is about the step's OUTPUT, not only its behaviour: the
  // operator reading a failure digest must be told which of the two happened.
  assert.match(SCAN_PUSH, /could not run|scanner error|transport/i, 'no message naming a scan FAILURE');
  assert.match(SCAN_PUSH, /blocking|fixable CRITICAL/i, 'no message naming a blocking FINDING');
});

test('(#499) the build-deploy job still installs what the shared pipeline needs', () => {
  // The scan is now Node, and infra-image-scan.mjs imports the `yaml` package for the severity map.
  // A future edit dropping either prerequisite would fail at DEPLOY time, on the production path.
  const wf = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/cd-deploy.yml'), 'utf8');
  const job = wf.slice(wf.indexOf('build-deploy:'));
  assert.match(job, /pnpm install --frozen-lockfile/, 'the deploy job must install JS deps for the scanner');
  assert.match(job, /TRIVY_VERSION=v[\d.]+/, 'the deploy job must still install a PINNED Trivy');
});

// ── The control: a genuine fixable CRITICAL still blocks, and is NOT retried ─────────────────────

/** One fixable CRITICAL, in the shape Trivy v0.74.0 emits it. */
const FIXABLE_CRITICAL = {
  Results: [
    {
      Target: 'mcm-bff:latest (alpine 3.23)',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2026-99999',
          PkgName: 'libcrypto3',
          InstalledVersion: '3.5.0-r0',
          FixedVersion: '3.5.1-r0', // ← fixable: this is what makes it blocking
          Severity: 'CRITICAL',
          Title: 'openssl: a timeout error in the service response handling',
        },
      ],
    },
  ],
};

test('(#499) CONTROL — a fixable CRITICAL still fails the gate, exactly as the bash step did', () => {
  const findings = normalizeTrivy(FIXABLE_CRITICAL, 'mcm-bff:latest', [{ path: '(--image)', line: 0 }], loadSeverityMap());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, true, 'a fixable CRITICAL must be blocking');
  const code = gate({ schemaVersion: 1, generatedForImages: ['mcm-bff:latest'], findings }, [], '2026-09-19');
  assert.equal(code, 1, 'an un-allowlisted fixable CRITICAL must FAIL the gate — the deploy must not push');
});

test('(#499) CONTROL — the policy bar is unchanged: an UNFIXABLE critical still does not block', () => {
  // The bash step passed --ignore-unfixed, so a Critical with no upstream fix never blocked (the
  // agent-gateway perl-base CVEs). Pinned, because inheriting the shared pipeline must not quietly
  // dead-end the deploy on things nobody can patch.
  const unfixable = structuredClone(FIXABLE_CRITICAL);
  delete unfixable.Results[0].Vulnerabilities[0].FixedVersion;
  const findings = normalizeTrivy(unfixable, 'mcm-bff:latest', [{ path: '(--image)', line: 0 }], loadSeverityMap());
  assert.equal(findings[0].blocking, false, 'an UNFIXABLE critical must stay non-blocking');
  assert.equal(gate({ schemaVersion: 1, generatedForImages: ['mcm-bff:latest'], findings }, [], '2026-09-19'), 0);
});

test('(#499) CONTROL — a fixable CRITICAL is NOT classified transient, so it is never retried', () => {
  // The failure this guards against is subtle and was measured once already (item #495): a finding's
  // own TITLE routinely contains "timeout", "error" or "Service Unavailable". If the classifier
  // matched those, a real Critical would be retried three times and then reported anyway — slower,
  // for nothing, and the retry line in the log would misdescribe a genuine finding as a blip.
  const v = FIXABLE_CRITICAL.Results[0].Vulnerabilities[0];
  assert.equal(isTransientScannerFailure(v.Title), false, `a finding title classified TRANSIENT: ${v.Title}`);
  assert.equal(isTransientScannerFailure(JSON.stringify(FIXABLE_CRITICAL)), false);
  for (const title of [
    'net/http: HTTP/2 server does not limit Service Unavailable responses',
    'curl: connection reset by peer in TLS handshake',
    'openssl: read timed out while parsing a certificate',
  ]) {
    assert.equal(isTransientScannerFailure(title), false, `advisory title classified TRANSIENT: ${title}`);
  }
});

test('(#499) CONTROL — a genuine vulnerability-DB blip IS classified transient, so it retries', () => {
  // The other half. Without this the change is just a rename: the measured failure from run 3622
  // must still be the thing that earns a retry.
  const measured = [
    'ERROR [vulndb] Failed to download artifact repo="mirror.gcr.io/aquasec/trivy-db:2"',
    'oci download error: failed to fetch the layer: GET https://mirror.gcr.io/v2/',
    'FATAL failed to download the vulnerability DB',
  ];
  for (const line of measured) {
    assert.equal(isTransientScannerFailure(line), true, `a measured DB blip classified REAL: ${line}`);
  }
});
