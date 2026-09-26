/**
 * The ownership turn that every assistant-mediated add goes through (040 US4, extended by 047 US4).
 *
 * WHY THIS EXISTS. Feature 040 US4 put a question between "add <movie> to <collection>" and the
 * HITL approval card: the organizer resolves the target, then asks `Do you own "<title>"?` and
 * waits ([organizer.py](../../../../../agents/movie-assistant/src/nodes/organizer.py) —
 * `_ask_ownership`, reached on EVERY resolved add). The approval card is only built on the reply.
 * A spec that sends the add request and waits directly for `approval-request` therefore waits for
 * an element the graph will never emit until it is answered.
 *
 * That is exactly what happened. 040's own commit recorded the web E2E leg as DEFERRED, and the
 * feature's final validation ran `pnpm nx e2e mcm-app` with 33 specs SKIPPED — including all five
 * assistant add specs, which were never re-run against the new flow. Feature 051 forwarded
 * `E2E_AGENT_PRODUCTION` into the CI Playwright container, the five stopped skipping, and all five
 * failed on the same missing `approval-request` (backlog #150, cluster A). The specs were stale;
 * the product was not.
 *
 * Answering **"No"** is deliberate: it ends the ownership chain immediately, whereas "Yes" opens
 * 047 US4's media-formats → ripped → rip-qualities follow-ups. Specs that are about the approval
 * gate want the shortest honest route to it; the chain itself is covered by
 * `agent-add-ownership.spec.ts`, which is where a change to it should break.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** TMDB enrichment + a model turn stand between the request and the question. */
export const OWNERSHIP_TIMEOUT = 180_000;

/**
 * Answer the "Do you own this movie?" question that precedes the approval gate.
 *
 * Asserts the question actually arrived before answering it, so a graph that stopped asking fails
 * here with "Do you own" not found — rather than silently proceeding and failing later on the
 * approval card, which is the ambiguous symptom this whole helper exists to remove.
 *
 * The Yes/No options render through `render_selection` (kind "ownership" → non-pickable ⇒ the
 * `control` button group) in the `selection-options` component — NOT the curator's
 * `disambiguation-options`.
 */
export async function answerOwnership(page: Page, answer: 'Yes' | 'No' = 'No'): Promise<void> {
  await answerChainQuestion(page, 'Do you own', answer);
}

/**
 * Answer the "Is this a children's movie?" question, which 059 US2 put at the FRONT of the chain —
 * before the ownership question, so that every add records the answer including the not-owned adds
 * that short-circuit the rest of the chain.
 *
 * Kept as its own exported step rather than folded into `answerOwnership`, so each spec's turn
 * sequence stays visible at the call site. A helper that quietly swallowed both questions would
 * make the next inserted question invisible too — and the ordering is precisely what the chain
 * guarantees.
 */
export async function answerChildrens(page: Page, answer: 'Yes' | 'No' = 'No'): Promise<void> {
  await answerChainQuestion(page, /children/i, answer);
}

/**
 * Answer one Yes/No question of the add chain, asserting the question actually arrived first.
 *
 * `asks` is not optional garnish. Both questions render the same `selection-options` control, so a
 * bare `.last()` can match the PREVIOUS question's control while it is still mounted — the answer
 * then lands on a question already answered and the flow stalls on the approval card, which is the
 * ambiguous symptom this whole helper exists to remove.
 */
async function answerChainQuestion(
  page: Page,
  asks: string | RegExp,
  answer: 'Yes' | 'No',
): Promise<void> {
  await expect(page.getByTestId('assistant-dock-panel')).toContainText(asks, {
    timeout: OWNERSHIP_TIMEOUT,
  });
  const options = page.locator('[data-testid="selection-options"]').last();
  await expect(options).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
  await options
    .locator('[data-testid^="selection-option-control-"]')
    .filter({ hasText: new RegExp(`^${answer}$`) })
    .first()
    .click();
}


// ── Verifying the WRITE an approved add produced (item #568) ───────────────────────────────────
//
// WHY THIS IS NOT "poll until the collection exists". Every create-if-missing add applies as TWO
// writes, and `apply_proposal` ([approval_gate.py](../../../../../agents/movie-assistant/src/nodes/approval_gate.py))
// orders them deliberately: `create_collection` is awaited INLINE in the item loop — its new id has
// to thread into every add — while each `add` is pushed onto `deferred` and only issued afterwards,
// in the bounded-concurrency `asyncio.gather` pass. So the collection is observable STRICTLY BEFORE
// the add is even sent. A wait on the collection is therefore not a wait on the add at all: it is
// guaranteed by construction to return early, and whatever it guards races the real write.
//
// That is what failed run 4002 (`assistant-add-ambiguous.spec.ts`, @gate, PR #567 — a diff with
// nothing to do with collections). Reconstructed from `mc-service.log`, with the request durations
// that the raw line order hides — `collection_created` is logged at the END of a 265 ms handler, so
// it appears in the file AFTER the delete that followed it:
//
//   43.4545  POST /collections starts (the organizer's create_collection; 265 ms under load)
//   43.5153  GET /collections — the insert is already visible, so the old poll returns TRUE
//   43.5216  GET /collections/<id>/movies → 200 []   ← toHaveLength(1) reads [] and FAILS here
//   43.6584  DELETE /collections/<id> starts         ← this test's OWN afterEach, 137 ms LATER
//   43.7195  both complete (204, then the 201)
//   43.7739  POST /collections/<id>/movies → 404     ← the add, arriving after the teardown
//
// The DELETE and the 404 are CONSEQUENCES of the assertion having already failed, not its cause:
// the teardown token is worker 3's own BFF session (`authorized_party: movie-collection-manager`),
// the creating token is the agent (`authorized_party: agent-gateway`) for the same subject, and the
// name is a unique `Date.now()` discriminator that only this test ever declared to `ownCollection`.
// Ownership-scoped teardown (item #165) makes a foreign worker's delete impossible here, so there
// is no cross-worker race to isolate — the item's first hypothesis was inverted causality.
//
// The class is the one CLAUDE.md's instrument rule names, and item #564's in a new shape: an
// assertion whose wait completes before the asserted effect can exist is not a wait.

/** Look a collection up by name through the BFF. `undefined` when absent — or when the read failed. */
export async function findCollection(
  request: APIRequestContext,
  name: string,
): Promise<{ collectionId: string } | undefined> {
  const res = await request.get('/bff-api/collections');
  if (!res.ok()) return undefined;
  const body = await res.json();
  const items = (body.items ?? body) as { collectionId: string; name: string }[];
  return items.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

/** A movie as the add specs read it back. Widened per call site for the ownership fields. */
export interface AddedMovie {
  title: string;
  [key: string]: unknown;
}

/**
 * Wait until `collectionName` holds EXACTLY `expected` movies, then hand them back.
 *
 * Polls the pair as ONE object, for the same reason item #564's retention fix does: each half is
 * separately satisfiable at an instant the other is not. `collection` alone is true before the add
 * is issued (see above); `movies` alone cannot be read until the collection exists. `-1` marks a
 * read that failed rather than a collection that is empty, so a flaking listing can never be
 * mistaken for "nothing was added".
 *
 * Demanding equality with `expected` — not `>=` — means a count that has already overshot can never
 * satisfy the poll, so a duplicate that is present when the listing is read fails closed instead of
 * settling on the first of the two. It does NOT make this a proof of at-most-once: a duplicate
 * landing after this returns is invisible to any read-based wait. That property is enforced upstream
 * (mc-service uniqueness → 409 → `skipped_duplicate`, FR-009a/SC-006) and covered in the integration
 * tier. What this wait does guarantee is that the three states which used to pass silently now fail
 * closed: the add never fires (count stays 0), a duplicate is already present (count is 2), the
 * collection is never created (`collection` stays false).
 *
 * Proven by `scripts/__tests__/assistant-add-wait.test.mjs`, which drives this against run 4002's
 * measured tick sequence and keeps the replaced predicate as an executed control.
 */
export async function waitForAddedMovies(
  request: APIRequestContext,
  collectionName: string,
  expected: number,
  timeout: number,
): Promise<{ collectionId: string; movies: AddedMovie[] }> {
  let settled: { collectionId: string; movies: AddedMovie[] } | undefined;
  await expect
    .poll(
      async () => {
        const collection = await findCollection(request, collectionName);
        if (!collection) return { collection: false, movies: -1 };
        const res = await request.get(`/bff-api/collections/${collection.collectionId}/movies`);
        if (!res.ok()) return { collection: true, movies: -1 };
        const movies = ((await res.json()).items ?? []) as AddedMovie[];
        settled = { collectionId: collection.collectionId, movies };
        return { collection: true, movies: movies.length };
      },
      { timeout },
    )
    .toEqual({ collection: true, movies: expected });
  // Non-null is sound: the poll only passes on a tick that read the listing and set this.
  return settled!;
}
