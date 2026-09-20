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
import { type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';

const S3_ENDPOINT = process.env['BACKUP_TEST_S3_INTERNAL_ENDPOINT'] ?? 'http://mcm-backup-test-minio:9000';
const S3_BUCKET = process.env['BACKUP_TEST_S3_BUCKET'] ?? 'mcm-backups-test';
const S3_ACCESS_KEY = process.env['BACKUP_TEST_S3_ACCESS_KEY'] ?? 'mcmbackuptest';
const S3_SECRET = process.env['BACKUP_TEST_S3_SECRET_KEY'] ?? '';

const unique = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

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
  // A missing secret would make every case below fail as the same authentication error, which
  // reads as a broken feature rather than a missing input.
  test.skip(S3_SECRET === '', 'BACKUP_TEST_S3_SECRET_KEY is not set — bring up the `backups` profile.');

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
    const testButton = page.locator('[data-testid^="backup-destination-test-"]').first();
    await testButton.click();
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toContainText(
      /confirmed it can be written to/i,
      { timeout: 30000 },
    );

    // ── Edit, WITHOUT retyping the secret (US1-AC3 / FR-003) ─────────────────
    const renamed = `${label}-renamed`;
    await page.locator('[data-testid^="backup-destination-edit-"]').first().click();
    await page.waitForSelector('[data-testid="backup-destination-form"]', { state: 'visible', timeout: 15000 });
    // The secret field is EMPTY on edit — not a row of dots. A masked stand-in would say a
    // credential had been fetched into the page, and none was.
    await expect(page.locator('[data-testid="backup-destination-secret"] input, [data-testid="backup-destination-secret"]')).toHaveValue('');
    await page.fill('[data-testid="backup-destination-label"]', renamed);
    await page.click('[data-testid="backup-destination-save"]');
    await expect(page.getByText(renamed, { exact: true })).toBeVisible({ timeout: 20000 });

    // Still verifiable, which proves the stored credential survived an update that omitted it.
    await page.locator('[data-testid^="backup-destination-test-"]').first().click();
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toContainText(
      /confirmed it can be written to/i,
      { timeout: 30000 },
    );

    // ── Delete ───────────────────────────────────────────────────────────────
    await page.locator('[data-testid^="backup-destination-delete-"]').first().click();
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
    await page.locator('[data-testid^="backup-destination-test-"]').first().click();
    await expect(page.locator('[data-testid="backup-destination-test-result"]')).toBeVisible({ timeout: 30000 });

    expect(bodies.length).toBeGreaterThan(0); // a leak check over zero responses proves nothing
    for (const body of bodies) {
      expect(body).not.toContain(S3_SECRET);
      expect(body).not.toContain('secretEnc');
    }

    await page.locator('[data-testid^="backup-destination-delete-"]').first().click();
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
});
