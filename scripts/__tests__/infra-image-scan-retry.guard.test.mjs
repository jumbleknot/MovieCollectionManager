// Item #495 — a Trivy vulnerability-DB download blip must not red the required `infra-image-scan` gate.
//
// WHY THIS GUARD EXISTS. `scripts/sast-scan.mjs` grew a bounded transient retry in item #449 because a
// network-dependent, fail-closed scanner turns an upstream blip into a red REQUIRED context.
// `scripts/infra-image-scan.mjs` had the identical shape and no retry of any kind — `grep -n
// "retry\|attempt\|backoff"` returned nothing — while Trivy fetches its vulnerability DB over the
// network on every run and the scanner deliberately exits non-zero rather than emitting a clean report.
//
// MEASURED, PR #494, 2026-09-19 — four consecutive runs inside 32 minutes, across three commits:
//
//   run 3619  01:38:04  3d72e67e  push          ✅ 2m39s
//   run 3622  01:47:32  3d72e67e  pull_request  ❌ DB fetch      ← same commit as 3619
//   run 3625  01:56:50  10137f71  pull_request  ✅ full 212s scan
//   run 3628  02:10:46  dbb3d25d  pull_request  ❌ DB fetch
//
// Roughly a coin flip, interleaved, on the same blob — intermittent, not an outage. Both failures
// killed the run before a single image was scanned.
//
// It costs a full CI cycle per blip, not a button: `/actions/runs/{id}/rerun` and `/rerun-failed-jobs`
// are BOTH 404 on this Forgejo build, so the only recovery from a flaked required job is a new commit.
//
// THE FAIL-CLOSED BEHAVIOUR IS CORRECT AND THESE TESTS PIN IT. This item is about not failing on the
// FIRST blip; it is never about converting a red into a green. The tests that matter most here are the
// CONTROL tests — a retry that fires on a real finding would be far worse than no retry at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scanImage } from '../infra-image-scan.mjs';
import { isTransientScannerFailure, readTail } from '../lib/scanner-retry.mjs';

// ── The measured evidence ────────────────────────────────────────────────────

/**
 * Run 3622's `step_infra-image-scan` stderr, as captured. The INFO preamble is reproduced because it
 * is what pushed the fatal line past the old 500-character HEAD truncation.
 */
const RUN_3622_STDERR = [
  '2026-09-19T01:47:49Z\tINFO\t[vulndb] Need to update DB',
  '2026-09-19T01:47:49Z\tINFO\t[vulndb] Downloading vulnerability DB...',
  '2026-09-19T01:47:49Z\tINFO\t[vulndb] Downloading artifact...\trepo="mirror.gcr.io/aquasec/trivy-db:2"',
  '2026-09-19T01:47:52Z\tERROR\t[vulndb] Failed to download artifact\trepo="mirror.gcr.io/aquasec/trivy-db:2" err="oci download error: failed to fetch the layer: GET https://mirror.gcr.io/v2/aquasec/trivy-db/blobs/sha256:1cb80d6c00000000000000000000000000000000000000000000000000000000: TOOMANYREQUESTS: too many requests"',
  '2026-09-19T01:47:52Z\tFATAL\tFatal error\tinit error: DB error: failed to download vulnerability DB',
].join('\n');

/** A genuine scanner fault: the image reference is wrong. Retrying this is pure delay. */
const IMAGE_NOT_FOUND_STDERR =
  '2026-09-19T01:47:52Z\tFATAL\tFatal error\timage scan error: scan error: unable to initialize a scanner: ' +
  'unable to initialize an image scanner: unable to find the specified image "nosuch/image:v1" in ["docker" "containerd"]';

/** A Trivy run that WORKED and found something. This is a gate failure, not a transport failure. */
const FINDINGS_JSON = JSON.stringify({
  SchemaVersion: 2,
  Results: [
    {
      Target: 'axllent/mailpit:v1.31.1 (alpine 3.22)',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2026-33186',
          PkgName: 'google.golang.org/grpc',
          Severity: 'HIGH',
          FixedVersion: '1.79.3',
          Title: 'grpc-go: improper error handling causes a connection timeout to be retried indefinitely',
          Description: 'A remote attacker can trigger a socket read that never completes. HTTP 503 responses are mishandled.',
        },
      ],
    },
  ],
});

/** A spawnSync stand-in. Returns the queued results in order and records every invocation. */
function fakeSpawn(...results) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const r = results[Math.min(calls.length - 1, results.length - 1)];
    return { status: 0, stdout: '', stderr: '', error: undefined, ...r };
  };
  fn.calls = calls;
  return fn;
}

/** A sleep that records what it was asked to wait, so backoff is asserted without spending the time. */
function fakeSleep() {
  const waited = [];
  const fn = (ms) => waited.push(ms);
  fn.waited = waited;
  return fn;
}

const quiet = { sleep: fakeSleep(), onRetry: () => {}, baseDelayMs: 1 };

// ── The classifier, against the measured strings ─────────────────────────────

test('#495: the EXACT run-3622 Trivy DB-download failure is classified transient', () => {
  assert.equal(
    isTransientScannerFailure(RUN_3622_STDERR),
    true,
    'the measured failure that redded runs 3622 and 3628 must be retryable — it is the whole point of this item',
  );
});

test('#495: each measured Trivy DB-fetch string classifies transient ON ITS OWN', () => {
  // The lines arrive together today, but Trivy has changed its log format before. Pinning them
  // individually means a format change costs one assertion rather than the whole behaviour.
  for (const sample of [
    'ERROR\t[vulndb] Failed to download artifact\trepo="mirror.gcr.io/aquasec/trivy-db:2"',
    'err="oci download error: failed to fetch the layer: GET https://mirror.gcr.io/v2/…"',
    'FATAL\tFatal error\tinit error: DB error: failed to download vulnerability DB',
    'init error: DB error: failed to download the vulnerability DB',
    'ERROR\t[javadb] Failed to download artifact',
  ]) {
    assert.equal(isTransientScannerFailure(sample), true, `should be transient: ${sample}`);
  }
});

// ── THE CONTROL. A real failure must never be retried. ───────────────────────

test('#495 CONTROL: a CVE FINDING is never classified transient, however its title reads', () => {
  // This is the failure mode item #449 explicitly warned about: naive matching on "timeout" or
  // "error" retries real findings three times and then reports them anyway. The titles below are
  // written to contain every tempting word — "error", "timeout", "retried", "503", "socket read".
  for (const sample of [
    FINDINGS_JSON,
    'CVE-2026-33186: grpc-go: improper error handling causes a connection timeout to be retried indefinitely',
    'CVE-2025-68121: net/http: HTTP/2 server does not limit Service Unavailable responses', // deliberately adversarial
    'GHSA-xxxx-yyyy: openssl: TLS connection state confusion',
    'RUSTSEC-2024-0001: timeout handling is unsound',
    'Total: 41 (UNKNOWN: 0, LOW: 12, MEDIUM: 20, HIGH: 8, CRITICAL: 1)',
  ]) {
    assert.equal(
      isTransientScannerFailure(sample),
      false,
      `a finding must NEVER be retried — classified transient: ${sample.slice(0, 90)}`,
    );
  }
});

test('#495 CONTROL: a genuine scanner fault is thrown on the FIRST attempt, unretried', () => {
  const spawn = fakeSpawn({ status: 1, stderr: IMAGE_NOT_FOUND_STDERR });
  const sleep = fakeSleep();
  assert.throws(
    () => scanImage('nosuch/image:v1', { spawn, attempts: 3, baseDelayMs: 1, sleep, onRetry: () => {} }),
    /unable to find the specified image/,
    'a real fault must surface verbatim and immediately',
  );
  assert.equal(spawn.calls.length, 1, 'a real fault must NOT be retried');
  assert.equal(sleep.waited.length, 0, 'and must not spend backoff time');
});

test('#495 CONTROL: Trivy missing from PATH is a fault, not a transport failure', () => {
  const spawn = fakeSpawn({ error: new Error('spawnSync trivy ENOENT'), status: null });
  assert.throws(
    () => scanImage('alpine:3.22', { spawn, ...quiet }),
    /is Trivy installed/,
    'an absent scanner is a configuration fault — retrying it only delays the real message',
  );
  assert.equal(spawn.calls.length, 1);
});

test('#495 CONTROL: unparseable Trivy output is a fault, not a transport failure', () => {
  const spawn = fakeSpawn({ status: 0, stdout: 'not json at all' });
  assert.throws(() => scanImage('alpine:3.22', { spawn, ...quiet }), /not parseable JSON/);
  assert.equal(spawn.calls.length, 1, 'a parse failure must not be retried');
});

test('#495 CONTROL: a successful scan WITH findings is returned untouched and never retried', () => {
  // The gate verdict belongs to check-infra-image-findings.mjs. Trivy exits 0 here, so this path
  // must not even be able to reach the retry driver's failure branch.
  const spawn = fakeSpawn({ status: 0, stdout: FINDINGS_JSON });
  const out = scanImage('axllent/mailpit:v1.31.1', { spawn, ...quiet });
  assert.equal(spawn.calls.length, 1);
  assert.equal(out.Results[0].Vulnerabilities[0].VulnerabilityID, 'CVE-2026-33186');
});

// ── The retry itself ─────────────────────────────────────────────────────────

test('#495: the measured DB blip is retried and a later success is returned', () => {
  const spawn = fakeSpawn(
    { status: 1, stderr: RUN_3622_STDERR },
    { status: 1, stderr: RUN_3622_STDERR },
    { status: 0, stdout: FINDINGS_JSON },
  );
  const sleep = fakeSleep();
  const out = scanImage('axllent/mailpit:v1.31.1', { spawn, attempts: 3, baseDelayMs: 1000, sleep, onRetry: () => {} });
  assert.equal(out.SchemaVersion, 2);
  assert.equal(spawn.calls.length, 3, 'should have taken all three attempts');
  assert.equal(sleep.waited.length, 2, 'should sleep between attempts, not after the last one');
  assert.ok(sleep.waited[1] > sleep.waited[0], 'the backoff must grow, not tick at a fixed interval');
});

test('#495: FAIL-CLOSED is preserved — exhausting the retries still throws', () => {
  // If this assertion is ever relaxed, the gate starts reporting clean on an outage — which is the
  // one outcome strictly worse than the flake this item exists to fix.
  const spawn = fakeSpawn({ status: 1, stderr: RUN_3622_STDERR });
  assert.throws(
    () => scanImage('axllent/mailpit:v1.31.1', { spawn, attempts: 3, baseDelayMs: 1, sleep: fakeSleep(), onRetry: () => {} }),
    (err) => err instanceof Error && /TRANSPORT|not a (security )?finding/i.test(err.message),
    'a scanner that never ran must never report clean',
  );
  assert.equal(spawn.calls.length, 3, 'and must have actually spent its attempts first');
});

test('#495: a retry is REPORTED — a silent retry is indistinguishable from no retry', () => {
  const seen = [];
  const spawn = fakeSpawn({ status: 1, stderr: RUN_3622_STDERR }, { status: 0, stdout: FINDINGS_JSON });
  scanImage('axllent/mailpit:v1.31.1', {
    spawn, attempts: 3, baseDelayMs: 1, sleep: fakeSleep(), onRetry: (info) => seen.push(info),
  });
  assert.equal(seen.length, 1, 'the one retry that fired must be reported');
  assert.match(String(seen[0].scanner), /trivy axllent\/mailpit/, 'the report must name the image, not just "trivy"');
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].attempts, 3);
  assert.match(String(seen[0].reason), /vulndb|oci download error/, 'and must carry the cause');
});

// ── The instrument. Run 3622 could not be diagnosed because of this. ─────────

test('#495: the failure message carries the TAIL of Trivy stderr, where the fatal line is', () => {
  // The original truncated with `.slice(0, 500)` — the HEAD. Trivy opens with INFO lines, so run
  // 3622's captured failure ended mid-URL, cut off exactly where the HTTP status would have been.
  // A 403, a 429 and a 500 imply three different remedies and the digest could name none of them.
  const preamble = Array.from({ length: 40 }, (_, i) => `2026-09-19T01:47:49Z\tINFO\tpadding line ${i}`).join('\n');
  const stderr = `${preamble}\n${RUN_3622_STDERR}`;
  assert.ok(stderr.length > 500, 'the fixture must exceed the old truncation window or it proves nothing');
  let thrown;
  try {
    scanImage('axllent/mailpit:v1.31.1', { spawn: fakeSpawn({ status: 1, stderr }), ...quiet, attempts: 1 });
  } catch (e) { thrown = e; }
  assert.ok(thrown, 'must throw');
  assert.match(thrown.message, /TOOMANYREQUESTS/, 'the HTTP status must survive truncation — it is the remedy');
  assert.match(thrown.message, /failed to download vulnerability DB/, 'and so must the FATAL line');
});

test('#495: readTail says how much it dropped, so a truncated log cannot read as a whole one', () => {
  const out = readTail('x'.repeat(3000), 100);
  assert.match(out, /2900 earlier chars omitted/);
  assert.equal(out.endsWith('x'.repeat(100)), true, 'and keeps the END');
  assert.equal(readTail('short'), 'short', 'a short output is passed through unchanged');
});

// ── The wiring ───────────────────────────────────────────────────────────────
//
// The classifier and driver can be perfect while nothing calls them. These read the source and pin
// that the Trivy invocation is actually wrapped and actually classified — the mutation that removes
// the `retryTransient(` call or swaps `transientOr` back for `new ScanError` turns one of these red.

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'infra-image-scan.mjs'), 'utf8');

test('#495: scanImage runs Trivy through retryTransient', () => {
  const at = SRC.indexOf('export function scanImage(');
  assert.notEqual(at, -1, 'scanImage should still exist — update this guard if it was renamed');
  const body = SRC.slice(at, at + 3000);
  assert.match(body, /retryTransient\(/, 'scanImage must run Trivy through retryTransient');
  assert.match(body, /transientOr\(/, 'and must classify its non-zero-exit failure rather than throwing a bare ScanError');
});

test('#495: the retry mechanism is IMPORTED, not re-implemented', () => {
  // Two copies of this would drift, and the hard part is the signature list — a signature learned
  // from one scanner's outage is exactly the one the other needs next.
  assert.match(SRC, /from '\.\/lib\/scanner-retry\.mjs'/, 'must import the shared module');
  assert.doesNotMatch(SRC, /const TRANSIENT_SIGNATURES\s*=/, 'must not carry a second signature list');
});

test('#495: the Trivy stderr is no longer HEAD-truncated', () => {
  assert.doesNotMatch(SRC, /stderr[^\n]*\.slice\(0,/, 'slicing from the head throws away the fatal line');
});
