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
 *   6.  Browse: "My Collections" nav link refreshes collection list (no error after nav-back)
 *   7.  Default: "Set as Default" adds default badge to card
 *   8.  Duplicate: same name → error message shown (mc-service 409 surfaced in UI)
 *   9.  Edit: tapping Edit opens modal pre-filled with current name (RED — stub)
 *   10. Edit: save updates collection name in list (RED — stub)
 *   11. Delete: cancel keeps the collection (RED — no confirmation dialog yet)
 *   12. Delete: confirm removes collection from list (RED — no confirmation dialog yet)
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
  // Navigate to /home and accept either home-route (no default collection) or
  // collection-screen-add-movie (FR-009 auto-redirect to default collection).
  // home-screen.tsx uses sessionStorage on web to prevent the redirect from firing
  // more than once per browser tab session, so a second goto('/home') after detecting
  // the collection screen will land stably on home-route.
  await page.goto(`${BASE}/home`);

  const fastResult = await Promise.race([
    page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 20000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 20000 }).then(() => 'collection' as const),
  ]).catch(() => null);

  if (fastResult === 'collection') {
    // FR-009 redirected us. The sessionStorage key is now set, so navigating back
    // to /home will not trigger the redirect again.
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 30000 });
    return;
  }
  if (fastResult === 'home') {
    return;
  }

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

  // Accept either home-route or collection screen (FR-009 may fire during OIDC).
  // 60s budget: BFF/Keycloak is under more load after many tests have run.
  const slowResult = await Promise.race([
    page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);

  if (!slowResult) {
    throw new Error('Login failed: could not verify authenticated state after OIDC flow');
  }

  if (slowResult === 'collection') {
    // FR-009 redirected; sessionStorage key is now set — navigate back to home.
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 30000 });
  }
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

    // Click the Open action on the specific newly-created card.
    // The outer card wrapper is not a button role (to avoid nested-button HTML error),
    // so we scope to it by testID + text and then find the inner action button.
    const card = page.locator('[data-testid="collection-card"]', { hasText: name });
    await card.getByTestId('collection-card-action-open').click();

    // Collection screen renders with Add Movie FAB
    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('movie-search-input')).toBeVisible();
  });

  test('"My Collections" nav link shows collection list without error after navigating from a collection screen', async ({ page }) => {
    // This test exercises the useFocusEffect fix in home-screen.tsx.
    // Previously, navigating back to home via the nav bar would NOT call refresh(),
    // so if the collections hook had an error from a prior failed fetch (or stale
    // state), the user would see "Failed to load collections".
    const name = `Nav Refresh Test ${Date.now()}`;
    await createCollection(page, name);

    // Open the collection screen
    const card = page.locator('[data-testid="collection-card"]', { hasText: name });
    await card.getByTestId('collection-card-action-open').click();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // Navigate back to home via the "My Collections" nav bar link.
    // Note: on web the Stack navigator keeps all routes mounted, so there may be
    // two home-screen instances in the DOM (old background + new foreground).
    // We scope all assertions to the LAST home-route (the foreground instance)
    // to avoid Playwright picking the background (hidden) one.
    await page.click('[data-testid="nav-home"]');
    const homeScreen = page.locator('[data-testid="home-route"]').last();
    // Wait for create-button — it only appears when isLoading=false
    await homeScreen.locator('[data-testid="home-screen-create-button"]').waitFor({ state: 'visible', timeout: 15000 });

    // No error banner on the foreground home-screen
    await expect(homeScreen.locator('[data-testid="home-screen-error"]')).not.toBeVisible({ timeout: 3000 });

    // Collection list visible in the foreground home-screen.
    // We created a collection so the list (not empty state) must appear.
    // Avoid comma CSS selector: Playwright evaluates 'A, B' across all matching
    // parents when chained from a .last() locator, finding one element from each
    // home-route instance — then .first() picks the hidden background one.
    await homeScreen
      .locator('[data-testid="collection-list"]')
      .waitFor({ state: 'visible', timeout: 10000 });

    // The collection we created must appear in the list
    await expect(homeScreen.getByText(name)).toBeVisible({ timeout: 5000 });
  });

  test('tapping a collection card navigates to collection screen', async ({ page }) => {
    const name = `Card Tap Test ${Date.now()}`;
    await createCollection(page, name);

    // Click the specific card for the just-created collection (avoids strict mode
    // violation when multiple collection cards exist from previous test runs).
    // The outer card wrapper is not a button role (to avoid nested-button HTML error),
    // so we scope by testID + collection name text.
    await page.locator('[data-testid="collection-card"]', { hasText: name }).click();

    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible({ timeout: 10000 });
  });
});

// ─── FR-009: auto-redirect fires only once per session ────────────────────────

test.describe('FR-009 auto-navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('"My Collections" nav link shows collection list — not auto-redirected to default collection again', async ({ page }) => {
    // After login, FR-009 may have already redirected to the default collection.
    // Clicking "My Collections" should always land on the collection list (home-route),
    // never re-trigger the redirect a second time.
    await page.click('[data-testid="nav-home"]');

    // Must arrive at home-route (collection list), not the collection screen.
    await page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 15000 });
    await expect(page.getByTestId('home-route')).toBeVisible();

    // Should NOT immediately redirect away to a collection screen.
    // Give 3 s for any erroneous redirect to fire — if it fires, the test fails.
    const redirected = await page
      .waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    expect(redirected).toBe(false);
  });

  test('navigation bar link is labelled "My Collections"', async ({ page }) => {
    const navLink = page.getByTestId('nav-home');
    await expect(navLink).toBeVisible();
    await expect(navLink).toHaveText('My Collections');
  });

  test('FR-009 fires on login: redirects to default collection when one is set', async ({ page }) => {
    // Create a collection and mark it as default so FR-009 has something to redirect to.
    // (If the user already has a default collection this also verifies the redirect fired.)
    const name = `FR009 Test ${Date.now()}`;
    await createCollection(page, name);
    await page.click('[data-testid="collection-card-action-set-default"]');
    await expect(page.getByTestId('collection-card-default-badge')).toBeVisible({ timeout: 5000 });

    // Clear sessionStorage FR-009 flag to simulate a fresh login in the same tab.
    // In production this happens naturally on each new browser tab / browser restart.
    await page.evaluate(() => sessionStorage.removeItem('mcm_auto_nav_done'));

    // Navigate to /home — FR-009 should redirect to the default collection.
    await page.goto(`${BASE}/home`);

    // Wait for the collection screen to appear (FR-009 redirect fired).
    // We do NOT race against home-route here: home-route renders immediately on
    // mount (while collections are still loading), so it would always win a race
    // against collection-screen-add-movie, giving a false 'home' result even when
    // FR-009 is working correctly. Waiting only for collection-screen-add-movie
    // with a generous timeout is the correct, race-free assertion.
    const onCollectionScreen = await page
      .waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    expect(onCollectionScreen).toBe(true);
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
