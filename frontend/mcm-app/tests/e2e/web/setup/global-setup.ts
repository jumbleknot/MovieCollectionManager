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

import { chromium, request, type APIRequestContext, type FullConfig, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FIXTURE_COLLECTIONS,
  FIXTURE_MOVIES,
  type FixtureMovie,
} from '../../fixtures/base-dataset';
import { agentSeedingEnabled, seedAgentConfig } from './agent-config-seed';
import { authFileForWorker, WORKER_IDENTITY_MANIFEST } from './auth-files';
import { createUserWithRoles, keycloakAdminEnabled, reapStaleWorkerUsers } from './keycloak-admin';
import { ensureLargeLibrary, largeLibraryEnabled } from './large-library-seed';
import { requireEnv } from './load-e2e-env';

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
// Feature 027 US4: credentials come from .env.e2e.local / job env — never a hardcoded fallback.
/**
 * One Playwright worker's identity (054 US4).
 *
 * `userId` is null for worker 0, which reuses the canonical `E2E_TEST_USER` rather than minting a
 * throwaway — and is therefore the one identity teardown must NOT delete.
 */
interface WorkerIdentity {
  index: number;
  username: string;
  password: string;
  userId: string | null;
}

const USER = requireEnv('E2E_TEST_USER');
const PASS = requireEnv('E2E_TEST_PASSWORD');

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
async function loginViaKeycloak(page: Page, creds: { username: string; password: string } = { username: USER, password: PASS }): Promise<void> {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 20000 });

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 20000 }),
    page.click('[data-testid="btn-login-with-keycloak"]'),
  ]);

  try {
    await popup.waitForSelector('input[name="username"]', { timeout: 15000 });
    await popup.fill('input[name="username"]', creds.username);
    await popup.fill('input[name="password"]', creds.password);
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

  // WHOSE session is this? (054 US4.) The `catch` above swallows a popup that closed before the form
  // appeared and calls it "SSO session already active" — which is true, and which under per-worker
  // identities would silently authenticate this worker as SOMEONE ELSE. Every worker would then share
  // one identity again while every file on disk said otherwise: the shared-state class this story
  // exists to remove, wearing a disguise that no count would reveal.
  //
  // Browser contexts have isolated cookie jars, so this should never fire. "Should never" is not a
  // measurement, and the failure it guards is silent.
  const who = await page.evaluate(async () => {
    const r = await fetch('/bff-api/auth/user', { credentials: 'include' });
    return r.ok ? ((await r.json()) as { username?: string }).username ?? null : null;
  });
  if (who && who.toLowerCase() !== creds.username.toLowerCase()) {
    throw new Error(
      `[global-setup] identity mismatch: logged in as "${who}" but expected "${creds.username}". `
      + 'A leaked SSO session would give two workers one identity — refusing to continue.',
    );
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

/**
 * Mint one authenticated session per Playwright worker (052 US3, FR-009).
 *
 * SEQUENTIAL, deliberately. `/bff-api/auth/login` is rate-limited at **5 per 60 s per IP**
 * (rate-limiter.ts `RATE_LIMITS.login`), and inside the Playwright container every login shares one
 * source IP. Firing these concurrently would trip that limit and fail setup outright — swapping the
 * refresh bucket this feature is fixing for the login bucket next to it. A login takes ~15 s, so
 * running them one at a time keeps the rate under four per minute without any explicit pacing.
 *
 * Worker 0 reuses the session already established by the caller, so this costs N-1 extra logins.
 */
async function mintPerWorkerSessions(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  workerCount: number,
): Promise<WorkerIdentity[]> {
  // Drop any per-worker file left by a previous run before minting. Lowering the worker bound would
  // otherwise leave `user-6.json`/`user-7.json` sitting next to freshly-minted ones — sessions that
  // are stale, possibly already evicted, and indistinguishable at a glance from live ones.
  for (const f of fs.readdirSync(AUTH_DIR)) {
    if (/^user-\d+\.json$/.test(f)) fs.rmSync(path.join(AUTH_DIR, f));
  }

  // …and the REALM users behind those files (item #183). Teardown deletes what the manifest records,
  // but a killed run never reaches teardown and the write below then overwrites the manifest — so
  // its users lose the only record that would ever have deleted them. Reaping here instead of only
  // there makes the cleanup self-healing: setup always runs.
  //
  // BEFORE the manifest is overwritten, and before minting, so this run's own fresh users are never
  // candidates regardless of the age threshold.
  const reaped = await reapStaleWorkerUsers();
  if (reaped) {
    console.log(
      `[global-setup] reaped ${reaped} stale per-worker identity/identities left by an interrupted `
      + 'run (item #183)',
    );
  }

  // Worker 0 IS the canonical user, reusing the session the caller already established. That is not
  // just a saving: `/bff-api/auth/login` is rate-limited at 5 per 60 s PER IP, and inside the
  // Playwright container every login shares one source IP. Minting a fresh identity for worker 0 too
  // would add a seventh login and push the run into that bucket — trading the per-user contention
  // this story removes for the login bucket next to it.
  fs.copyFileSync(AUTH_FILE, authFileForWorker(0));
  const identities: WorkerIdentity[] = [{ index: 0, username: USER, password: PASS, userId: null }];

  if (!keycloakAdminEnabled()) {
    // NOT a silent fallback. Without the service-account secret no user can be minted, so every
    // worker would share one identity — which is the defect, not a degraded mode of the fix. Say so
    // loudly enough that a green run cannot be mistaken for a run that proved anything.
    console.warn(
      '[global-setup] ⚠️  KEYCLOAK_SERVICE_CLIENT_SECRET is unset — cannot mint per-worker users, so '
      + `all ${workerCount} workers share ${USER}. Per-user buckets (agent rate limit, session cost `
      + 'ceiling, MAX_CONCURRENT_SESSIONS) are contended again and results are NOT comparable with a '
      + 'per-worker-identity run. See specs/054-app-e2e-reliability-cluster (US4).',
    );
    for (let i = 1; i < workerCount; i += 1) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: IGNORE_TLS });
      try {
        await loginViaKeycloak(await ctx.newPage());
        await ctx.storageState({ path: authFileForWorker(i) });
      } finally {
        await ctx.close();
      }
      identities.push({ index: i, username: USER, password: PASS, userId: null });
    }
    return identities;
  }

  // SEQUENTIAL, deliberately — see the login rate limit above. A login takes ~15 s, so one at a time
  // keeps the rate under four per minute without explicit pacing.
  for (let i = 1; i < workerCount; i += 1) {
    const user = await createUserWithRoles(`e2e_w${i}`, ['mc-user']);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: IGNORE_TLS });
    try {
      await loginViaKeycloak(await ctx.newPage(), { username: user.username, password: user.password });
      await ctx.storageState({ path: authFileForWorker(i) });
    } finally {
      await ctx.close();
    }
    identities.push({ index: i, username: user.username, password: user.password, userId: user.userId });
  }

  // The manifest is what lets global TEARDOWN delete these again. Without it every run would leave N-1
  // users behind in the realm for ever, and a realm that grows without bound is a slow way to make the
  // next person's admin queries lie.
  fs.writeFileSync(WORKER_IDENTITY_MANIFEST, JSON.stringify(identities, null, 2));

  console.log(
    `[global-setup] minted ${workerCount} worker identities — ${identities.length - 1} fresh users + the `
    + 'canonical one for worker 0, so no two workers share a per-USER bucket (054 US4)',
  );
  return identities;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const browser = await chromium.launch();
  try {
    // 1. Authenticate once and persist the session (also warms /home).
    const context = await browser.newContext({ ignoreHTTPSErrors: IGNORE_TLS });
    const page = await context.newPage();
    await loginViaKeycloak(page);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: AUTH_FILE });

    // 1b. One IDENTITY per worker (054 US4), so no two workers share a per-user bucket — the refresh
    //     bucket 052 fixed, and also the agent rate limit, the session cost ceiling, and
    //     MAX_CONCURRENT_SESSIONS, all of which are keyed on the user and were still shared.
    const identities = await mintPerWorkerSessions(browser, Math.max(1, config.workers ?? 1));

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
      // 047 US1 (T003): the large-library fixture. OPT-IN — seeding thousands of movies would
      // tax every E2E run for the benefit of two specs, and US1's defect only reproduces at a
      // size where paging the collection is a real cost. Idempotent: a second run tops up.
      if (largeLibraryEnabled()) {
        await ensureLargeLibrary(api);
      }
    } finally {
      await api.dispose();
    }

    // 2b. Every worker needs its OWN fixture dataset, because it can no longer see anyone else's.
    //     That is the whole point — `listCollections` returns only the caller's data, so a blanket
    //     teardown becomes correct by construction instead of by discipline (054 US4, FR-013).
    //
    //     COST: this is N× the seeding and N× the agent-config PUT, and the PUT runs live credential
    //     probes. Measured and recorded in tasks.md T023 rather than assumed cheap.
    const seedStart = Date.now();
    for (const identity of identities.filter((i) => i.index > 0 && i.userId !== null)) {
      const workerApi = await request.newContext({
        baseURL: BASE,
        storageState: authFileForWorker(identity.index),
        ignoreHTTPSErrors: IGNORE_TLS,
      });
      try {
        await ensureFixtures(workerApi);
        if (agentSeedingEnabled()) await seedAgentConfig(workerApi);
      } finally {
        await workerApi.dispose();
      }
    }
    if (identities.length > 1) {
      console.log(
        `[global-setup] seeded fixtures for ${identities.length - 1} worker identities in `
        + `${((Date.now() - seedStart) / 1000).toFixed(1)}s (054 US4 T023)`,
      );
    }

    // 3. Warm the heavy collection + movie-detail routes (best-effort) so the first
    //    test that hits them doesn't pay the Metro cold-compile (FR-005/FR-007).
    await warmRoutes(page, browseId);
  } finally {
    await browser.close();
  }
}
