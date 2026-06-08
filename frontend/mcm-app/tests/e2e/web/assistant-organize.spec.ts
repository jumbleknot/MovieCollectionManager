/**
 * T048 (web E2E): Organize a collection by conversation — the US2 journey end-to-end.
 *
 * Multi-item remove → the assistant plans a batch, previews it behind an explicit approval
 * (nothing removed pre-approval), and on approval removes exactly the planned movies (FR-006/
 * 007, US2-AC1/2; SC-001 web leg). Drives the full live stack: CopilotKit dock → BFF /run →
 * production-node gateway → Ollama plan → movie-mcp list/delete → mc-service. Verified via BFF.
 *
 * Requires the FULL agent stack (HANDOFF.md) + E2E_AGENT_PRODUCTION=1 (host gateway :8123 with
 * the organize nodes). The test seeds its own collection + movies via the BFF and tears it down.
 *
 * Determinism: the seeded titles are simple + distinct so the Ollama plan extractor resolves
 * them reliably; the remove resolution + apply are pure code.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-organize.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;

function movieBody(title: string): Record<string, unknown> {
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
  };
}

async function seedCollection(
  request: APIRequestContext,
  name: string,
  titles: string[],
): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  const collectionId = (await res.json()).collectionId as string;
  for (const title of titles) {
    const m = await request.post(`/bff-api/collections/${collectionId}/movies`, {
      data: movieBody(title),
    });
    expect(m.ok()).toBeTruthy();
  }
  return collectionId;
}

async function movieTitles(request: APIRequestContext, collectionId: string): Promise<Set<string>> {
  const res = await request.get(`/bff-api/collections/${collectionId}/movies`);
  expect(res.ok()).toBeTruthy();
  const items = ((await res.json()).items ?? []) as { title: string }[];
  return new Set(items.map((m) => m.title));
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

test.describe('Assistant organize flow (feature 012, US2 / T048)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('multi-item remove → batch preview → approve removes exactly the planned movies', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t048-org-${Date.now()}`;
    const collectionId = await seedCollection(request, name, ['Zorgon', 'Blarnix', 'Quaffle']);

    await gotoHome(page);
    await openDock(page);
    await send(page, `remove Zorgon and Quaffle from ${name}`);

    // The batch preview appears behind the approval gate — nothing removed yet.
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    expect(await movieTitles(request, collectionId)).toEqual(
      new Set(['Zorgon', 'Blarnix', 'Quaffle']),
    );

    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      'Done',
      { timeout: DONE_TIMEOUT },
    );

    // Exactly the two planned movies are gone; the third remains (US2-AC2).
    expect(await movieTitles(request, collectionId)).toEqual(new Set(['Blarnix']));
  });
});
