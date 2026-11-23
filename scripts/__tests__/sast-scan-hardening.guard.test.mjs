// Items #1108–#1111 — SAST-gate edge cases found by the BELAY port of these scripts, each verified
// against MCM before it was fixed. Every test here fails on the code before its item.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isTransientScannerFailure,
  retryTransient,
  semgrepFailureText,
  computeChangedTargets,
  discoverPythonProjects,
  pythonProjectsWithoutLock,
  assertKnownPythonSurfaces,
  PYTHON_SURFACES,
  parseArgs,
  UsageError,
  scrubSecretsInText,
  assertSomeRules,
} from '../sast-scan.mjs';
import { scrubSecretsInText as zapScrub } from '../zap-scan.mjs';
import { reportShapeProblem } from '../check-sast-findings.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── #1108: Semgrep's registry fetch is retried, and only when it is transient ──

// Measured 2026-11-23 with semgrep 1.185.0, SEMGREP_URL pointed at a local server. Exit 7, EMPTY
// stderr — the reason exists only in the --json report's errors[].
const REPORT_503 = JSON.stringify({
  results: [],
  errors: [
    { code: 2, type: 'SemgrepError', message: 'Failed to download configuration from http://127.0.0.1:18503/c/p/python Failed after multiple attempts (too many 503 error responses)' },
    { code: 7, type: 'SemgrepError', message: 'invalid configuration file found (1 configs were invalid)' },
  ],
});
const REPORT_404 = JSON.stringify({
  results: [],
  errors: [
    { code: 2, type: 'SemgrepError', message: 'Failed to download configuration from http://127.0.0.1:18404/c/p/python HTTP 404.' },
    { code: 7, type: 'SemgrepError', message: 'invalid configuration file found (1 configs were invalid)' },
  ],
});
// Measured the same day, SEMGREP_URL=http://127.0.0.1:9 (nothing listening): exit 2, on stderr.
const STDERR_REFUSED =
  "requests.exceptions.ConnectionError: HTTPConnectionPool(host='127.0.0.1', port=9): Max retries exceeded with url: /c/p/python";

test('#1108: the failure text carries the report errors[] that Semgrep leaves stderr empty for', () => {
  const why = semgrepFailureText('', REPORT_503);
  assert.match(why, /too many 503 error responses/);
  assert.equal(semgrepFailureText('boom', 'not json'), 'boom');
  assert.equal(semgrepFailureText('', ''), '');
});

test('#1108: a registry 503 and a refused connection are transient; a 404 is not', () => {
  assert.equal(isTransientScannerFailure(semgrepFailureText('', REPORT_503)), true, '503');
  assert.equal(isTransientScannerFailure(semgrepFailureText(STDERR_REFUSED, '')), true, 'refused');
  assert.equal(isTransientScannerFailure(semgrepFailureText('', REPORT_404)), false, 'a 404 is a bad pack name — fail at once');
  assert.equal(isTransientScannerFailure('invalid configuration file found (1 configs were invalid)'), false, 'a bad rule');
});

test('#1108: runSemgrep goes through retryTransient and clears a stale report before each attempt', () => {
  const src = readFileSync(join(SCRIPTS, 'sast-scan.mjs'), 'utf8');
  const body = src.slice(src.indexOf('function runSemgrep('), src.indexOf('export function ruleFixturePairs'));
  assert.match(body, /retryTransient\('semgrep'/);
  assert.match(body, /rmSync\(nativeOut/);
  assert.match(body, /transientOr\(/);
});

test('#1108: a transient Semgrep failure is re-attempted, then still fails closed', () => {
  let calls = 0;
  const transient = () => {
    calls += 1;
    const e = new Error('registry 503');
    e.transient = true;
    throw e;
  };
  assert.throws(() => retryTransient('semgrep', transient, { sleep: () => {}, onRetry: () => {} }), /TRANSPORT\/SERVICE ERROR/);
  assert.equal(calls, 3);
});

// ── #1109: --scope changed fails closed when git diff fails ──

test('#1109: a failed git diff throws, naming the base — never an empty "clean" set', () => {
  const failing = () => ({ status: 128, stdout: '', stderr: "fatal: ambiguous argument 'origin/main...HEAD'" });
  assert.throws(() => computeChangedTargets('origin/main', failing), /cannot compute the changed set.*origin\/main/s);
});

test('#1109: a successful diff still yields its scan targets', () => {
  const ok = () => ({ status: 0, stdout: 'scripts/sast-scan.mjs\nREADME.md\n', stderr: '' });
  assert.deepEqual(computeChangedTargets('origin/main', ok), ['scripts/sast-scan.mjs']);
});

test('#1109: the CLI exits 2 for an unknown base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sast-1109-'));
  try {
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'sast-scan.mjs'), '--scope', 'changed', '--base', 'no-such-ref-1109', '--only', 'semgrep', '--out', dir], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot compute the changed set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #1110: Python projects are discovered repo-wide, and a lockless one fails ──

test('#1110: a pyproject.toml anywhere in the tree is a project; the root is "."', () => {
  const files = ['agents/a/pyproject.toml', 'agents/a/uv.lock', 'tools/deep/x/pyproject.toml', 'pyproject.toml', 'uv.lock'];
  assert.deepEqual(discoverPythonProjects(files), ['.', 'agents/a', 'tools/deep/x']);
});

test('#1110: a project outside agents/ and mcp-servers/ fails the scan by name', () => {
  const onDisk = [...PYTHON_SURFACES.map((s) => s.project), 'backend/py-tool'];
  assert.throws(() => assertKnownPythonSurfaces(onDisk, []), /backend\/py-tool/);
});

test('#1110: a pyproject.toml with no committed uv.lock fails the scan by name', () => {
  const files = ['agents/a/pyproject.toml', 'agents/a/uv.lock', 'mcp-servers/b/pyproject.toml'];
  assert.deepEqual(pythonProjectsWithoutLock(files), ['mcp-servers/b']);
  assert.throws(() => assertKnownPythonSurfaces(['agents/a'], ['mcp-servers/b']), /no committed uv\.lock: mcp-servers\/b/);
});

test('#1110: the real tree discovers exactly the registered surfaces, each locked', () => {
  assert.deepEqual(discoverPythonProjects(), PYTHON_SURFACES.map((s) => s.project).sort());
  assert.deepEqual(pythonProjectsWithoutLock(), []);
  assert.doesNotThrow(() => assertKnownPythonSurfaces());
});

// ── #1111: the smaller edge cases ──

test('#1111: zero custom rules is refused, not "passed for all 0"', () => {
  assert.throws(() => assertSomeRules([]), /NO custom rules/);
  assert.doesNotThrow(() => assertSomeRules([{ rule: 'r.yaml', fixtures: ['r.ts'] }]));
});

test('#1111: a value flag with no value is a usage error, never a crash or undefined', () => {
  for (const argv of [['--only'], ['--scope'], ['--base'], ['--out'], ['--base', '--only', 'semgrep'], ['--only', ',']]) {
    assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
  }
  assert.deepEqual(parseArgs(['--only', 'semgrep,pip-audit']).only, ['semgrep', 'pip-audit']);
});

test('#1111: the CLI prints usage and exits 2 for a trailing --only', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'sast-scan.mjs'), '--only'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--only needs a value\. Usage: sast-scan\.mjs/);
});

test('#1111: token redaction covers ordinary query-string and cookie names, in both scrubbers', () => {
  const raw =
    'GET /cb?code=x&access_token=tok-AAAA1111&state=s Cookie: mcm_access_token=tok-BBBB2222; ' +
    'refresh_token=tok-CCCC3333 id_token=tok-DDDD4444 client_secret=tok-EEEE5555 api_key=tok-FFFF6666';
  for (const scrub of [scrubSecretsInText, zapScrub]) {
    const out = scrub(raw);
    assert.doesNotMatch(out, /tok-[A-F]{4}\d{4}/, out);
    assert.match(out, /access_token=<redacted>&state=s/, 'a query-string value stops at &');
    assert.match(out, /code=x/, 'non-secret parameters are left alone');
  }
});

test('#1111: a report the gate cannot evaluate is named, and exits 2 — never 1', () => {
  assert.match(reportShapeProblem(null), /null/);
  assert.match(reportShapeProblem({}), /findings/);
  assert.match(reportShapeProblem({ findings: 'x', scanners: [] }), /findings/);
  assert.match(reportShapeProblem({ findings: [], scanners: null }), /scanners/);
  assert.match(reportShapeProblem({ findings: [{}], scanners: [] }), /findings\[0\]/);
  assert.equal(reportShapeProblem({ findings: [], scanners: [] }), null);
  assert.equal(reportShapeProblem({ findings: [] }), null, '`scanners` is optional to the gate, so not required here');

  const dir = mkdtempSync(join(tmpdir(), 'sast-1111-'));
  try {
    for (const body of ['{}', 'null', '{"schemaVersion":1,"scanners":[],"findings":[]}']) {
      const p = join(dir, 'r.json');
      writeFileSync(p, body);
      const r = spawnSync(process.execPath, [join(SCRIPTS, 'check-sast-findings.mjs'), '--report', p], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${body}: ${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
