/**
 * Large-library fixture (047 US1 / T003) — one collection big enough that walking it by
 * keyset page is a real cost.
 *
 * WHY IT EXISTS. US1's defect only reproduces at scale: the navigator used to page the whole
 * target collection before it could navigate, so at 50 rows a page a 2,500-movie collection is
 * 50 `list_movies` calls against a 30-per-60 s budget the navigator does not skip. Against the
 * ordinary fixture dataset (a handful of movies) every version of that code passes, which is
 * exactly the shape of test that let the bug ship.
 *
 * OPT-IN, NEVER ON BY DEFAULT. Seeding 2,500 movies is thousands of BFF round-trips; making it
 * part of every `global-setup` run would tax every E2E job for the benefit of two specs. It runs
 * only when `E2E_LARGE_LIBRARY=1`.
 *
 * IDEMPOTENT AND TOPPED UP, NEVER RE-SEEDED. Re-running counts what is already there and creates
 * only the shortfall, so a second run costs one page read. Titles are generated deterministically
 * (`Large Library Title NNNNN`) so "already present" is decidable without storing state, and so a
 * failed run resumes rather than duplicating.
 *
 * Usage:
 *   E2E_LARGE_LIBRARY=1 pnpm nx e2e mcm-app            # seeds, then runs the suite
 *   E2E_LARGE_LIBRARY=1 E2E_LARGE_LIBRARY_SIZE=3000 …  # override the size
 */

import type { APIRequestContext } from '@playwright/test';

/** The fixture collection's name. Distinct from the E2E prefix so cleanup never removes it. */
export const LARGE_LIBRARY_COLLECTION = 'E2E Large Library';

/** 2,500 at 50 rows a page is 50 keyset pages — comfortably past the 30-call/60 s budget. */
export const LARGE_LIBRARY_SIZE = Number(process.env['E2E_LARGE_LIBRARY_SIZE'] ?? 2500);

/** How many creates are in flight at once. Enough to be quick, not enough to fight mc-service. */
const CONCURRENCY = 24;

/** Page size mc-service returns; used only to report how many pages the fixture implies. */
const KEYSET_PAGE = 50;

export function largeLibraryEnabled(): boolean {
  return process.env['E2E_LARGE_LIBRARY'] === '1';
}

/**
 * Deterministic title for row `i`. Zero-padded so lexical and numeric order agree, and prefixed
 * so it can never collide with a real fixture title or a member's own film.
 */
export function largeLibraryTitle(i: number): string {
  return `Large Library Title ${String(i).padStart(5, '0')}`;
}

function movieBody(i: number): Record<string, unknown> {
  // Every CreateMovieRequest field is sent explicitly — mc-service's non-Option Rust fields
  // reject a missing key (same reason global-setup's toCreateMovieBody is exhaustive).
  return {
    title: largeLibraryTitle(i),
    year: 1950 + (i % 75),
    contentType: 'Movie',
    language: 'English',
    owned: i % 2 === 0,
    ripped: false,
    childrens: false,
    ownedMedia: i % 2 === 0 ? ['DVD'] : [],
    ripQuality: [],
    genres: ['Drama'],
    rated: 'PG',
    directors: [],
    actors: [],
    tags: [],
    movieSet: null,
    originalTitle: null,
    releaseDate: null,
    outline: null,
    plot: null,
    runtime: null,
    externalIds: [],
  };
}

async function findCollectionId(api: APIRequestContext, name: string): Promise<string | null> {
  const res = await api.get('/bff-api/collections');
  if (!res.ok()) {
    throw new Error(`[large-library] GET /bff-api/collections failed: ${res.status()}`);
  }
  const body = await res.json();
  const items = (body.items ?? body) as { collectionId: string; name: string }[];
  return items.find((c) => c.name === name)?.collectionId ?? null;
}

/** Which of the generated titles already exist, walked page by page via the keyset cursor. */
async function existingTitles(api: APIRequestContext, collectionId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  // Bounded so a cursor bug cannot spin forever; 200 pages is 10k movies.
  for (let page = 0; page < 200; page++) {
    const qs = cursor ? `?limit=${KEYSET_PAGE}&cursor=${encodeURIComponent(cursor)}` : `?limit=${KEYSET_PAGE}`;
    const res = await api.get(`/bff-api/collections/${collectionId}/movies${qs}`);
    if (!res.ok()) {
      throw new Error(`[large-library] list movies failed: ${res.status()} ${await res.text()}`);
    }
    const body = await res.json();
    for (const m of (body.items ?? []) as { title: string }[]) seen.add(m.title);
    cursor = body.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return seen;
}

/**
 * Ensure the large-library collection exists and holds `size` movies. Returns its id.
 *
 * Safe to call repeatedly: only the shortfall is created.
 */
export async function ensureLargeLibrary(
  api: APIRequestContext,
  size: number = LARGE_LIBRARY_SIZE,
): Promise<string> {
  let collectionId = await findCollectionId(api, LARGE_LIBRARY_COLLECTION);
  if (!collectionId) {
    const res = await api.post('/bff-api/collections', {
      data: { name: LARGE_LIBRARY_COLLECTION },
    });
    if (!res.ok()) {
      throw new Error(
        `[large-library] create collection failed: ${res.status()} ${await res.text()}`,
      );
    }
    collectionId = (await res.json()).collectionId as string;
  }

  const present = await existingTitles(api, collectionId);
  const missing: number[] = [];
  for (let i = 0; i < size; i++) {
    if (!present.has(largeLibraryTitle(i))) missing.push(i);
  }

  if (missing.length === 0) {
    console.log(
      `[large-library] "${LARGE_LIBRARY_COLLECTION}" already holds ${present.size} movies ` +
        `(~${Math.ceil(present.size / KEYSET_PAGE)} keyset pages) — nothing to seed`,
    );
    return collectionId;
  }

  console.log(
    `[large-library] seeding ${missing.length} of ${size} movies into ` +
      `"${LARGE_LIBRARY_COLLECTION}" (${CONCURRENCY} at a time) — this is slow by design, once`,
  );
  const started = Date.now();
  for (let offset = 0; offset < missing.length; offset += CONCURRENCY) {
    const batch = missing.slice(offset, offset + CONCURRENCY);
    await Promise.all(
      batch.map(async (i) => {
        const res = await api.post(`/bff-api/collections/${collectionId}/movies`, {
          data: movieBody(i),
        });
        // 409 means a concurrent/previous run already created it — the (title, year) uniqueness
        // constraint IS the idempotency guarantee here, so it is a success, not a failure.
        if (!res.ok() && res.status() !== 409) {
          throw new Error(
            `[large-library] seed "${largeLibraryTitle(i)}" failed: ${res.status()} ${await res.text()}`,
          );
        }
      }),
    );
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[large-library] seeded ${missing.length} movies in ${elapsed}s — ` +
      `${size} total, ~${Math.ceil(size / KEYSET_PAGE)} keyset pages to walk`,
  );
  return collectionId;
}
