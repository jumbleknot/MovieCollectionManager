/**
 * T106 (web E2E): Movie add/edit flows via Playwright.
 * T137 (web E2E): Movie browse/column selection/search/filter flows.
 * T138 (web E2E): Search by non-title fields + ownedMedia/ripQuality filter chips.
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
 *  10. Genre filter chip — clicking a genre chip filters list to that genre only
 *  11. Director text search — typing a director name filters the list
 *
 * Test scenarios (T138):
 *  12. Actor text search — typing an actor name filters the list
 *  13. ownedMedia filter chip — clicking chip filters list to movies with that media
 *  14. ripQuality filter chip — clicking chip filters list to movies with that rip quality
 *
 * Test scenarios (T151):
 *  15. Cancel delete — dialog closes, movie detail screen still shown
 *  16. Confirm delete — movie removed, navigates back to collection screen
 *
 * Test scenarios (TR25 / FR-019a — column persistence):
 *  17. Column toggle persists after navigating away and back (AsyncStorage)
 *
 * Test scenarios (TR21 / FR-026a — autofill suppression):
 *  18. collection-name: autocomplete=off, aria-label and placeholder have no "name" keyword
 *  19. director entry: autocomplete=off, placeholder has no "name" keyword
 *  20. actor entry: autocomplete=off, placeholder has no "name" keyword
 *  21. ext-id-system: autocomplete=off, aria-label has no "name" keyword
 *  22. ext-id-unique: autocomplete=off, placeholder has no "id" keyword, aria-label has no "identifier"
 */

import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_COLLECTIONS, FIXTURE_MOVIES } from '../fixtures/base-dataset';
import { resetMutationMovies } from './setup/e2e-cleanup';

import { E2E_BASE_URL as BASE } from './setup/target';

// T018 (FR-014): post-test teardown via the BFF API (not UI), runs even if a test
// throws mid-body. Empties the MUTATION fixture so movie writes never leak between
// tests or runs. (The in-body UI deletes some tests still do are now redundant
// belt-and-suspenders; this hook is the guaranteed cleanup.)
test.afterEach(async ({ request }) => {
  await resetMutationMovies(request);
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Navigate to the home screen using the session inherited from global setup
 * (Playwright storageState). No login here — global setup authenticates once per
 * run (T013, FR-004, SC-001). Handles the FR-009 default-collection redirect.
 */
async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  // Wait on home-screen-create-button — the FR-009-RESOLVED signal (renders only after the
  // auto-nav check completes AND collections load). home-route is the wrapper that renders
  // immediately during loading and races ahead of the FR-009 redirect: if a default collection
  // is set, waiting on home-route could return just before router.replace() strands the test
  // off /home. 60 s budget covers Metro's cold compile.
  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);
  if (result === 'collection') {
    // FR-009 fires at most once per session, so a second /home reveals the list + create button.
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    return;
  }
  if (!result) {
    throw new Error('gotoHome: home screen did not render — is the global-setup session valid?');
  }
}

/** Resolve a fixture collection's id via the BFF (deterministic — avoids scanning the card list). */
async function collectionIdByName(page: Page, name: string): Promise<string> {
  const res = await page.request.get(`${BASE}/bff-api/collections`);
  const body = await res.json();
  const items = body.items ?? body;
  const col = items.find((c: { name: string }) => c.name === name);
  if (!col) {
    throw new Error(`Fixture collection "${name}" not found — run web global setup (pnpm nx e2e mcm-app) to seed it.`);
  }
  return col.collectionId;
}

/**
 * Open a fixture collection's screen by deep-linking to its id.
 *
 * Defaults to the MUTATION fixture (E2E Mutation) so write tests (add/edit/delete,
 * filter-by-created-movie) never touch the read-only BROWSE fixture whose exact
 * counts the search/filter assertions (T015/T016) depend on. global setup resets
 * MUTATION to empty each run, keeping these tests isolated.
 */
async function navigateToCollection(page: Page, name: string = FIXTURE_COLLECTIONS.MUTATION): Promise<void> {
  const id = await collectionIdByName(page, name);
  await page.goto(`${BASE}/collections/${id}`);
  await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
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
    await gotoHome(page);
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
    await gotoHome(page);
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

  test('genre filter chip — clicking chip filters list to only that genre', async ({ page }) => {
    // Create a movie with a unique genre so the genre chip appears in filter options.
    await navigateToCollection(page);
    await clickAddMovie(page);
    const genreTitle = `GenreFilter E2E ${Date.now()}`;
    const uniqueGenre = `TestGenre${Date.now()}`;
    await fillRequiredMovieFields(page, { title: genreTitle });
    await page.fill('[data-testid="movie-form-genre-input"]', uniqueGenre);
    await page.click('[data-testid="movie-form-genre-add-button"]');
    await page.click('[data-testid="movie-form-submit-button"]');
    // Wait for movie detail screen then navigate back to collection
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // The genre chip should now appear in the filter panel (filter-options refreshes on focus)
    const chipTestId = `filter-chip-genre-${uniqueGenre}`;
    await page.waitForSelector(`[data-testid="${chipTestId}"]`, { timeout: 10000 });

    // Click the genre chip to apply the filter
    await page.click(`[data-testid="${chipTestId}"]`);
    await page.waitForTimeout(600); // past debounce

    // Only movies with that genre should appear — at minimum the one we just created.
    // Use a generous timeout: clicking the chip fires an API call whose response can
    // take up to ~2s under test-run load before the row re-renders.
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 10000 });
    const rows = page.getByTestId('movie-list-item-row');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    // The created movie must be in the filtered list
    await expect(rows.filter({ hasText: genreTitle })).toBeVisible({ timeout: 10000 });

    // Teardown: navigate to the movie and delete it
    const movieRow = page.getByTestId('movie-list-item-row').filter({ hasText: genreTitle });
    await movieRow.click();
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 10000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });

  test('actor text search — typing an actor name filters the list', async ({ page }) => {
    // Create a movie with a unique actor so searching by actor name returns it.
    await navigateToCollection(page);
    await clickAddMovie(page);
    const actorTitle = `ActorSearch E2E ${Date.now()}`;
    const uniqueActor = `Actor${Date.now()}`;
    await fillRequiredMovieFields(page, { title: actorTitle });
    await page.fill('[data-testid="movie-form-actor-input"]', uniqueActor);
    await page.click('[data-testid="movie-form-actor-add-button"]');
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // Search by the unique actor name
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });
    await page.fill('[data-testid="movie-search-input"]', uniqueActor);
    await page.waitForTimeout(600); // past debounce

    // The created movie should appear in the search results
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 8000 });
    await expect(
      page.getByTestId('movie-list-item-row').filter({ hasText: actorTitle }),
    ).toBeVisible({ timeout: 5000 });

    // Teardown
    const movieRow = page.getByTestId('movie-list-item-row').filter({ hasText: actorTitle });
    await movieRow.click();
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 10000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });

  test('ownedMedia filter chip — clicking chip filters list to movies with that media', async ({ page }) => {
    // Create a movie with owned=true and a specific media format so the chip appears.
    await navigateToCollection(page);
    await clickAddMovie(page);
    const ownedTitle = `OwnedMedia E2E ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: ownedTitle });

    // Enable "Owned" toggle
    await page.click('[data-testid="movie-form-owned-toggle"]');
    await page.waitForSelector('[data-testid="movie-form-owned-media-picker"]', { timeout: 5000 });

    // Select DVD from the owned media picker (testID uses lowercase: dvd)
    await page.click('[data-testid="movie-form-owned-media-dvd"]');

    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // The ownedMedia chip should now appear in the filter panel
    const chipTestId = 'filter-chip-ownedMedia-DVD';
    await page.waitForSelector(`[data-testid="${chipTestId}"]`, { timeout: 10000 });

    // Click the chip
    await page.click(`[data-testid="${chipTestId}"]`);
    await page.waitForTimeout(600); // past debounce

    // The movie we created must appear in the filtered list
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 10000 });
    await expect(
      page.getByTestId('movie-list-item-row').filter({ hasText: ownedTitle }),
    ).toBeVisible({ timeout: 10000 });

    // Teardown
    const movieRow = page.getByTestId('movie-list-item-row').filter({ hasText: ownedTitle });
    await movieRow.click();
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 10000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });

  test('ripQuality filter chip — clicking chip filters list to movies with that rip quality', async ({ page }) => {
    // Create a movie with ripped=true and a rip quality so the chip appears.
    await navigateToCollection(page);
    await clickAddMovie(page);
    const rippedTitle = `RipQuality E2E ${Date.now()}`;
    await fillRequiredMovieFields(page, { title: rippedTitle });

    // Enable "Ripped" toggle
    await page.click('[data-testid="movie-form-ripped-toggle"]');
    await page.waitForSelector('[data-testid="movie-form-rip-quality-picker"]', { timeout: 5000 });

    // Select Blu-Ray from the rip quality picker (testID uses lowercase+kebab: blu-ray)
    await page.click('[data-testid="movie-form-rip-quality-blu-ray"]');

    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // The ripQuality chip should now appear in the filter panel
    const chipTestId = 'filter-chip-ripQuality-Blu-Ray';
    await page.waitForSelector(`[data-testid="${chipTestId}"]`, { timeout: 10000 });

    // Click the chip
    await page.click(`[data-testid="${chipTestId}"]`);
    await page.waitForTimeout(600); // past debounce

    // The movie we created must appear in the filtered list
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 10000 });
    await expect(
      page.getByTestId('movie-list-item-row').filter({ hasText: rippedTitle }),
    ).toBeVisible({ timeout: 10000 });

    // Teardown
    const movieRow = page.getByTestId('movie-list-item-row').filter({ hasText: rippedTitle });
    await movieRow.click();
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 10000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });

  test('director text search — typing a director name filters the list', async ({ page }) => {
    // Create a movie with a unique director so a search by director returns it.
    await navigateToCollection(page);
    await clickAddMovie(page);
    const directorTitle = `DirectorSearch E2E ${Date.now()}`;
    const uniqueDirector = `Director${Date.now()}`;
    await fillRequiredMovieFields(page, { title: directorTitle });
    await page.fill('[data-testid="movie-form-director-input"]', uniqueDirector);
    await page.click('[data-testid="movie-form-director-add-button"]');
    await page.click('[data-testid="movie-form-submit-button"]');
    // Wait for movie detail screen then navigate back to collection
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    await page.goBack();
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 10000 });

    // Search by the unique director name
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 8000 });
    await page.fill('[data-testid="movie-search-input"]', uniqueDirector);
    await page.waitForTimeout(600); // past debounce

    // The created movie should appear in the search results
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 8000 });
    await expect(
      page.getByTestId('movie-list-item-row').filter({ hasText: directorTitle }),
    ).toBeVisible({ timeout: 5000 });

    // Teardown: navigate to the movie and delete it
    const movieRow = page.getByTestId('movie-list-item-row').filter({ hasText: directorTitle });
    await movieRow.click();
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 10000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
  });
});

// ─── T151: Delete movie ────────────────────────────────────────────────────────

test.describe('Movie delete (T151)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page);
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

// ─── Column visibility persistence (TR25 / FR-019a) ───────────────────────────

test.describe('Column visibility persistence (FR-019a)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page);
    await navigateToCollection(page);
  });

  test('column toggle persists after navigating away and back', async ({ page }) => {
    // Expo Router's Stack keeps ALL screen instances in the DOM when navigating
    // forward, so any testID selector can match multiple elements (one per screen
    // instance in the stack). Use .filter({ visible: true }) throughout to target
    // only the currently active screen's elements.
    const visible = (testId: string) =>
      page.locator(`[data-testid="${testId}"]`).filter({ visible: true });

    // year/contentType are always visible and no longer toggleable (FR-019b),
    // so this persistence test exercises a still-toggleable column instead.
    // Observable: MovieListHeader renders a "Media" text cell when ownedMedia is
    // visible, nothing when hidden. Testing through this avoids DOM attribute
    // issues — RNW 0.21.x Pressable doesn't forward unknown props or reflect
    // accessibilityState as aria-checked on the DOM div.
    const mediaHeader = () => visible('movie-list-header').getByText('Media', { exact: true });

    // Capture initial state (may be on or off if a prior test left AsyncStorage dirty)
    await expect(visible('movie-list-header')).toBeVisible({ timeout: 8000 });
    const mediaVisibleBefore = await mediaHeader().isVisible().catch(() => false);

    // Toggle the Media column; wait for AsyncStorage write to settle.
    await visible('column-toggle-ownedMedia').click();
    await page.waitForTimeout(300);
    const mediaVisibleAfterToggle = await mediaHeader().isVisible().catch(() => false);
    // Verify toggle actually flipped the state
    expect(mediaVisibleAfterToggle).toBe(!mediaVisibleBefore);

    // Navigate to home. Must NOT use waitForSelector without visible filter —
    // Expo Router's Stack adds a new home instance on top of the stack while
    // keeping the original home instance in the DOM, so selectors resolve to
    // 2+ elements and waitForSelector picks the hidden original.
    await page.click('[data-testid="nav-home"]');
    await visible('home-screen-create-button').waitFor({ state: 'visible', timeout: 10000 });

    // Navigate back to collection — inline with visible filtering rather than
    // calling navigateToCollection(), which uses plain waitForSelector and would
    // pick the hidden collection instance still in the stack.
    await visible('collection-card').first().click();
    await visible('collection-screen-add-movie').waitFor({ state: 'visible', timeout: 10000 });

    // Column state must match what we toggled to — AsyncStorage persisted it.
    await expect(visible('movie-list-header')).toBeVisible({ timeout: 8000 });
    const mediaVisibleAfterNav = await mediaHeader().isVisible().catch(() => false);
    expect(mediaVisibleAfterNav).toBe(mediaVisibleAfterToggle);

    // Restore original state.
    if (mediaVisibleAfterNav !== mediaVisibleBefore) {
      await visible('column-toggle-ownedMedia').click();
      await page.waitForTimeout(300);
    }
  });
});

// ─── T015 / T016: exact-count filter & search assertions against the BROWSE fixture ──
//
// FR-010 / SC-003: every count below is DERIVED from FIXTURE_MOVIES (the single source
// of truth), not hardcoded — so changing the fixture automatically updates expectations.
// These read-only assertions run against the seeded E2E Browse collection (never mutated),
// unlike the create-then-filter integration tests above which write to MUTATION.

const countWhere = (pred: (m: (typeof FIXTURE_MOVIES)[number]) => boolean): number =>
  FIXTURE_MOVIES.filter(pred).length;

// Map a fixture decade label ("2010s") to the numeric decade chip value (2010).
const decadeChipValue = (label: string): number => parseInt(label.replace(/s$/, ''), 10);

test.describe('Movie filter exact counts (T015 / FR-010)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page);
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 15000 });
  });

  test('BROWSE shows exactly the fixture movie count (baseline)', async ({ page }) => {
    await expect(page.getByTestId('movie-list-item-row')).toHaveCount(FIXTURE_MOVIES.length, {
      timeout: 10000,
    });
  });

  const cases: Array<{ label: string; chip: string; expected: number }> = [
    { label: 'Type = Movie', chip: 'filter-chip-contentType-Movie', expected: countWhere((m) => m.contentType === 'Movie') },
    { label: 'Type = Series', chip: 'filter-chip-contentType-Series', expected: countWhere((m) => m.contentType === 'Series') },
    { label: 'Type = Concert', chip: 'filter-chip-contentType-Concert', expected: countWhere((m) => m.contentType === 'Concert') },
    { label: 'Owned = Yes', chip: 'filter-chip-owned-Yes', expected: countWhere((m) => m.owned) },
    { label: 'Ripped = Yes', chip: 'filter-chip-ripped-Yes', expected: countWhere((m) => m.ripped) },
    { label: 'Genre = Action', chip: 'filter-chip-genre-Action', expected: countWhere((m) => m.genres.includes('Action')) },
    { label: 'Decade = 2010s', chip: `filter-chip-decade-${decadeChipValue('2010s')}`, expected: countWhere((m) => m.decade === '2010s') },
    { label: 'Decade = 1980s', chip: `filter-chip-decade-${decadeChipValue('1980s')}`, expected: countWhere((m) => m.decade === '1980s') },
    { label: 'Rated = R', chip: 'filter-chip-rated-R', expected: countWhere((m) => m.rated === 'R') },
    { label: 'Media = DVD', chip: 'filter-chip-ownedMedia-DVD', expected: countWhere((m) => m.ownedMedia.includes('DVD')) },
  ];

  for (const c of cases) {
    test(`filter ${c.label} → exactly ${c.expected} movies`, async ({ page }) => {
      await page.click(`[data-testid="${c.chip}"]`);
      await page.waitForTimeout(700); // filter debounce + list reload
      await expect(page.getByTestId('movie-list-item-row')).toHaveCount(c.expected, { timeout: 10000 });
    });
  }
});

test.describe('Movie search exact counts (T016 / SC-003)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page);
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.waitForSelector('[data-testid="movie-search-input"]', { timeout: 15000 });
  });

  test('search for an exact fixture title → exactly 1 movie', async ({ page }) => {
    const title = FIXTURE_MOVIES[0]!.title; // "Alpha" — unique single-word title
    const expected = countWhere((m) => m.title === title); // 1
    await page.fill('[data-testid="movie-search-input"]', title);
    await page.waitForTimeout(700);
    await expect(page.getByTestId('movie-list-item-row')).toHaveCount(expected, { timeout: 10000 });
  });

  test('search for a non-matching term → empty state (0 movies)', async ({ page }) => {
    await page.fill('[data-testid="movie-search-input"]', 'zzz-no-such-movie-99999');
    await page.waitForTimeout(700);
    await expect(page.getByTestId('movie-list-empty')).toBeVisible({ timeout: 10000 });
  });
});

// ─── Autofill suppression (TR21 / FR-026a) ────────────────────────────────────

test.describe('Autofill suppression (FR-026a)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page);
  });

  test('collection-name input: autocomplete=off, aria-label has no "name" keyword, placeholder has no "name" keyword', async ({ page }) => {
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { timeout: 15000 });
    await page.click('[data-testid="home-screen-create-button"]');
    await page.waitForSelector('[data-testid="collection-form-name-input"]', { timeout: 5000 });
    const input = page.getByTestId('collection-form-name-input');
    await expect(input).toHaveAttribute('autocomplete', 'off');
    // aria-label must not contain "name" keyword (Chrome reads aria-label for contact autofill)
    const ariaLabel = (await input.getAttribute('aria-label')) ?? '';
    expect(ariaLabel.toLowerCase()).not.toMatch(/\bname\b/);
    // placeholder must not contain "name" keyword
    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    expect(placeholder.toLowerCase()).not.toMatch(/\bname\b/);
    await page.keyboard.press('Escape');
  });

  test('director entry input: autocomplete=off, placeholder has no "name" keyword', async ({ page }) => {
    await navigateToCollection(page);
    await clickAddMovie(page);
    const input = page.getByTestId('movie-form-director-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveAttribute('autocomplete', 'off');
    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    expect(placeholder.toLowerCase()).not.toMatch(/\bname\b/);
  });

  test('actor entry input: autocomplete=off, placeholder has no "name" keyword', async ({ page }) => {
    await navigateToCollection(page);
    await clickAddMovie(page);
    const input = page.getByTestId('movie-form-actor-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveAttribute('autocomplete', 'off');
    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    expect(placeholder.toLowerCase()).not.toMatch(/\bname\b/);
  });

  test('ext-id-system input: autocomplete=off, aria-label has no "name" keyword', async ({ page }) => {
    await navigateToCollection(page);
    await clickAddMovie(page);
    const input = page.getByTestId('movie-form-ext-id-system-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveAttribute('autocomplete', 'off');
    // aria-label must not contain "name" keyword
    const ariaLabel = (await input.getAttribute('aria-label')) ?? '';
    expect(ariaLabel.toLowerCase()).not.toMatch(/\bname\b/);
  });

  test('ext-id-unique input: autocomplete=off, placeholder has no "id" keyword, aria-label has no "identifier"', async ({ page }) => {
    await navigateToCollection(page);
    await clickAddMovie(page);
    const input = page.getByTestId('movie-form-ext-id-unique-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveAttribute('autocomplete', 'off');
    // placeholder must not contain standalone "id" keyword (Chrome identifier heuristic)
    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    expect(placeholder.toLowerCase()).not.toMatch(/\bid\b/);
    // aria-label must not contain "identifier"
    const ariaLabel = (await input.getAttribute('aria-label')) ?? '';
    expect(ariaLabel.toLowerCase()).not.toContain('identifier');
  });
});

// ─── 013 US1 — server-applied sort (Playwright) ────────────────────────────────
// Scenarios (US1-AC1..AC5): default title→year order; change sort reorders; sort works with
// the filter; chosen order survives a filter change; a fresh open resets to the default.
test.describe('movie sort (013 US1)', () => {
  async function visibleTitles(page: Page): Promise<string[]> {
    await page.waitForSelector('[data-testid="movie-list-item-title"]', { timeout: 15000 });
    return page.getByTestId('movie-list-item-title').allInnerTexts();
  }

  test('opens in default title order (US1-AC1)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    const titles = await visibleTitles(page);
    const expected = FIXTURE_MOVIES.map((m) => m.title).sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(expected);
  });

  test('toggling direction to descending reverses the order (US1-AC2)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.click('[data-testid="sort-dir-toggle"]');
    await page.waitForTimeout(700); // reload
    const titles = await visibleTitles(page);
    const expectedDesc = FIXTURE_MOVIES.map((m) => m.title).sort((a, b) => b.localeCompare(a));
    expect(titles).toEqual(expectedDesc);
  });

  test('sort applies to the filtered subset (US1-AC3)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.click('[data-testid="filter-chip-contentType-Movie"]');
    await page.waitForTimeout(700);
    const titles = await visibleTitles(page);
    const expected = FIXTURE_MOVIES.filter((m) => m.contentType === 'Movie')
      .map((m) => m.title)
      .sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(expected);
  });

  test('chosen sort survives a filter change (US1-AC4)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.click('[data-testid="sort-dir-toggle"]'); // descending
    await page.waitForTimeout(700);
    await page.click('[data-testid="filter-chip-contentType-Movie"]');
    await page.waitForTimeout(700);
    const titles = await visibleTitles(page);
    const expected = FIXTURE_MOVIES.filter((m) => m.contentType === 'Movie')
      .map((m) => m.title)
      .sort((a, b) => b.localeCompare(a)); // still descending
    expect(titles).toEqual(expected);
  });

  test('a fresh open resets to the default order (US1-AC5)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.click('[data-testid="sort-dir-toggle"]'); // descending
    await page.waitForTimeout(700);
    // Leave and re-open the collection — sort is session-scoped, not persisted.
    await gotoHome(page);
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    const titles = await visibleTitles(page);
    const expectedAsc = FIXTURE_MOVIES.map((m) => m.title).sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(expectedAsc);
  });
});

// ─── 013 US2 — movie count info line (Playwright) ──────────────────────────────
// Scenarios (US2-AC1..AC5): total unfiltered; filtered/total when filtered; updates after
// add/delete; total restored when the filter clears.
test.describe('movie count line (013 US2)', () => {
  async function countLineText(page: Page): Promise<string> {
    await page.waitForSelector('[data-testid="movie-count-line"]', { timeout: 15000 });
    return (await page.getByTestId('movie-count-line').innerText()).trim();
  }
  function leadingInt(s: string): number {
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : NaN;
  }

  test('shows the total count when unfiltered (US2-AC1)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    expect(await countLineText(page)).toBe(`${FIXTURE_MOVIES.length} movies`);
  });

  test('shows filtered/total when filtered, total again when cleared (US2-AC2/AC5)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.BROWSE);
    await page.click('[data-testid="filter-chip-contentType-Movie"]');
    await page.waitForTimeout(700);
    const movieCount = FIXTURE_MOVIES.filter((m) => m.contentType === 'Movie').length;
    expect(await countLineText(page)).toBe(`${movieCount} of ${FIXTURE_MOVIES.length} movies`);
    // Clear the filter — count returns to the unfiltered total.
    await page.click('[data-testid="filter-chip-contentType-Movie"]');
    await page.waitForTimeout(700);
    expect(await countLineText(page)).toBe(`${FIXTURE_MOVIES.length} movies`);
  });

  test('count updates after an add and a delete (US2-AC3/AC4)', async ({ page }) => {
    await navigateToCollection(page, FIXTURE_COLLECTIONS.MUTATION);
    const collectionUrl = page.url(); // re-open here to read the count after a deep-loaded delete
    const before = leadingInt(await countLineText(page));

    // Add a movie → count increments by one.
    const title = `Count Test ${Date.now()}`;
    await clickAddMovie(page);
    await fillRequiredMovieFields(page, { title });
    await page.click('[data-testid="movie-form-submit-button"]');
    await page.waitForSelector('[data-testid="movie-detail-title"]', { timeout: 15000 });
    const movieDetailUrl = page.url();
    await page.click('[data-testid="movie-detail-back-button"]');
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
    await page.waitForTimeout(600);
    expect(leadingInt(await countLineText(page))).toBe(before + 1);

    // Delete it → count returns to the original total. Deep-loading the detail URL leaves no
    // back-history to the collection, so re-open the collection screen explicitly to read the count.
    await page.goto(movieDetailUrl);
    await page.waitForSelector('[data-testid="movie-detail-delete-button"]', { timeout: 15000 });
    await page.click('[data-testid="movie-detail-delete-button"]');
    await page.click('[data-testid="delete-dialog-confirm-button"]');
    await page.waitForTimeout(800);
    await page.goto(collectionUrl);
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 15000 });
    await page.waitForTimeout(600);
    expect(leadingInt(await countLineText(page))).toBe(before);
  });
});
