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
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

import { E2E_BASE_URL as BASE } from './setup/target';

// T017 (FR-014): post-test teardown via the BFF API (not UI), runs even if a test
// throws. Deletes every collection these tests created so the home-screen list stays
// at the fixture baseline — keeping later tests fast and independent.
test.afterEach(async ({ request }) => {
  await cleanupNonFixtureCollections(request);
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Navigate to the home screen using the session inherited from global setup
 * (Playwright storageState). No login happens here — global setup authenticates
 * once per run (T012, FR-004, SC-001), so each test starts already authenticated.
 *
 * Handles the FR-009 auto-redirect: if /home redirects to the default collection
 * screen, navigate back to /home (home-screen.tsx sets a sessionStorage key so the
 * redirect fires at most once per tab session) so every test starts on the list.
 */
async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);

  // Wait on home-screen-create-button — the FR-009-RESOLVED signal. It renders only after
  // the auto-nav check completes (isFr009Checked) AND collections finish loading. Do NOT wait
  // on home-route: that SafeAreaView wrapper renders immediately (with the loading spinner)
  // BEFORE the FR-009 effect decides, so it races ahead of the redirect — if the user has a
  // default collection, this helper could return on home-route just before FR-009 calls
  // router.replace() to that collection, stranding the test off /home (the create button then
  // never appears → 60 s timeout). With the create-button signal, a default deterministically
  // resolves to 'collection' below and is recovered. 60 s budget covers Metro's cold compile.
  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);

  if (result === 'collection') {
    // FR-009 redirected to the default collection (fires at most once per session via a
    // module flag + localStorage), so a second /home now reveals the list + create button.
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    return;
  }
  if (!result) {
    throw new Error('gotoHome: home screen did not render — is the global-setup session valid?');
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
    timeout: 60000, // cold Metro compile + collections load can exceed 30 s on the first create
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
    await gotoHome(page);
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
    await gotoHome(page);
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
    await gotoHome(page);
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
    await gotoHome(page);
  });

  test('"Set as Default" action adds Default badge to card', async ({ page }) => {
    const name = `Default Test ${Date.now()}`;
    await createCollection(page, name);

    // Tap "Set as Default" on the new card
    await page.click('[data-testid="collection-card-action-set-default"]');

    // Default badge must now be visible on the card
    await expect(page.getByTestId('collection-card-default-badge')).toBeVisible({ timeout: 5000 });
  });

  test('setting new default removes "Default" badge from previously default card', async ({ page }) => {
    // Create two collections so we can transfer the default between them.
    const nameA = `DefaultA ${Date.now()}`;
    const nameB = `DefaultB ${Date.now() + 1}`;
    await createCollection(page, nameA);
    await createCollection(page, nameB);

    // Set collection A as default — use the card with nameA to scope the action
    const cardA = page.locator('[data-testid="collection-card"]', { hasText: nameA });
    const cardB = page.locator('[data-testid="collection-card"]', { hasText: nameB });

    await cardA.getByTestId('collection-card-action-set-default').click();
    await expect(cardA.getByTestId('collection-card-default-badge')).toBeVisible({ timeout: 5000 });

    // Now set collection B as default
    await cardB.getByTestId('collection-card-action-set-default').click();

    // B must gain the Default badge
    await expect(cardB.getByTestId('collection-card-default-badge')).toBeVisible({ timeout: 5000 });

    // A must NO LONGER show the Default badge (the stale-badge bug)
    await expect(cardA.getByTestId('collection-card-default-badge')).not.toBeVisible({ timeout: 5000 });
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
    await gotoHome(page);
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
    await gotoHome(page);
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
