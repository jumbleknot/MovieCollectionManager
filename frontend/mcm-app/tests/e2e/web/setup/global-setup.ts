/**
 * T008 (test infrastructure): Playwright global setup.
 *
 * Runs once before the web E2E suite (wired via playwright.config.ts `globalSetup`).
 * Two responsibilities:
 *   1. Authenticate through the Keycloak OIDC popup flow exactly once and save the
 *      resulting session to `.auth/user.json` (FR-004, FR-005, SC-001). Every test
 *      then inherits this session via `storageState`, so no individual test logs in.
 *   2. Verify-or-create the fixture dataset via the BFF API (FR-007, FR-008, FR-009):
 *      - BROWSE   : read-only; ensure every FIXTURE_MOVIES entry exists (by title).
 *      - MUTATION : reset to empty (delete all movies).
 *      - DEFAULT  : ensure it exists.
 *
 * Requires the full stack running: Keycloak + BFF (Expo :8081) + mc-service + MongoDB + Redis.
 */

import { chromium, request, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FIXTURE_COLLECTIONS,
  FIXTURE_MOVIES,
  type FixtureMovie,
} from '../../fixtures/base-dataset';
import { agentSeedingEnabled, seedAgentConfig } from './agent-config-seed';

// Feature 007: target the BFF container instead of Metro when E2E_BFF_TARGET is set
// (must mirror playwright.config.ts). The marker assertion below proves the request path.
const TARGET = process.env['E2E_BFF_TARGET'];
const BASE =
  TARGET === 'dev-container' ? 'http://localhost:8082'
  : TARGET === 'prod-container' ? 'https://localhost:8443'
  : 'http://localhost:8081';
const IGNORE_TLS = TARGET === 'prod-container'; // self-signed Caddy endpoint
const EXPECTED_BFF_SOURCE = TARGET ?? null;     // 'dev-container' | 'prod-container' | null (Metro)
const AUTH_DIR = path.join(__dirname, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'user.json');
const USER = process.env['E2E_TEST_USER'] ?? 'testuser';
const PASS = process.env['E2E_TEST_PASSWORD'] ?? 'TestPass1!ok';

/** Representative year for a fixture decade — mc-service derives the decade filter from `year`. */
function decadeToYear(decade: string): number {
  const start = parseInt(decade.replace(/s$/, ''), 10); // '2010s' -> 2010
  return start + 5; // mid-decade, unambiguously inside the decade bucket
}

function toCreateMovieBody(m: FixtureMovie): Record<string, unknown> {
  // mc-service deserialization requires all CreateMovieRequest fields present
  // (non-Option Rust fields reject missing keys), so every field is sent explicitly.
  return {
    title: m.title,
    year: decadeToYear(m.decade),
    contentType: m.contentType,
    language: 'English',
    owned: m.owned,
    ripped: m.ripped,
    childrens: false,
    ownedMedia: m.ownedMedia,
    ripQuality: [],
    genres: m.genres,
    rated: m.rated,
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

/**
 * Perform the Keycloak OIDC popup flow in a launched browser, leaving the context
 * with a valid BFF session cookie. Mirrors the slow path of the per-spec login()
 * helper that this global setup replaces.
 */
async function loginViaKeycloak(page: Page): Promise<void> {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20000 });

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 20000 }),
    page.click('[data-testid="btn-login-with-keycloak"]'),
  ]);

  try {
    await popup.waitForSelector('input[name="username"]', { timeout: 15000 });
    await popup.fill('input[name="username"]', USER);
    await popup.fill('input[name="password"]', PASS);
    await popup.press('input[name="password"]', 'Enter');
  } catch {
    // SSO session already active — popup closed before the form appeared.
  }

  await popup.waitForEvent('close', { timeout: 25000 }).catch(() => {});
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await page.goto(`${BASE}/home`);

  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);

  if (!result) {
    throw new Error('[global-setup] Login failed: could not verify authenticated state after OIDC flow');
  }
}

interface CollectionSummary {
  collectionId: string;
  name: string;
}

async function listCollections(api: APIRequestContext): Promise<CollectionSummary[]> {
  const res = await api.get('/bff-api/collections');
  if (!res.ok()) {
    throw new Error(`[global-setup] GET /bff-api/collections failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.items ?? body) as CollectionSummary[];
}

async function ensureCollection(
  api: APIRequestContext,
  existing: CollectionSummary[],
  name: string,
): Promise<string> {
  const found = existing.find((c) => c.name === name);
  if (found) return found.collectionId;
  const res = await api.post('/bff-api/collections', { data: { name } });
  if (!res.ok()) {
    throw new Error(`[global-setup] create collection "${name}" failed: ${res.status()} ${await res.text()}`);
  }
  const created = await res.json();
  return created.collectionId;
}

async function listMovies(api: APIRequestContext, collectionId: string): Promise<{ movieId: string; title: string }[]> {
  const res = await api.get(`/bff-api/collections/${collectionId}/movies`);
  if (!res.ok()) {
    throw new Error(`[global-setup] list movies for ${collectionId} failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.items ?? []) as { movieId: string; title: string }[];
}

/** Seed any missing FIXTURE_MOVIES into BROWSE (idempotent; matches by title) — FR-008. */
async function ensureBrowseMovies(api: APIRequestContext, browseId: string): Promise<void> {
  const present = new Set((await listMovies(api, browseId)).map((m) => m.title));
  for (const m of FIXTURE_MOVIES) {
    if (present.has(m.title)) continue;
    const res = await api.post(`/bff-api/collections/${browseId}/movies`, { data: toCreateMovieBody(m) });
    if (!res.ok()) {
      throw new Error(`[global-setup] seed movie "${m.title}" failed: ${res.status()} ${await res.text()}`);
    }
  }
}

/** Reset the MUTATION collection to empty — FR-009. */
async function resetMutation(api: APIRequestContext, mutationId: string): Promise<void> {
  for (const m of await listMovies(api, mutationId)) {
    const res = await api.delete(`/bff-api/collections/${mutationId}/movies/${m.movieId}`);
    if (!res.ok() && res.status() !== 404) {
      throw new Error(`[global-setup] reset MUTATION: delete movie ${m.movieId} failed: ${res.status()}`);
    }
  }
}

/**
 * Delete every collection that is NOT a fixture. The E2E test user is dedicated to
 * testing, so any non-fixture collection is leftover test data. Removing it each run
 * prevents unbounded residue (which slows the home-screen render enough to flake
 * tests) and guarantees Independent State. Within-run cleanup is still handled by
 * each spec's afterEach (T017/T018); this is the cross-run safety net.
 */
async function resetNonFixtureCollections(
  api: APIRequestContext,
  existing: CollectionSummary[],
): Promise<void> {
  const keep = new Set<string>(Object.values(FIXTURE_COLLECTIONS));
  const victims = existing.filter((c) => !keep.has(c.name));
  const POOL = 8;
  for (let i = 0; i < victims.length; i += POOL) {
    await Promise.all(
      victims.slice(i, i + POOL).map(async (c) => {
        const res = await api.delete(`/bff-api/collections/${c.collectionId}`);
        if (!res.ok() && res.status() !== 404) {
          throw new Error(`[global-setup] delete residue "${c.name}" failed: ${res.status()}`);
        }
      }),
    );
  }
}

async function ensureFixtures(api: APIRequestContext): Promise<{ browseId: string }> {
  let existing = await listCollections(api);
  await resetNonFixtureCollections(api, existing);
  existing = existing.filter((c) =>
    (Object.values(FIXTURE_COLLECTIONS) as string[]).includes(c.name),
  );

  const browseId = await ensureCollection(api, existing, FIXTURE_COLLECTIONS.BROWSE);
  const mutationId = await ensureCollection(api, existing, FIXTURE_COLLECTIONS.MUTATION);
  await ensureCollection(api, existing, FIXTURE_COLLECTIONS.DEFAULT);

  await ensureBrowseMovies(api, browseId);
  await resetMutation(api, mutationId);
  return { browseId };
}

/**
 * Feature 006 (FR-005/FR-007): warm the heavy authenticated routes once, here in global
 * setup, so the FIRST test that visits them does not absorb the Metro dev cold-compile
 * (60–70 s for an uncompiled route) and time out. `/home` is already warmed by the login
 * flow above; this additionally compiles the collection screen and a movie-detail screen.
 * Best-effort: warm-up failures must never fail the suite — they are an optimization, not
 * a gate, so every navigation is guarded.
 */
async function warmRoutes(page: Page, browseId: string): Promise<void> {
  try {
    await page.goto(`${BASE}/collections/${browseId}`);
    await page
      .waitForSelector('[data-testid="movie-list-container"]', { timeout: 60000 })
      .catch(() => {});
    const firstRow = page.getByTestId('movie-list-item-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click().catch(() => {});
      await page
        .waitForSelector('[data-testid="movie-detail-title"]', { timeout: 60000 })
        .catch(() => {});
    }
  } catch {
    // Warm-up is a best-effort optimization; never fail global setup on it.
  }
}

/**
 * Feature 007 (FR-002): positively prove the request path is the BFF container, not Metro.
 * server.js stamps every response with X-BFF-Source=<dev-container|prod-container>; Metro
 * never sets it. Fail fast (before seeding) if the marker is missing or wrong. No-op for
 * the default Metro target.
 */
async function assertBffSource(api: APIRequestContext): Promise<void> {
  if (!EXPECTED_BFF_SOURCE) return;
  const res = await api.get('/bff-api/auth/init');
  const got = res.headers()['x-bff-source'];
  if (got !== EXPECTED_BFF_SOURCE) {
    throw new Error(
      `[global-setup] BFF request-path check FAILED: expected X-BFF-Source='${EXPECTED_BFF_SOURCE}' ` +
        `but got '${got ?? '(none)'}' at ${BASE}. Is the ${EXPECTED_BFF_SOURCE} container serving this ` +
        `origin (and Metro NOT on this port)?`,
    );
  }
  console.log(`[global-setup] BFF request-path confirmed: X-BFF-Source=${got} @ ${BASE}`);
}

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch();
  try {
    // 1. Authenticate once and persist the session (also warms /home).
    const context = await browser.newContext({ ignoreHTTPSErrors: IGNORE_TLS });
    const page = await context.newPage();
    await loginViaKeycloak(page);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: AUTH_FILE });

    // 2. Verify-or-create the fixture dataset using the saved session.
    const api = await request.newContext({
      baseURL: BASE,
      storageState: AUTH_FILE,
      ignoreHTTPSErrors: IGNORE_TLS,
    });
    let browseId: string;
    try {
      await assertBffSource(api); // FR-002: prove the container is the request path (fail fast)
      ({ browseId } = await ensureFixtures(api));
      // Feature 018 (T050): when running the agent flows against the live gateway, seed the test
      // user's runnable assistant config (provider=ollama + their TMDB key) so the dock — now gated
      // on a runnable config (T018) — renders for the assistant suite. Goes through the real PUT
      // validate-on-save path; no shared-credential backdoor (SC-002). Skipped otherwise so the
      // non-agent suite and the off/new-user gating spec (T014) see the unconfigured default.
      if (agentSeedingEnabled()) {
        await seedAgentConfig(api);
        console.log('[global-setup] seeded runnable agent config for the E2E test user (018 T050)');
      }
    } finally {
      await api.dispose();
    }

    // 3. Warm the heavy collection + movie-detail routes (best-effort) so the first
    //    test that hits them doesn't pay the Metro cold-compile (FR-005/FR-007).
    await warmRoutes(page, browseId);
  } finally {
    await browser.close();
  }
}
