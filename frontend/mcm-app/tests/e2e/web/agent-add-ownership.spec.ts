/**
 * T045 (web E2E, 040 US4 / Item 2): TMDB add asks ownership + navigates to the movie detail.
 *
 * The add-from-TMDB flow now asks "Do you own this movie?" (Yes/No buttons) BEFORE the approval
 * gate; answering "No" builds the proposal with owned=false; approving adds the movie AND the
 * assistant navigates to that movie's detail screen (navigate_to_movie with the created movieId).
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → intent
 * classify (add) → curator TMDB enrich → organizer ownership question (render_selection) → tap
 * "No" → HITL approval → movie-mcp add (owned=false) → navigate_to_movie UI-action → router.push.
 *
 * IMPORTANT (research R15 / CLAUDE.md): the dock is driven IN-APP from /home. Requires the FULL
 * agent stack + E2E_AGENT_PRODUCTION=1 + a runnable dock config (TMDB key for enrichment).
 *
 * Run: node scripts/agent-e2e.mjs agent-add-ownership
 */
import { test, expect } from './fixtures/worker-session';
import { type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { requireAgentStack } from './setup/agent-stack-gate';
import { cleanupOwnedCollections, ownCollection } from './setup/e2e-cleanup';

const OWNERSHIP_TIMEOUT = 180_000;
const APPROVAL_TIMEOUT = 150_000;
const NAV_TIMEOUT = 90_000;

// A real TMDB title (also used by assistant-add) so curator enrichment resolves deterministically.
const MOVIE_TITLE = 'Coherence';

async function seedCollection(request: APIRequestContext, name: string): Promise<string> {
  ownCollection(name);
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).collectionId as string;
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', {
    state: 'visible',
    timeout: 60000,
  });
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', {
    state: 'visible',
    timeout: 60000,
  });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', {
    state: 'visible',
    timeout: 10000,
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid="assistant-dock-input"]', text);
  await page.click('[data-testid="assistant-dock-send"]');
}

test.describe('Assistant TMDB add — ownership + detail navigation (040 US4)', () => {
  requireAgentStack(test);

  test.afterEach(async ({ request }) => {
    await cleanupOwnedCollections(request);
  });

  test('add from TMDB → "Do you own this?" → No → added owned=false → lands on the detail screen', async ({
    page,
    request,
  }) => {
    // TMDB enrichment + two model turns + the apply round — this file is legitimately slow.
    test.setTimeout(600_000);
    const name = `t040own${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // ── The ownership question (Yes/No) appears BEFORE the approval gate ─────────────
    // The question is an assistant MESSAGE ('Do you own "<title>"?'); its Yes/No options render
    // via `render_selection` (kind "ownership" → non-pickable ⇒ the `control` button group) in the
    // `selection-options` component — not the curator's `disambiguation-options`.
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    const options = page.locator('[data-testid="selection-options"]').last();
    await expect(options).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
    // Nothing is written yet, and the approval card hasn't been offered.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);

    // ── Answer "No" (not owned) ──────────────────────────────────────────────────────
    await options
      .locator('[data-testid^="selection-option-control-"]')
      .filter({ hasText: /^No$/ })
      .first()
      .click();

    // ── The add proposal is then surfaced for approval; approve it ───────────────────
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await expect(approval).toContainText(MOVIE_TITLE);
    await page.click('[data-testid="approval-approve"]');

    // ── The assistant navigates to the newly-added movie's detail screen ─────────────
    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });
    await expect(page.locator('[data-testid="movie-detail-back-button"]')).toBeVisible({
      timeout: NAV_TIMEOUT,
    });

    // ── The movie was persisted with owned=false ─────────────────────────────────────
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const movies = ((await moviesRes.json()).items ?? []) as Array<{ title: string; owned: boolean }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].title).toBe(MOVIE_TITLE);
    expect(movies[0].owned).toBe(false);
  });

  // ── 047 US4: the ownership follow-up chain ───────────────────────────────────────────────
  //
  // Answering "Yes" now opens a chain — media formats → ripped → rip qualities — before the
  // approval gate, so the member confirms ONE complete change instead of an add followed by an
  // edit. The option values are published by mc-service (GET /api/v1/movie-metadata) and reach
  // the client through the agent; nothing in the app or the agent holds a copy of them.

  const MULTI = '[data-testid="multi-select-options"]';

  /** Toggle the named options in a multi-select, then confirm. */
  async function chooseAndConfirm(page: Page, labels: string[]): Promise<void> {
    const list = page.locator(MULTI).last();
    await expect(list).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
    for (const label of labels) {
      await list.locator('[data-testid^="multi-select-option-"]').filter({ hasText: label }).first().click();
    }
    await list.locator('[data-testid="multi-select-confirm"]').click();
  }

  /** Answer a Yes/No question rendered as selection controls. */
  async function answerYesNo(page: Page, answer: 'Yes' | 'No'): Promise<void> {
    const options = page.locator('[data-testid="selection-options"]').last();
    await expect(options).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
    await options
      .locator('[data-testid^="selection-option-control-"]')
      .filter({ hasText: new RegExp(`^${answer}$`) })
      .first()
      .click();
  }

  test('typed add → yes → formats → ripped → qualities → the movie carries exactly those values (US4-AC2..AC6)', async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t047own${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Yes');

    // US4-AC2/AC3: the format toggle list, with two on and one turned back off.
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Which formats', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await chooseAndConfirm(page, ['DVD', 'Blu-Ray 3D', 'Blu-Ray 3D']); // toggled on then off
    // Only DVD remains selected.

    // US4-AC5: ripped → yes → the rip-quality toggle list.
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('ripped', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Yes');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('qualities', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await chooseAndConfirm(page, ['UHD Blu-Ray']);

    // US4-AC6: one approval for the whole change.
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');

    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const movies = ((await moviesRes.json()).items ?? []) as Array<{
      title: string;
      owned: boolean;
      ripped: boolean;
      ownedMedia: string[];
      ripQuality: string[];
    }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].owned).toBe(true);
    expect(movies[0].ripped).toBe(true);
    // EXACTLY the chosen values — the toggled-off format must not survive (US4-AC3).
    expect(movies[0].ownedMedia).toEqual(['DVD']);
    expect(movies[0].ripQuality).toEqual(['UHD Blu-Ray']);
  });

  test('zero formats confirmed → still added as owned with none recorded (US4-AC8)', async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t047zero${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Yes');

    // Confirm with nothing selected — a valid answer, not a no-op.
    await chooseAndConfirm(page, []);
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('ripped', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'No');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');

    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    const movies = ((await moviesRes.json()).items ?? []) as Array<{
      owned: boolean;
      ripped: boolean;
      ownedMedia: string[];
      ripQuality: string[];
    }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].owned).toBe(true);
    expect(movies[0].ownedMedia).toEqual([]);
    expect(movies[0].ripped).toBe(false);
    expect(movies[0].ripQuality).toEqual([]);
  });

  test('typed answers reach the same result as tapping (FR-036)', async ({ page, request }) => {
    test.setTimeout(900_000);
    const name = `t047typed${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    // Every answer TYPED — no step of this flow may be reachable only by tapping.
    await send(page, 'yes');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Which formats', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await send(page, 'dvd and blu-ray');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('ripped', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await send(page, 'no');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');

    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    const movies = ((await moviesRes.json()).items ?? []) as Array<{
      owned: boolean;
      ownedMedia: string[];
    }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].owned).toBe(true);
    // Canonical domain casing, whatever the member typed.
    expect(movies[0].ownedMedia).toEqual(['DVD', 'Blu-Ray']);
  });

  test('abandoning mid-chain adds nothing (US4-AC7)', async ({ page, request }) => {
    test.setTimeout(900_000);
    const name = `t047abandon${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Yes');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Which formats', {
      timeout: OWNERSHIP_TIMEOUT,
    });

    // Walk away mid-chain with an unrelated request.
    await send(page, `how many movies do I have in ${name}`);

    // No approval is ever offered and nothing is written.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0, {
      timeout: APPROVAL_TIMEOUT,
    });
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(((await moviesRes.json()).items ?? []).length).toBe(0);
  });
});
