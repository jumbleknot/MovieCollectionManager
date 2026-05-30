/**
 * k6 load test for movie collection endpoints (T164)
 *
 * Acceptance thresholds (SC-004, SC-006):
 * - p95 home screen collection list < 3000ms  (SC-004)
 * - p95 movie list (initial 50-movie page)    < 3000ms  (SC-006)
 * - p95 movie text search                     < 3000ms  (SC-006)
 *
 * Prerequisites:
 *   Full stack must be running before executing this test:
 *     Keycloak  → port 8099
 *     Redis     → port 6379
 *     mc-service + MongoDB  → docker compose -f infrastructure-as-code/docker/mc-service/compose.yaml up -d
 *     BFF (Expo) → port 8081  (cd frontend/mcm-app && pnpm start)
 *
 * Environment variables:
 *   BASE_URL           BFF base URL (default: http://localhost:8081)
 *   LOAD_TEST_COOKIE   Full cookie header value from a successful BFF login session.
 *                      Obtain by logging in via the app and copying the Set-Cookie header,
 *                      e.g.: "mcm-session=<session-id>; Path=/; HttpOnly; SameSite=Strict"
 *                      Pass just the name=value portion: "mcm-session=<session-id>"
 *
 * Compile and run:
 *   npx esbuild tests/load/collection-load-impl.ts --bundle --platform=browser \
 *     --outfile=tests/load/collection-load-impl.js
 *   k6 run -e BASE_URL=http://localhost:8081 -e LOAD_TEST_COOKIE="mcm-session=..." \
 *     tests/load/collection-load-impl.js
 *
 * Or use the Nx target:
 *   BASE_URL=http://localhost:8081 LOAD_TEST_COOKIE="mcm-session=..." \
 *     pnpm nx test:load mcm-app
 */

// k6 uses its own runtime module system — not Node.js
// @ts-ignore k6 runtime
import http from 'k6/http';
// @ts-ignore k6 runtime
import { check, sleep } from 'k6';
// @ts-ignore k6 runtime
import { Trend, Rate } from 'k6/metrics';

// Declare k6 globals for TypeScript
declare const __ENV: Record<string, string>;

// ─── Custom metrics ────────────────────────────────────────────────────────────

/** SC-004: Home screen — list all collections for the user */
const collectionsListDuration = new Trend('collections_list_duration');
/** SC-006: Movie list — first page (50 movies) from 10,000-movie collection */
const moviesListDuration = new Trend('movies_list_duration');
/** SC-006: Movie text search against 10,000-movie collection */
const searchDuration = new Trend('search_duration');
/** Overall failure rate across all measured endpoints */
const loadFailRate = new Rate('load_failures');

// ─── Load test options ─────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '30s', target: 25 },   // ramp up to 25 VUs
    { duration: '2m', target: 100 },   // sustain at 100 concurrent users
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    /** SC-004: Home screen collection list must load in < 3s at p95 */
    collections_list_duration: ['p(95)<3000'],
    /** SC-006: Movie list (cursor page 1) must load in < 3s at p95 */
    movies_list_duration: ['p(95)<3000'],
    /** SC-006: Movie search must return results in < 3s at p95 */
    search_duration: ['p(95)<3000'],
    /** Global failure rate must stay below 1% */
    load_failures: ['rate<0.01'],
  },
};

// ─── Configuration ─────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8081';
const LOAD_TEST_COOKIE = __ENV.LOAD_TEST_COOKIE || '';

/** Content types matching ContentType enum in mc-service */
const CONTENT_TYPES = ['Movie', 'Series', 'Concert'] as const;
/** USA ratings matching UsaRating enum in mc-service */
const RATINGS = ['G', 'PG', 'PG-13', 'R', 'NR', 'Unrated'] as const;
/** Media formats matching MediaFormat enum in mc-service */
const MEDIA_FORMATS = ['DVD', 'Blu-Ray', 'UHD Blu-Ray'] as const;
/** Sample genres for realistic data variety */
const GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller',
] as const;

// ─── Seed data helpers ─────────────────────────────────────────────────────────

/** Build a single movie payload for index `i` (0-based). */
function moviePayload(i: number): string {
  const contentType = CONTENT_TYPES[i % CONTENT_TYPES.length];
  const owned = i % 4 !== 0;                    // 75% owned
  const ripped = owned && i % 3 === 0;          // ~25% ripped (only when owned)
  const genre = GENRES[i % GENRES.length];

  return JSON.stringify({
    title: `Load Test ${genre} Movie ${i + 1}`,
    year: 1970 + (i % 55),                      // 1970–2024
    contentType,
    language: i % 10 === 0 ? 'French' : 'English',
    owned,
    ripped,
    childrens: i % 20 === 0,
    rated: RATINGS[i % RATINGS.length],
    directors: [`Director ${(i % 50) + 1}`],
    actors: [
      `Actor ${(i % 100) + 1}`,
      `Actor ${((i + 1) % 100) + 1}`,
    ],
    genres: [genre],
    tags: [],
    movieSet: null,
    ownedMedia: owned ? [MEDIA_FORMATS[i % MEDIA_FORMATS.length]] : [],
    ripQuality: ripped ? [MEDIA_FORMATS[i % MEDIA_FORMATS.length]] : [],
    externalIds: [],
  });
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

/**
 * Runs once before load test begins (single VU).
 *
 * 1. Creates a dedicated test collection via BFF
 * 2. Seeds 10,000 movies using k6 `http.batch()` — 50 concurrent requests × 200 batches
 *
 * Seeding time estimate: ~200 batches × ~50–100ms per batch ≈ 10–20 seconds
 *
 * Returns shared data passed to each VU: { collectionId, cookie }
 */
export function setup(): { collectionId: string | null; cookie: string } {
  if (!LOAD_TEST_COOKIE) {
    console.warn(
      '[load] LOAD_TEST_COOKIE is not set. ' +
      'All requests will be unauthenticated and return 401. ' +
      'See test file header for instructions on obtaining a session cookie.',
    );
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    Cookie: LOAD_TEST_COOKIE,
  };

  // 1. Create the load-test collection
  const createRes = http.post(
    `${BASE_URL}/bff-api/collections`,
    JSON.stringify({ name: `Load Test Collection ${Date.now()}` }),
    { headers: authHeaders, tags: { name: 'seed_create_collection' } },
  );

  if (createRes.status !== 201 && createRes.status !== 200) {
    console.error(
      `[load] setup: Failed to create test collection. ` +
      `HTTP ${createRes.status}: ${createRes.body}`,
    );
    return { collectionId: null, cookie: LOAD_TEST_COOKIE };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = JSON.parse(createRes.body as string) as any;
  const collectionId: string = collection.id;
  console.log(`[load] setup: Created collection ${collectionId}`);

  // 2. Seed 10,000 movies in batches of 50 concurrent requests
  const BATCH_SIZE = 50;
  const TOTAL_MOVIES = 10_000;
  const TOTAL_BATCHES = TOTAL_MOVIES / BATCH_SIZE;
  const movieUrl = `${BASE_URL}/bff-api/collections/${collectionId}/movies`;

  let totalSeeded = 0;
  let totalFailed = 0;

  for (let batch = 0; batch < TOTAL_BATCHES; batch++) {
    // Build an array of [method, url, body, params] tuples for http.batch()
    const requests: Parameters<typeof http.batch>[0] = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const movieIndex = batch * BATCH_SIZE + i;
      requests.push([
        'POST',
        movieUrl,
        moviePayload(movieIndex),
        { headers: authHeaders, tags: { name: 'seed_movie' } },
      ]);
    }

    // Send BATCH_SIZE requests concurrently
    const responses = http.batch(requests) as { status: number }[];
    const batchFailed = responses.filter(r => r.status !== 201 && r.status !== 200).length;
    const batchSeeded = BATCH_SIZE - batchFailed;

    totalSeeded += batchSeeded;
    totalFailed += batchFailed;

    if (batchFailed > 0) {
      console.warn(`[load] setup: Batch ${batch + 1}/${TOTAL_BATCHES} — ${batchFailed} failed`);
    }

    // Brief pause every 10 batches (500 movies) to avoid overwhelming the server
    if (batch % 10 === 9) {
      sleep(0.5);
    }
  }

  console.log(
    `[load] setup: Seeded ${totalSeeded}/${TOTAL_MOVIES} movies ` +
    `(${totalFailed} failed) in collection ${collectionId}`,
  );

  return { collectionId, cookie: LOAD_TEST_COOKIE };
}

// ─── Default VU function ───────────────────────────────────────────────────────

/**
 * Runs concurrently across VUs according to `options.stages`.
 *
 * Each VU simulates a user who:
 * 1. Loads the home screen (lists all collections)     → measures SC-004 threshold
 * 2. Opens the 10,000-movie collection (first page)    → measures SC-006 threshold
 * 3. Searches for a random movie title                 → measures SC-006 threshold
 */
export default function (data: { collectionId: string | null; cookie: string }): void {
  if (!data.collectionId) {
    // Seeding failed in setup — skip load test VUs to avoid misleading results
    console.warn('[load] VU: collectionId not set (setup failed) — skipping iteration');
    return;
  }

  const authHeaders = {
    Cookie: data.cookie,
  };

  // ── SC-004: Home screen — list all user collections ──────────────────────────
  const collectionsRes = http.get(
    `${BASE_URL}/bff-api/collections`,
    { headers: authHeaders, tags: { name: 'collections_list' } },
  );
  collectionsListDuration.add(collectionsRes.timings.duration);
  loadFailRate.add(collectionsRes.status !== 200 ? 1 : 0);
  check(collectionsRes, {
    'SC-004 collections list: HTTP 200': (r) => r.status === 200,
    'SC-004 collections list: < 3s': (r) => r.timings.duration < 3000,
  });

  // ── SC-006: Movie list — first page (50 movies) from 10,000-movie collection ─
  const moviesRes = http.get(
    `${BASE_URL}/bff-api/collections/${data.collectionId}/movies`,
    { headers: authHeaders, tags: { name: 'movies_list' } },
  );
  moviesListDuration.add(moviesRes.timings.duration);
  loadFailRate.add(moviesRes.status !== 200 ? 1 : 0);
  check(moviesRes, {
    'SC-006 movies list: HTTP 200': (r) => r.status === 200,
    'SC-006 movies list: < 3s': (r) => r.timings.duration < 3000,
  });

  // ── SC-006: Movie search — text search across 10,000 movies ──────────────────
  // Use a random index to search for different movie titles each iteration
  const searchIndex = Math.floor(Math.random() * 10_000) + 1;
  const searchRes = http.get(
    `${BASE_URL}/bff-api/collections/${data.collectionId}/movies?search=Movie+${searchIndex}`,
    { headers: authHeaders, tags: { name: 'movies_search' } },
  );
  searchDuration.add(searchRes.timings.duration);
  loadFailRate.add(searchRes.status !== 200 ? 1 : 0);
  check(searchRes, {
    'SC-006 movie search: HTTP 200': (r) => r.status === 200,
    'SC-006 movie search: < 3s': (r) => r.timings.duration < 3000,
  });

  // Brief think time between iterations (realistic user pacing)
  sleep(1);
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Runs once after all VUs finish.
 * Deletes the load-test collection (and its 10,000 seeded movies) to keep the
 * database clean between test runs.
 */
export function teardown(data: { collectionId: string | null; cookie: string }): void {
  if (!data.collectionId) {
    console.warn('[load] teardown: No collection to clean up (seeding was skipped)');
    return;
  }

  const authHeaders = {
    Cookie: data.cookie,
  };

  const deleteRes = http.del(
    `${BASE_URL}/bff-api/collections/${data.collectionId}`,
    null,
    { headers: authHeaders, tags: { name: 'teardown_delete_collection' } },
  );

  if (deleteRes.status === 200 || deleteRes.status === 204) {
    console.log(`[load] teardown: Deleted collection ${data.collectionId}`);
  } else {
    console.warn(
      `[load] teardown: Failed to delete collection ${data.collectionId}. ` +
      `HTTP ${deleteRes.status} — clean up manually.`,
    );
  }
}
