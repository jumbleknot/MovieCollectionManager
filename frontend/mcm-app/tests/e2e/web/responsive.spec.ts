/**
 * Responsive / narrow-viewport audit — web (feature 015, T045; FR-016).
 *
 * Across compact (phone) → medium → expanded (desktop) viewports:
 *   - no horizontal overflow / clipped content on the home and collection screens;
 *   - the assistant dock panel stays within the viewport and reflows to (near) full
 *     width on the compact breakpoint (the "full-width sheet" contract).
 *
 * Uses the authenticated global-setup session.
 */
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

const VIEWPORTS = [
  { name: 'compact', width: 360, height: 740 },
  { name: 'medium', width: 768, height: 1024 },
  { name: 'expanded', width: 1280, height: 900 },
] as const;

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);
  if (result === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
  } else if (!result) {
    throw new Error('gotoHome: home screen did not render');
  }
}

async function gotoCollection(page: Page): Promise<void> {
  const res = await page.request.get(`${BASE}/bff-api/collections`);
  const body = await res.json();
  const items = body.items ?? body;
  const col = items.find((c: { name: string }) => c.name === 'E2E Browse');
  await page.goto(`${BASE}/collections/${col.collectionId}`);
  await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { timeout: 30000 });
}

/** True when the document does not scroll horizontally (2px tolerance for sub-pixel layout). */
async function hasNoHorizontalOverflow(page: Page): Promise<{ ok: boolean; scrollW: number; clientW: number }> {
  return page.evaluate(() => {
    const el = document.documentElement;
    const scrollW = Math.max(el.scrollWidth, document.body.scrollWidth);
    const clientW = el.clientWidth;
    return { ok: scrollW <= clientW + 2, scrollW, clientW };
  });
}

test.describe('responsive — no overflow across viewports', () => {
  for (const vp of VIEWPORTS) {
    test(`home has no horizontal overflow @ ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoHome(page);
      const r = await hasNoHorizontalOverflow(page);
      expect(r.ok, `scrollWidth ${r.scrollW} > clientWidth ${r.clientW}`).toBe(true);
    });

    test(`collection screen has no horizontal overflow @ ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoCollection(page);
      const r = await hasNoHorizontalOverflow(page);
      expect(r.ok, `scrollWidth ${r.scrollW} > clientWidth ${r.clientW}`).toBe(true);
    });
  }
});

test.describe('responsive — assistant dock reflow', () => {
  test('dock panel stays within the viewport and reflows wide on compact', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await gotoHome(page);

    await page.getByTestId('assistant-dock-toggle').click();
    const panel = page.getByTestId('assistant-dock-panel');
    await panel.waitFor({ state: 'visible', timeout: 15000 });

    const box = await panel.boundingBox();
    expect(box, 'dock panel should have a layout box').not.toBeNull();
    const vw = 360;
    // Hard contract: the panel must not overflow the viewport horizontally.
    expect(box!.x).toBeGreaterThanOrEqual(-2);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 2);

    const ratio = box!.width / vw;
    await testInfo.attach('dock-width-ratio', { body: `panel ${Math.round(box!.width)}px / ${vw}px = ${(ratio * 100).toFixed(0)}%`, contentType: 'text/plain' });
    // eslint-disable-next-line no-console
    console.log(`[T045] compact dock panel width: ${Math.round(box!.width)}px (${(ratio * 100).toFixed(0)}% of ${vw}px viewport)`);
    // Reflow contract: on a 360px phone the panel should occupy most of the width.
    expect(ratio, `dock panel only ${(ratio * 100).toFixed(0)}% of viewport on compact`).toBeGreaterThanOrEqual(0.8);
  });
});
