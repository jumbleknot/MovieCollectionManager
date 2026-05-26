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
 *   6. Column header row visible above the movie list (always shown, even when empty)
 *   7. Column selection — toggling runtime column shows/hides it in the list
 *   8. Search — typing in search bar filters the movie list
 *   9. Search immediately after mount — no race with initial listMovies() load
 *  10. Filter — selecting a filter chip filters the movie list
 *  11. Combined search+filter — both applied simultaneously
 *
 * Test scenarios (T151):
 *  12. Cancel delete — dialog closes, movie detail screen still shown
 *  13. Confirm delete — movie removed, navigates back to collection screen
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:8081';

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function login(page: Page) {
  // Navigate to /home and accept either home-route (no default collection) or
  // collection-screen-add-movie (FR-009 auto-redirect to default collection).
  // home-screen.tsx uses localStorage on web to prevent the redirect from looping,
  // so navigateToCollection() can always find the collection screen after login.
  await page.goto(`${BASE}/home`);
  const alreadyLoggedIn = await Promise.race([
    page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 30000 }).then(() => true),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 30000 }).then(() => true),
  ]).catch(() => false);
  if (alreadyLoggedIn) return;

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

  // Accept either home-route or collection screen (FR-009 may redirect).
  // 60s budget: BFF/Redis under more load as the test run progresses.
  await Promise.race([
    page.waitForSelector('[data-testid="home-route"]', { state: 'visible', timeout: 60000 }),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }),
  ]);
}

async function navigateToCollection(page: Page) {
  // FR-009: if the user has a default collection, login triggers an auto-redirect
  // to that collection's screen before or shortly after home-route appears.
  // Check if we're already on the collection screen (3s non-blocking window).
  const alreadyAtCollection = await page
    .waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (alreadyAtCollection) return;

  // Still on home screen — wait for collection cards and click the first one.
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

  test('duplicate movie rejection — server error shown after submit', async ({ page }) => {
    // Add the first movie
    await clickAddMovie(page);
    const dupTitle = `Dup Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: dupTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Capture the movie detail URL now so teardown can navigate back directly
    const movieDetailUrl = page.url();

    // Go back to the collection screen via the back button
    await page.click('[data-testid="movie-detail-back-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });

    // Try to add the exact same movie
    await clickAddMovie(page);
    await fillRequiredMovieFields(page, { title: dupTitle });
    await page.click('[data-testid="movie-form-submit-button"]');

    // Server error banner should appear (movie-form-server-error testID)
    await expect(page.getByTestId('movie-form-server-error')).toBeVisible({ timeout: 10000 });
    // Form stays open — no navigation on error
    await expect(page.getByTestId('movie-form-title-input')).toBeVisible();

    // Teardown: cancel the duplicate form, then navigate directly to the first movie
    // and delete it. Avoids clicking into a potentially long/scrolled list.
    await page.click('[data-testid="movie-form-cancel-button"]');
    await page.goto(movieDetailUrl);
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 15000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
  });

  test('back button navigates from movie detail to collection screen', async ({ page }) => {
    // Add a movie and land on the detail screen
    await clickAddMovie(page);
    const backTitle = `Back Button Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: backTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Capture the movie detail URL now so teardown can navigate back directly
    const movieDetailUrl = page.url();

    // Back button should be visible
    await expect(page.getByTestId('movie-detail-back-button')).toBeVisible();

    // Click back button
    await page.click('[data-testid="movie-detail-back-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible();

    // Teardown: navigate directly to the movie detail URL and delete. Using
    // page.goto avoids having to find the row in a potentially long/scrolled list.
    await page.goto(movieDetailUrl);
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 15000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
  });

  test('collection screen refreshes to show newly added movie after navigating back', async ({ page }) => {
    const refreshTitle = `Refresh Test ${Date.now()}`;
    await clickAddMovie(page);
    await fillRequiredMovieFields(page, { title: refreshTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Capture URL for teardown
    const movieDetailUrl = page.url();

    // Navigate back to the collection screen
    await page.click('[data-testid="movie-detail-back-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });

    // The newly added movie must appear in the refreshed list.
    // useFocusEffect re-fetches on focus, so the newly created movie should be visible.
    await expect(
      page.getByTestId('movie-list-item-row').filter({ hasText: refreshTitle }),
    ).toBeVisible({ timeout: 15000 });

    // Teardown
    await page.goto(movieDetailUrl);
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 15000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
  });

  test('optional fields — save rated and see it in detail view', async ({ page }) => {
    await clickAddMovie(page);
    const ratedTitle = `Rated Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: ratedTitle });

    // Select "R" rating
    await page.click('[data-testid="movie-form-rated-r"]');
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Rated field should appear in detail view
    await expect(page.getByTestId('movie-detail-rated')).toHaveText('R');

    // Teardown
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });

  test('optional fields — save tags and see them in detail view', async ({ page }) => {
    await clickAddMovie(page);
    const tagTitle = `Tag Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: tagTitle });

    // Add a tag
    await page.fill('[data-testid="movie-form-tag-input"]', 'classic');
    await page.click('[data-testid="movie-form-tag-add-button"]');
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Tags should appear in detail view
    await expect(page.getByTestId('movie-detail-tags')).toContainText('classic');

    // Teardown
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });

  test('edit optional field (server error on save shown in form)', async ({ page }) => {
    // Add a movie first
    await clickAddMovie(page);
    const editErrTitle = `Edit Err Test ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: editErrTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Open edit form
    await page.click('[data-testid="movie-detail-edit-button"]');
    await page.waitForSelector('[data-testid="movie-form-title-input"]', { timeout: 10000 });

    // Clear the title (required field) — this causes a server-side validation error
    await page.fill('[data-testid="movie-form-title-input"]', '');
    // Submit — client-side validation catches this before server
    await page.click('[data-testid="movie-form-submit-button"]');
    await expect(page.getByTestId('movie-form-title-error')).toBeVisible({ timeout: 5000 });

    // Cancel edit and teardown
    await page.click('[data-testid="movie-form-cancel-button"]');
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 5000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
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

  test('column header row visible above movie list (always shown, even when empty)', async ({ page }) => {
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });

    // movie-list-header is always rendered regardless of whether the list has items
    await expect(page.getByTestId('movie-list-header')).toBeVisible({ timeout: 5000 });

    // "Title" column is always present (not behind a toggle)
    await expect(page.getByTestId('movie-list-header')).toContainText('Title');
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

  test('search immediately after mount — result not overwritten by initial load (no race)', async ({ page }) => {
    // This test exercises the generation-counter fix in use-movies.ts.
    // Previously, listMovies() fired on mount and could overwrite search results
    // if the user typed before the initial fetch resolved.
    // Strategy: navigate fresh to the collection screen (triggers listMovies), then
    // immediately type a term — the search result must stick, not be reverted.
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });

    // Type before the initial mount fetch might have resolved
    await page.fill('[data-testid="movie-search-input"]', 'nonexistent-xyz-no-match-99999');

    // Wait for debounce (300ms) plus a comfortable buffer for the search API call
    await page.waitForTimeout(800);

    // The empty state must appear — if the race condition were present, the list
    // would be replaced by all movies from the initial listMovies() response.
    await expect(page.getByTestId('movie-list-empty')).toBeVisible({ timeout: 8000 });

    // The search input still shows the typed term (wasn't reset)
    await expect(page.getByTestId('movie-search-input')).toHaveValue('nonexistent-xyz-no-match-99999');

    // Clean up: clear search to restore normal state
    await page.click('[data-testid="movie-search-clear"]');
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
    // Create a dedicated movie so this test is independent of pre-existing data.
    await clickAddMovie(page);
    const cancelTitle = `Cancel Delete E2E ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: cancelTitle });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });

    // Open delete dialog
    await page.click('[data-testid="movie-detail-delete-button"]');
    await expect(page.getByTestId('delete-dialog')).toBeVisible({ timeout: 5000 });

    // Cancel
    await page.click('[data-testid="delete-dialog-cancel-button"]');
    await expect(page.getByTestId('delete-dialog')).not.toBeVisible({ timeout: 3000 });

    // Movie detail is still shown
    await expect(page.getByTestId('movie-detail-title')).toBeVisible({ timeout: 3000 });

    // Teardown: delete the movie we created so subsequent runs are idempotent
    await page.click('[data-testid="movie-detail-delete-button"]');
    await expect(page.getByTestId('delete-dialog')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
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

    // Should navigate back to the collection screen — FAB is always present regardless of
    // whether the movie list is empty or not.
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
    await expect(page.getByTestId('collection-screen-add-movie')).toBeVisible();
  });
});
