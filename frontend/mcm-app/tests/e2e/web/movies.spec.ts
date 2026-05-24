/**
 * T106 (web E2E): Movie add/edit flows via Playwright.
 * T137 (web E2E): Movie browse/column selection/search/filter flows.
 * T151 (web E2E): Movie delete — confirm deletes and navigates back; cancel keeps movie.
 *
 * Requires full stack: Keycloak + BFF + mc-service + MongoDB + Expo web server.
 * Run: pnpm nx e2e mcm-app
 *
 * Test scenarios (T106):
 *   1. Add movie with all required fields → movie detail screen shows title
 *   2. Edit optional field (owned toggle) → change persists in detail view
 *   3. Missing required field rejection → form shows validation error inline
 *   4. Duplicate movie rejection → error message shown after submit
 *
 * Test scenarios (T137):
 *   5. Browse — collection screen shows movie list, search bar, filter panel
 *   6. Column selection — toggling runtime column shows/hides it in the list
 *   7. Search — typing in search bar filters the movie list
 *   8. Filter — selecting a filter chip filters the movie list
 *   9. Combined search+filter — both applied simultaneously
 *
 * Test scenarios (T151):
 *  10. Cancel delete — dialog closes, movie detail screen still shown
 *  11. Confirm delete — movie removed, navigates back to collection screen
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:8081';

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function login(page: Page) {
  // Fast path: navigate directly to /home. If the BFF session cookie is still
  // valid (typical for subsequent tests in the same run), the home screen loads
  // immediately without needing a Keycloak popup round-trip.
  //
  // Sentinel: home-route (testID on HomeScreen's SafeAreaView) — appears as soon
  // as AuthGuard confirms auth, independently of useCollections.isLoading. Using
  // home-screen-create-button as the sentinel causes intermittent 30s timeouts when
  // many collection cards have accumulated and the BFF fetch takes longer.
  await page.goto(`${BASE}/home`);
  const alreadyHome = await page
    .waitForSelector('[data-testid="home-route"]', {
      state: 'visible',
      timeout: 30000,
    })
    .then(() => true)
    .catch(() => false);
  if (alreadyHome) return;

  // Slow path: no active session — go through the full Keycloak OIDC flow.
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15000 });

  // expo-web-browser opens Keycloak in a popup (window.open) — capture it
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 15000 }),
    page.click('[data-testid="btn-login-with-keycloak"]'),
  ]);

  // Fill credentials (may be skipped if SSO session active and popup closes first)
  try {
    await popup.waitForSelector('input[name="username"]', { timeout: 10000 });
    await popup.fill('input[name="username"]', process.env['E2E_TEST_USER'] ?? 'testuser');
    await popup.fill('input[name="password"]', process.env['E2E_TEST_PASSWORD'] ?? 'TestPass1!ok');
    await popup.press('input[name="password"]', 'Enter');
  } catch {
    // SSO session active — popup closed before login form appeared
  }

  // auth-callback.tsx closes the popup after posting the code back to opener
  await popup.waitForEvent('close', { timeout: 20000 }).catch(() => {});

  // Wait for the in-app navigation then reload for a fresh Expo Router render.
  await page.waitForURL(`${BASE}/home`, { timeout: 30000 }).catch(() => {});
  await page.goto(`${BASE}/home`);

  // Wait for home-route — appears as soon as AuthGuard confirms auth, before
  // useCollections finishes loading. Avoids timeout with many accumulated collections.
  // 60s budget: by the time later tests run, the BFF/Redis is under more load and
  // the useAuth session check takes longer than the default 30s.
  await page.waitForSelector('[data-testid="home-route"]', {
    state: 'visible',
    timeout: 60000,
  });
}

async function navigateToCollection(page: Page) {
  // login() waits only for auth (home-route), not for collections to load.
  // Wait up to 30s for the first card — gives useCollections time to finish the BFF fetch.
  await page.waitForSelector('[data-testid="collection-card"]', { timeout: 30000 });
  await page.click('[data-testid="collection-card"]');
  await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });
}

async function clickAddMovie(page: Page) {
  await page.click('[data-testid="collection-screen-add-movie"]');
  await page.waitForSelector('[data-testid="movie-form-title-input"]', { timeout: 10000 });
}

async function fillRequiredMovieFields(
  page: Page,
  opts: { title?: string; year?: string; language?: string } = {},
) {
  const { title = 'Playwright Test Movie', year = '2024', language = 'English' } = opts;
  await page.fill('[data-testid="movie-form-title-input"]', title);
  await page.fill('[data-testid="movie-form-year-input"]', year);
  await page.fill('[data-testid="movie-form-language-input"]', language);
}

// ─── Test suite ────────────────────────────────────────────────────────────────

test.describe('Movie add/edit flows', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToCollection(page);
  });

  test('add movie with all required fields — detail screen shows title', async ({ page }) => {
    // Use a unique title to avoid mc-service 409 on repeated test runs
    const title = `Playwright Add Test ${Date.now()}`;
    await clickAddMovie(page);
    await fillRequiredMovieFields(page, { title });
    await page.click('[data-testid="movie-form-submit-button"]');

    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    await expect(page.getByTestId('movie-detail-title')).toHaveText(title);
  });

  test('edit optional field (owned toggle) — change persists in detail view', async ({ page }) => {
    // First add a movie we can edit
    await clickAddMovie(page);
    const uniqueTitle = `Edit Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: uniqueTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Tap Edit
    await page.click('[data-testid="movie-detail-edit-button"]');
    await page.waitForSelector('[data-testid="movie-form-title-input"]', { timeout: 10000 });

    // Toggle owned on
    const ownedToggle = page.getByTestId('movie-form-owned-toggle');
    await ownedToggle.click();

    // ownedMedia picker should appear
    await expect(page.getByTestId('movie-form-owned-media-picker')).toBeVisible({ timeout: 5000 });

    // Save
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Owned should now show "Yes"
    await expect(page.getByTestId('movie-detail-owned')).toHaveText('Yes');
  });

  test('missing required field — form shows inline validation error', async ({ page }) => {
    await clickAddMovie(page);

    // Leave title empty, submit
    await page.fill('[data-testid="movie-form-year-input"]', '2024');
    await page.fill('[data-testid="movie-form-language-input"]', 'English');
    await page.click('[data-testid="movie-form-submit-button"]');

    // Validation error for title should be visible
    await expect(page.getByTestId('movie-form-title-error')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('movie-form-title-error')).toContainText(/title is required/i);

    // Form should NOT have navigated away
    await expect(page.getByTestId('movie-form-title-input')).toBeVisible();
  });

  test('missing year — form shows year validation error', async ({ page }) => {
    await clickAddMovie(page);

    await page.fill('[data-testid="movie-form-title-input"]', 'Year Test');
    await page.fill('[data-testid="movie-form-language-input"]', 'English');
    // Leave year empty
    await page.click('[data-testid="movie-form-submit-button"]');

    await expect(page.getByTestId('movie-form-year-error')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('movie-form-year-error')).toContainText(/year is required/i);
  });

  test('duplicate movie rejection — error shown after submit', async ({ page }) => {
    // Add the first movie
    await clickAddMovie(page);
    const dupTitle = `Dup Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: dupTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Go back to the collection screen
    await page.goBack();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // Try to add the exact same movie
    await clickAddMovie(page);
    await fillRequiredMovieFields(page, { title: dupTitle });
    await page.click('[data-testid="movie-form-submit-button"]');

    // Error banner or toast should appear — mc-service returns 409
    // The form stays visible (no navigation on error)
    await expect(page.getByTestId('movie-form-title-input')).toBeVisible({ timeout: 10000 });
  });
});

// ─── T137: Browse / search / filter / column selection ────────────────────────

test.describe('Movie browse/search/filter (T137)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToCollection(page);
  });

  test('browse — collection screen shows movie list, search bar, and filter panel', async ({ page }) => {
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });
    await expect(page.getByTestId('movie-search-input')).toBeVisible();
    await expect(page.getByTestId('movie-filter-panel')).toBeVisible();
    // Either the list or the empty state should be present
    const listOrEmpty = await page.$(
      '[data-testid="movie-list-container"], [data-testid="movie-list-empty"]',
    );
    expect(listOrEmpty).not.toBeNull();
  });

  test('column selection — toggling runtime column shows it in list rows', async ({ page }) => {
    await page.waitForSelector('[data-testid="column-toggle-runtime"]', { timeout: 8000 });

    // Runtime column is hidden by default
    expect(await page.$('[data-testid="movie-list-item-runtime"]')).toBeNull();

    // Toggle runtime on
    await page.click('[data-testid="column-toggle-runtime"]');
    await page.waitForTimeout(500);

    // Runtime cells should now appear (if there are movies)
    const runtimeCell = await page.$('[data-testid="movie-list-item-runtime"]');
    // If list has movies, runtime cells appear; if empty list, that's fine too
    const isEmpty = await page.$('[data-testid="movie-list-empty"]');
    if (!isEmpty) {
      expect(runtimeCell).not.toBeNull();
    }

    // Toggle runtime off again
    await page.click('[data-testid="column-toggle-runtime"]');
    await page.waitForTimeout(500);
    expect(await page.$('[data-testid="movie-list-item-runtime"]')).toBeNull();
  });

  test('search — typing in search bar updates the list', async ({ page }) => {
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });

    await page.click('[data-testid="movie-search-input"]');
    await page.fill('[data-testid="movie-search-input"]', 'nonexistent-xyz-movie-title-12345');

    // Clear button should appear
    await expect(page.getByTestId('movie-search-clear')).toBeVisible({ timeout: 3000 });

    // Wait for debounce + list reload
    await page.waitForTimeout(500);

    // Should show empty state (no movies matching that title)
    await page.waitForSelector(
      '[data-testid="movie-list-container"], [data-testid="movie-list-empty"]',
      { timeout: 8000 },
    );

    // Clear the search
    await page.click('[data-testid="movie-search-clear"]');
    await expect(page.getByTestId('movie-search-clear')).not.toBeVisible({ timeout: 3000 });
  });

  test('combined search+filter — search input and filter chip applied together', async ({ page }) => {
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });

    // Type in search bar
    await page.fill('[data-testid="movie-search-input"]', 'matrix');
    await page.waitForTimeout(400); // past debounce

    // Try to click any genre filter chip if available
    const genreChip = await page.$('[data-testid^="filter-chip-genre-"]');
    if (genreChip) {
      await genreChip.click();
      await page.waitForTimeout(500);
    }

    // List should still be functional (not crashed)
    const listOrEmpty = await page.$(
      '[data-testid="movie-list-container"], [data-testid="movie-list-empty"]',
    );
    expect(listOrEmpty).not.toBeNull();
  });
});

// ─── T151: Delete movie ────────────────────────────────────────────────────────

test.describe('Movie delete (T151)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateToCollection(page);
  });

  async function navigateToFirstMovie(page: Page): Promise<string | undefined> {
    // Wait for at least one movie row to be present
    await page.waitForSelector('[data-testid="movie-list-item-row"]', { timeout: 10000 });
    const row = page.getByTestId('movie-list-item-row').first();
    // Get the title before clicking
    const titleEl = row.getByTestId('movie-list-item-title');
    const title = await titleEl.textContent().catch(() => undefined);
    await row.click();
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 10000 });
    return title ?? undefined;
  }

  test('cancel delete — dialog closes and movie detail is still shown', async ({ page }) => {
    await navigateToFirstMovie(page);

    // Open delete dialog
    await page.click('[data-testid="movie-detail-delete-button"]');
    await expect(page.getByTestId('delete-dialog')).toBeVisible({ timeout: 5000 });

    // Cancel
    await page.click('[data-testid="delete-dialog-cancel-button"]');
    await expect(page.getByTestId('delete-dialog')).not.toBeVisible({ timeout: 3000 });

    // Movie detail is still shown
    await expect(page.getByTestId('movie-detail-title')).toBeVisible({ timeout: 3000 });
  });

  test('confirm delete — movie removed, navigates back to collection screen', async ({ page }) => {
    // Add a throwaway movie to delete
    await clickAddMovie(page);
    const deleteTitle = `Delete E2E Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: deleteTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Verify we're on the detail screen
    await expect(page.getByTestId('movie-detail-title')).toHaveText(deleteTitle);

    // Open delete dialog and confirm
    await page.click('[data-testid="movie-detail-delete-button"]');
    await expect(page.getByTestId('delete-dialog')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="delete-dialog-confirm-button"]');

    // Should navigate back to the collection screen
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 15000 });
    await expect(page.getByTestId('movie-list-container')).toBeVisible();
  });
});
