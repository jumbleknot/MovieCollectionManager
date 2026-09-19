// T007 — OKF conformance gate (scripts/check-openwiki-okf.mjs) — feature 043.
// Drives the REAL gate CLI as a subprocess against one fixture bundle per rule and asserts the
// contracted exit codes (specs/043-openwiki-okf/contracts/check-openwiki-okf-cli.md):
//   0 clean / selftest passed · 1 violation / selftest broken · 2 bad args.
// Rules V1–V13 are defined in specs/043-openwiki-okf/data-model.md.
//
// Deterministic, offline, token-free, node: built-ins only — this file is CI-enforced on every push
// by the `guardrails / naming` job's shell-expanded `node --test scripts/__tests__/*.test.mjs` glob,
// which runs in a container with no forge access and no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs');
const FIXTURES = join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'openwiki-okf');

function runGate(args) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const onFixture = (name) => runGate(['--bundle', join(FIXTURES, name)]);

// ── V13: the conformant baseline ────────────────────────────────────────────────
test('V13 a fully conformant bundle passes with no findings', () => {
  const { code, out } = onFixture('valid');
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.match(out, /conformant/i);
});

// ── V1–V5: front matter ─────────────────────────────────────────────────────────
test('V1 unparseable front matter fails and names the file', () => {
  const { code, out } = onFixture('unparseable-frontmatter');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /broken\.md/);
});

test('V2 a missing required `type` fails and names the file', () => {
  const { code, out } = onFixture('missing-type');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /no-type\.md/);
  assert.match(out, /type/i);
});

test('V3 a present-but-blank optional field fails', () => {
  const { code, out } = onFixture('blank-optional-field');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /blank\.md/);
});

test('V4 `tags` as a bare string fails — it must be an array', () => {
  const { code, out } = onFixture('tags-not-array');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /badtags\.md/);
  assert.match(out, /tags/i);
});

test('V5 a non-ISO-8601 timestamp fails and names the field', () => {
  const { code, out } = onFixture('bad-timestamp');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /badtime\.md/);
  assert.match(out, /timestamp/i);
});

// ── V6/V7: source-link resolution (offline in BOTH branches) ────────────────────
test('V6 a dangling repository-relative resource fails and names the missing path', () => {
  const { code, out } = onFixture('dangling-resource');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /dangling\.md/);
  assert.match(out, /this-file-does-not-exist\.md/);
});

test('V7 an external resource is shape-checked only and never fetched', () => {
  // The fixture cites an unresolvable .invalid host: if the gate ever fetches, this cannot pass.
  const { code, out } = onFixture('external-resource');
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.doesNotMatch(out, /ENOTFOUND|EAI_AGAIN|fetch failed/i);
});

// ── V8/V9: directory structure ──────────────────────────────────────────────────
test('V8 a directory with concepts but no index.md fails', () => {
  const { code, out } = onFixture('missing-index');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /index\.md/);
});

test('V9 a concept absent from its directory index fails and names it', () => {
  const { code, out } = onFixture('orphaned-concept');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /unlisted\.md/);
});

// ── V10: fail-closed on an absent or empty bundle ───────────────────────────────
test('V10 an absent bundle fails CLOSED with exit 1 (a violation, not a usage error)', () => {
  const { code, out } = runGate(['--bundle', join(FIXTURES, 'no-such-bundle-dir')]);
  assert.equal(code, 1, `expected exit 1 (not 2), got ${code}\n${out}`);
  assert.match(out, /no bundle|required artifact/i);
});

test('V10 an empty bundle directory fails CLOSED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'okf-empty-'));
  try {
    const { code, out } = runGate(['--bundle', dir]);
    assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V10 a partially-written bundle (concepts, no index) fails rather than merging as a subset', () => {
  const { code } = onFixture('missing-index');
  assert.equal(code, 1);
});

// ── V11: the hand-authored brief is exempt ──────────────────────────────────────
test('V11 INSTRUCTIONS.md is exempt from concept validation', () => {
  // It legitimately carries NO front matter. A gate that validates it fails on its own brief.
  const { code, out } = onFixture('instructions-only');
  assert.equal(code, 0, `expected exit 0, got ${code}\n${out}`);
  assert.doesNotMatch(out, /INSTRUCTIONS\.md/);
});

// ── V12: drift REPORTS, never fails ─────────────────────────────────────────────
test('V12 a stale concept emits a drift warning but still exits 0', () => {
  const { code, out } = onFixture('stale-concept');
  assert.equal(code, 0, `drift must not affect the exit code, got ${code}\n${out}`);
  assert.match(out, /stale\.md/);
  assert.match(out, /stale|drift/i);
});

test('V12 drift is still reported when the concept is checked out with CRLF endings', () => {
  // This gate fails OPEN on a CRLF working tree, which is the worst direction and the exact failure
  // class feature 051 exists to close — found inside the feature's own toolchain.
  //
  // The V12 guard reads `Date.parse(fields.timestamp)` on the RAW value. On CRLF input the value
  // arrives as '…Z\r', which parses to NaN, so the guard concludes "no usable timestamp", the
  // staleness comparison silently never runs, and the gate prints `✅ conformant`. V5 escapes the
  // identical bug only because it happens to `.trim()` first — that asymmetry is the bug, so the fix
  // belongs where the field is READ, not at one more call site.
  //
  // The fixture is built here rather than checked in: `.gitattributes` now declares eol=lf for *.md,
  // so a committed CRLF fixture would be normalised away. Constructing the bytes in the test is also
  // what FR-024 asks for — prove the parser, not the checkout.
  const dir = mkdtempSync(join(tmpdir(), 'okf-crlf-'));
  try {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    writeFileSync(
      join(dir, 'index.md'),
      crlf('---\ntype: Reference\ntitle: Test Bundle\ndescription: Index for the CRLF fixture bundle.\ntimestamp: 2026-07-27T00:00:00Z\n---\n# Test Bundle\n- [Stale](stale.md) — how requests are authenticated.\n'),
    );
    writeFileSync(
      join(dir, 'stale.md'),
      crlf('---\ntype: Runbook\ntitle: Stale\nresource: README.md\ntimestamp: 2001-01-01T00:00:00Z\n---\nBody written long before the source changed.\n'),
    );

    const { code, out } = runGate(['--bundle', dir]);
    assert.equal(code, 0, `drift must not affect the exit code, got ${code}\n${out}`);
    assert.match(out, /stale\.md/, 'the drift check silently did not run on CRLF input — the gate failed OPEN');
    assert.match(out, /stale|drift/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Reporting contract ──────────────────────────────────────────────────────────
// ── V14/V15: body links (item #491) ─────────────────────────────────────────────
test('V14 a site-root-absolute body link fails, even though every other rule is satisfied', () => {
  // The defect this fixture isolates: the target IS a real repository path and the `resource`
  // field resolves, so V6 and every front-matter rule pass. Only the leading `/` is wrong — which
  // is precisely why 204 of these survived on `main` (item #491).
  const { code, out } = onFixture('site-root-link');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /absolute\.md/);
  assert.match(out, /V14/);
});

test('V14 names the file-relative form to write instead', () => {
  // A finding that says only "wrong" makes the reader re-derive the fix once per link.
  const { code, out } = runGate(['--bundle', join(FIXTURES, 'site-root-link'), '--json']);
  assert.equal(code, 1);
  const f = JSON.parse(out).findings.find((x) => x.rule === 'V14');
  assert.ok(f, 'expected a V14 finding');
  assert.match(f.message, /\.\.\/\.\.\/\.\.\/openwiki\/INSTRUCTIONS\.md/, `expected the relative form, got: ${f.message}`);
});

test('V15 a relative link that resolves to nothing fails', () => {
  const { code, out } = onFixture('unresolvable-link');
  assert.equal(code, 1, `expected exit 1, got ${code}\n${out}`);
  assert.match(out, /dangling\.md/);
  assert.match(out, /V15/);
});

test('V14/V15 ignore links inside a code fence or a code span', () => {
  // The brief has to be able to SHOW the wrong form (openwiki/INSTRUCTIONS.md §6). A gate that
  // fails on documentation of the defect cannot be used to document the defect.
  const dir = mkdtempSync(join(tmpdir(), 'okf-code-'));
  try {
    writeFileSync(join(dir, 'index.md'), '---\ntype: Reference\n---\n# Root\n- [A](a.md)\n');
    writeFileSync(join(dir, 'a.md'),
      '---\ntype: R\n---\nnever `[x](/openwiki/a.md)`:\n\n```md\n[y](/openwiki/b.md)\n[z](nope.md)\n```\n');
    const { code, out } = runGate(['--bundle', dir]);
    assert.equal(code, 0, `code samples must not fail the gate, got ${code}\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V15 resolves a link from its own file\'s directory, not from the bundle root', () => {
  // The mirror-image bug: resolving from the bundle root would pass a dangling sibling link and
  // fail a valid one. Both directions are asserted in one bundle.
  const dir = mkdtempSync(join(tmpdir(), 'okf-relbase-'));
  try {
    mkdirSync(join(dir, 'area'), { recursive: true });
    writeFileSync(join(dir, 'index.md'), '---\ntype: Reference\n---\n# Root\n- [A](area/a.md)\n');
    writeFileSync(join(dir, 'area', 'index.md'), '# Area\n- [a](a.md)\n- [b](b.md)\n');
    writeFileSync(join(dir, 'area', 'b.md'), '---\ntype: R\n---\nb\n');
    // `b.md` is a sibling — valid. `area/b.md` would only resolve from the bundle root — invalid.
    writeFileSync(join(dir, 'area', 'a.md'), '---\ntype: R\n---\n[ok](b.md) and [bad](area/b.md)\n');
    const { code, out } = runGate(['--bundle', dir, '--json']);
    assert.equal(code, 1);
    const found = JSON.parse(out).findings.filter((f) => f.rule === 'V15');
    assert.equal(found.length, 1, `expected exactly one V15 finding, got ${found.length}: ${out}`);
    assert.match(found[0].message, /area\/b\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real bundle has no site-root-absolute or dangling body link', () => {
  // The regression guard for item #491 itself: the shipped bundle, not a fixture.
  const { code, out } = runGate(['--json']);
  const findings = JSON.parse(out).findings.filter((f) => f.rule === 'V14' || f.rule === 'V15');
  assert.deepEqual(findings, [], `openwiki/ carries ${findings.length} broken body link(s)`);
  assert.equal(code, 0, `the shipped bundle must be conformant, got ${code}`);
});

test('all findings are reported in one run, not just the first', () => {
  // Fixing a generated bundle one finding per run would be an N-run loop.
  const dir = mkdtempSync(join(tmpdir(), 'okf-multi-'));
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'index.md'), '---\ntype: Reference\n---\n# Root\n- [A](a.md)\n');
    writeFileSync(join(dir, 'a.md'), '---\ntitle: No type here\n---\nBody.\n');
    writeFileSync(join(dir, 'sub', 'b.md'), '---\ntitle: Also no type\n---\nBody.\n');
    const { code, out } = runGate(['--bundle', dir]);
    assert.equal(code, 1);
    assert.match(out, /a\.md/);
    assert.match(out, /b\.md/, 'second finding missing — the gate stopped early');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--json emits machine-readable findings', () => {
  const { code, out } = runGate(['--bundle', join(FIXTURES, 'missing-type'), '--json']);
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.findings) && parsed.findings.length > 0);
  assert.ok(parsed.findings.some((f) => f.file.includes('no-type.md')));
});

// ── CLI contract ────────────────────────────────────────────────────────────────
test('--selftest proves the detector and exits 0', () => {
  const { code, out } = runGate(['--selftest']);
  assert.equal(code, 0, `selftest must pass, got ${code}\n${out}`);
});

test('an unknown argument exits 2 (usage error, distinct from a violation)', () => {
  const { code } = runGate(['--not-a-real-flag']);
  assert.equal(code, 2);
});

test('the gate offers no skip or allowlist escape hatch', () => {
  // FR-014a is fail-closed with no opt-out; FR-012 forbids allowlisting generated content.
  const { code } = runGate(['--bundle', join(FIXTURES, 'no-such-bundle-dir'), '--allow-missing']);
  assert.equal(code, 2, '--allow-missing must not be a recognised flag');
});
