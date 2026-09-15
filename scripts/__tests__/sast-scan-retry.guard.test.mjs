// Item #449 — a transient osv.dev outage must not red the required `guardrails / sast` gate.
//
// WHY THIS GUARD EXISTS. On 2026-09-13, run 3328 (PR #444, the scheduled openwiki-maintenance PR)
// failed the REQUIRED `guardrails / sast` context on:
//
//   [sast-scan] FAILED fast: [pip-audit] agents/movie-assistant produced non-JSON output:
//     File ".../pip_audit/_service/osv.py", line 79, in query
//       raise ServiceError from http_error
//   pip_audit._service.interface.ServiceError
//
// The scan had otherwise COMPLETED — `scope=changed findings=16 blocking=0`, semgrep 0, cargo-audit 0.
// No security finding was involved. osv.dev answered 200 minutes later and the identical path passed on
// PRs #443 and #445 the same day. One transient HTTP error from a third party had redded a required gate
// for every PR open at that moment, and `sast-scan.mjs` contained zero occurrences of `retry`, `backoff`
// or `attempt`.
//
// The fail-closed behaviour is CORRECT and these tests pin it: a scanner that could not run must never
// report clean. What was missing is a bounded retry before that verdict, and an output that distinguishes
// "the advisory service was unreachable" from "the scanner ran and found something".
//
// The usual outcome of a retry is that it silently never triggers, so the classifier and the retry driver
// are exported and tested directly rather than inferred from a scan that happens to pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTransientScannerFailure,
  TransientScannerError,
  retryTransient,
} from '../sast-scan.mjs';

// ── The classifier ───────────────────────────────────────────────────────────

test('#449: the EXACT run-3328 output is classified transient', () => {
  const measured = [
    'Traceback (most recent call last):',
    '  File ".../pip_audit/_service/osv.py", line 79, in query',
    '    raise ServiceError from http_error',
    'pip_audit._service.interface.ServiceError',
  ].join('\n');
  assert.equal(
    isTransientScannerFailure(measured),
    true,
    'the measured osv.dev failure that redded run 3328 must be retryable — it is the whole point of this item',
  );
});

test('#449: common transport failures from every network-dependent scanner are classified transient', () => {
  for (const sample of [
    'pip_audit._service.interface.ServiceError',
    'requests.exceptions.ConnectionError: HTTPSConnectionPool(host=\'api.osv.dev\', port=443)',
    'requests.exceptions.ReadTimeout: HTTPSConnectionPool(host=\'api.osv.dev\', port=443): Read timed out.',
    'urllib3.exceptions.MaxRetryError: Max retries exceeded with url: /v1/querybatch',
    'HTTP Error 502: Bad Gateway',
    'HTTP Error 503: Service Unavailable',
    'HTTP Error 504: Gateway Timeout',
    'HTTP Error 429: Too Many Requests',
    'error: failed to fetch advisory database: network failure',
    'fatal: unable to access https://github.com/RustSec/advisory-db: Could not resolve host',
    'Error: connect ECONNRESET 140.82.121.6:443',
    'Error: connect ETIMEDOUT',
    'getaddrinfo EAI_AGAIN registry.npmjs.org',
    'Temporary failure in name resolution',
    'Error: socket hang up',
    'WARN GET https://registry.npmjs.org/-/npm/v1/security/audits error (ECONNREFUSED)',
  ]) {
    assert.equal(
      isTransientScannerFailure(sample),
      true,
      `should be transient: ${sample}`,
    );
  }
});

test('#449: a REAL scanner fault is NOT classified transient — it must fail on the first attempt', () => {
  // These are the failures where retrying is pure waste and, worse, hides the real cause behind a
  // multi-attempt delay. A misconfigured venv or an unparseable report is not an outage.
  for (const sample of [
    'error: No virtual environment found; run `uv sync`',
    'ModuleNotFoundError: No module named \'pip_audit\'',
    'error: Failed to parse `pyproject.toml`',
    'thread \'main\' panicked at src/main.rs:12:5',
    'error: the lock file Cargo.lock needs to be updated but --locked was passed',
    'ERR_PNPM_NO_LOCKFILE  Cannot audit without a lockfile',
    'Permission denied (os error 13)',
    '',
  ]) {
    assert.equal(
      isTransientScannerFailure(sample),
      false,
      `should NOT be transient: ${sample || '(empty output)'}`,
    );
  }
});

test('#449: the classifier does not fall for the WORD "error" alone', () => {
  // A finding's own title routinely contains "error", "timeout" or a URL. Classifying on those would
  // retry real findings and, after the retries, still report them — slower, for nothing.
  assert.equal(isTransientScannerFailure('GHSA-xxxx: improper error handling in foo'), false);
  assert.equal(isTransientScannerFailure('RUSTSEC-2024-0001: timeout handling is unsound'), false);
});

// ── The retry driver ─────────────────────────────────────────────────────────

/** A sleep that records what it was asked to wait, so backoff is asserted without spending the time. */
function fakeSleep() {
  const waited = [];
  const fn = (ms) => waited.push(ms);
  fn.waited = waited;
  return fn;
}

test('#449: a transient failure is RETRIED and a later success is returned', () => {
  let calls = 0;
  const sleep = fakeSleep();
  const out = retryTransient(
    'pip-audit',
    () => {
      calls += 1;
      if (calls < 3) throw new TransientScannerError('pip_audit._service.interface.ServiceError');
      return { ok: true };
    },
    { attempts: 3, baseDelayMs: 1000, sleep },
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 3, 'should have taken all three attempts');
  assert.equal(sleep.waited.length, 2, 'should sleep between attempts, not after the last one');
});

test('#449: the retry BACKS OFF — a fixed-interval retry is not a retry against a service under load', () => {
  const sleep = fakeSleep();
  assert.throws(() =>
    retryTransient('pip-audit', () => { throw new TransientScannerError('ServiceError'); },
      { attempts: 4, baseDelayMs: 1000, sleep }),
  );
  assert.equal(sleep.waited.length, 3);
  for (let i = 1; i < sleep.waited.length; i += 1) {
    assert.ok(
      sleep.waited[i] > sleep.waited[i - 1],
      `delay ${i} (${sleep.waited[i]}ms) must exceed delay ${i - 1} (${sleep.waited[i - 1]}ms)`,
    );
  }
});

test('#449: FAIL-CLOSED is preserved — exhausting the retries still throws', () => {
  // This item is about not failing on the FIRST blip. It is NOT about tolerating a scanner that
  // cannot run. If this assertion is ever relaxed, the gate starts reporting clean on an outage.
  const sleep = fakeSleep();
  assert.throws(
    () => retryTransient('pip-audit', () => { throw new TransientScannerError('ServiceError'); },
      { attempts: 3, baseDelayMs: 1, sleep }),
    (err) => err instanceof Error,
    'a scanner that never ran must never report clean',
  );
});

test('#449: the exhausted error says TRANSPORT, names the attempt count, and denies a finding was involved', () => {
  const sleep = fakeSleep();
  let thrown;
  try {
    retryTransient('pip-audit', () => { throw new TransientScannerError('osv.dev ServiceError'); },
      { attempts: 3, baseDelayMs: 1, sleep });
  } catch (e) { thrown = e; }
  assert.ok(thrown, 'must throw');
  const msg = String(thrown.message);
  assert.match(msg, /transport|service/i, 'must name the failure CLASS, not just repeat the scanner output');
  assert.match(msg, /3/, 'must say how many attempts were made');
  assert.match(msg, /not a (security )?finding/i,
    'run 3328 read as a security failure when it was an outage — the output must say which it is');
  assert.match(msg, /pip-audit/, 'must name the scanner');
});

test('#449: a NON-transient failure is thrown on the FIRST attempt, unretried and unwrapped', () => {
  let calls = 0;
  const sleep = fakeSleep();
  assert.throws(
    () => retryTransient('pip-audit', () => {
      calls += 1;
      throw new Error('error: No virtual environment found; run `uv sync`');
    }, { attempts: 3, baseDelayMs: 1, sleep }),
    /No virtual environment/,
    'a real fault must surface verbatim and immediately',
  );
  assert.equal(calls, 1, 'a real fault must NOT be retried');
  assert.equal(sleep.waited.length, 0, 'and must not spend backoff time');
});

test('#449: retryTransient reports each retry, so a retry that fires is VISIBLE in the job log', () => {
  // A silent retry is indistinguishable from no retry at all, which is how this defect class survives.
  const seen = [];
  const sleep = fakeSleep();
  retryTransient('pip-audit', (() => {
    let n = 0;
    return () => { n += 1; if (n < 2) throw new TransientScannerError('ServiceError'); return 'ok'; };
  })(), { attempts: 3, baseDelayMs: 1, sleep, onRetry: (info) => seen.push(info) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scanner, 'pip-audit');
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].attempts, 3);
  assert.match(String(seen[0].reason), /ServiceError/);
});

// ── The wiring ───────────────────────────────────────────────────────────────
//
// The classifier and driver above can be perfect while nothing calls them. These read the source and
// pin that every network-dependent scanner invocation is actually wrapped — the mutation that removes
// a `retryTransient(` call turns one of these red.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sast-scan.mjs'),
  'utf8',
);

test('#449: every network-dependent scanner runner is wrapped in retryTransient', () => {
  // pip-audit queries osv.dev, cargo-audit fetches the RustSec advisory DB, pnpm audit queries the
  // npm registry's advisory endpoint. All three are a third party over the network on the required
  // gate's critical path, and all three fail the same way. Fixing only the one that happened to bite
  // leaves the same defect behind twice.
  for (const fn of ['auditOnePythonSurface', 'runCargoAudit', 'pnpmAuditJson']) {
    const at = SRC.indexOf(`function ${fn}(`);
    assert.notEqual(at, -1, `${fn} should still exist — update this guard if it was renamed`);
    const body = SRC.slice(at, at + 3000);
    assert.match(body, /retryTransient\(/, `${fn} must run its scanner through retryTransient`);
  }
});

test('#449: the scanner failure paths classify before throwing, rather than throwing a bare Error', () => {
  // The classifier only ever runs if the throw sites consult it.
  assert.match(SRC, /TransientScannerError/, 'the throw sites must be able to mark a failure transient');
  const marks = SRC.match(/new TransientScannerError\(|transientOr\(/g) ?? [];
  assert.ok(marks.length >= 3, `expected at least 3 classified throw sites, found ${marks.length}`);
});
