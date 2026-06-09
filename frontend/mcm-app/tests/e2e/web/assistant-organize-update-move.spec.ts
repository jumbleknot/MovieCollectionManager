/**
 * T070 (web E2E): Organize update + move by conversation — the US2 update/move slice end-to-end.
 *
 * In-place update ("mark X as owned") and cross-collection move ("move X from A to B") each plan
 * a change, preview it behind an explicit approval (nothing changes pre-approval, FR-007), and on
 * approval apply it: update PUTs the full-replacement payload; move adds-to-dest then
 * removes-from-source. Drives the full live stack: CopilotKit dock → BFF /run → production-node
 * gateway → Ollama plan → movie-mcp update/add/delete → mc-service. Verified via the BFF.
 *
 * Requires the FULL agent stack (HANDOFF.md) + E2E_AGENT_PRODUCTION=1 (host gateway :8123 with the
 * T070 organizer). Each test seeds its own collection(s) via the BFF and tears them down.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-organize-update-move.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;

function movieBody(title: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title,
    year: 1999,
    contentType: 'Movie',
    language: 'English',
    owned: true,
    ripped: false,
    childrens: false,
    ownedMedia: [],
    ripQuality: [],
    genres: ['Sci-Fi'],
    rated: 'R',
    directors: [],
    actors: [],
    tags: [],
    movieSet: null,
    originalTitle: null,
    releaseDate: null,
    outline: null,
    plot: null,
    runtime: null,
    externalIds: [],
    ...overrides,
  };
}

async function seedCollection(
  request: APIRequestContext,
  name: string,
  movies: Record<string, unknown>[],
): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  const collectionId = (await res.json()).collectionId as string;
  for (const body of movies) {
    const m = await request.post(`/bff-api/collections/${collectionId}/movies`, { data: body });
    expect(m.ok()).toBeTruthy();
  }
  return collectionId;
}

async function movies(
  request: APIRequestContext,
  collectionId: string,
): Promise<{ title: string; owned: boolean }[]> {
  const res = await request.get(`/bff-api/collections/${collectionId}/movies`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()).items ?? []) as { title: string; owned: boolean }[];
}

async function movieTitles(request: APIRequestContext, collectionId: string): Promise<Set<string>> {
  return new Set((await movies(request, collectionId)).map((m) => m.title));
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', {
    state: 'visible',
    timeout: 60000,
  });
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid="assistant-dock-input"]', text);
  await page.click('[data-testid="assistant-dock-send"]');
}

async function approveAndAwaitDone(page: Page): Promise<void> {
  const approval = page.locator('[data-testid="approval-request"]');
  await expect(approval).toBeVisible({ timeout: PREVIEW_TIMEOUT });
  await page.click('[data-testid="approval-approve"]');
  await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText('Done', {
    timeout: DONE_TIMEOUT,
  });
}

test.describe('Assistant organize update + move (feature 012, US2 / T070)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('in-place update → preview → approve flips the owned flag', async ({ page, request }) => {
    test.setTimeout(360_000);
    const name = `t070-upd-${Date.now()}`;
    const collectionId = await seedCollection(request, name, [movieBody('Zorgon', { owned: false })]);

    await gotoHome(page);
    await openDock(page);
    await send(page, `mark Zorgon as owned in ${name}`);

    // The preview appears behind the approval gate — nothing changed yet (FR-007).
    await expect(page.locator('[data-testid="approval-request"]')).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    expect((await movies(request, collectionId)).find((m) => m.title === 'Zorgon')?.owned).toBe(false);

    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText('Done', {
      timeout: DONE_TIMEOUT,
    });

    // Approval applied the full-replacement update — the flag flipped, the title is preserved.
    const after = await movies(request, collectionId);
    expect(after.find((m) => m.title === 'Zorgon')?.owned).toBe(true);
  });

  test('cross-collection move → preview → approve relocates the movie', async ({ page, request }) => {
    test.setTimeout(360_000);
    const src = `t070-mv-src-${Date.now()}`;
    const dst = `t070-mv-dst-${Date.now()}`;
    const srcId = await seedCollection(request, src, [movieBody('Zorgon'), movieBody('Blarnix')]);
    const dstId = await seedCollection(request, dst, []);

    await gotoHome(page);
    await openDock(page);
    await send(page, `move Zorgon from ${src} to ${dst}`);

    // Nothing moves before approval (FR-007).
    await expect(page.locator('[data-testid="approval-request"]')).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    expect(await movieTitles(request, srcId)).toEqual(new Set(['Zorgon', 'Blarnix']));
    expect(await movieTitles(request, dstId)).toEqual(new Set());

    await approveAndAwaitDone(page);

    // The movie left the source and arrived in the destination (US2-AC2).
    expect(await movieTitles(request, srcId)).toEqual(new Set(['Blarnix']));
    expect(await movieTitles(request, dstId)).toEqual(new Set(['Zorgon']));
  });
});
