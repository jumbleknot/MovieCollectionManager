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
 * The destination here is the S3 test target on the compose `backups` profile, addressed by the
 * name the BFF CONTAINER can reach it by — the browser never connects to it; the BFF does.
 */
import { test, expect } from './fixtures/worker-session';
import { type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';

const S3_ENDPOINT = process.env['BACKUP_TEST_S3_INTERNAL_ENDPOINT'] ?? 'http://mcm-bff-backup-minio:9000';
const S3_BUCKET = process.env['BACKUP_TEST_S3_BUCKET'] ?? 'mcm-backups-test';
const S3_ACCESS_KEY = process.env['BACKUP_TEST_S3_ACCESS_KEY'] ?? 'mcmbackuptest';
const S3_SECRET = process.env['BACKUP_TEST_S3_SECRET_KEY'] ?? '';

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
  await page.waitForSelector('[data-testid="settings-nav-backups"]', { state: 'visible', timeout: 30000 });
  await page.click('[data-testid="settings-nav-backups"]');
  await page.waitForSelector('[data-testid="settings-backups-screen"]', { state: 'visible', timeout: 30000 });
}

async function fillDestination(page: Page, label: string): Promise<void> {
  await page.click('[data-testid="backup-destination-add"]');
  await page.waitForSelector('[data-testid="backup-destination-form"]', { state: 'visible', timeout: 15000 });
  await page.fill('[data-testid="backup-destination-label"]', label);
  await page.fill('[data-testid="backup-destination-endpoint"]', S3_ENDPOINT);
  await page.fill('[data-testid="backup-destination-bucket"]', S3_BUCKET);
  await page.fill('[data-testid="backup-destination-access-key-id"]', S3_ACCESS_KEY);
  await page.fill('[data-testid="backup-destination-secret"]', S3_SECRET);
}

test.describe('Backup destinations (feature 073)', () => {
  // A missing credential would make every case below fail as the same authentication error,
  // which reads as a broken feature rather than a missing input — so it skips instead.
  //
  // BUT A SKIP READS AS A PASS, and these are `@gate` tests. So the skip is ESCALATABLE, the same
  // way MCM_REQUIRE_LIVE_STACK works for the integration tier: set E2E_REQUIRE_BACKUP_TARGETS=1
  // and a missing target becomes a hard failure instead of a quiet green.
  //
  // WHY THIS MATTERS RIGHT NOW: CI's app-e2e does NOT bring these targets up. The S3 one is
  // `${REGISTRY_HOST}/jumbleknot/minio` — the repository's own from-source image, in the forge
  // registry — and that job has no REGISTRY_HOST and no registry credentials. Until that is
  // wired up (or the S3 target moves to a public image with an acceptable CVE posture), this
  // file SKIPS in CI and proves nothing there. It is verified locally instead. Do not read a
  // green app-e2e as evidence that backups work.
  const targetsMissing = S3_SECRET === '';
  if (targetsMissing && process.env['E2E_REQUIRE_BACKUP_TARGETS'] === '1') {
    throw new Error(
      'E2E_REQUIRE_BACKUP_TARGETS=1 but BACKUP_TEST_S3_SECRET_KEY is unset — the backup ' +
        'destinations are not up. Bring them up with: docker compose -p mcm --env-file ' +
        'infrastructure-as-code/docker/stacks/mcm.env -f ' +
        'infrastructure-as-code/docker/backups/compose.yaml up -d',
    );
  }
  test.skip(
    targetsMissing,
    'BACKUP_TEST_S3_SECRET_KEY is unset — the backup destinations are not up. This is a SKIP, ' +
      'not a pass. Set E2E_REQUIRE_BACKUP_TARGETS=1 to make it a failure.',
  );

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

  test.beforeEach(async ({ request }) => {
    await clearBackupState(request);
  });

  // THE COLLECTIONS THIS FILE CREATES MUST BE REMOVED, and that is not tidiness — it is the
  // difference between a green suite and a broken one three flows later.
  //
  // MEASURED on run 3838. The restore test creates `<name> (backup <timestamp>)` collections and a
  // `Mutated …` one, in the SHARED e2e test account. Left behind, the next mobile flow asked
  // "tell me about Avatar" and the assistant answered:
  //
  //   "Which collection should I add Avatar: Fire and Ash to? You have: E2E Browse, E2E Mutation,
  //    E2E Default, Mutated e2e-17899…, E2E Browse (backup 2026-09-20 19:03), …"
  //
  // — a disambiguation instead of a movie card, so `agent-disambiguation` failed three attempts on
  // a card that never had a title. A test that mutates shared state and does not restore it does
  // not fail itself; it fails something else, later, somewhere that looks unrelated.
  //
  // Matched by NAME because the restore is driven through the UI, so the created ids are not
  // visible to the test. Both patterns are ones only this file produces: `(backup <timestamp>)` is
  // the restore writer's own suffix, and `Mutated e2e-` is this file's mutation fixture.
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

  /** The server-assigned id for a destination, so a locator names ONE row rather than the first. */
  async function destinationIdFor(page: Page, label: string): Promise<string> {
    const list = await (await page.request.get(`${BASE}/bff-api/backups/destinations`)).json();
    const match = (Array.isArray(list) ? list : []).find((d: { label: string }) => d.label === label);
    if (!match) throw new Error(`no destination named ${label} — it was not created`);
    return match.id;
  }

  test('add, verify, edit and delete a destination', { tag: '@gate' }, async ({ page }) => {
    const label = unique();
    await openBackupsSettings(page);

    // ── Add (US1-AC1) ────────────────────────────────────────────────────────
    await fillDestination(page, label);
    await page.click('[data-testid="backup-destination-save"]');
    await page.waitForSelector('[data-testid="backup-destination-list"]', { state: 'visible', timeout: 20000 });
    await expect(page.getByText(label, { exact: true })).toBeVisible();

    // ── Verify (US1-AC2) — a real probe against a real server ────────────────
    const row = page.locator('[data-testid="backup-destination-list"]').getByText(label, { exact: true });
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
    await page.waitForSelector('[data-testid="backup-destination-form"]', { state: 'visible', timeout: 15000 });
    // The secret field is EMPTY on edit — not a row of dots. A masked stand-in would say a
    // credential had been fetched into the page, and none was.
    await expect(page.locator('[data-testid="backup-destination-secret"] input, [data-testid="backup-destination-secret"]')).toHaveValue('');
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

  test('no response carries the stored secret back (US1-AC3)', { tag: '@gate' }, async ({ page }) => {
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
    await page.waitForSelector('[data-testid="backup-destination-list"]', { state: 'visible', timeout: 20000 });
    const id = await destinationIdFor(page, label);
    await page.click(`[data-testid="backup-destination-test-${id}"]`);
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toBeVisible({ timeout: 30000 });

    expect(bodies.length).toBeGreaterThan(0); // a leak check over zero responses proves nothing
    for (const body of bodies) {
      expect(body).not.toContain(S3_SECRET);
      expect(body).not.toContain('secretEnc');
    }

    await page.click(`[data-testid="backup-destination-delete-${id}"]`);
  });

  test('a blocked address is refused with a reason the user can act on (US1-AC4)', { tag: '@gate' }, async ({ page }) => {
    await openBackupsSettings(page);
    await fillDestination(page, unique());
    await page.fill('[data-testid="backup-destination-endpoint"]', 'http://169.254.169.254/');
    await page.click('[data-testid="backup-destination-save"]');

    await expect(page.locator('[data-testid="backup-error-banner"]')).toContainText(/not allowed/i, {
      timeout: 20000,
    });
  });

  // ── US2: take a backup right now ─────────────────────────────────────────────

  test('set up a backup, run it, and see it in history', { tag: '@gate' }, async ({ page }) => {
    const label = unique();
    await openBackupsSettings(page);
    await fillDestination(page, label);
    await page.click('[data-testid="backup-destination-save"]');
    await page.waitForSelector('[data-testid="backup-destination-list"]', { state: 'visible', timeout: 20000 });

    await page.click('[data-testid="backup-job-add"]');
    await page.waitForSelector('[data-testid="backup-job-form"]', { state: 'visible', timeout: 15000 });
    await page.fill('[data-testid="backup-job-label"]', `${label} job`);
    // No collections selected — every collection this user owns, resolved when the backup runs.
    await page.click('[data-testid="backup-job-save"]');
    await page.waitForSelector('[data-testid="backup-job-list"]', { state: 'visible', timeout: 20000 });

    await page.locator('[data-testid^="backup-job-run-"]').first().click();
    await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(/Backed up \d+ movies/i, {
      timeout: 120000,
    });

    // The version the run just wrote is listed at the destination.
    await page.locator('[data-testid^="backup-job-versions-"]').first().click();
    await expect(page.locator('[data-testid="backup-version-list"]')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid^="backup-version-restore-"]').first()).toBeEnabled();
  });

  // ── US3: recover without risking what I have now ─────────────────────────────

  test('back up, change the data, restore, and confirm nothing was overwritten', { tag: '@gate' }, async ({ page, request }) => {
    const label = unique();
    await openBackupsSettings(page);
    await fillDestination(page, label);
    await page.click('[data-testid="backup-destination-save"]');
    await page.waitForSelector('[data-testid="backup-destination-list"]', { state: 'visible', timeout: 20000 });

    await page.click('[data-testid="backup-job-add"]');
    await page.waitForSelector('[data-testid="backup-job-form"]', { state: 'visible', timeout: 15000 });
    await page.fill('[data-testid="backup-job-label"]', `${label} restore job`);
    await page.click('[data-testid="backup-job-save"]');
    await page.waitForSelector('[data-testid="backup-job-list"]', { state: 'visible', timeout: 20000 });

    await page.locator('[data-testid^="backup-job-run-"]').first().click();
    await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(/Backed up/i, {
      timeout: 120000,
    });

    // Snapshot live state through the API, then CHANGE it, so the restore has something it
    // could plausibly overwrite. Read through the same BFF the UI uses.
    const before = await (await request.get(`${BASE}/bff-api/collections`)).json();
    const beforeCount = (Array.isArray(before) ? before : before.items ?? []).length;

    const added = await request.post(`${BASE}/bff-api/collections`, {
      data: { name: `Mutated ${label}`.slice(0, 50) },
    });
    expect(added.ok()).toBeTruthy();

    await page.reload();
    await page.waitForSelector('[data-testid="settings-backups-screen"]', { state: 'visible', timeout: 30000 });
    await page.locator('[data-testid^="backup-job-versions-"]').first().click();
    await page.waitForSelector('[data-testid="backup-version-list"]', { state: 'visible', timeout: 30000 });
    await page.locator('[data-testid^="backup-version-restore-"]').first().click();

    await expect(page.locator('[data-testid="backup-notice-banner"]')).toContainText(/Restored \d+ movies/i, {
      timeout: 120000,
    });

    // The collection created AFTER the backup must still be there: a restore adds, it never
    // replaces. This is SC-003 seen from the outside.
    const after = await (await request.get(`${BASE}/bff-api/collections`)).json();
    const afterList = Array.isArray(after) ? after : after.items ?? [];
    expect(afterList.some((c: { name: string }) => c.name.startsWith(`Mutated ${label}`.slice(0, 20)))).toBe(true);
    // And the restore added collections rather than replacing any.
    expect(afterList.length).toBeGreaterThan(beforeCount);
  });

  test('an unreadable version is listed but cannot be restored (US3-AC5)', { tag: '@gate' }, async ({ page }) => {
    // Not asserted by corrupting an object from the browser — nothing in the UI can do that.
    // The integration tier covers the corrupt cases against a real destination; what this
    // asserts is the UI contract: `usable: false` renders as visibly non-restorable rather
    // than silently absent, so a user is never offered a version that will fail.
    await openBackupsSettings(page);
    const unusable = page.locator('[data-testid^="backup-version-unusable-"]');
    if ((await unusable.count()) > 0) {
      const key = (await unusable.first().getAttribute('data-testid'))!.replace('backup-version-unusable-', '');
      await expect(page.locator(`[data-testid="backup-version-restore-${key}"]`)).toBeDisabled();
    }
  });
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
      await page.waitForSelector('[data-testid="backup-destination-list"]', { state: 'visible', timeout: 20000 });

      await page.click('[data-testid="backup-job-add"]');
      await page.waitForSelector('[data-testid="backup-job-form"]', { state: 'visible', timeout: 15000 });
      await page.fill('[data-testid="backup-job-label"]', `${label} scheduled`);
      await page.click('[data-testid="backup-job-save"]');
      await page.waitForSelector('[data-testid="backup-job-list"]', { state: 'visible', timeout: 20000 });

      // Open the job so the schedule editor is on screen.
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-schedule-editor"]')).toBeVisible({ timeout: 20000 });

      // CONSENT IS A REAL OIDC ROUND TRIP (FR-022) — the app navigates to Keycloak and comes
      // back through the consent callback. The worker already holds a Keycloak SSO session, so
      // this usually returns without showing a login form; both paths are handled because
      // which one happens depends on state this test does not own.
      await expect(page.locator('[data-testid="backup-consent-prompt"]')).toBeVisible();
      await page.click('[data-testid="backup-consent-grant"]');
      const loginField = page.locator('input[name="username"]');
      if (await loginField.isVisible({ timeout: 8000 }).catch(() => false)) {
        await loginField.fill(E2E_USER);
        await page.fill('input[name="password"]', E2E_PASSWORD);
        await page.click('input[type="submit"], button[type="submit"]');
      }
      await page.waitForURL(/\/settings\/backups/, { timeout: 60000 });
      await expect
        .poll(async () => (await (await request.get(`${BASE}/bff-api/backups/consent`)).json()).granted, {
          timeout: 30000,
        })
        .toBe(true);

      // Turn scheduling on, now that the permission exists.
      await openBackupsSettings(page);
      await page.locator('[data-testid^="backup-job-versions-"]').first().click();
      await expect(page.locator('[data-testid="backup-schedule-editor"]')).toBeVisible({ timeout: 20000 });
      await page.click('[data-testid="backup-schedule-enabled"]');

      // Read back the instant the SERVER decided this job is next due. Using the server's own
      // answer rather than one the test computes is what makes this a test of the scheduling
      // arithmetic instead of a test of the test's copy of it.
      interface ScheduledJob {
        id: string;
        nextRunAt?: string;
      }
      const scheduledJobOrNull = async (): Promise<ScheduledJob | null> => {
        const jobs = (await (await request.get(`${BASE}/bff-api/backups/jobs`)).json()) as ScheduledJob[];
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
});
