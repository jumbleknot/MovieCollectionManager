// Feature 058 (item #184, option 5) — the security gate names WHICH LEVER clears a finding.
//
// THE INCIDENT THIS ENCODES. fast-uri's override range `>=3.1.4 <4` ALREADY PERMITTED the published
// fix 3.1.5. The lockfile pinned 3.1.4. The fix predated the advisory by three days, the gate went
// red and stayed red for TEN DAYS, and a four-week acceptance was written — for something a lockfile
// refresh would have cleared. Nobody was lazy; the gate simply said "fast-uri@3.1.4 is vulnerable,
// fix >=3.1.5" and left the reader to work out whether to raise the floor or refresh the lockfile.
// Those are different actions and only one of them was needed.
//
// So the module answers exactly that question, and the messages are specified rather than left to
// the caller — a `raise-floor` message naming only the VALUE half would reproduce the half-bump this
// repository already has a separate guard for.
//
// TWO INVARIANTS ARE UNDER TEST AS MUCH AS THE LOGIC:
//
//   * Advice is emitted for NON-BLOCKING findings too. The two live cases on main (hono, undici 6.x)
//     are non-blocking today purely by severity — which is the state fast-uri occupied BEFORE its
//     advisory landed. Blocking-only advice would first appear once the finding is already reddening
//     every branch, which is too late to be worth anything.
//
//   * Advice CANNOT change the gate's exit code. Making "an override already permits the fix" a
//     second blocking axis alongside severity and scope would red main on merge for findings the
//     existing policy classifies as non-blocking. That is a policy change, not a message change, and
//     it is explicitly out of scope. The last test in this file is what holds that line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adviseLever, selectAdvice, parseLocation, parseFixFloor } from '../override-lever.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, 'fixtures/fast-uri-reconstruction.json'), 'utf8'));

const OVERRIDES = FIXTURE.overrides;
const byId = (id) => FIXTURE.findings.find((f) => f.id === id);

/** A minimal SCA finding, so each case states only what it is actually about. */
const finding = (location, fixAvailable, extra = {}) => ({
  scanner: 'pnpm-audit', kind: 'sca', id: 'GHSA-test', location, fixAvailable,
  severity: 'High', scope: 'runtime', blocking: true, ...extra,
});

// ── the measured incident ────────────────────────────────────────────────────────────────────────

test('1. the fast-uri incident: range already permits the fix, lockfile pinned below', () => {
  const advice = adviseLever(byId('GHSA-7p8r-x3mc-p8w7'), OVERRIDES);
  assert.ok(advice, 'the incident produced no advice at all — this is the case the module exists for');
  assert.equal(advice.action, 'refresh-lockfile');
  assert.equal(advice.package, 'fast-uri');
  assert.equal(advice.resolved, '3.1.4');
  assert.equal(advice.fixFloor, '3.1.5');
  assert.equal(advice.permitted, '>=3.1.4 <4');
});

test('2. the incident message names the range, the pin and the remedy', () => {
  const { message } = adviseLever(byId('GHSA-7p8r-x3mc-p8w7'), OVERRIDES);
  assert.match(message, />=3\.1\.4 <4/, 'the message must quote the range that already permits the fix');
  assert.match(message, /3\.1\.5/, 'the message must name the fixed version');
  assert.match(message, /3\.1\.4/, 'the message must name the version the lockfile pins');
  assert.match(message, /refresh/i, 'the message must name refreshing the lockfile as the remedy');
  assert.doesNotMatch(
    message, /raise the floor/i,
    'a refresh case must NOT suggest raising the floor — sending the reader to the wrong lever is ' +
      'the exact failure this module exists to prevent',
  );
});

// ── the live cases on main ───────────────────────────────────────────────────────────────────────

test('3. hono: an override with NO upper bound still yields refresh advice', () => {
  const advice = adviseLever(finding('hono@4.12.29', '>=4.12.34'), { 'hono@<4.12.25': '>=4.12.25' });
  assert.ok(advice, 'an unbounded-above override (`>=4.12.25`) must still be evaluated, not skipped');
  assert.equal(advice.action, 'refresh-lockfile');
});

test('4. undici 6.x: resolution inside the range and below the fix', () => {
  const advice = adviseLever(byId('GHSA-FIXTURE-in-range'), OVERRIDES);
  assert.equal(advice?.action, 'refresh-lockfile');
});

test('5. undici 7.x: resolution OUTSIDE the override range yields no advice', () => {
  // The override governs only `>=6.27.0 <7`. Telling someone to refresh the lockfile for the 7.x
  // resolution would be advice the override cannot possibly deliver. Per-resolution, not per-package.
  const advice = adviseLever(byId('GHSA-FIXTURE-outside-range'), OVERRIDES);
  assert.equal(
    advice, null,
    'undici@7.24.7 sits outside `>=6.27.0 <7`, so the override cannot reach it and a refresh would ' +
      'not clear the finding. Keying on the package name alone produces exactly this wrong advice.',
  );
});

// ── the other lever ──────────────────────────────────────────────────────────────────────────────

test('6. a fix beyond the override ceiling is a floor raise, not a refresh', () => {
  const advice = adviseLever(byId('GHSA-FIXTURE-beyond-ceiling'), OVERRIDES);
  assert.equal(advice?.action, 'raise-floor');
});

test('7. the raise-floor message names BOTH halves', () => {
  const { message } = adviseLever(byId('GHSA-FIXTURE-beyond-ceiling'), OVERRIDES);
  assert.match(message, /fast-uri@</, 'must name the vulnerable-range KEY half');
  assert.match(message, />=4\.0\.1/, 'must name the patched-floor VALUE half');
  assert.match(
    message, /both halves/i,
    'the message must say both halves move together — a floor raise that edits only the value is ' +
      'the half-bump check-override-consistency.mjs exists to catch',
  );
});

test('8. a fix BELOW the override lower bound is unreachable, and reports nothing', () => {
  // This case was originally written expecting `raise-floor`, from the contract's decision table.
  // It is LOGICALLY UNREACHABLE, and the table was wrong. To enter the raise-floor branch a finding
  // must be in range (R >= L) and unremediated (R < F). If additionally F < L, then R >= L > F > R —
  // a contradiction. Exhaustively confirmed over the ordering space: zero combinations satisfy all
  // three. So raise-floor is entered ONLY via F >= U, the fix lying beyond the override's ceiling.
  //
  // Kept as a test rather than deleted, because the reachable-looking branch survives in the module
  // as a defensive `||` and a later reader will otherwise re-derive this from scratch. What actually
  // happens here is the already-remediated path: 3.1.4 is already at or above a 2.0.0 floor.
  const advice = adviseLever(finding('fast-uri@3.1.4', '>=2.0.0'), OVERRIDES);
  assert.equal(
    advice, null,
    'a resolution at or above the fix floor is stale, not actionable — whatever the override says',
  );
});

// ── the silent cases ─────────────────────────────────────────────────────────────────────────────

test('9. an already-remediated resolution yields no advice', () => {
  assert.equal(adviseLever(byId('GHSA-FIXTURE-already-remediated'), OVERRIDES), null);
});

test('10. a package with no override yields no advice', () => {
  assert.equal(adviseLever(byId('GHSA-FIXTURE-no-override'), OVERRIDES), null);
});

test('11. a plain pin is not parsed as a keyed floor and yields no spurious advice', () => {
  // react-dom/postcss/@expo/dom-webview have no vulnerable-range half. They are out of the keyed
  // rule's scope, not violations — and must not produce advice invented from a bare version.
  const advice = adviseLever(finding('react-dom@19.2.0', '>=19.2.3'), OVERRIDES);
  assert.equal(advice, null, 'a plain pin has no range semantics to reason about');
});

test('12. an absent or unparseable fixAvailable yields no advice and does not throw', () => {
  assert.equal(adviseLever(finding('fast-uri@3.1.4', undefined), OVERRIDES), null);
  assert.equal(adviseLever(finding('fast-uri@3.1.4', 'not a range'), OVERRIDES), null);
  assert.equal(adviseLever(finding('fast-uri@3.1.4', ''), OVERRIDES), null);
});

test('13. an unparseable override value yields no advice and does not throw', () => {
  assert.equal(adviseLever(finding('weird@1.0.0', '>=2.0.0'), { 'weird@<2.0.0': 'latest' }), null);
});

test('14. a scoped package name splits on the LAST @', () => {
  assert.deepEqual(parseLocation('@scope/name@1.2.3'), { name: '@scope/name', version: '1.2.3' });
  assert.equal(parseLocation('@expo/dom-webview'), null, 'no version half → not a location');
  assert.equal(parseFixFloor('>=9.0.6'), '9.0.6');
  assert.equal(parseFixFloor('>= 9.0.6 <10'), '9.0.6');
});

// ── aggregation ──────────────────────────────────────────────────────────────────────────────────

test('15. four advisories on one resolution collapse to one advice entry', () => {
  const four = ['a', 'b', 'c', 'd'].map((id) =>
    finding('hono@4.12.29', '>=4.12.34', { id: `GHSA-${id}` }));
  const advice = selectAdvice(four, { 'hono@<4.12.25': '>=4.12.25' });
  assert.equal(advice.length, 1, 'hono carries four advisories and must produce ONE line, not four');
});

test('16. advice is produced for NON-BLOCKING findings', () => {
  // The whole early-warning value. hono and undici are non-blocking today by severity alone, which
  // is the state fast-uri was in before its advisory landed.
  const advice = selectAdvice(
    [finding('hono@4.12.29', '>=4.12.34', { blocking: false, severity: 'Low' })],
    { 'hono@<4.12.25': '>=4.12.25' },
  );
  assert.equal(advice.length, 1, 'blocking-only advice would first appear once it is already too late');
});

// ── the invariant that keeps this a MESSAGE change ───────────────────────────────────────────────

test('17. the gate prints advice for non-blocking findings and STILL exits 0', () => {
  // The line between "improve the message" and "silently add a second blocking axis alongside
  // severity and scope". If this ever fails, the gate has started failing merges for a condition the
  // severity policy classifies as non-blocking — which would red main for hono and undici today.
  const dir = mkdtempSync(join(tmpdir(), 'lever-gate-'));
  const report = join(dir, 'findings.json');
  const allowlist = join(dir, 'allowlist.yaml');
  writeFileSync(report, JSON.stringify({
    findings: [
      { scanner: 'pnpm-audit', kind: 'sca', id: 'GHSA-nb', title: 'non-blocking, advice-eligible',
        location: 'hono@4.12.29', ecosystem: 'npm', nativeSeverity: 'medium', severity: 'Medium',
        scope: 'runtime', blocking: false, fixAvailable: '>=4.12.34' },
    ],
  }));
  writeFileSync(allowlist, '[]\n'); // the loader requires a bare YAML LIST, not a mapping

  const out = execFileSync('node', [
    resolve(REPO_ROOT, 'scripts/check-sast-findings.mjs'),
    '--report', report, '--allowlist', allowlist,
  ], { encoding: 'utf8' }); // execFileSync THROWS on a non-zero exit — that is the exit-0 assertion

  assert.match(
    out, /hono/,
    'the gate ran and exited 0 but never mentioned hono, so the advice is not wired into its output',
  );
  assert.match(out, /refresh/i, 'the advice section must name the lever, not merely list the finding');
});
