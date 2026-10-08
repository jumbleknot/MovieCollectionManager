// Feature 078 US6 — retry a page that ran out of time at low reasoning effort (plan D9).
// Pure rules only: which pages carry a tag, and what effort an invocation overrides. Offline, free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCALATED_EFFORT, pageKey, isDeadlineStop, splitByEscalation, escalationPolicy, invocationEffort,
  nextEscalations, stillFailing,
} from '../wiki-escalation.mjs';

const sl = (area, pages, extra = {}) => ({ area, pages, kind: 'refresh', reason: `r:${area}`, subjects: {}, ...extra });
const tag = (failuresAtLow = 0) => ({ effort: 'low', reason: 'deadline', since: 't0', failuresAtLow });
const NOW = '2026-10-08T00:00:00.000Z';
const outcome = (o) => ({ parts: [], ok: false, landedParts: [], failedParts: [], deadlineStop: false, effortUsed: null, ...o });

test('the escalation step is low, keyed area/page', () => {
  assert.equal(ESCALATED_EFFORT, 'low');
  assert.equal(pageKey('runbooks', 'x.md'), 'runbooks/x.md');
});

test('trigger: only exit 124/137 with a deadline in force is a deadline stop (FR-017, SC-009)', () => {
  assert.equal(isDeadlineStop({ status: 124 }, 60_000), true);
  assert.equal(isDeadlineStop({ status: 137 }, 60_000), true);
  for (const inv of [{ status: 0 }, { status: 1 }, { status: 2 }, { error: 'spawn failed' }, null, undefined]) {
    assert.equal(isDeadlineStop(inv, 60_000), false, JSON.stringify(inv));
  }
  assert.equal(isDeadlineStop({ status: 124 }, null), false, 'no deadline in force (a local run): a 124 is not ours');
});

test('trigger table: a non-deadline failure never creates a tag (SC-009)', () => {
  // Research R14's failure types other than the deadline stop all end as a NORMAL exit: worker exit
  // without submitting, provider 429, openwiki state error, policy or conformance (V16) violation.
  const next = nextEscalations({
    prior: {}, outcomes: [outcome({ parts: [sl('runbooks', ['a.md'])], failedParts: [sl('runbooks', ['a.md'])] })],
    backlog: [sl('runbooks', ['a.md'])], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, {});
});

test('a deadline stop tags exactly the pages that did not land (AC1, partial landing)', () => {
  const next = nextEscalations({
    prior: {},
    outcomes: [outcome({ parts: [sl('projects', ['sast.md']), sl('runbooks', ['x.md'])], landedParts: [sl('projects', ['sast.md'])], failedParts: [sl('runbooks', ['x.md'])], deadlineStop: true })],
    backlog: [sl('runbooks', ['x.md'])], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, { 'runbooks/x.md': { effort: 'low', reason: 'deadline', since: NOW, failuresAtLow: 0 } });
});

test('a deadline stop at an explicit high still tags; an existing tag is neither reset nor counted (Review Focus 5)', () => {
  const fresh = nextEscalations({ prior: {}, outcomes: [outcome({ parts: [sl('a', ['p.md'])], failedParts: [sl('a', ['p.md'])], deadlineStop: true, effortUsed: 'high' })], backlog: [sl('a', ['p.md'])], pageExists: () => true, now: NOW });
  assert.equal(fresh['a/p.md'].failuresAtLow, 0);
  const kept = nextEscalations({ prior: { 'a/p.md': tag(2) }, outcomes: [outcome({ parts: [sl('a', ['p.md'])], failedParts: [sl('a', ['p.md'])], deadlineStop: true, effortUsed: 'high' })], backlog: [sl('a', ['p.md'])], pageExists: () => true, now: NOW });
  assert.deepEqual(kept['a/p.md'], tag(2));
});

test('a landed tagged page loses its tag, whether its invocation verified or only that part landed (AC5)', () => {
  const prior = { 'a/p.md': tag(), 'b/q.md': tag() };
  const next = nextEscalations({
    prior,
    outcomes: [outcome({ parts: [sl('a', ['p.md'])], ok: true }), outcome({ parts: [sl('b', ['q.md']), sl('c', ['r.md'])], landedParts: [sl('b', ['q.md'])], failedParts: [sl('c', ['r.md'])] })],
    backlog: [sl('c', ['r.md'])], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, {});
  assert.deepEqual(Object.keys(prior), ['a/p.md', 'b/q.md'], 'the input map is not mutated');
});

test('failing again at low increments the count, for ANY failure kind (AC6)', () => {
  const next = nextEscalations({ prior: { 'a/p.md': tag(1) }, outcomes: [outcome({ parts: [sl('a', ['p.md'])], failedParts: [sl('a', ['p.md'])], effortUsed: 'low' })], backlog: [sl('a', ['p.md'])], pageExists: () => true, now: NOW });
  assert.equal(next['a/p.md'].failuresAtLow, 2);
  assert.deepEqual(stillFailing({ 'a/p.md': tag(1) }, next), [{ key: 'a/p.md', failuresAtLow: 2 }]);
  assert.deepEqual(stillFailing({}, {}), []);
});

test('an orphan tag is kept while its page exists or is queued, dropped otherwise (edge case)', () => {
  const next = nextEscalations({
    prior: { 'a/exists.md': tag(), 'a/queued.md': tag(), 'a/gone.md': tag() }, outcomes: [],
    backlog: [sl('a', ['queued.md'])], pageExists: (k) => k === 'a/exists.md', now: NOW,
  });
  assert.deepEqual(Object.keys(next).sort(), ['a/exists.md', 'a/queued.md']);
});

test('split: no tags is the identity, stored message included', () => {
  const slices = [sl('a', ['p.md'], { runMessage: 'stored' })];
  const { escalated, normal } = splitByEscalation(slices, {});
  assert.deepEqual(escalated, []);
  assert.equal(normal[0], slices[0], 'the very same object: a run with no tags is byte-for-byte today');
});

test('split: a fully tagged slice moves whole, keeping its message', () => {
  const s = sl('a', ['p.md'], { runMessage: 'stored' });
  const { escalated, normal } = splitByEscalation([s], { 'a/p.md': tag() });
  assert.deepEqual(normal, []);
  assert.equal(escalated[0], s);
});

test('split: a mixed slice is narrowed and its stored message dropped (Review Focus 1)', () => {
  const s = sl('runbooks', ['a.md', 'b.md'], { runMessage: 'Write a.md and b.md', subjects: { 'a.md': 'A', 'b.md': 'B' } });
  const { escalated, normal } = splitByEscalation([s], { 'runbooks/b.md': tag() });
  assert.deepEqual(escalated.map((x) => [x.area, x.pages, x.kind, x.subjects]), [['runbooks', ['b.md'], 'refresh', { 'b.md': 'B' }]]);
  assert.deepEqual(normal.map((x) => [x.area, x.pages, x.kind, x.subjects]), [['runbooks', ['a.md'], 'refresh', { 'a.md': 'A' }]]);
  assert.ok(!('runMessage' in escalated[0]) && !('runMessage' in normal[0]), 'both re-render from their own pages');
  assert.equal(s.runMessage, 'Write a.md and b.md', 'the input slice is not mutated');
});

test('policy: provider support and explicit effort, with the workflow\'s empty string meaning unset (Review Focus 2)', () => {
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'fireworks' }), { explicit: null, supportsLow: true });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: '' }), { explicit: null, supportsLow: true });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: 'high' }), { explicit: 'high', supportsLow: true });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'anthropic' }), { explicit: null, supportsLow: false });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'nonsense' }), { explicit: null, supportsLow: false });
});

test('invocationEffort: low only for escalated work, never over an explicit effort or an unsupporting provider (FR-019, FR-020)', () => {
  assert.equal(invocationEffort({ explicit: null, supportsLow: true }, true), 'low');
  assert.equal(invocationEffort({ explicit: null, supportsLow: true }, false), null);
  assert.equal(invocationEffort({ explicit: 'high', supportsLow: true }, true), null);
  assert.equal(invocationEffort({ explicit: null, supportsLow: false }, true), null);
});

test('page-level: only the pages that did not land in a failed part are tagged or counted; a landed page in it is cleared (FR-017, review I1)', () => {
  const part = sl('runbooks', ['a.md', 'b.md']);
  const next = nextEscalations({
    prior: { 'runbooks/a.md': tag(1) },
    outcomes: [outcome({ parts: [part], failedParts: [part], failedPages: ['runbooks/b.md'], deadlineStop: true })],
    backlog: [part], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, { 'runbooks/b.md': { effort: 'low', reason: 'deadline', since: NOW, failuresAtLow: 0 } },
    'a.md landed (fresh) so its tag goes; only b.md is tagged');
  const counted = nextEscalations({
    prior: { 'runbooks/a.md': tag(1), 'runbooks/b.md': tag(1) },
    outcomes: [outcome({ parts: [part], failedParts: [part], failedPages: ['runbooks/b.md'], effortUsed: 'low' })],
    backlog: [part], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(counted, { 'runbooks/b.md': tag(2) });
});
