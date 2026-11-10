/**
 * 098 US1 (web E2E): the collection screen's column, sort and filter controls are docked behind a
 * compact `view-options-toggle` bar that drops a panel down over the list.
 *
 *   SC-001  at 360×640, ≥3 movie rows are inside the viewport on load
 *   SC-003  filter and return to the full list in 3 presses (open, choose, close)
 *   FR-007  Escape re-docks without navigating
 *   FR-008  the docked bar shows the active-filter count
 *   FR-010  the same docked bar at desktop width — no inline controls at any width
 *   FR-005a opening/closing the panel does not move or re-scroll the list
 *   FR-016  focus returns to the bar on close
 *
 * Runs against the read-only BROWSE fixture; every expected count is derived from FIXTURE_MOVIES.
 * Requires the full stack (pnpm nx e2e mcm-app).
 */

import { test, expect } from './fixtures/worker-session';
import { type Page } from '@playwright/test';
import { FIXTURE_COLLECTIONS, FIXTURE_MOVIES } from '../fixtures/base-dataset';
import { E2E_BASE_URL as BASE } from './setup/target';

const PHONE = { width: 360, height: 640 };
const DESKTOP = { width: 1280, height: 800 };

async function collectionIdByName(page: Page, name: string): Promise<string> {
  const res = await page.request.get(`${BASE}/bff-api/collections`);
  const body = await res.json();
  const items = body.items ?? body;
  const col = items.find((c: { name: string }) => c.name === name);
  if (!col) {
    throw new Error(
      `Fixture collection "${name}" not found — run web global setup (pnpm nx e2e mcm-app) to seed it.`,
    );
  }
  return col.collectionId;
}

async function gotoBrowse(page: Page): Promise<void> {
  const id = await collectionIdByName(page, FIXTURE_COLLECTIONS.BROWSE);
  await page.goto(`${BASE}/collections/${id}`);
  await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 30000 });
  await expect(page.getByTestId('movie-list-item-row')).toHaveCount(FIXTURE_MOVIES.length, {
    timeout: 30000,
  });
}

/** Rows whose box lies fully inside the viewport. */
async function rowsInViewport(page: Page): Promise<number> {
  const vp = page.viewportSize()!;
  const boxes = await page.getByTestId('movie-list-item-row').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    }),
  );
  return boxes.filter((b) => b.height > 0 && b.top >= 0 && b.bottom <= vp.height).length;
}

/** Text of the first row whose bottom edge is below the list container's top edge. */
async function firstRowInView(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="movie-list-container"]');
    const top = container ? container.getBoundingClientRect().top : 0;
    const rows = Array.from(document.querySelectorAll('[data-testid="movie-list-item-row"]'));
    const first = rows.find((r) => r.getBoundingClientRect().bottom > top + 1);
    return first?.textContent ?? '';
  });
}

// One contentType value from the fixture, and its derived count.
const CONTENT_TYPE = 'Series';
const SERIES_COUNT = FIXTURE_MOVIES.filter((m) => m.contentType === CONTENT_TYPE).length;

test.describe('Collection view options — docked (098 US1)', () => {
  test('phone: docked on load, no inline controls, ≥3 rows visible (SC-001, US1-AC1)', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await gotoBrowse(page);
    await expect(page.getByTestId('view-options-toggle')).toBeVisible();
    await expect(page.getByTestId('movie-filter-panel')).toHaveCount(0);
    await expect(page.getByTestId('movie-sort-control')).toHaveCount(0);
    await expect(page.locator('[data-testid^="column-toggle-"]')).toHaveCount(0);
    const visible = await rowsInViewport(page);
    test
      .info()
      .annotations.push({ type: 'SC-001 rows in viewport (branch)', description: String(visible) });
    expect(visible).toBeGreaterThanOrEqual(3);
  });

  test('open → choose a filter → close filters the list in 3 presses (SC-003, US1-AC3/4/5)', async ({
    page,
  }) => {
    expect(SERIES_COUNT).toBeGreaterThan(0);
    expect(SERIES_COUNT).toBeLessThan(FIXTURE_MOVIES.length);
    await page.setViewportSize(PHONE);
    await gotoBrowse(page);

    await page.getByTestId('view-options-toggle').click(); // 1
    await expect(page.getByTestId('view-options-panel')).toBeVisible();
    await page.getByTestId(`filter-chip-contentType-${CONTENT_TYPE}`).click(); // 2
    // Choosing does not close the panel (FR-006).
    await expect(page.getByTestId('view-options-panel')).toBeVisible();
    await page.getByTestId('view-options-close').click(); // 3

    await expect(page.getByTestId('view-options-panel')).toHaveCount(0);
    await expect(page.getByTestId('movie-list-item-row')).toHaveCount(SERIES_COUNT, {
      timeout: 15000,
    });
    await expect(page.getByTestId('view-options-active-count')).toHaveText('1');
    await expect(page.getByTestId('view-options-toggle')).toHaveAttribute(
      'aria-label',
      'View options, 1 filter active',
    );

    // Leave the read-only fixture view as found: clear the filter (persisted per user).
    await page.getByTestId('view-options-toggle').click();
    await page.getByTestId('filter-clear-button').click();
    await page.getByTestId('view-options-close').click();
    await expect(page.getByTestId('view-options-active-count')).toHaveCount(0);
  });

  test('Escape re-docks without navigating, and focus returns to the bar (FR-007, FR-016)', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await gotoBrowse(page);
    const url = page.url();
    await page.getByTestId('view-options-toggle').click();
    await expect(page.getByTestId('view-options-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('view-options-panel')).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe('view-options-toggle');
  });

  test('a filter chip is reachable and operable by keyboard alone (WCAG 2.1.1, T011a)', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await gotoBrowse(page);
    await page.getByTestId('view-options-toggle').click();
    await expect(page.getByTestId('view-options-panel')).toBeVisible();

    // Focus is on the panel heading (FR-016); Tab forward until the chip holds focus.
    const chip = page.getByTestId(`filter-chip-contentType-${CONTENT_TYPE}`);
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await chip.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'Tab never reached the filter chip').toBe(true);

    await page.keyboard.press('Enter');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('movie-list-item-row')).toHaveCount(SERIES_COUNT, {
      timeout: 15000,
    });

    // Leave the read-only fixture view as found.
    await page.getByTestId('view-options-toggle').click();
    await page.getByTestId('filter-clear-button').click();
    await page.getByTestId('view-options-close').click();
    await expect(page.getByTestId('view-options-active-count')).toHaveCount(0);
  });

  test('desktop: the same docked bar, no inline controls (FR-010)', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await gotoBrowse(page);
    await expect(page.getByTestId('view-options-toggle')).toBeVisible();
    await expect(page.getByTestId('movie-filter-panel')).toHaveCount(0);
    await expect(page.getByTestId('movie-sort-control')).toHaveCount(0);
    await page.getByTestId('view-options-toggle').click();
    await expect(page.getByTestId('movie-filter-panel')).toBeVisible();
    await expect(page.getByTestId('movie-sort-control')).toBeVisible();
  });

  test('opening and closing the panel does not re-scroll the list (FR-005a)', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoBrowse(page);
    // Scroll the list so the first row in view is no longer the first row.
    await page.getByTestId('movie-list-item-row').first().hover();
    await page.mouse.wheel(0, 200);
    await expect
      .poll(() => firstRowInView(page))
      .not.toBe(await page.getByTestId('movie-list-item-row').first().textContent());
    const before = await firstRowInView(page);

    await page.getByTestId('view-options-toggle').click();
    await expect(page.getByTestId('view-options-panel')).toBeVisible();
    await page.getByTestId('view-options-close').click();
    await expect(page.getByTestId('view-options-panel')).toHaveCount(0);

    expect(await firstRowInView(page)).toBe(before);
  });
});
