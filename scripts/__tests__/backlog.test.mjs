// Unit tests for the agent-driven backlog tool (feature 049).
//
// Runs in CI: the guardrails `naming` job executes `node --test scripts/__tests__/*.test.mjs`
// (feature 041), so this file MUST stay deterministic, offline and token-free. Every case drives an
// exported pure function or an injected fetch/env double — never a live forge call. The live-forge
// verification lives in specs/049-forgejo-issue-tracking/quickstart.md, run by hand once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A REAL-shaped tailnet host, assembled from fragments so no contiguous `.ts.net` literal appears in
// this file. `scripts/check-topology-scrub.mjs` scans the whole tree and holds no literal to compare
// against (by design), so it cannot tell an invented tailnet host from the real one — spelling one out
// here fails that gate, which is exactly what happened on the first run of `preflight`. Same technique
// as ci-digest-redact.test.mjs. Do not "tidy" this into a single string.
const tsNetHost = (label) => label + '.ts' + '.net';
const REAL_HOST = tsNetHost('forge.tailz9x8w7');

import { forgeEndpoint } from '../ci-status.mjs';
import {
  BacklogError,
  selectToken,
  describeMissingWriteToken,
  describeScopeFailure,
  assertWriteTargetsOriginRepo,
  assertWritePathTargetsOriginRepo,
  forgeRequest,
  buildIssueQuery,
  readTotalCount,
  describeTruncation,
  resolveNames,
  selectReadyItems,
  distillItem,
  readBodyFrom,
  findDuplicateOpenItem,
  planMissingNames,
  describeFormValidation,
  renderLine,
  TAXONOMY,
  classifyUpdateFailure,
  wouldCreateCycle,
  describeDivergence,
} from '../backlog.mjs';

// ── T003/T004: endpoint derivation (FR-007, research D1) ─────────────────────────────────────────
//
// The port case is the whole point. Phase 0 built the API base from FORGE_REGISTRY_HOST — a bare
// hostname with no port — and every call failed as `TypeError: fetch failed`, which reads exactly like
// an unreachable forge or a blocked firewall. The remote is the only value carrying scheme + host + PORT.

test('endpoint derivation keeps the port from an http remote', () => {
  const { base, owner, repo } = forgeEndpoint({ origin: 'http://forge.example:3000/acme/widget.git' });
  assert.equal(base, 'http://forge.example:3000/api/v1');
  assert.equal(owner, 'acme');
  assert.equal(repo, 'widget');
});

test('endpoint derivation handles https and a missing .git suffix', () => {
  assert.equal(
    forgeEndpoint({ origin: 'https://forge.example/acme/widget' }).base,
    'https://forge.example/api/v1',
  );
  assert.equal(forgeEndpoint({ origin: 'https://forge.example/acme/widget' }).repo, 'widget');
});

test('endpoint derivation rejects a remote it cannot parse rather than guessing', () => {
  assert.throws(() => forgeEndpoint({ origin: 'git@forge.example:acme/widget.git' }), /could not parse/);
  assert.throws(() => forgeEndpoint({ origin: 'not-a-url' }), /could not parse/);
});

// ── T005/T006: redaction on every emit path (FR-007, SC-004, US4-AC4) ────────────────────────────

test('redaction removes the forge host and port from any emitted line', () => {
  const line = renderLine(`GET http://${REAL_HOST}:3000/acme/widget/api/v1/issues`);
  assert.ok(!line.includes('tailz9x8w7'), `host survived redaction: ${line}`);
  assert.ok(line.includes('<forge>'), `expected a <forge> placeholder, got: ${line}`);
});

test('redaction strips control characters so a hostile title cannot emit terminal escapes', () => {
  const line = renderLine('title: [31mred[0m');
  assert.ok(!line.includes(''), 'escape sequence survived');
  assert.ok(!line.includes(''), 'bell survived');
});

// ── T007/T008: credential selection (FR-005, research D6) ───────────────────────────────────────

test('writes require the issue token; reads prefer it and fall back to the read-only token', () => {
  const both = { MCM_FORGE_ISSUE_TOKEN: 'issue', MCM_FORGE_TOKEN: 'read' };
  assert.deepEqual(selectToken(both, { write: true }), { token: 'issue', name: 'MCM_FORGE_ISSUE_TOKEN' });
  assert.deepEqual(selectToken(both, { write: false }), { token: 'issue', name: 'MCM_FORGE_ISSUE_TOKEN' });
  assert.deepEqual(selectToken({ MCM_FORGE_TOKEN: 'read' }, { write: false }), {
    token: 'read',
    name: 'MCM_FORGE_TOKEN',
  });
});

test('a whitespace-only token counts as absent, not as a credential', () => {
  assert.throws(
    () => selectToken({ MCM_FORGE_ISSUE_TOKEN: '   ', MCM_FORGE_TOKEN: 'read' }, { write: true }),
    /MCM_FORGE_ISSUE_TOKEN/,
  );
  assert.equal(
    selectToken({ MCM_FORGE_ISSUE_TOKEN: '   ', MCM_FORGE_TOKEN: 'read' }, { write: false }).name,
    'MCM_FORGE_TOKEN',
  );
});

test('a missing write credential is refused by name, with the remedy and the read-only consequence', () => {
  const msg = describeMissingWriteToken();
  assert.match(msg, /MCM_FORGE_ISSUE_TOKEN/);
  assert.match(msg, /read-only/i);
  assert.match(msg, /setx/);
  assert.throws(() => selectToken({}, { write: true }), /MCM_FORGE_ISSUE_TOKEN/);
});

test('with no credential at all even reads fail loudly rather than degrading to anonymous', () => {
  assert.throws(() => selectToken({}, { write: false }), /MCM_FORGE_TOKEN/);
});

// ── T009/T010: scope-failure diagnosis (FR-006, SC-003, US4-AC3) ────────────────────────────────

test('a 403 names the token used, the permission missing, and that scope is granular not expiry', () => {
  const msg = describeScopeFailure(403, '/repos/a/b/issues', 'MCM_FORGE_TOKEN');
  assert.match(msg, /403/);
  assert.match(msg, /MCM_FORGE_TOKEN/);
  assert.match(msg, /write:issue/);
  assert.match(msg, /granular scope/i);
  assert.doesNotMatch(msg, /expired/i);
});

test('scope diagnosis maps each endpoint family to the permission it actually needs', () => {
  assert.match(describeScopeFailure(403, '/repos/a/b/issues/4/comments', 'T'), /write:issue/);
  assert.match(describeScopeFailure(403, '/repos/a/b/issues/4/dependencies', 'T'), /write:issue/);
  assert.match(describeScopeFailure(403, '/repos/a/b/labels', 'T'), /write:issue/);
  assert.match(describeScopeFailure(401, '/repos/a/b', 'T'), /read:repository/);
});

test('scope diagnosis names the issue token when that is the one that failed', () => {
  assert.match(
    describeScopeFailure(403, '/repos/a/b/issues', 'MCM_FORGE_ISSUE_TOKEN'),
    /MCM_FORGE_ISSUE_TOKEN/,
  );
});

// ── T011/T012: the same-repository write guard (FR-016, US7-AC2) ─────────────────────────────────
//
// The write credential can reach items on other repositories by the operator's decision, so this guard
// is the only client-side bound. It is the one test standing between a typo and someone else's tracker.

const ORIGIN = { owner: 'acme', repo: 'widget' };

test('the write guard passes through the repository the working copy points at', () => {
  assert.doesNotThrow(() => assertWriteTargetsOriginRepo({ owner: 'acme', repo: 'widget' }, ORIGIN));
});

test('the write guard refuses a different owner', () => {
  assert.throws(() => assertWriteTargetsOriginRepo({ owner: 'other', repo: 'widget' }, ORIGIN), /refus/i);
});

test('the write guard refuses a different repository', () => {
  assert.throws(() => assertWriteTargetsOriginRepo({ owner: 'acme', repo: 'other' }, ORIGIN), /refus/i);
});

test('the write guard is case-sensitive rather than guessing at equivalence', () => {
  assert.throws(() => assertWriteTargetsOriginRepo({ owner: 'Acme', repo: 'widget' }, ORIGIN), /refus/i);
});

// ── T013/T014: transport (FR-006, FR-008, US2-AC4) ──────────────────────────────────────────────

const fakeFetch = (status, body = '{}', headers = {}) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

test('transport returns parsed data plus the total header, never the raw text', async () => {
  const res = await forgeRequest('/issues', {
    base: 'http://f/api/v1',
    token: 't',
    tokenName: 'T',
    fetchImpl: fakeFetch(200, '[{"number":1}]', { 'x-total-count': '7' }),
  });
  assert.deepEqual(res.data, [{ number: 1 }]);
  assert.equal(res.total, 7);
  assert.equal(res.text, undefined, 'raw text must not be handed to callers');
});

test('transport routes 401/403 through the scope diagnosis', async () => {
  await assert.rejects(
    forgeRequest('/issues', {
      base: 'http://f/api/v1',
      token: 't',
      tokenName: 'MCM_FORGE_TOKEN',
      fetchImpl: fakeFetch(403, '{"message":"forbidden"}'),
    }),
    /write:issue/,
  );
});

test('transport reports an unreachable forge distinctly from an authorization refusal', async () => {
  await assert.rejects(
    forgeRequest('/issues', {
      base: 'http://f/api/v1',
      token: 't',
      tokenName: 'T',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }),
    (e) => {
      assert.match(e.message, /could not reach/i);
      assert.doesNotMatch(e.message, /scope/i);
      assert.match(e.message, /api\/v1/, 'the derived base must be named — a portless base is the trap');
      return true;
    },
  );
});

test('transport surfaces an unexpected status with the status code', async () => {
  await assert.rejects(
    forgeRequest('/issues', {
      base: 'http://f/api/v1',
      token: 't',
      tokenName: 'T',
      fetchImpl: fakeFetch(500, 'boom'),
    }),
    /500/,
  );
});

// ── T016/T017: listing query (FR-008, US2-AC3, research D2) ─────────────────────────────────────

test('every listing query carries type=issues — without it 143 rows come back where 1 is correct', () => {
  for (const opts of [{}, { state: 'open' }, { q: 'x' }, { labels: ['a'] }, { page: 3, limit: 10 }]) {
    assert.equal(buildIssueQuery(opts).get('type'), 'issues', `missing type for ${JSON.stringify(opts)}`);
  }
});

test('page and limit are always sent together', () => {
  const q = buildIssueQuery({});
  assert.ok(q.get('page'), 'page missing');
  assert.ok(q.get('limit'), 'limit missing');
});

test('limit is clamped to the measured hard cap of 50', () => {
  assert.equal(buildIssueQuery({ limit: 200 }).get('limit'), '50');
  assert.equal(buildIssueQuery({ limit: 60 }).get('limit'), '50');
  assert.equal(buildIssueQuery({ limit: 10 }).get('limit'), '10');
});

test('state, free-text and label filters pass through when given', () => {
  const q = buildIssueQuery({ state: 'closed', q: 'cascade', labels: ['type/bug', 'priority/p1'] });
  assert.equal(q.get('state'), 'closed');
  assert.equal(q.get('q'), 'cascade');
  assert.equal(q.get('labels'), 'type/bug,priority/p1');
});

test('an omitted state defaults to open rather than silently listing closed work', () => {
  assert.equal(buildIssueQuery({}).get('state'), 'open');
});

// ── T018/T019: authoritative totals (FR-008, US2-AC2) ───────────────────────────────────────────

test('the total comes from x-total-count, not from the number of rows', () => {
  assert.equal(readTotalCount({ get: () => '142' }), 142);
  assert.equal(readTotalCount({ get: () => null }), null);
});

test('a full page with a larger total is reported as truncated', () => {
  const note = describeTruncation(142, 50);
  assert.match(note, /142/);
  assert.match(note, /truncat/i);
});

test('a complete result set produces no truncation notice', () => {
  assert.equal(describeTruncation(3, 3), null);
  assert.equal(describeTruncation(null, 3), null);
});

test('a row count exceeding the reported total does not fabricate a truncation notice', () => {
  assert.equal(describeTruncation(2, 3), null);
});

// ── T020/T021: name resolution (FR-012, research D3) ────────────────────────────────────────────
//
// Measured: `labels=<unknown-name>` is silently ignored server-side and returns the UNFILTERED set, so a
// typo'd filter reads as "matched everything". The name must be rejected locally, before the request.

const LABELS = [
  { id: 1, name: 'type/bug' },
  { id: 2, name: 'priority/p1' },
];

test('known names resolve to their ids', () => {
  assert.deepEqual(resolveNames(['type/bug'], LABELS, 'label'), [{ id: 1, name: 'type/bug' }]);
});

test('an unknown label is refused locally, because the API would silently return everything', () => {
  assert.throws(() => resolveNames(['type/bugg'], LABELS, 'label'), /type\/bugg/);
});

test('the refusal lists the valid values so the operator does not have to go looking', () => {
  try {
    resolveNames(['nope'], LABELS, 'label');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /type\/bug/);
    assert.match(e.message, /priority\/p1/);
  }
});

test('name resolution reports the kind of thing that was not found', () => {
  assert.throws(() => resolveNames(['2026-Q4'], [], 'milestone'), /milestone/i);
});

test('resolving an empty request is a no-op rather than an error', () => {
  assert.deepEqual(resolveNames([], LABELS, 'label'), []);
  assert.deepEqual(resolveNames(undefined, LABELS, 'label'), []);
});

// ── T022/T023: ready-work selection (FR-011, US2-AC1, US5-AC3) ──────────────────────────────────

const item = (number, labels = [], extra = {}) => ({
  number,
  title: `item ${number}`,
  state: 'open',
  labels: labels.map((name) => ({ name })),
  ...extra,
});

test('ready work excludes bot-managed items', () => {
  const { ready } = selectReadyItems([item(29, ['status/bot-managed']), item(30, ['priority/p2'])], {});
  assert.deepEqual(ready.map((i) => i.number), [30]);
});

test('ready work excludes items labelled blocked', () => {
  const { ready } = selectReadyItems([item(1, ['status/blocked']), item(2)], {});
  assert.deepEqual(ready.map((i) => i.number), [2]);
});

test('ready work excludes an item whose blocker is still open, even when unlabelled', () => {
  const { ready } = selectReadyItems([item(1), item(2)], { 1: [{ number: 9, state: 'open' }] });
  assert.deepEqual(ready.map((i) => i.number), [2]);
});

test('a closed blocker does not hold an item back', () => {
  const { ready } = selectReadyItems([item(1)], { 1: [{ number: 9, state: 'closed' }] });
  assert.deepEqual(ready.map((i) => i.number), [1]);
});

test('a blocked label with no blocking edge is warned about, and the graph wins', () => {
  const { ready, warnings } = selectReadyItems([item(1, ['status/blocked'])], { 1: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /#1/);
  assert.deepEqual(ready.map((i) => i.number), [1], 'the dependency graph is the authority');
});

test('an unlabelled item with an open blocker is warned about too', () => {
  const { warnings } = selectReadyItems([item(1)], { 1: [{ number: 9, state: 'open' }] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /#1/);
});

test('ready work is ordered by priority then by item number', () => {
  const items = [
    item(5, ['priority/p3']),
    item(2, ['priority/p1']),
    item(9, ['priority/p1']),
    item(7, []),
  ];
  const { ready } = selectReadyItems(items, {});
  assert.deepEqual(ready.map((i) => i.number), [2, 9, 5, 7], 'unprioritised sorts last');
});

// ── T024/T025: item distillation (FR-008, US2-AC4) ──────────────────────────────────────────────

const RAW = {
  number: 12,
  title: 'Fix the thing',
  state: 'open',
  body: 'context',
  labels: [{ name: 'type/bug' }],
  milestone: { title: '049-forgejo-issue-tracking' },
  user: { login: 'someone' },
  updated_at: '2026-08-08T00:00:00Z',
  comments: 2,
  html_url: `http://${REAL_HOST}:3000/acme/widget/issues/12`,
  assets: ['noise'],
  original_author_id: 0,
};

test('a listing-shaped distillation OMITS dependency fields rather than defaulting them to empty', () => {
  const d = distillItem(RAW);
  assert.equal('blockedBy' in d, false, 'an empty array here would read as "no blockers"');
  assert.equal('blocks' in d, false);
  assert.equal('comments' in d, false);
  assert.equal(d.commentCount, 2, "the API's own count is true without a second call");
});

test('distillation keeps the fields a decision needs and drops the payload noise', () => {
  const d = distillItem(RAW, { comments: [{ user: { login: 'a' }, body: 'hi' }], blockers: [], blocks: [] });
  assert.equal(d.number, 12);
  assert.deepEqual(d.labels, ['type/bug']);
  assert.equal(d.milestone, '049-forgejo-issue-tracking');
  assert.equal(d.comments.length, 1);
  assert.equal(d.assets, undefined);
  assert.equal(d.original_author_id, undefined);
});

test('distillation reports both dependency directions', () => {
  const d = distillItem(RAW, { comments: [], blockers: [{ number: 3 }], blocks: [{ number: 4 }] });
  assert.deepEqual(d.blockedBy, [3]);
  assert.deepEqual(d.blocks, [4]);
});

test('a distilled item carries no forge host, because it is rendered into a transcript', () => {
  const d = distillItem(RAW, { comments: [], blockers: [], blocks: [] });
  assert.ok(!JSON.stringify(d).includes('tailz9x8w7'), 'host leaked through distillation');
});

// ── T028/T029: body input (FR-009, US1-AC2) ─────────────────────────────────────────────────────

test('a body is read from a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backlog-test-'));
  try {
    const p = join(dir, 'body.md');
    writeFileSync(p, '## Context\n\nmulti\nline\n');
    assert.match(readBodyFrom(p), /multi\nline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a body is read from stdin when the path is a dash', () => {
  assert.equal(readBodyFrom('-', { stdin: () => 'from stdin' }), 'from stdin');
});

test('a missing body file is refused by name rather than filing an empty item', () => {
  assert.throws(() => readBodyFrom('/nonexistent/body.md'), /\/nonexistent\/body\.md/);
});

test('an empty body is refused — an item with no context is not a backlog item', () => {
  assert.throws(() => readBodyFrom('-', { stdin: () => '   \n' }), /empty/i);
});

test('a body beyond the size cap is refused rather than truncated silently', () => {
  assert.throws(() => readBodyFrom('-', { stdin: () => 'x'.repeat(64 * 1024 + 1) }), /64/);
});

// ── T030/T031: duplicate detection (spec Edge Cases) ────────────────────────────────────────────

const OPEN = [
  { number: 4, title: 'Cascade delete needs a replica set', state: 'open' },
  { number: 5, title: 'Something else', state: 'open' },
];

test('a closely matching open item is reported instead of filing a duplicate', () => {
  const hit = findDuplicateOpenItem('cascade delete needs a replica set', OPEN);
  assert.equal(hit.number, 4);
});

test('duplicate detection ignores case and surrounding whitespace', () => {
  assert.equal(findDuplicateOpenItem('  CASCADE DELETE NEEDS A REPLICA SET  ', OPEN).number, 4);
});

test('an unrelated title is not treated as a duplicate', () => {
  assert.equal(findDuplicateOpenItem('add a keyset pagination cursor', OPEN), null);
});

// ── T032a/T032b: idempotent setup and form validation (FR-012, FR-013, FR-014) ───────────────────

test('setup plans nothing when every desired name already exists', () => {
  assert.deepEqual(planMissingNames(['a', 'b'], [{ name: 'a' }, { name: 'b' }]), []);
});

test('setup plans only the gap when some names exist', () => {
  assert.deepEqual(planMissingNames(['a', 'b', 'c'], [{ name: 'b' }]), ['a', 'c']);
});

test('setup plans everything on an empty repository', () => {
  assert.deepEqual(planMissingNames(['a', 'b'], []), ['a', 'b']);
});

test('setup never queues an existing entry, so an operator colour change is not reverted', () => {
  const existing = [{ name: 'type/bug', color: 'ff0000', description: 'operator edited' }];
  assert.ok(!planMissingNames(TAXONOMY.map((l) => l.name), existing).includes('type/bug'));
});

test('the taxonomy covers type, priority and status families', () => {
  const names = TAXONOMY.map((l) => l.name);
  for (const n of [
    'type/bug',
    'type/feature',
    'type/tech-debt',
    'type/chore',
    'priority/p1',
    'priority/p2',
    'priority/p3',
    'status/blocked',
    'status/needs-spec',
    'status/bot-managed',
  ]) {
    assert.ok(names.includes(n), `taxonomy missing ${n}`);
  }
});

test('form validation is driven by the ENUMERATED templates, not by issue_config/validate', () => {
  // Measured: issue_config/validate answers {"valid":true} with ZERO templates present — it validates the
  // issue config, not the YAML forms. Treating it as a form parser (which this feature originally planned
  // to do) would have reported a working form on a repository that has none.
  const msg = describeFormValidation([], { valid: true, message: '' });
  assert.match(msg, /no issue form is in effect/i);
  assert.match(msg, /NOT evidence/);
  assert.match(msg, /default branch/i);
});

test('an enumerated form is reported with its field ids', () => {
  const msg = describeFormValidation(
    [{ name: 'Backlog item', body: [{ id: 'context' }, { id: 'acceptance-criteria' }, { type: 'markdown' }] }],
    { valid: true, message: '' },
  );
  assert.match(msg, /Backlog item/);
  assert.match(msg, /context/);
  assert.match(msg, /acceptance-criteria/);
});

test('an invalid issue config is surfaced alongside an otherwise-present form', () => {
  const msg = describeFormValidation([{ name: 'Backlog item', body: [] }], { valid: false, message: 'bad yaml' });
  assert.match(msg, /bad yaml/);
});

// ── The write guard at the request boundary (FR-016) ─────────────────────────────────────────────
//
// Added while wiring the commands: comparing the derived slug against itself is a tautology that
// protects nothing. The guard only means something when the target came from somewhere else — a
// `--repo` flag, a skill, a fan-out caller — or when a mis-built path is caught at the request edge.

test('a mutating request path targeting another repository is refused at the boundary', () => {
  assert.throws(
    () => assertWritePathTargetsOriginRepo('/repos/other/thing/issues', ORIGIN),
    /Refusing to write to other\/thing/,
  );
});

test('a mutating request path targeting the origin repository passes the boundary check', () => {
  assert.doesNotThrow(() => assertWritePathTargetsOriginRepo('/repos/acme/widget/issues/4/labels', ORIGIN));
});

test('a write to a path outside /repos/ is refused rather than assumed safe', () => {
  assert.throws(() => assertWritePathTargetsOriginRepo('/user/repos', ORIGIN), /outside \/repos\//);
});

// ── T039/T040: the blocked-close classifier (FR-010, US3-AC3) ────────────────────────────────────
//
// ⚠️ CHARACTERIZATION TESTS — deliberately labelled, and NOT verified RED first.
// The command layer was written in one pass, ahead of these two test tasks, so an honest RED against a
// missing implementation is no longer available (recorded as a deviation in tasks.md's Progress note).
// Their value is as regression guards, and — more importantly — the assertion below is driven by the
// REAL response captured from the live forge, not by a predicted shape. The status code (412) and the
// wording were unobserved during planning; a guess here would have been the defect.

const BLOCKED_CLOSE = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'backlog', 'blocked-close-412.json'), 'utf8'),
);

test('a 412 open-dependencies refusal is classified as blocked, distinctly from any other failure', () => {
  const raw = new BacklogError(
    `Forge returned ${BLOCKED_CLOSE.status} for PATCH /repos/a/b/issues/145: ${JSON.stringify(BLOCKED_CLOSE.body)}`,
  );
  const out = classifyUpdateFailure(raw, 145);
  assert.match(out.message, /BLOCKED/);
  assert.match(out.message, /unblock/i);
  assert.match(out.message, /#145/);
  assert.match(out.message, /unchanged/i, 'the caller must be told the item was not modified');
  assert.match(out.message, /open dependencies/, 'the original response is preserved, not replaced');
});

test('an unrelated failure is passed through untouched rather than mislabelled as blocked', () => {
  const raw = new BacklogError('Forge returned 500 for PATCH /repos/a/b/issues/9: boom');
  assert.equal(classifyUpdateFailure(raw, 9), raw);
});

test('the captured fixture is the real shape: 412 with an open-dependencies message', () => {
  assert.equal(BLOCKED_CLOSE.status, 412);
  assert.match(BLOCKED_CLOSE.body.message, /open dependencies/);
  assert.ok(!JSON.stringify(BLOCKED_CLOSE).includes('.ts.net'), 'fixture must not carry the forge host');
});

// ── T051/T052: dependency edges and cycle refusal (FR-011, US5-AC1…AC3) ──────────────────────────
//
// ⚠️ The self/reciprocal cases are CHARACTERIZATION tests (the `dep` wiring predated them — see the
// tasks.md deviation note); `wouldCreateCycle` itself was written test-first from this block.

test('a self-dependency is a cycle', () => {
  assert.equal(wouldCreateCycle(5, 5, {}), true);
});

test('a reciprocal edge is a cycle', () => {
  assert.equal(wouldCreateCycle(5, 6, { 6: [{ number: 5 }] }), true);
});

test('a transitive cycle is caught, not just the reciprocal one', () => {
  assert.equal(wouldCreateCycle(1, 3, { 3: [{ number: 2 }], 2: [{ number: 1 }] }), true);
});

test('an unrelated chain is not a cycle', () => {
  assert.equal(wouldCreateCycle(1, 3, { 3: [{ number: 4 }], 4: [{ number: 5 }] }), false);
});

test('cycle detection terminates on a graph that already contains a loop', () => {
  assert.doesNotThrow(() => wouldCreateCycle(9, 1, { 1: [{ number: 2 }], 2: [{ number: 1 }] }));
});

// ── T041/T042: concurrent-divergence detection (spec Edge Cases, US3-AC2) ─────────────────────────
//
// ⚠️ CHARACTERIZATION tests for the reporting function (the `update` wiring predated them). Writing
// them surfaced a real defect: the check ran AFTER this command's own label writes, so
// `--add-label X --state closed` in one invocation compared against a timestamp its own write had
// already moved and aborted on a "concurrent change" that never happened. The command now skips the
// check when it has already written, which is the only honest answer — our write is the newest one.

test('matching timestamps are not a divergence', () => {
  assert.equal(describeDivergence(4, '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z'), null);
});

test('a changed timestamp is reported with both values and the remedy, not silently overwritten', () => {
  const msg = describeDivergence(4, '2026-08-08T00:00:00Z', '2026-08-08T01:00:00Z');
  assert.match(msg, /#4/);
  assert.match(msg, /2026-08-08T00:00:00Z/);
  assert.match(msg, /2026-08-08T01:00:00Z/);
  assert.match(msg, /show 4/);
  assert.match(msg, /Not overwriting/i);
});
