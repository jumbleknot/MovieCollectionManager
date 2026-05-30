/**
 * T017/T018 (cleanup hardening): shared post-test teardown helpers.
 *
 * These run in Playwright `afterEach` hooks using the BFF API (NOT UI interactions),
 * so cleanup happens even when a test throws mid-body (FR-014). Tests run serially
 * within a file (playwright.config `fullyParallel: false`), so resetting to the
 * fixture baseline after each test is safe and keeps the home-screen list small —
 * which is what prevents the residue-induced render timeouts seen in Phase 3.
 *
 * The E2E user is test-dedicated, so any non-fixture collection / any movie in the
 * MUTATION collection is test-created data and safe to remove.
 */

import type { APIRequestContext } from '@playwright/test';
import { FIXTURE_COLLECTIONS } from '../../fixtures/base-dataset';

const KEEP = new Set<string>(Object.values(FIXTURE_COLLECTIONS));

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

/** Delete every non-fixture collection via the BFF (collections.spec teardown) — FR-014. */
export async function cleanupNonFixtureCollections(request: APIRequestContext): Promise<void> {
  const victims = (await listCollections(request)).filter((c) => !KEEP.has(c.name));
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
