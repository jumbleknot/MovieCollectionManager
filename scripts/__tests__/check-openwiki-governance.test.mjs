// T041–T045 — the OpenWiki governance gate (scripts/check-openwiki-governance.mjs) — feature 044.
//
// Drives the REAL gate CLI as a subprocess against one mini-repository fixture per rule and asserts
// the contracted exit codes (specs/044-openwiki-automation-migration/contracts/cli-contracts.md C2):
//   0 clean / selftest passed · 1 violation / selftest broken · 2 bad args.
//
// Rules G1–G11 are defined in the contract; G12 comes from data-model E4's validation list ("the
// authoritative-concept assignment must not be `regenerate`"), which the contract's table omitted.
//
// Deterministic, offline, token-free, `node:` built-ins + `yaml` — CI-enforced on every push by the
// `guardrails / naming` job's shell-expanded `node --test scripts/__tests__/*.test.mjs` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-governance.mjs');
const FIXTURES = join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'openwiki-governance');

function runGate(args) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const onFixture = (name, ...extra) => runGate(['--root', join(FIXTURES, name), ...extra]);

/** A writable copy of a fixture, for the cases that need a mutation the fixture tree does not hold. */
function copyFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), 'governance-'));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

// ── the baseline ────────────────────────────────────────────────────────────────

test('a fully governed mini-repository passes with no findings', () => {
  const { code, out } = onFixture('valid');
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
});

// ── G1–G4, G12: the policy declaration ──────────────────────────────────────────

test('G1 a documentation path no policy entry matches fails', () => {
  const { code, out } = onFixture('unclassified-path');
  assert.equal(code, 1, out);
  assert.match(out, /G1/);
  assert.match(out, /orphan-note\.md/, 'the finding must name the unclassified path');
});

test('G2 a policy value outside the five declared states fails', () => {
  const { code, out } = onFixture('invalid-policy-value');
  assert.equal(code, 1, out);
  assert.match(out, /G2/);
  assert.match(out, /sometimes/, 'and name the offending value');
});

test('G3 `actor: generator` outside openwiki/ fails', () => {
  // The mechanical expression of FR-026c. The generator's write scope is the bundle plus its own
  // managed regions; every other `regenerate` assignment governs an agent under human review, and
  // widening that is a separate feature rather than a policy edit.
  const { code, out } = onFixture('generator-outside-bundle');
  assert.equal(code, 1, out);
  assert.match(out, /G3/);
  assert.match(out, /docs\/runbooks/);
  assert.match(out, /generator/);
});

test('G4 an event-driven entry with no events fails', () => {
  const { code, out } = onFixture('event-driven-without-events');
  assert.equal(code, 1, out);
  assert.match(out, /G4/);
  assert.match(out, /docs\/decisions/);
});

test('G12 an authoritative concept whose effective policy is `regenerate` fails', () => {
  // data-model E4. An authoritative concept has no upstream document, so a "refresh" has nothing to
  // refresh FROM — it could only paraphrase, which is exactly what the fingerprints exist to stop.
  const { code, out } = onFixture('authoritative-declared-regenerate');
  assert.equal(code, 1, out);
  assert.match(out, /G12/);
  assert.match(out, /musl-openssl\.md/);
});

test('policy precedence anchors on path segments, not glob length', () => {
  // Ranking by raw length made `**/README.md` outrank `.specify/**`, so a README inside an excluded
  // tree resolved to `regenerate`. "A rule about THIS directory beats a rule about files anywhere."
  const { code, out } = onFixture('valid', '--explain', 'openwiki/gotchas/musl-openssl.md');
  assert.equal(code, 0, out);
  assert.match(out, /openwiki\/gotchas\/musl-openssl\.md/);
  assert.match(out, /event-driven/, 'the specific per-concept entry must win over openwiki/**');
});

// ── G5–G7: protected passages ───────────────────────────────────────────────────

test('G5 a reworded protected passage fails and says what changed', () => {
  const { code, out } = onFixture('reworded-passage');
  assert.equal(code, 1, out);
  assert.match(out, /G5/);
  assert.match(out, /musl-openssl\.md/, 'name the concept');
  assert.match(out, /Vendored OpenSSL is musl-conditional/, 'name the anchor');
  // FR-029e: a reader may not know the passage was protected, so the failure has to explain itself.
  assert.match(out, /fingerprint|protected/i);
});

test('G6 a DELETED protected passage fails as a removal', () => {
  // The manifest is the authority. A fingerprint comparison against absent text must not pass for
  // lack of anything to compare — a protected passage can only be deliberately delisted, never
  // silently dropped (FR-029c).
  const { code, out } = onFixture('deleted-passage');
  assert.equal(code, 1, out);
  assert.match(out, /G6/);
  assert.match(out, /remov|missing|absent/i);
  assert.match(out, /Vendored OpenSSL is musl-conditional/);
});

test('G7 a protected passage on a concept that cites a resource fails', () => {
  // Freezing a derived summary against the document it summarizes would fail every legitimate
  // refresh, turning protection into a permanent blocker (FR-041a).
  const { code, out } = onFixture('protected-on-derived');
  assert.equal(code, 1, out);
  assert.match(out, /G7/);
  assert.match(out, /local-dev\.md/);
  assert.match(out, /resource/);
});

test('FR-029d the escape hatch: passage and fingerprint corrected together passes', () => {
  // Without this the gate is a permanent blocker on correcting the very content it protects, and a
  // gate people have to work around is worse than no gate.
  const { code, out } = onFixture('fingerprint-updated');
  assert.equal(code, 0, `the sanctioned correction must pass, got ${code}\n${out}`);
});

// ── fingerprint normalization ───────────────────────────────────────────────────

test('normalization ignores line endings and trailing whitespace', () => {
  const { code, out } = onFixture('whitespace-drift');
  assert.equal(code, 0, `CRLF and trailing spaces are not a content change, got ${code}\n${out}`);
});

test('normalization does NOT ignore a word change', () => {
  // Over-normalizing would let a meaning-changing edit pass, which is the failure this whole gate
  // exists to prevent. `reworded-passage` differs from `valid` by two words.
  assert.equal(onFixture('reworded-passage').code, 1);

  // ...and by one word, in case the difference above was doing the work.
  const dir = copyFixture('valid');
  try {
    const page = join(dir, 'openwiki', 'gotchas', 'musl-openssl.md');
    writeFileSync(page, readFileSync(page, 'utf8').replace('cannot link', 'can link'));
    const { code, out } = runGate(['--root', dir]);
    assert.equal(code, 1, `a single-word inversion must fail\n${out}`);
    assert.match(out, /G5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--fingerprint prints the value the manifest should carry', () => {
  const { code, out } = onFixture('valid', '--fingerprint', 'openwiki/gotchas/musl-openssl.md', 'Vendored OpenSSL is musl-conditional');
  assert.equal(code, 0, out);
  const printed = out.match(/sha256:[0-9a-f]{64}/)?.[0];
  assert.ok(printed, `expected a sha256 value, got: ${out}`);
  const manifest = readFileSync(join(FIXTURES, 'valid', 'openwiki', 'protected.yaml'), 'utf8');
  assert.ok(manifest.includes(printed), 'the computed value must match what the passing fixture declares');
});

// ── G8–G10: the index and the assistant surfaces ────────────────────────────────

test('G8 prose in CLAUDE.md beyond the index and the managed regions fails', () => {
  // Without this the file silently re-grows and the trim is undone within weeks (FR-040).
  const { code, out } = onFixture('claude-stray-prose');
  assert.equal(code, 1, out);
  assert.match(out, /G8/);
  assert.match(out, /CLAUDE\.md/);
});

test('G8 prose INSIDE a machine-managed region is exempt', () => {
  // The three regions are owned by Nx, Spec Kit and the generator. A gate that fought them would fail
  // on content no human can fix, and would be switched off.
  assert.equal(onFixture('valid').code, 0);
  const dir = copyFixture('valid');
  try {
    const file = join(dir, 'CLAUDE.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(
      'Machine-managed by Nx.',
      'Machine-managed by Nx. A whole paragraph of prose, rewritten by the tool on every run, which no\nhuman edits and no gate may reject.',
    ));
    const { code, out } = runGate(['--root', dir]);
    assert.equal(code, 0, `managed-region prose must be exempt\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G9 an index entry pointing at a concept that does not exist fails', () => {
  const { code, out } = onFixture('dangling-index-entry');
  assert.equal(code, 1, out);
  assert.match(out, /G9/);
  assert.match(out, /gone\.md/);
});

test('G10 an assistant surface pointing at moved content fails', () => {
  const { code, out } = onFixture('stale-assistant-surface');
  assert.equal(code, 1, out);
  assert.match(out, /G10/);
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /docs\/local-dev\.md/);
});

// ── G11: every concept is exactly one of derived or authoritative ───────────────

test('G11 a concept that is neither derived nor authoritative fails', () => {
  // This is what turns the routing rule from a convention into something checkable: without a class,
  // "does a learning about this subject go upstream or into the concept?" has no mechanical answer.
  const { code, out } = onFixture('unclassified-concept');
  assert.equal(code, 1, out);
  assert.match(out, /G11/);
  assert.match(out, /nameless\.md/);
  assert.match(out, /neither/i);
});

test('G11 a concept that is BOTH derived and authoritative fails', () => {
  const { code, out } = onFixture('both-classifications');
  assert.equal(code, 1, out);
  assert.match(out, /G11/);
  assert.match(out, /local-dev\.md/);
  assert.match(out, /both/i);
});

test('G11 a concept whose resource does not resolve is not silently derived', () => {
  const dir = copyFixture('valid');
  try {
    const page = join(dir, 'openwiki', 'runbooks', 'local-dev.md');
    writeFileSync(page, readFileSync(page, 'utf8').replace('resource: docs/runbooks/local-dev.md', 'resource: docs/runbooks/gone.md'));
    const { code, out } = runGate(['--root', dir]);
    assert.equal(code, 1, `a dangling citation makes the concept unclassifiable\n${out}`);
    assert.match(out, /G11/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail-closed, and the CLI contract ──────────────────────────────────────────

test('a missing protection manifest is a violation, never a skip', () => {
  const { code, out } = onFixture('missing-manifest');
  assert.equal(code, 1, out);
  assert.match(out, /protected\.yaml/);
});

test('an unparseable policy file is a violation, never a skip', () => {
  const { code, out } = onFixture('unparseable-policy');
  assert.equal(code, 1, out);
  assert.match(out, /policy\.yaml/);
});

test('there is no skip flag and no allowlist', () => {
  // Matching the OKF gate's V10 posture (FR-015): a rejected page is fixed in INSTRUCTIONS.md and
  // regenerated, never accepted in place. An allowlisted leak stays leaked.
  const source = readFileSync(GATE, 'utf8');
  const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
  for (const forbidden of ['--skip', '--allow', 'allowlist', 'ALLOWLIST']) {
    assert.ok(!code.some((l) => l.includes(forbidden)), `the gate must not offer \`${forbidden}\``);
  }
});

test('--selftest proves the rules still detect their cases', () => {
  const { code, out } = runGate(['--selftest']);
  assert.equal(code, 0, out);
  assert.match(out, /G1/);
  assert.match(out, /G12/);
});

test('--json emits machine-readable findings', () => {
  const r = spawnSync(process.execPath, [GATE, '--root', join(FIXTURES, 'reworded-passage'), '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.findings));
  assert.equal(parsed.findings[0].rule, 'G5');
  assert.ok(parsed.findings[0].message.length > 0);
});

test('bad usage exits 2', () => {
  assert.equal(runGate(['--nope']).code, 2);
  assert.equal(runGate(['--root']).code, 2);
});

// ── the real repository ─────────────────────────────────────────────────────────

test('the real repository passes its own governance gate', () => {
  const { code, out } = runGate([]);
  assert.equal(code, 0, `the repository must satisfy the rules it enforces\n${out}`);
});
