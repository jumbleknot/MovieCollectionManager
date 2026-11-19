/**
 * Web E2E — per-user backup destinations (feature 073, T025; SC-001, US1-AC1/2/3/5).
 *
 * TIER: `@gate`. These are deterministic and involve no model decision, so they belong in the
 * blocking tier. An UNCLASSIFIED e2e test fails rather than defaulting into a tier
 * (openwiki/invariants/testing-tiers.md), so the tag is not optional decoration.
 *
 * Locators are `data-testid`: React Native Web renders the RN `testID` prop as a `data-testid`
 * DOM attribute, and playwright.config.ts sets `testIdAttribute` to match.
 *
 * The destinations here are the S3 and WebDAV test targets from
 * infrastructure-as-code/docker/backups/compose.yaml, each addressed by the name the BFF CONTAINER
 * can reach it by — the browser never connects to them; the BFF does. The S3 group covers the
 * feature in depth; the WebDAV group (item #1069) covers the WebDAV form, probe, write and read
 * paths through the UI, and leaves the destination-agnostic contracts to the S3 group.
 */
import { test, expect } from './fixtures/worker-session';
import { type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';

const S3_ENDPOINT =
  process.env['BACKUP_TEST_S3_INTERNAL_ENDPOINT'] ?? 'http://mcm-bff-backup-rustfs:9000';
const S3_BUCKET = process.env['BACKUP_TEST_S3_BUCKET'] ?? 'mcm-backups-test';
const S3_ACCESS_KEY = process.env['BACKUP_TEST_S3_ACCESS_KEY'] ?? 'mcmbackuptest';
const S3_SECRET = process.env['BACKUP_TEST_S3_SECRET_KEY'] ?? '';

// The WebDAV target (item #1069). Same rule as S3: the INTERNAL name, the one the BFF container
// resolves. The user is a fixed non-secret name in both compose and CI; the password is minted
// per run in CI and lives in `.env.local` locally.
const WEBDAV_ENDPOINT =
  process.env['BACKUP_TEST_WEBDAV_INTERNAL_ENDPOINT'] ?? 'http://mcm-bff-backup-webdav:6065';
const WEBDAV_USER = process.env['BACKUP_TEST_WEBDAV_USER'] ?? 'mcmbackuptest';
const WEBDAV_PASSWORD = process.env['BACKUP_TEST_WEBDAV_PASSWORD'] ?? '';

const BRING_UP =
  'Bring them up with: docker compose -p mcm --env-file ' +
  'infrastructure-as-code/docker/stacks/mcm.env -f ' +
  'infrastructure-as-code/docker/backups/compose.yaml up -d';

const unique = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Feature 073 T061. BACKUP_TICK_SECRET lives in `.env.local`, NOT `.env.e2e.local` — and
// `loadE2eEnv()` only reads the latter. Passing just the e2e file is what produced a green run
// with silently skipped backup tests once already, so the scheduling test fails loudly rather
// than skipping when this is absent.
const TICK_SECRET = process.env['BACKUP_TICK_SECRET'] ?? '';
const E2E_USER = process.env['E2E_TEST_USER'] ?? '';
const E2E_PASSWORD = process.env['E2E_TEST_PASSWORD'] ?? '';

async function openBackupsSettings(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="nav-settings"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="nav-settings"]');
  await page.waitForSelector('[data-testid="settings-nav-backups"]', {
    state: 'visible',
    timeout: 30000,
  });
  await page.click('[data-testid="settings-nav-backups"]');
  await page.waitForSelector('[data-testid="settings-backups-screen"]', {
    state: 'visible',
    timeout: 30000,
  });
}

async function fillDestination(page: Page, label: string): Promise<void> {
  await page.click('[data-testid="backup-destination-add"]');
  await page.waitForSelector('[data-testid="backup-destination-form"]', {
    state: 'visible',
    timeout: 15000,
  });
  await page.fill('[data-testid="backup-destination-label"]', label);
  await page.fill('[data-testid="backup-destination-endpoint"]', S3_ENDPOINT);
  await page.fill('[data-testid="backup-destination-bucket"]', S3_BUCKET);
  await page.fill('[data-testid="backup-destination-access-key-id"]', S3_ACCESS_KEY);
  await page.fill('[data-testid="backup-destination-secret"]', S3_SECRET);
}

async function fillWebdavDestination(page: Page, label: string): Promise<void> {
  await page.click('[data-testid="backup-destination-add"]');
  await page.waitForSelector('[data-testid="backup-destination-form"]', {
    state: 'visible',
    timeout: 15000,
  });
  // The type switch FIRST: it swaps the S3 fields for the WebDAV ones, so the username field
  // does not exist until it has been pressed.
  await page.click('[data-testid="backup-destination-type-webdav"]');
  await page.waitForSelector('[data-testid="backup-destination-username"]', {
    state: 'visible',
    timeout: 15000,
  });
  await page.fill('[data-testid="backup-destination-label"]', label);
  await page.fill('[data-testid="backup-destination-endpoint"]', WEBDAV_ENDPOINT);
  await page.fill('[data-testid="backup-destination-username"]', WEBDAV_USER);
  await page.fill('[data-testid="backup-destination-secret"]', WEBDAV_PASSWORD);
}

// ── Whether a destination can be used at all ───────────────────────────────────
//
// A missing credential would make every case below fail as the same authentication error,
// which reads as a broken feature rather than a missing input — so it skips instead.
//
// BUT A SKIP READS AS A PASS, and these are `@gate` tests. So the skip is ESCALATABLE, the same
// way MCM_REQUIRE_LIVE_STACK works for the integration tier: set E2E_REQUIRE_BACKUP_TARGETS=1
// and a missing target becomes a hard failure instead of a quiet green.
//
// CI DOES RUN THIS FILE NOW — corrected 2026-09-21, run 3873. An earlier revision of this
// comment said app-e2e could not bring the targets up, because the S3 one was then a
// from-source image in the repository's own registry and the job had neither the variable nor
// registry credentials. That was wired up, and since feature 080 the S3 target is the upstream
// `rustfs/rustfs` image, pulled by digest with no registry input at all: app-ci's
// `app-e2e-bring-up-backup-destinations` step brings it up and the suite runs for real, with
// E2E_REQUIRE_BACKUP_TARGETS=1 so an absent target fails rather than skips.
//
// The correction matters more than the fact. Acting on the stale note, this session reported
// "a green app-e2e is not evidence that backups work" — which had stopped being true, and
// would have had a reviewer discount a signal that was real.
//
// ONE GUARD PER DESTINATION, NOT ONE FOR THE FILE (item #1069). Each `describe` below guards
// only the destination its own tests use, so a stopped WebDAV container skips the WebDAV tests
// and leaves the S3 ones running, and the reverse. A file-wide guard on both would skip tests
// that never touch the absent target — the same decide-from-the-wrong-input mistake item #981
// was filed for.
const REQUIRE_TARGETS = process.env['E2E_REQUIRE_BACKUP_TARGETS'] === '1';

type DestinationKind = 's3' | 'webdav';

const TARGETS: Record<
  DestinationKind,
  { name: string; endpoint: string; secretVar: string; secret: string; draft: object }
> = {
  s3: {
    name: 'S3',
    endpoint: S3_ENDPOINT,
    secretVar: 'BACKUP_TEST_S3_SECRET_KEY',
    secret: S3_SECRET,
    draft: {
      type: 's3',
      endpoint: S3_ENDPOINT,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY,
      secret: S3_SECRET,
    },
  },
  webdav: {
    name: 'WebDAV',
    endpoint: WEBDAV_ENDPOINT,
    secretVar: 'BACKUP_TEST_WEBDAV_PASSWORD',
    secret: WEBDAV_PASSWORD,
    draft: {
      type: 'webdav',
      endpoint: WEBDAV_ENDPOINT,
      username: WEBDAV_USER,
      secret: WEBDAV_PASSWORD,
    },
  },
};

/**
 * Register, in the calling `describe`, the skip-or-fail decision for one destination.
 *
 * Two layers. An unset credential is decided at collection time, before anything runs. But A SET
 * SECRET IS NOT A RUNNING TARGET (item #981): a `.env.local` copied from another checkout carries
 * the secret while the backups compose file was never brought up here, and then every test failed
 * on `backup-destination-list` never appearing — an instrument error that reads as an application
 * defect. So reachability is also PROBED, once per worker, before any test in the group runs.
 *
 * The probe goes THROUGH THE BFF (the unsaved-draft form of destinations/test), not straight at
 * the endpoint: that address is the name the BFF CONTAINER resolves, which the Playwright process
 * cannot, and the BFF is the hop whose reachability the tests depend on. A draft persists nothing.
 * Any non-`ok` outcome — refused, timed out, a URL-guard 400, a wrong secret — means the tests in
 * the group cannot pass, so it skips (or, required, fails) and says why.
 */
function guardDestination(kind: DestinationKind): void {
  const target = TARGETS[kind];
  const missing = target.secret === '';
  if (missing && REQUIRE_TARGETS) {
    throw new Error(
      `E2E_REQUIRE_BACKUP_TARGETS=1 but ${target.secretVar} is unset — the ${target.name} ` +
        `backup destination is not up. ${BRING_UP}`,
    );
  }
  test.skip(
    missing,
    `${target.secretVar} is unset — the ${target.name} backup destination is not up. This is a ` +
      'SKIP, not a pass. Set E2E_REQUIRE_BACKUP_TARGETS=1 to make it a failure.',
  );

  test.beforeAll(async ({ playwright, workerStorageState }, testInfo) => {
    const api = await playwright.request.newContext({
      storageState: workerStorageState,
      ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors ?? false,
    });
    let unreachable: string | null = null;
    try {
      const res = await api.post(`${BASE}/bff-api/backups/destinations/test`, {
        data: { ...target.draft, label: `e2e-reachability-probe-${kind}` },
        timeout: 15000,
      });
      // A refused address is a 400 problem document rather than `{ ok: false }` — and an
      // UNRESOLVABLE host lands there too, which is the usual signature of the target being down.
      const body = await res.json().catch(() => null);
      if (!res.ok()) {
        const detail = [body?.title, body?.detail].filter(Boolean).join(': ');
        unreachable = `the BFF answered HTTP ${res.status()} to the probe${detail ? ` — ${detail}` : ''}`;
      } else if (body?.ok !== true) unreachable = body?.reason ?? 'the probe did not report ok';
    } catch (err) {
      unreachable = `the probe request failed: ${(err as Error).message.split('\n')[0]}`;
    } finally {
      await api.dispose();
    }
    if (unreachable === null) return;

    const why =
      `the ${target.name} backup destination ${target.endpoint} is not usable from the BFF ` +
      `(${unreachable}). ${BRING_UP}`;
    if (REQUIRE_TARGETS) throw new Error(`E2E_REQUIRE_BACKUP_TARGETS=1 but ${why}`);
    test.skip(
      true,
      `${target.secretVar} is set, but ${why} This is a SKIP, not a pass. Set ` +
        'E2E_REQUIRE_BACKUP_TARGETS=1 to make it a failure.',
    );
  });
}

// ── Per-test state, shared by every group ──────────────────────────────────────

// Each worker has its OWN user (054 US4), but that user persists across runs — so a spec that
// failed before reaching its delete step leaves a destination behind, and the next run sees
// several. That is exactly how `.first()` came to delete the wrong one and report the feature
// broken. Start every test from a known-empty list instead of hoping the previous one tidied up.
/**
 * Remove every backup job and destination belonging to the acting user.
 *
 * Run BOTH before and after each test, deliberately. Before, so a test starts from a known
 * list and a positional locator is unambiguous. After, so nothing this file created is still
 * there for the next thing to trip over — the lesson the collections leak taught at the cost
 * of three CI cycles.
 *
 * Jobs first: deleting a destination DISABLES its jobs (FR-006) rather than removing them, so
 * clearing destinations alone would leave disabled jobs behind and a non-empty job list.
 */
async function clearBackupState(request: APIRequestContext): Promise<void> {
  const jobs = await (await request.get(`${BASE}/bff-api/backups/jobs`)).json();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    await request.delete(`${BASE}/bff-api/backups/jobs/${j.id}`);
  }
  const destinations = await (await request.get(`${BASE}/bff-api/backups/destinations`)).json();
  for (const d of Array.isArray(destinations) ? destinations : []) {
    await request.delete(`${BASE}/bff-api/backups/destinations/${d.id}`);
  }
  // AND THE STANDING PERMISSION (feature 073 T061). The scheduling test grants a real, NON-
  // EXPIRING Keycloak offline token to the acting user. Leaving one behind is worse than
  // leaving a collection behind: it is a live credential on a shared test account that
  // nothing later in the job would clean up, and it does not age out. Revoked here so the
  // token is given up at Keycloak, not merely forgotten.
  await request.delete(`${BASE}/bff-api/backups/consent`);
}

/**
 * Register, in the calling `describe`, the before- and after-each cleanup every group needs.
 *
 * THE COLLECTIONS THIS FILE CREATES MUST BE REMOVED, and that is not tidiness — it is the
 * difference between a green suite and a broken one three flows later.
 *
 * MEASURED on run 3838. The restore test creates `<name> (backup <timestamp>)` collections and a
 * `Mutated …` one, in the SHARED e2e test account. Left behind, the next mobile flow asked
 * "tell me about Avatar" and the assistant answered:
 *
 *   "Which collection should I add Avatar: Fire and Ash to? You have: E2E Browse, E2E Mutation,
 *    E2E Default, Mutated e2e-17899…, E2E Browse (backup 2026-09-20 19:03), …"
 *
 * — a disambiguation instead of a movie card, so `agent-disambiguation` failed three attempts on
 * a card that never had a title. A test that mutates shared state and does not restore it does
 * not fail itself; it fails something else, later, somewhere that looks unrelated.
 *
 * Matched by NAME because the restore is driven through the UI, so the created ids are not
 * visible to the test. Both patterns are ones only this file produces: `(backup <timestamp>)` is
 * the restore writer's own suffix, and `Mutated e2e-` is this file's mutation fixture.
 */
function registerCleanup(): void {
  test.beforeEach(async ({ request }) => {
    await clearBackupState(request);
  });

  test.afterEach(async ({ request }) => {
    await clearBackupState(request);
    const res = await request.get(`${BASE}/bff-api/collections`);
    const list = await res.json();
    for (const c of Array.isArray(list) ? list : (list.items ?? [])) {
      const id = c.collectionId ?? c.id;
      if (!id) continue;
      if (/\(backup .+\)$/.test(c.name) || /^Mutated e2e-/.test(c.name)) {
        await request.delete(`${BASE}/bff-api/collections/${id}`);
      }
    }
  });
}

/** The server-assigned id for a destination, so a locator names ONE row rather than the first. */
async function destinationIdFor(page: Page, label: string): Promise<string> {
  const list = await (await page.request.get(`${BASE}/bff-api/backups/destinations`)).json();
  const match = (Array.isArray(list) ? list : []).find((d: { label: string }) => d.label === label);
  if (!match) throw new Error(`no destination named ${label} — it was not created`);
  return match.id;
}

test.describe('Backup destinations (feature 073)', () => {
  guardDestination('s3');
  registerCleanup();

  test('add, verify, edit and delete a destination', { tag: '@gate' }, async ({ page }) => {
    const label = unique();
    await openBackupsSettings(page);

    // ── Add (US1-AC1) ────────────────────────────────────────────────────────
    await fillDestination(page, label);
    await page.click('[data-testid="backup-destination-save"]');
    await page.waitForSelector('[data-testid="backup-destination-list"]', {
      state: 'visible',
      timeout: 20000,
    });
    await expect(page.getByText(label, { exact: true })).toBeVisible();

    // ── Verify (US1-AC2) — a real probe against a real server ────────────────
    const row = page
      .locator('[data-testid="backup-destination-list"]')
      .getByText(label, { exact: true });
    await expect(row).toBeVisible();
    // By ID, not `.first()`. The list can legitimately hold more than one destination, and a
    // positional locator silently acts on whichever happens to sort first.
    const id = await destinationIdFor(page, label);
    await page.click(`[data-testid="backup-destination-test-${id}"]`);
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toContainText(
      /confirmed it can be written to/i,
      { timeout: 30000 },
    );

    // ── Edit, WITHOUT retyping the secret (US1-AC3 / FR-003) ─────────────────
    const renamed = `${label}-renamed`;
    await page.click(`[data-testid="backup-destination-edit-${id}"]`);
    await page.waitForSelector('[data-testid="backup-destination-form"]', {
      state: 'visible',
      timeout: 15000,
    });
    // The secret field is EMPTY on edit — not a row of dots. A masked stand-in would say a
    // credential had been fetched into the page, and none was.
    await expect(
      page.locator(
        '[data-testid="backup-destination-secret"] input, [data-testid="backup-destination-secret"]',
      ),
    ).toHaveValue('');
    await page.fill('[data-testid="backup-destination-label"]', renamed);
    await page.click('[data-testid="backup-destination-save"]');
    await expect(page.getByText(renamed, { exact: true })).toBeVisible({ timeout: 20000 });

    // Still verifiable, which proves the stored credential survived an update that omitted it.
    await page.click(`[data-testid="backup-destination-test-${id}"]`);
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toContainText(
      /confirmed it can be written to/i,
      { timeout: 30000 },
    );

    // ── Delete ───────────────────────────────────────────────────────────────
    await page.click(`[data-testid="backup-destination-delete-${id}"]`);
    await expect(page.getByText(renamed, { exact: true })).toHaveCount(0, { timeout: 20000 });
  });

  test(
    'no response carries the stored secret back (US1-AC3)',
    { tag: '@gate' },
    async ({ page }) => {
      const label = unique();
      await openBackupsSettings(page);
      await fillDestination(page, label);

      // Watch the wire, not the screen. A secret absent from the rendered page but present in a
      // response body has still left the server, and the next thing to read that body might not
      // be this UI.
      const bodies: string[] = [];
      page.on('response', async (res) => {
        if (!res.url().includes('/bff-api/backups/')) return;
        try {
          bodies.push(await res.text());
        } catch {
          /* a streamed or empty body is not a leak */
        }
      });

      await page.click('[data-testid="backup-destination-save"]');
      await page.waitForSelector('[data-testid="backup-destination-list"]', {
        state: 'visible',
        timeout: 20000,
      });
      const id = await destinationIdFor(page, label);
      await page.click(`[data-testid="backup-destination-test-${id}"]`);
      await expect(page.locator('[data-testid="backup-destination-test-result"]')).toBeVisible({
        timeout: 30000,
      });

      expect(bodies.length).toBeGreaterThan(0); // a leak check over zero responses proves nothing
      for (const body of bodies) {
        expect(body).not.toContain(S3_SECRET);
        expect(body).not.toContain('secretEnc');
      }

      await page.click(`[data-testid="backup-destination-delete-${id}"]`);
    },
  );

  test(
    'a blocked address is refused with a reason the user can act on (US1-AC4)',
    { tag: '@gate' },
    async ({ page }) => {
      await openBackupsSettings(page);
      await fillDestination(page, unique());
      await page.fill('[data-testid="backup-destination-endpoint"]', 'http://169.254.169.254/');
      await page.click('[data-testid="backup-destination-save"]');

      await expect(page.locator('[data-testid="backup-error-banner"]')).toContainText(
        /not allowed/i,
        {
          timeout: 20000,
        },
      );
    },
  );

  // ── US2: take a backup right now ─────────────────────────────────────────────

  test('set up a backup, run it, and see it in history', { tag: '@gate' }, async ({ page }) => {
    const label = unique();
    await openBackupsSettings(page);
    await fillDestination(page, label);
    await page.click('[data-testid="backup-destination-save"]');
    await page.waitForSelector('[data-testid="backup-destination-list"]', {
      state: 'visible',
      timeout: 20000,
    });

    await page.click('[data-testid="backup-job-add"]');
    await page.waitForSelector('[data-testid="backup-job-form"]', {
      state: 'visible',
      timeout: 15000,
    });
    await page.fill('[data-testid="backup-job-label"]', `${label} job`);
    // No collections selected — every collection this user owns, resolved when the backup runs.
    await page.click('[data-testid="backup-job-save"]');
    await page.waitForSelector('[data-testid="backup-job-list"]', {
      state: 'visible',
      timeout: 20000,
    });

    await page.locator('[data-testid^="backup-job-run-"]').first().click();
    await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
      /Backed up \d+ movies/i,
      {
        timeout: 120000,
      },
    );

    // The version the run just wrote is listed at the destination.
    await page.locator('[data-testid^="backup-job-versions-"]').first().click();
    await expect(page.locator('[data-testid="backup-version-list"]')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator('[data-testid^="backup-version-restore-"]').first()).toBeEnabled();
  });

  // ── US3: recover without risking what I have now ─────────────────────────────

  test(
    'back up, change the data, restore, and confirm nothing was overwritten',
    { tag: '@gate' },
    async ({ page, request }) => {
      const label = unique();
      await openBackupsSettings(page);
      await fillDestination(page, label);
      await page.click('[data-testid="backup-destination-save"]');
      await page.waitForSelector('[data-testid="backup-destination-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      await page.click('[data-testid="backup-job-add"]');
      await page.waitForSelector('[data-testid="backup-job-form"]', {
        state: 'visible',
        timeout: 15000,
      });
      await page.fill('[data-testid="backup-job-label"]', `${label} restore job`);
      await page.click('[data-testid="backup-job-save"]');
      await page.waitForSelector('[data-testid="backup-job-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      await page.locator('[data-testid^="backup-job-run-"]').first().click();
      await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
        /Backed up/i,
        {
          timeout: 120000,
        },
      );

      // Snapshot live state through the API, then CHANGE it, so the restore has something it
      // could plausibly overwrite. Read through the same BFF the UI uses.
      const before = await (await request.get(`${BASE}/bff-api/collections`)).json();
      const beforeCount = (Array.isArray(before) ? before : (before.items ?? [])).length;

      const added = await request.post(`${BASE}/bff-api/collections`, {
        data: { name: `Mutated ${label}`.slice(0, 50) },
      });
      expect(added.ok()).toBeTruthy();

      await page.reload();
      await page.waitForSelector('[data-testid="settings-backups-screen"]', {
        state: 'visible',
        timeout: 30000,
      });
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await page.waitForSelector('[data-testid="backup-version-list"]', {
        state: 'visible',
        timeout: 30000,
      });
      await page.locator('[data-testid^="backup-version-restore-"]').first().click();

      await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
        /Restored \d+ movies/i,
        {
          timeout: 120000,
        },
      );

      // The collection created AFTER the backup must still be there: a restore adds, it never
      // replaces. This is SC-003 seen from the outside.
      const after = await (await request.get(`${BASE}/bff-api/collections`)).json();
      const afterList = Array.isArray(after) ? after : (after.items ?? []);
      expect(
        afterList.some((c: { name: string }) => c.name.startsWith(`Mutated ${label}`.slice(0, 20))),
      ).toBe(true);
      // And the restore added collections rather than replacing any.
      expect(afterList.length).toBeGreaterThan(beforeCount);
    },
  );

  test(
    'an unreadable version is listed but cannot be restored (US3-AC5)',
    { tag: '@gate' },
    async ({ page }) => {
      // Not asserted by corrupting an object from the browser — nothing in the UI can do that.
      // The integration tier covers the corrupt cases against a real destination; what this
      // asserts is the UI contract: `usable: false` renders as visibly non-restorable rather
      // than silently absent, so a user is never offered a version that will fail.
      await openBackupsSettings(page);
      const unusable = page.locator('[data-testid^="backup-version-unusable-"]');
      if ((await unusable.count()) > 0) {
        const key = (await unusable.first().getAttribute('data-testid'))!.replace(
          'backup-version-unusable-',
          '',
        );
        await expect(page.locator(`[data-testid="backup-version-restore-${key}"]`)).toBeDisabled();
      }
    },
  );
  // ── US4: backups happen without me ───────────────────────────────────────────

  test(
    'a scheduled backup runs unattended and exactly once (SC-005, US4-AC1/AC4)',
    { tag: '@gate' },
    async ({ page, request, browser }) => {
      // THE INSTANT IS SUPPLIED, NEVER WAITED FOR. The job's own `nextRunAt` is read back and
      // handed to the tick as `?now=`, so this asserts the real scheduling path at a real due
      // time without the test sleeping until 03:00. A scheduling test that waits is slow when
      // it passes and flaky when it does not.
      if (TICK_SECRET === '') {
        throw new Error(
          'BACKUP_TICK_SECRET is unset, so the tick route would answer 404 and this test would ' +
            'report a missing route as a broken feature. It lives in .env.local (NOT ' +
            '.env.e2e.local, which is all Playwright loads by itself) — export it, or source ' +
            'frontend/mcm-app/.env.local, before running this spec.',
        );
      }

      const label = unique();
      await openBackupsSettings(page);
      await fillDestination(page, label);
      await page.click('[data-testid="backup-destination-save"]');
      await page.waitForSelector('[data-testid="backup-destination-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      await page.click('[data-testid="backup-job-add"]');
      await page.waitForSelector('[data-testid="backup-job-form"]', {
        state: 'visible',
        timeout: 15000,
      });
      await page.fill('[data-testid="backup-job-label"]', `${label} scheduled`);
      await page.click('[data-testid="backup-job-save"]');
      await page.waitForSelector('[data-testid="backup-job-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      // Open the job so the schedule editor is on screen.
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-schedule-editor"]')).toBeVisible({
        timeout: 20000,
      });

      // CONSENT IS A REAL OIDC ROUND TRIP (FR-022) — the app navigates to Keycloak and comes
      // back through the consent callback. The worker already holds a Keycloak SSO session, so
      // this usually returns without showing a login form; both paths are handled because
      // which one happens depends on state this test does not own.
      // WHO THIS SESSION ACTUALLY IS. Worker 0 reuses the canonical E2E_TEST_USER; workers 1+
      // get their own minted identity. The BFF stores the grant under the SESSION's user, so
      // if a Keycloak login form appears we must sign in as that same person — signing in as
      // someone else would store one user's offline token against another user's id.
      const sessionUser = (await (await request.get(`${BASE}/bff-api/auth/user`)).json()) as {
        username?: string;
      };

      await expect(page.locator('[data-testid="backup-consent-prompt"]')).toBeVisible();
      await page.click('[data-testid="backup-consent-grant"]');

      // Keycloak either passes straight through on the existing SSO session or asks for
      // credentials. Wait for WHICHEVER arrives.
      //
      // `locator.isVisible()` cannot be used for this: it is a NON-RETRYING check that answers
      // immediately, so called right after the click it races the navigation, always reports
      // false, and the login step is silently skipped — which is exactly how this test failed
      // while the page sat on Keycloak's login form for the full 30s poll.
      await page.waitForURL(/localhost:8099|consent=granted/, { timeout: 60000 });

      if (page.url().includes('localhost:8099')) {
        await page.waitForSelector('input[name="username"]', { state: 'visible', timeout: 30000 });
        if (sessionUser.username && sessionUser.username.toLowerCase() !== E2E_USER.toLowerCase()) {
          throw new Error(
            `This worker is signed in as "${sessionUser.username}" but only ${E2E_USER}'s password ` +
              'is available here, and Keycloak asked for credentials rather than reusing the SSO ' +
              "session. Signing in as a different user would store that user's offline token " +
              "against this session's id — failing instead of doing that quietly.",
          );
        }
        await page.fill('input[name="username"]', E2E_USER);
        await page.fill('input[name="password"]', E2E_PASSWORD);
        await page.click('input[type="submit"], button[type="submit"]');
      }

      // The callback's own redirect target, so this cannot match the page we started on.
      await page.waitForURL(/consent=granted/, { timeout: 60000 });
      await expect
        .poll(
          async () => (await (await request.get(`${BASE}/bff-api/backups/consent`)).json()).granted,
          {
            timeout: 30000,
          },
        )
        .toBe(true);

      // Turn scheduling on, now that the permission exists.
      await openBackupsSettings(page);
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-schedule-editor"]')).toBeVisible({
        timeout: 20000,
      });
      // By ROLE, scoped to the editor. The design-system Switch does not forward a testID to
      // the DOM (see the note in schedule-editor.tsx), so a bare testID locator matches nothing
      // and the click times out as if the screen were broken — which is exactly how this read.
      await page.locator('[data-testid="backup-schedule-editor"]').getByRole('switch').click();

      // Read back the instant the SERVER decided this job is next due. Using the server's own
      // answer rather than one the test computes is what makes this a test of the scheduling
      // arithmetic instead of a test of the test's copy of it.
      interface ScheduledJob {
        id: string;
        nextRunAt?: string;
      }
      const scheduledJobOrNull = async (): Promise<ScheduledJob | null> => {
        const jobs = (await (
          await request.get(`${BASE}/bff-api/backups/jobs`)
        ).json()) as ScheduledJob[];
        return (Array.isArray(jobs) ? jobs : []).find((j) => j.nextRunAt) ?? null;
      };
      await expect
        .poll(async () => (await scheduledJobOrNull()) !== null, {
          timeout: 30000,
          message: 'turning the schedule on never produced a nextRunAt on any job',
        })
        .toBe(true);
      const job = (await scheduledJobOrNull())!;

      // EVERY COOKIE CLEARED. Without this the run could be succeeding on the session rather
      // than on the stored permission, and the test would prove nothing about unattended
      // operation — which is the entire point of US4.
      await page.context().clearCookies();
      await expect
        .poll(async () => (await page.context().cookies()).length, { timeout: 10000 })
        .toBe(0);

      // The ticks go through a context with NO storage state and no cookies at all — a
      // deliberately anonymous caller holding nothing but the tick secret.
      const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const tickUrl = `${BASE}/bff-api/backups/tick?now=${encodeURIComponent(job.nextRunAt!)}`;
      const tickOptions = { headers: { 'x-backup-tick-secret': TICK_SECRET }, timeout: 120000 };
      // TWO AT ONCE, standing in for two application instances. Exactly one must claim the job.
      const [a, b] = await Promise.all([
        anonymous.request.post(tickUrl, tickOptions),
        anonymous.request.post(tickUrl, tickOptions),
      ]);
      const bodies = await Promise.all([a.json(), b.json()]);
      await anonymous.close();

      expect(a.status()).toBe(200);
      expect(b.status()).toBe(200);
      // `leader: false` from one of them is a NORMAL outcome, not an error — so the assertion
      // is on the total claimed, not on both reporting success.
      expect(bodies.reduce((n, x) => n + (x.claimed ?? 0), 0)).toBe(1);

      // EXACTLY ONE ARTIFACT. Two would mean the claim did not hold; none would mean the run
      // never happened without a session.
      const versions = await (
        await request.get(`${BASE}/bff-api/backups/jobs/${job.id}/versions`)
      ).json();
      expect(Array.isArray(versions) ? versions.length : 0).toBe(1);
    },
  );
  // ── US5/US6: retention, and a failure you cannot miss ────────────────────────

  test(
    'keep-last-N prunes the oldest version on success (SC-007, US5-AC1)',
    { tag: '@gate' },
    async ({ page, request }) => {
      // WHAT THIS DOES NOT ASSERT, AND WHY. SC-008 — "a failed run prunes nothing" — is not
      // provable through this UI. Every failure inducible from the browser (a bucket that does
      // not exist, a wrong credential, a blocked address) also breaks the DELETE path and the
      // versions listing, so a wrongly-attempted prune would fail for the same reason the run
      // did and the test would pass without discriminating anything. An earlier draft of this
      // case did exactly that. SC-008 is proven in the integration tier instead, at the same
      // destination with working credentials, by inducing the failure with the size ceiling —
      // and verified there by mutation. See backup-runner.integration.test.ts.
      const label = unique();
      await openBackupsSettings(page);
      await fillDestination(page, label);
      await page.click('[data-testid="backup-destination-save"]');
      await page.waitForSelector('[data-testid="backup-destination-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      // keep-last-2, so three runs prove the prune without three times the wait.
      await page.click('[data-testid="backup-job-add"]');
      await page.waitForSelector('[data-testid="backup-job-form"]', {
        state: 'visible',
        timeout: 15000,
      });
      await page.fill('[data-testid="backup-job-label"]', `${label} retention`);
      await page.fill('[data-testid="backup-job-keep-last"]', '2');
      await page.click('[data-testid="backup-job-save"]');
      await page.waitForSelector('[data-testid="backup-job-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      const jobs = (await (await request.get(`${BASE}/bff-api/backups/jobs`)).json()) as {
        id: string;
        label: string;
      }[];
      const jobId = jobs.find((j) => j.label === `${label} retention`)!.id;
      const versionKeys = async (): Promise<string[]> => {
        const body = await (
          await request.get(`${BASE}/bff-api/backups/jobs/${jobId}/versions`)
        ).json();
        // Defensive: a non-array here means the listing errored, and `.map` on it throws a
        // TypeError that hides the real reason. Surface an empty list and let the poll fail
        // on the count instead.
        return Array.isArray(body) ? (body as { key: string }[]).map((v) => v.key).sort() : [];
      };

      // ── EVERY WAIT IN THIS LOOP MUST BE ON SOMETHING THAT CHANGES (item #564). ────────────────
      //
      // Both of the original waits matched the state the PREVIOUS iteration left behind, so on the
      // third run neither waited at all and the assertions below raced the run:
      //
      //   1. the banner reads `Backed up N movies` after EVERY run, so `toContainText` matched run
      //      1's banner the instant run 2 was clicked;
      //   2. the count was polled `.toBe(Math.min(i + 1, 2))`, which is **2 for both i=1 and i=2** —
      //      a ceiling already reached, so the poll returned on its first tick.
      //
      // Measured on run 3980: the two surviving keys were 258ms apart and run 2's key was ABSENT,
      // i.e. the final assertion ran before the third backup existed. Nothing had been pruned
      // because nothing yet needed pruning — the retention code was never implicated.
      let firstKey = '';
      for (let i = 0; i < 3; i += 1) {
        // The key set BEFORE the click is what makes this run distinguishable from the last one.
        const before = new Set(await versionKeys());
        await page.locator(`[data-testid="backup-job-run-${jobId}"]`).click();

        // A COMPOUND fact, because each half alone is satisfiable by the previous iteration's end
        // state on the third run:
        //   fresh — this run wrote a key that was not present before the click. On its own this is
        //           satisfied the instant the third key lands, which is BEFORE the prune.
        //   total — retention has settled back to the ceiling. On its own this is already true at
        //           i=2 before the click, which is fault (2) above.
        // Only the pair pins "this run finished AND retention has run". Polled as one object so a
        // transient where both are momentarily true of different instants cannot slip through.
        await expect
          .poll(
            async () => {
              const keys = await versionKeys();
              return { fresh: keys.filter((k) => !before.has(k)).length, total: keys.length };
            },
            { timeout: 120000 },
          )
          .toEqual({ fresh: 1, total: Math.min(i + 1, 2) });

        // The banner is asserted AFTER that poll, and is deliberately NOT the wait. Its text is
        // identical for every run, so as a wait it sequences nothing — which is how this test broke.
        // It is kept because "the UI told the user" is worth asserting, and moved here so it cannot
        // be mistaken for a wait again. The other run-clicks in this file each do exactly ONE run
        // with no prior banner on screen, so their identical assertions DO wait; this loop was the
        // only place the text's sameness mattered.
        await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
          /Backed up \d+ movies/i,
          { timeout: 30000 },
        );

        if (i === 0) [firstKey] = await versionKeys();
      }

      const remaining = await versionKeys();
      expect(remaining).toHaveLength(2);
      // The one that went is the OLDEST. Asserting the count alone would pass an
      // implementation that deleted the newest, which is the opposite of retention.
      expect(remaining).not.toContain(firstKey);
    },
  );

  test(
    'a failed run is surfaced and STAYS surfaced until a later one succeeds (FR-037)',
    { tag: '@gate' },
    async ({ page }) => {
      const label = unique();
      await openBackupsSettings(page);

      // A destination that saves but cannot be written to, so the run fails for real.
      await page.click('[data-testid="backup-destination-add"]');
      await page.waitForSelector('[data-testid="backup-destination-form"]', {
        state: 'visible',
        timeout: 15000,
      });
      await page.fill('[data-testid="backup-destination-label"]', label);
      await page.fill('[data-testid="backup-destination-endpoint"]', S3_ENDPOINT);
      await page.fill('[data-testid="backup-destination-bucket"]', `absent-${Date.now()}`);
      await page.fill('[data-testid="backup-destination-access-key-id"]', S3_ACCESS_KEY);
      await page.fill('[data-testid="backup-destination-secret"]', S3_SECRET);
      await page.click('[data-testid="backup-destination-save"]');
      await page.waitForSelector('[data-testid="backup-destination-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      await page.click('[data-testid="backup-job-add"]');
      await page.waitForSelector('[data-testid="backup-job-form"]', {
        state: 'visible',
        timeout: 15000,
      });
      await page.fill('[data-testid="backup-job-label"]', `${label} failing`);
      await page.click('[data-testid="backup-job-save"]');
      await page.waitForSelector('[data-testid="backup-job-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      await page.locator('[data-testid^="backup-job-run-"]').first().click();
      await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
        /did not finish/i,
        { timeout: 120000 },
      );

      // Open the job's history: the banner is there with a reason.
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-failure-banner"]')).toBeVisible({
        timeout: 30000,
      });

      // IT SURVIVES A RELOAD. That is the whole of FR-037 — the banner is derived from the
      // newest run, not from dismissable client state, so a user who closes the app and comes
      // back is still told their backups are not working.
      await page.reload();
      await page.waitForSelector('[data-testid="settings-backups-screen"]', {
        state: 'visible',
        timeout: 30000,
      });
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-failure-banner"]')).toBeVisible({
        timeout: 30000,
      });

      // And the next-run line is present, naming the zone rather than a bare time.
      await expect(page.locator('[data-testid="backup-next-run"]')).toContainText(/Not scheduled/i);
    },
  );
});

// ── WebDAV (item #1069) ────────────────────────────────────────────────────────
//
// The S3 group above covers the feature in depth. What it cannot cover is anything WebDAV-specific
// in the UI path: the form's type switch and username field, the probe answering for a WebDAV
// server, and the WebDAV driver's write AND read through a real run and restore. Those are what
// this group asserts — the destination-agnostic contracts (secret never echoed, blocked address,
// restore adds rather than replaces, scheduling, retention, failure surfacing) are not repeated.
//
// Its OWN guard: a stopped WebDAV container skips only these tests, never the S3 ones.
test.describe('Backup destinations — WebDAV (item #1069)', () => {
  guardDestination('webdav');
  registerCleanup();

  test('add, verify and delete a WebDAV destination', { tag: '@gate' }, async ({ page }) => {
    const label = unique();
    await openBackupsSettings(page);

    await fillWebdavDestination(page, label);
    await page.click('[data-testid="backup-destination-save"]');
    await page.waitForSelector('[data-testid="backup-destination-list"]', {
      state: 'visible',
      timeout: 20000,
    });
    await expect(page.getByText(label, { exact: true })).toBeVisible();

    // A real probe against a real WebDAV server, through the saved (stored-secret) path.
    const id = await destinationIdFor(page, label);
    await page.click(`[data-testid="backup-destination-test-${id}"]`);
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toContainText(
      /confirmed it can be written to/i,
      { timeout: 30000 },
    );

    await page.click(`[data-testid="backup-destination-delete-${id}"]`);
    await expect(page.getByText(label, { exact: true })).toHaveCount(0, { timeout: 20000 });
  });

  test(
    'back up to WebDAV, see it in history, and restore from it',
    { tag: '@gate' },
    async ({ page }) => {
      const label = unique();
      await openBackupsSettings(page);
      await fillWebdavDestination(page, label);
      await page.click('[data-testid="backup-destination-save"]');
      await page.waitForSelector('[data-testid="backup-destination-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      await page.click('[data-testid="backup-job-add"]');
      await page.waitForSelector('[data-testid="backup-job-form"]', {
        state: 'visible',
        timeout: 15000,
      });
      await page.fill('[data-testid="backup-job-label"]', `${label} job`);
      await page.click('[data-testid="backup-job-save"]');
      await page.waitForSelector('[data-testid="backup-job-list"]', {
        state: 'visible',
        timeout: 20000,
      });

      // WRITE path: the run uploads the archive over WebDAV.
      await page.locator('[data-testid^="backup-job-run-"]').first().click();
      await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
        /Backed up \d+ movies/i,
        { timeout: 120000 },
      );

      // LIST path: the version is read back from the WebDAV server, not from a local record.
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-version-list"]')).toBeVisible({
        timeout: 30000,
      });
      const restore = page.locator('[data-testid^="backup-version-restore-"]').first();
      await expect(restore).toBeEnabled();

      // READ path: the restore downloads the archive over WebDAV. The created collections carry
      // the `(backup <timestamp>)` suffix, which registerCleanup's afterEach removes.
      await restore.click();
      await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(
        /Restored \d+ movies/i,
        { timeout: 120000 },
      );
    },
  );
});
