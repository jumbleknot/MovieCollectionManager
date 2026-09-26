// Item #568 — the wait an approved assistant add is verified by.
//
// WHAT FAILED. `assistant-add-ambiguous.spec.ts` ("ambiguous title → ordinal pick → approve adds
// exactly one movie", @gate, so it BLOCKS a merge) went red on run 4002 / PR #567, a diff about the
// web bundle that touches no collection code. It received `[]` where it asserted one movie.
//
// WHY, from `mc-service.log` with the request DURATIONS the raw line order hides (`collection_created`
// is logged at the end of a 265 ms handler, so the file shows it AFTER the delete that followed it):
//
//   43.4545  POST /collections starts — the organizer's create_collection, 265 ms under load
//   43.5153  GET /collections — the insert is already visible, so the old wait returned TRUE
//   43.5216  GET /collections/<id>/movies → 200 []   ← the assertion read [] and FAILED here
//   43.6584  DELETE /collections/<id> starts         ← the spec's OWN afterEach, 137 ms LATER
//   43.7739  POST /collections/<id>/movies → 404     ← the add, arriving after its own teardown
//
// The delete and the 404 are CONSEQUENCES of the assertion having already failed. The item's opening
// hypothesis — a concurrent worker's cleanup deleting a foreign collection — is inverted causality:
// the teardown token is that worker's own BFF session, the creating token is the agent for the same
// subject, and the name is a unique `Date.now()` discriminator only that test ever declared to
// `ownCollection`, which ownership-scoped teardown (item #165) confines to it.
//
// The real defect is structural, not a race that could be made rarer. `apply_proposal` awaits
// `create_collection` INLINE (its new id threads into every add) and defers each `add` to a later
// `asyncio.gather` pass, so the collection is observable STRICTLY BEFORE the add is issued. A wait on
// the collection is therefore guaranteed by construction to return early.
//
// WHAT THIS TEST IS FOR. The fix cannot be proven by the E2E run it lives in: that needs the full
// live agent stack and a live model, and the old code passed it most of the time. So the PREDICATE is
// tested here instead, deterministically, against the tick sequence the failure actually produced —
// with the REMOVED predicate kept as an executed control, so the reproduction is demonstrated rather
// than asserted. This is the same discipline item #564's retention fix used, made executable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

import {
  findCollection,
  waitForAddedMovies,
} from '../../frontend/mcm-app/tests/e2e/web/setup/assistant-add-flow.ts';

const NAME = 't069-amb-1790392047041'; // the collection from run 4002, verbatim
const TITLE = 'Pirates of the Caribbean: The Curse of the Black Pearl';

/**
 * A stand-in `APIRequestContext` driven by a SCRIPT of states, one per poll tick.
 *
 * The tick advances on the collections LISTING — the first call of every tick — and the final state
 * repeats for ever, so a case that is meant to time out stays in the state that makes it do so.
 * Scripted by tick rather than by wall clock because the property under test is "which states settle
 * the predicate", and a sleep-based fake would make that depend on the runner's load.
 */
function fakeRequest(script) {
  let tick = -1;
  const ctx = {
    ticks: () => tick + 1,
    async get(url) {
      if (url === '/bff-api/collections') {
        tick = Math.min(tick + 1, script.length - 1);
        const state = script[tick];
        return {
          ok: () => true,
          json: async () => ({ items: state.collection ? [{ collectionId: 'c1', name: NAME }] : [] }),
        };
      }
      assert.equal(url, '/bff-api/collections/c1/movies', `unexpected request: ${url}`);
      const state = script[tick];
      if (state.movies === 'error') return { ok: () => false, json: async () => ({}) };
      return { ok: () => true, json: async () => ({ items: state.movies.map((t) => ({ title: t })) }) };
    },
  };
  return ctx;
}

/** The tick sequence measured on run 4002: the collection lands three ticks before the movie does. */
const RUN_4002 = [
  { collection: false, movies: [] }, // nothing written yet — still inside the approved apply
  { collection: true, movies: [] },  // create_collection landed; the add is still in `deferred`
  { collection: true, movies: [] },  // still not issued — 265 ms of it on the failing run
  { collection: true, movies: [TITLE] }, // the add applied: the state the spec is about
];

/** The predicate this fix REPLACED, kept executable so the reproduction is demonstrated. */
async function oldWaitForCollection(request, name, timeout) {
  await expect.poll(async () => (await findCollection(request, name)) !== undefined, { timeout }).toBe(true);
}

test('CONTROL: the removed predicate settles while the collection is still empty (the defect)', async () => {
  const request = fakeRequest(RUN_4002);
  await oldWaitForCollection(request, NAME, 5000);
  // It returned. Read the movies exactly as the spec did straight afterwards:
  const collection = await findCollection(request, NAME);
  const res = await request.get(`/bff-api/collections/${collection.collectionId}/movies`);
  const movies = (await res.json()).items;
  assert.deepEqual(movies, [], 'the old predicate must settle on a collection with NO movie in it');
  // …which is the `toHaveLength(1)` receiving `[]` that failed run 4002, reproduced deterministically.
});

test('the new predicate waits past the collection-only ticks and returns the added movie', async () => {
  const request = fakeRequest(RUN_4002);
  const { collectionId, movies } = await waitForAddedMovies(request, NAME, 1, 10000);
  assert.equal(collectionId, 'c1');
  assert.equal(movies.length, 1);
  assert.equal(movies[0].title, TITLE);
  // It cannot have settled on tick 2 or 3: those are the states the control stopped on.
  assert.ok(request.ticks() >= 4, `expected to poll past the collection-only states, got ${request.ticks()} ticks`);
});

test('MUTATION: the add never fires → fails closed instead of reading [] as a verdict', async () => {
  const request = fakeRequest([{ collection: true, movies: [] }]);
  await assert.rejects(() => waitForAddedMovies(request, NAME, 1, 1200));
});

test('MUTATION: a duplicate already present → fails closed rather than being accepted', async () => {
  // Equality, not `>=`: a count that has already overshot can never satisfy the poll, so it fails
  // instead of settling on the first of the two.
  //
  // The HONEST limit of that: a duplicate landing strictly AFTER this returns is invisible to any
  // read-based wait, whatever predicate it uses. At-most-once is enforced upstream — mc-service's
  // per-collection uniqueness answers 409 and `apply_proposal` classifies it `skipped_duplicate`
  // (FR-009a/SC-006) — and is covered in the integration tier, not by this wait.
  const request = fakeRequest([{ collection: true, movies: [TITLE, TITLE] }]);
  await assert.rejects(() => waitForAddedMovies(request, NAME, 1, 1200));
});

test('MUTATION: the collection is never created → fails closed', async () => {
  const request = fakeRequest([{ collection: false, movies: [] }]);
  await assert.rejects(() => waitForAddedMovies(request, NAME, 1, 1200));
});

test('a failed movies listing is never mistaken for an empty collection', async () => {
  const request = fakeRequest([{ collection: true, movies: 'error' }]);
  await assert.rejects(() => waitForAddedMovies(request, NAME, 1, 1200));
});
