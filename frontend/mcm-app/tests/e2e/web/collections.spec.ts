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
 *
 * expo-web-browser opens the Keycloak auth page in a popup (window.open).
 * Playwright must capture the popup, fill credentials there, wait for the popup
 * to close (auth-callback.tsx posts the code back via postMessage), then wait
 * for the main page to complete the code exchange and render home-route.
 */
async function login(page: Page): Promise<void> {
  // Fast path: navigate directly to /home. If the BFF session cookie is still
  // valid (typical for subsequent tests in the same run), the home screen loads
  // immediately without needing a Keycloak popup round-trip. This avoids a race
  // condition where the login route's auto-redirect to /home (because isAuthenticated
  // is already true) competes with the Keycloak popup click timing.
  //
  // Sentinel: home-route (testID on HomeScreen's SafeAreaView) — appears as soon
  // as AuthGuard confirms auth, independently of useCollections.isLoading. Using
  // home-screen-create-button as the sentinel causes intermittent 30s timeouts when
  // many collection cards have accumulated and the BFF fetch takes longer.
  await page.goto(`${BASE}/home`);
  const alreadyHome = await page
    .waitForSelector('[data-testid="home-route"]', {
      state: 'visible',
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false);
  if (alreadyHome) return;

  // Slow path: no active session — go through the full Keycloak OIDC flow.
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15000 });

  // Keycloak opens in a popup — capture it before clicking so we don't miss it
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 15000 }),
    page.click('[data-testid="btn-login-with-keycloak"]'),
  ]);

  // Fill credentials (may be skipped if SSO session is active and popup closes first)
  try {
    await popup.waitForSelector('input[name="username"]', { timeout: 10000 });
    await popup.fill('input[name="username"]', process.env['E2E_TEST_USER'] ?? 'testuser');
    await popup.fill('input[name="password"]', process.env['E2E_TEST_PASSWORD'] ?? 'TestPass1!ok');
    await popup.press('input[name="password"]', 'Enter');
  } catch {
    // SSO session active — popup closed before login form appeared
  }

  // auth-callback.tsx calls maybeCompleteAuthSession() which closes the popup
  await popup.waitForEvent('close', { timeout: 20000 }).catch(() => {});

  // Wait for the in-app navigation then reload for a fresh Expo Router render.
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await page.goto(`${BASE}/home`);

  // Wait for home-route — appears as soon as AuthGuard confirms auth, before
  // useCollections finishes loading. 60s budget matches movies.spec.ts — needed
  // when multiple spec-file workers run concurrently and BFF/Keycloak is under load.
  await page.waitForSelector('[data-testid="home-route"]', {
    state: 'visible',
    timeout: 60000,
  });
}

/**
 * Open the create-collection modal and fill in the name (and optional description).
 * Waits for the create button first — login() only waits for auth (home-route),
 * not for useCollections to finish loading (which reveals the button).
 */
async function openCreateForm(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="home-screen-create-button"]', {
    state: 'visible',
    timeout: 30000,
  });
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
  // Wait for the create modal to fully close before continuing — without this,
  // the modal close animation overlaps with the next action (e.g. clicking edit),
  // leaving two collection-form-name-input elements visible simultaneously.
  await expect(page.getByTestId('home-screen-create-modal')).not.toBeVisible({ timeout: 10000 });
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
    // Use .first() because multiple collection cards accumulate across test runs
    await expect(page.getByTestId('collection-card').first()).toBeVisible();
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
    // Either the list (≥1 collection) or the empty state must be present.
    // login() already waits for home-screen-create-button (meaning isLoading=false),
    // so the CollectionList has rendered — use waitForSelector to be safe.
    await page.waitForSelector(
      '[data-testid="collection-list"], [data-testid="collection-list-empty-state"]',
      { timeout: 5000 },
    );
  });

  test('"Open" action navigates to collection screen', async ({ page }) => {
    const name = `Open Test ${Date.now()}`;
    await createCollection(page, name);

    // Click the Open action on the specific newly-created card
    const card = page.getByRole('button', { name: `Open collection ${name}` });
    await card.locator('[data-testid="collection-card-action-open"]').click();

    // Collection screen renders with Add Movie FAB
    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('movie-search-input')).toBeVisible();
  });

  test('tapping a collection card navigates to collection screen', async ({ page }) => {
    const name = `Card Tap Test ${Date.now()}`;
    await createCollection(page, name);

    // Click the specific card for the just-created collection (avoids strict mode
    // violation when multiple collection cards exist from previous test runs)
    await page.getByRole('button', { name: `Open collection ${name}` }).click();

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

    // Target the specific card — many old "Edit Me" cards accumulate across test runs;
    // using a plain click('[data-testid="collection-card-action-edit"]') hits the first
    // (oldest) card, not the one we just created.
    const card = page.locator('[data-testid="collection-card"]', { hasText: originalName });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.getByTestId('collection-card-action-edit').click();

    await expect(page.getByTestId('home-screen-edit-modal')).toBeVisible({ timeout: 5000 });

    // Name input should be pre-filled with the existing name
    await expect(page.getByTestId('collection-form-name-input')).toHaveValue(originalName);
  });

  test('save changes updates collection name in list', async ({ page }) => {
    const originalName = `Edit Save ${Date.now()}`;
    const updatedName = `Edited Name ${Date.now()}`;
    await createCollection(page, originalName);

    // Target the specific card by name
    const card = page.locator('[data-testid="collection-card"]', { hasText: originalName });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.getByTestId('collection-card-action-edit').click();

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

    // Target the specific card by name
    const card = page.locator('[data-testid="collection-card"]', { hasText: originalName });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.getByTestId('collection-card-action-edit').click();

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
