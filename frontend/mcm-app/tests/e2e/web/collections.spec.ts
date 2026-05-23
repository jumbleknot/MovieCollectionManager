/**
 * T066 (web E2E): Collection management flows via Playwright.
 * T067 (web E2E): Collection create/browse/edit/delete — GREEN verification.
 *
 * Requires full stack: Keycloak + BFF + mc-service + MongoDB + Expo web server.
 * Run: pnpm nx e2e mcm-app
 *
 * Test scenarios (T066):
 *   1.  Create: valid name → card appears in collection list
 *   2.  Create: empty name → inline validation error shown; form stays open
 *   3.  Create: cancel → modal closes, collection not created
 *   4.  Browse: collection list renders after login
 *   5.  Browse: "Open" action navigates to collection screen (movie list)
 *   6.  Default: "Set as Default" adds default badge to card
 *   7.  Duplicate: same name → error message shown (mc-service 409 surfaced in UI)
 *   8.  Edit: tapping Edit opens modal pre-filled with current name (RED — stub)
 *   9.  Edit: save updates collection name in list (RED — stub)
 *   10. Delete: cancel keeps the collection (RED — no confirmation dialog yet)
 *   11. Delete: confirm removes collection from list (RED — no confirmation dialog yet)
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:8081';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Log in via Keycloak OIDC and wait for the home screen.
 * Falls through the SSO redirect if an active SSO session exists.
 */
async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15000 });
  await page.click('[data-testid="btn-login-with-keycloak"]');

  // Wait for either the home screen (SSO) or the Keycloak form (no SSO)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="home-route"]') !== null ||
      document.body.innerText.includes('Username or email'),
    { timeout: 30000 },
  );

  if (await page.$('text=Username or email')) {
    await page.fill('input[name="username"]', process.env.E2E_TEST_USER ?? 'testuser');
    await page.fill('input[name="password"]', process.env.E2E_TEST_PASSWORD ?? 'TestPass1!ok');
    await page.press('input[name="password"]', 'Enter');
  }

  await page.waitForSelector('[data-testid="home-route"]', { timeout: 30000 });
}

/**
 * Open the create-collection modal and fill in the name (and optional description).
 */
async function openCreateForm(page: Page): Promise<void> {
  await page.click('[data-testid="home-screen-create-button"]');
  await page.waitForSelector('[data-testid="home-screen-create-modal"]', { timeout: 5000 });
}

async function createCollection(
  page: Page,
  name: string,
  description?: string,
): Promise<void> {
  await openCreateForm(page);
  await page.fill('[data-testid="collection-form-name-input"]', name);
  if (description) {
    await page.fill('[data-testid="collection-form-description-input"]', description);
  }
  await page.click('[data-testid="collection-form-submit-button"]');
  // Wait for modal to close and list to appear
  await page.waitForSelector('[data-testid="collection-list"]', { timeout: 10000 });
}

// ─── Create scenarios ──────────────────────────────────────────────────────────

test.describe('Collection create', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('valid name → card appears in collection list', async ({ page }) => {
    const name = `Web E2E Collection ${Date.now()}`;
    await createCollection(page, name);
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('collection-card')).toBeVisible();
  });

  test('empty name → inline validation error; form stays open', async ({ page }) => {
    await openCreateForm(page);

    // Submit without entering a name
    await page.click('[data-testid="collection-form-submit-button"]');

    // Inline error on name field
    await expect(page.getByTestId('collection-form-name-error')).toBeVisible({ timeout: 5000 });

    // Modal is still open (form did not close)
    await expect(page.getByTestId('collection-form-name-input')).toBeVisible();
  });

  test('cancel → modal closes without creating collection', async ({ page }) => {
    const name = `Cancelled Collection ${Date.now()}`;
    await openCreateForm(page);
    await page.fill('[data-testid="collection-form-name-input"]', name);
    await page.click('[data-testid="collection-form-cancel-button"]');

    // Modal must close
    await expect(page.getByTestId('home-screen-create-modal')).not.toBeVisible({ timeout: 5000 });

    // Collection must NOT appear
    await expect(page.getByText(name)).not.toBeVisible();
  });

  test('duplicate name → error message shown in UI', async ({ page }) => {
    const name = `Duplicate Test ${Date.now()}`;

    // Create first
    await createCollection(page, name);
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });

    // Attempt duplicate
    await openCreateForm(page);
    await page.fill('[data-testid="collection-form-name-input"]', name);
    await page.click('[data-testid="collection-form-submit-button"]');

    // Error banner should surface the 409 from mc-service
    await expect(page.getByTestId('home-screen-error')).toBeVisible({ timeout: 10000 });
  });
});

// ─── Browse scenarios ──────────────────────────────────────────────────────────

test.describe('Collection browse', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('home screen shows collection list or empty state after login', async ({ page }) => {
    // Either the list (≥1 collection) or the empty state must be present
    const listOrEmpty = await page.$(
      '[data-testid="collection-list"], [data-testid="collection-list-empty-state"]',
    );
    expect(listOrEmpty).not.toBeNull();
  });

  test('"Open" action navigates to collection screen', async ({ page }) => {
    const name = `Open Test ${Date.now()}`;
    await createCollection(page, name);

    // Click the Open action on the new card
    await page.click('[data-testid="collection-card-action-open"]');

    // Collection screen renders with Add Movie FAB
    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('movie-search-input')).toBeVisible();
  });

  test('tapping a collection card navigates to collection screen', async ({ page }) => {
    const name = `Card Tap Test ${Date.now()}`;
    await createCollection(page, name);

    await page.click('[data-testid="collection-card"]');

    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible({ timeout: 10000 });
  });
});

// ─── Default collection scenarios ─────────────────────────────────────────────

test.describe('Set as default', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('"Set as Default" action adds Default badge to card', async ({ page }) => {
    const name = `Default Test ${Date.now()}`;
    await createCollection(page, name);

    // Tap "Set as Default" on the new card
    await page.click('[data-testid="collection-card-action-set-default"]');

    // Default badge must now be visible on the card
    await expect(page.getByTestId('collection-card-default-badge')).toBeVisible({ timeout: 5000 });
  });
});

// ─── Edit scenarios (RED — edit modal not yet wired in HomeScreen) ─────────────

test.describe('Collection edit (RED — stub implementation)', () => {
  /**
   * NOTE: These tests are RED until the edit modal is wired into HomeScreen.
   * handleEdit is a no-op stub in home-screen.tsx as of this writing.
   * They define the required behaviour and will pass once the modal is implemented.
   */

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Edit action opens modal pre-filled with current collection name', async ({ page }) => {
    const originalName = `Edit Me ${Date.now()}`;
    await createCollection(page, originalName);

    await page.click('[data-testid="collection-card-action-edit"]');

    // RED: edit modal does not exist yet
    await expect(page.getByTestId('home-screen-edit-modal')).toBeVisible({ timeout: 5000 });

    // Name input should be pre-filled with the existing name
    await expect(page.getByTestId('collection-form-name-input')).toHaveValue(originalName);
  });

  test('save changes updates collection name in list', async ({ page }) => {
    const originalName = `Edit Save ${Date.now()}`;
    const updatedName = `Edited Name ${Date.now()}`;
    await createCollection(page, originalName);

    await page.click('[data-testid="collection-card-action-edit"]');

    // RED: edit modal does not exist yet
    await page.waitForSelector('[data-testid="home-screen-edit-modal"]', { timeout: 5000 });

    await page.fill('[data-testid="collection-form-name-input"]', updatedName);
    await page.click('[data-testid="collection-form-submit-button"]');

    // Updated name appears in list
    await expect(page.getByText(updatedName)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(originalName)).not.toBeVisible();
  });

  test('cancel edit leaves name unchanged', async ({ page }) => {
    const originalName = `No Change ${Date.now()}`;
    await createCollection(page, originalName);

    await page.click('[data-testid="collection-card-action-edit"]');

    // RED: edit modal does not exist yet
    await page.waitForSelector('[data-testid="home-screen-edit-modal"]', { timeout: 5000 });

    // Type something but cancel
    await page.fill('[data-testid="collection-form-name-input"]', 'Cancelled Edit');
    await page.click('[data-testid="collection-form-cancel-button"]');

    // Modal must close; original name is still visible
    await expect(page.getByTestId('home-screen-edit-modal')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(originalName)).toBeVisible();
    await expect(page.getByText('Cancelled Edit')).not.toBeVisible();
  });
});

// ─── Delete scenarios (RED — confirmation dialog not yet wired in HomeScreen) ──

test.describe('Collection delete (RED — dialog not wired)', () => {
  /**
   * NOTE: These tests are RED until DeleteConfirmationDialog is wired into HomeScreen.
   * Currently the Delete action calls deleteCollection directly without a dialog.
   * They define the required behaviour (guard before destructive action).
   */

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Delete action shows confirmation dialog', async ({ page }) => {
    const name = `Dialog Test ${Date.now()}`;
    await createCollection(page, name);

    await page.click('[data-testid="collection-card-action-delete"]');

    // RED: confirmation dialog not yet wired
    await expect(page.getByTestId('delete-dialog')).toBeVisible({ timeout: 5000 });
  });

  test('cancel delete — collection remains in list', async ({ page }) => {
    const name = `Keep Me ${Date.now()}`;
    await createCollection(page, name);

    await page.click('[data-testid="collection-card-action-delete"]');

    // RED: confirmation dialog not yet wired
    await page.waitForSelector('[data-testid="delete-dialog"]', { timeout: 5000 });

    await page.click('[data-testid="delete-dialog-cancel-button"]');

    // Dialog closes; collection is still present
    await expect(page.getByTestId('delete-dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).toBeVisible();
  });

  test('confirm delete — collection removed from list', async ({ page }) => {
    // Create two collections so we can verify only one is deleted
    const keepName = `Keep Test ${Date.now()}`;
    const deleteName = `Delete Test ${Date.now()}`;
    await createCollection(page, keepName);
    await createCollection(page, deleteName);

    // Click Delete on the second card
    // Playwright can't target a specific card by adjacent text easily in a list,
    // so we use locator chaining to find the card containing deleteName's text.
    const deleteCard = page.locator('[data-testid="collection-card"]', { hasText: deleteName });
    await deleteCard.getByTestId('collection-card-action-delete').click();

    // RED: confirmation dialog not yet wired
    await page.waitForSelector('[data-testid="delete-dialog"]', { timeout: 5000 });

    await page.click('[data-testid="delete-dialog-confirm-button"]');

    // Deleted collection gone; kept collection still present
    await expect(page.getByText(deleteName)).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(keepName)).toBeVisible();
  });
});
