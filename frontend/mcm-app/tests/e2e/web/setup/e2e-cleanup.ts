/**
 * T017/T018 (cleanup hardening): shared post-test teardown helpers.
 *
 * These run in Playwright `afterEach` hooks using the BFF API (NOT UI interactions), so cleanup
 * happens even when a test throws mid-body (FR-014), and they keep the home-screen list small —
 * which is what prevents the residue-induced render timeouts seen in Phase 3.
 *
 * ── Why teardown is OWNERSHIP-SCOPED and not "delete every non-fixture collection" (item #165) ──
 *
 * It used to delete every collection the E2E user owned that was not a fixture, justified like this:
 * *"Tests run serially within a file (`fullyParallel: false`), so resetting to the fixture baseline
 * after each test is safe."* That is true and insufficient. `fullyParallel: false` serialises tests
 * WITHIN a file; Playwright still runs different FILES in parallel across workers (six here), and 21
 * spec files called this helper. So one file's teardown routinely deleted another file's live data.
 *
 * This was not a theoretical race. Measured across four `app-ci` runs (1612/1614/1616/1617), the
 * MEDIAN lifetime of a collection was **1.3 seconds**, and 36 of 40 in run 1617 were deleted within
 * five seconds of creation — while the agent flows that create them need them for a minute or more.
 * One instance, traced end to end in run 1617 (`agent-add-ownership.spec.ts:154`):
 *
 *     03:53:43.658  collection_created   6a794b477cccbc40a3c0260e
 *     03:53:43.681  movie_created        6a794b477cccbc40a3c0260f   (the assistant's add applied)
 *     03:53:43.720  GET .../movies/...                              (the detail screen loaded)
 *     03:53:45.107  collection_deleted   6a794b477cccbc40a3c0260e   ← 1.4 s later, mid-test
 *
 * The test then sat in `page.waitForURL` until its 90 s timeout. Not its own teardown — its body had
 * ~88 s left to run. This class of failure has been read as live-model/live-TMDB nondeterminism; a
 * large part of it was this.
 *
 * ── The rule now ──
 *
 * A test deletes only what it declared it owns. Ownership is registered by name, because the names
 * are the only thing that identifies a creator: every worker acts as the SAME `E2E_TEST_USER`, so
 * `owner_id` cannot separate them, and a collection the ASSISTANT creates (create-if-missing, an
 * import's per-tab collections) never passes through the test's own request context, so it cannot be
 * captured at the HTTP layer either. Every spec already names its collections with a unique
 * discriminator, so declaring the name costs one call.
 *
 * The failure mode is deliberately asymmetric: forgetting to declare leaks a collection (bounded,
 * and swept by `resetNonFixtureCollections` at the start of the next run, where nothing is in
 * flight), whereas the old behaviour destroyed another worker's in-flight fixture. Leaking is the
 * safe direction; that is why matching is exact-or-`"<name> "`-prefixed rather than a loose
 * substring, which could reach across to another worker's similarly-named collection.
 */

import type { APIRequestContext } from '@playwright/test';
import { FIXTURE_COLLECTIONS } from '../../fixtures/base-dataset';

const KEEP = new Set<string>(Object.values(FIXTURE_COLLECTIONS));

/**
 * Names the CURRENT test has claimed.
 *
 * Module state is per worker PROCESS, and a worker runs exactly one test at a time
 * (`fullyParallel: false`, one file per worker), so this is per-test state provided
 * `cleanupOwnedCollections` clears it — which it does, before it awaits anything.
 */
const OWNED = new Set<string>();

interface CollectionLite {
  collectionId: string;
  name: string;
}

async function listCollections(request: APIRequestContext): Promise<CollectionLite[]> {
  const res = await request.get('/bff-api/collections');
  if (!res.ok()) return [];
  const body = await res.json();
  return (body.items ?? body) as CollectionLite[];
}

/**
 * Declare that this test owns these collection names, so its teardown may delete them.
 *
 * Call it for a name the test creates itself AND for a name it asks the ASSISTANT to create
 * (create-if-missing) — the latter never reaches the BFF through this process, so nothing else can
 * observe it. A collection named `"<owned> Import"` or `"<owned> Export"` is covered by the owning
 * base name; anything else needs its own declaration.
 */
export function ownCollection(...names: (string | null | undefined)[]): void {
  for (const n of names) if (n) OWNED.add(n);
}

/** Create a collection through the BFF and claim it in one step. Returns the new collectionId. */
export async function createOwnedCollection(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  ownCollection(name);
  const res = await request.post('/bff-api/collections', { data: { name } });
  if (!res.ok()) {
    throw new Error(
      `[e2e-cleanup] createOwnedCollection("${name}") failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()).collectionId as string;
}

/** Whether `candidate` is a collection the test claimed (exact, or an `"<owned> Suffix"` child). */
function isOwned(candidate: string, owned: string[]): boolean {
  return owned.some((o) => candidate === o || candidate.startsWith(`${o} `));
}

/**
 * Delete the collections THIS test declared — and nothing else (item #165).
 *
 * Clears the ownership set first, so a failure mid-delete cannot carry a stale claim into the next
 * test in this worker (where the name may since have been recreated by someone else).
 */
export async function cleanupOwnedCollections(request: APIRequestContext): Promise<void> {
  const owned = [...OWNED];
  OWNED.clear();
  if (owned.length === 0) return;
  const victims = (await listCollections(request)).filter(
    (c) => !KEEP.has(c.name) && isOwned(c.name, owned),
  );
  await Promise.all(
    victims.map((c) => request.delete(`/bff-api/collections/${c.collectionId}`).catch(() => {})),
  );
}

/** Empty the MUTATION collection via the BFF (movies.spec teardown) — FR-014. */
export async function resetMutationMovies(request: APIRequestContext): Promise<void> {
  const mutation = (await listCollections(request)).find(
    (c) => c.name === FIXTURE_COLLECTIONS.MUTATION,
  );
  if (!mutation) return;
  const res = await request.get(`/bff-api/collections/${mutation.collectionId}/movies`);
  if (!res.ok()) return;
  const body = await res.json();
  const movies = (body.items ?? []) as { movieId: string }[];
  await Promise.all(
    movies.map((m) =>
      request
        .delete(`/bff-api/collections/${mutation.collectionId}/movies/${m.movieId}`)
        .catch(() => {}),
    ),
  );
}
