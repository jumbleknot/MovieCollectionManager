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

  test('add from TMDB → "Do you own this?" → No → added owned=false → lands on the detail screen', { tag: '@model-decision' }, async ({
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
    // ── 059 US2: the children's question comes FIRST, before ownership ───────────────
    // Answered here so the rest of this test walks the flow it was written for. That the
    // question appears, and appears before ownership, is asserted by the dedicated tests below.
    await answerYesNo(page, /children/i, 'No');
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

  /**
   * Answer a Yes/No question rendered as selection controls.
   *
   * 059 US2 added a SECOND Yes/No question, ahead of the ownership one, rendered by the same
   * `selection-options` control. `asks` pins which question is being answered: without it a bare
   * `.last()` can match the previous question's control while it is still mounted, so the answer
   * lands on an already-answered question and the flow stalls in a way that reads as a model
   * failure rather than a test bug.
   */
  async function answerYesNo(
    page: Page,
    asks: string | RegExp,
    answer: 'Yes' | 'No',
  ): Promise<void> {
    await expect(page.getByTestId('assistant-dock-panel')).toContainText(asks, {
      timeout: OWNERSHIP_TIMEOUT,
    });
    const options = page.locator('[data-testid="selection-options"]').last();
    await expect(options).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
    await options
      .locator('[data-testid^="selection-option-control-"]')
      .filter({ hasText: new RegExp(`^${answer}$`) })
      .first()
      .click();
  }

  test('typed add → yes → formats → ripped → qualities → the movie carries exactly those values (US4-AC2..AC6)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t047own${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // ── 059 US2: the children's question comes FIRST, before ownership ───────────────
    // Answered here so the rest of this test walks the flow it was written for. That the
    // question appears, and appears before ownership, is asserted by the dedicated tests below.
    await answerYesNo(page, /children/i, 'No');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Do you own', 'Yes');

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
    await answerYesNo(page, 'ripped', 'Yes');
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

  test('zero formats confirmed → still added as owned with none recorded (US4-AC8)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t047zero${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // ── 059 US2: the children's question comes FIRST, before ownership ───────────────
    // Answered here so the rest of this test walks the flow it was written for. That the
    // question appears, and appears before ownership, is asserted by the dedicated tests below.
    await answerYesNo(page, /children/i, 'No');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Do you own', 'Yes');

    // Confirm with nothing selected — a valid answer, not a no-op.
    await chooseAndConfirm(page, []);
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('ripped', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'ripped', 'No');

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

  test('typed answers reach the same result as tapping (FR-036)', { tag: '@model-decision' }, async ({ page, request }) => {
    test.setTimeout(900_000);
    const name = `t047typed${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // ── 059 US2: the children's question comes FIRST — and this test types every answer ──
    await expect(page.getByTestId('assistant-dock-panel')).toContainText(/children/i, {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await send(page, 'no');
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

  // ── 059 US2: the children's question, and where it sits in the chain ─────────────────────
  //
  // Before this feature `to_movie_payload` hardcoded `"childrens": False`, so every movie the
  // assistant added was recorded as not-a-children's-movie whether it is one or not, and the
  // member was never asked (backlog item #162). The answer now comes from them.
  //
  // ORDERING is the guarantee, so it is asserted directly: the question must appear, and appear
  // BEFORE "Do you own this?". The tests above answer it in passing; these are the ones that
  // would notice if it stopped being asked, or drifted to the end of the chain where a member
  // has already been asked four things.

  /** The panel's full text so far — used to assert which question came first. */
  async function panelText(page: Page): Promise<string> {
    return (await page.getByTestId('assistant-dock-panel').innerText()) ?? '';
  }

  test('the children\'s question is asked BEFORE ownership on a typed add (US2-AC1, FR-008a)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t059order${Date.now()}`;
    await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // The children's question, and NOT yet the ownership one. Asserting the absence of "Do you
    // own" at this moment is what makes this an ORDERING test rather than a presence test — a
    // chain that asked both, in the other order, would satisfy a presence check.
    await expect(page.getByTestId('assistant-dock-panel')).toContainText(/children/i, {
      timeout: OWNERSHIP_TIMEOUT,
    });
    expect(await panelText(page)).not.toContain('Do you own');
    // Nothing written, nothing proposed.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);

    await answerYesNo(page, /children/i, 'Yes');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
  });

  test('the children\'s question is asked before ownership on a card add too (US2-AC1)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t059card${Date.now()}`;
    await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    // An AMBIGUOUS title routes through the curator's candidate cards first; picking one resolves
    // the add. The question must open the chain on this path as well — the two paths reach the
    // organizer differently, and a question wired into only one of them is the kind of gap that
    // shows up as "some of my movies have it and some don't".
    await send(page, `add Pirates of the Caribbean to my collection ${name}`);
    const cards = page.locator('[data-testid="disambiguation-options"]').last();
    await expect(cards).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
    await page.locator('[data-testid="disambig-option-0"]').last().click();

    await expect(page.getByTestId('assistant-dock-panel')).toContainText(/children/i, {
      timeout: OWNERSHIP_TIMEOUT,
    });
    expect(await panelText(page)).not.toContain('Do you own');
  });

  test('the children\'s question is answerable by TAPPING only, and by TYPING only, with the same result (FR-012, SC-005)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    // Deliberately NOT folded into the existing "typed answers reach the same result as tapping"
    // test above: that one covers the 047 questions, and updating it to pass is not the same as
    // asserting the new one. Both halves run here, against two collections, and the resulting
    // movies are compared field-for-field.
    const tapName = `t059tap${Date.now()}`;
    const typeName = `t059type${Date.now()}`;
    const tapId = await seedCollection(request, tapName);
    const typeId = await seedCollection(request, typeName);

    await gotoHome(page);
    await openDock(page);

    // ── Half 1: every answer TAPPED ──────────────────────────────────────────────────
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${tapName}`);
    await answerYesNo(page, /children/i, 'Yes');
    await answerYesNo(page, 'Do you own', 'No');
    const tapApproval = page.locator('[data-testid="approval-request"]');
    await expect(tapApproval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');
    await page.waitForURL(new RegExp(`/collections/${tapId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    // ── Half 2: the same answers TYPED ───────────────────────────────────────────────
    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${typeName}`);
    await expect(page.getByTestId('assistant-dock-panel')).toContainText(/children/i, {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await send(page, 'yes');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await send(page, 'no');
    const typeApproval = page.locator('[data-testid="approval-request"]');
    await expect(typeApproval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');
    await page.waitForURL(new RegExp(`/collections/${typeId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    // ── The two movies must agree ────────────────────────────────────────────────────
    const read = async (id: string) => {
      const res = await request.get(`/bff-api/collections/${id}/movies`);
      expect(res.ok()).toBeTruthy();
      return ((await res.json()).items ?? []) as Array<{
        title: string;
        childrens: boolean;
        owned: boolean;
      }>;
    };
    const tapped = await read(tapId);
    const typed = await read(typeId);
    expect(tapped).toHaveLength(1);
    expect(typed).toHaveLength(1);
    expect(tapped[0].childrens).toBe(true);
    expect(typed[0].childrens).toBe(true);
    expect(typed[0].childrens).toBe(tapped[0].childrens);
    expect(typed[0].owned).toBe(tapped[0].owned);
  });

  test('answering No records No — not the old hardcoded default by coincidence (US2-AC2)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    // The "Yes" answer is the one that proves the value is read from the member. This asserts the
    // other branch reaches the write intact rather than arriving at False by the route the bug
    // took — the flow is walked, not the default trusted.
    const name = `t059no${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);
    await answerYesNo(page, /children/i, 'No');
    await answerYesNo(page, 'Do you own', 'No');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');
    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    const res = await request.get(`/bff-api/collections/${collectionId}/movies`);
    const movies = ((await res.json()).items ?? []) as Array<{ childrens: boolean }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].childrens).toBe(false);
  });

  test('abandoning at the children\'s question adds nothing (US2-AC4)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t059abandon${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);
    await expect(page.getByTestId('assistant-dock-panel')).toContainText(/children/i, {
      timeout: OWNERSHIP_TIMEOUT,
    });

    // Walk away at the very first question with an unrelated request.
    await send(page, `how many movies do I have in ${name}`);

    // No approval is ever offered and nothing is written — the new question moved the earliest
    // abandonment point one turn earlier, so this is a different moment from US4-AC7 below.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0, {
      timeout: APPROVAL_TIMEOUT,
    });
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(((await moviesRes.json()).items ?? []).length).toBe(0);
  });

  // ── 059 US1: the movie is added with the film's REAL certification ───────────────────────
  //
  // The reported defect (item #163): `to_movie_payload` hardcoded "rated": "NR", so every movie
  // the assistant added claimed to be not-rated whatever it actually was. The certification now
  // comes from TMDB's release-dates block, appended to the details call web-api-mcp already made.
  //
  // These two tests exist for what the unit tiers CANNOT reach: that mc-service accepts the value
  // on the real write path. A real rating and — the case that would 422 if `rated` were dropped
  // rather than sent as null — a film with no US certification at all.

  /** Both films are search-`exact` against live TMDB (measured 2026-08-15), so the flow never
   *  detours through disambiguation. Pets 2 publishes `PG`, `PG`; Nightless Night has no US
   *  release-date block at all. */
  const RATED_MOVIE = { title: 'The Secret Life of Pets 2', year: 2019, rated: 'PG' };
  const UNRATED_MOVIE = { title: 'Nightless Night', year: 2023 };

  test('added movie carries the film\'s real certification, not a fabricated "NR" (SC-001, item #163)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t059rated${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${RATED_MOVIE.title} (${RATED_MOVIE.year}) to my collection ${name}`);

    // ── 059 US2: the children's question comes FIRST, before ownership ───────────────
    // Answered here so the rest of this test walks the flow it was written for. That the
    // question appears, and appears before ownership, is asserted by the dedicated tests below.
    await answerYesNo(page, /children/i, 'No');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Do you own', 'No');

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
      rated: string | null;
    }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].title).toBe(RATED_MOVIE.title);
    // The whole point: PG, from the source — and specifically NOT the old literal.
    expect(movies[0].rated).toBe(RATED_MOVIE.rated);
    expect(movies[0].rated).not.toBe('NR');

    // And the member sees it on the detail screen they were just navigated to.
    await expect(page.getByTestId('movie-detail-back-button')).toBeVisible({ timeout: NAV_TIMEOUT });
  });

  test('a film with no US certification is added successfully with a blank rating (US1-AC4, SC-003)', { tag: '@model-decision' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const name = `t059norating${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${UNRATED_MOVIE.title} (${UNRATED_MOVIE.year}) to my collection ${name}`);

    // ── 059 US2: the children's question comes FIRST, before ownership ───────────────
    // Answered here so the rest of this test walks the flow it was written for. That the
    // question appears, and appears before ownership, is asserted by the dedicated tests below.
    await answerYesNo(page, /children/i, 'No');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Do you own', 'No');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');

    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });

    // The add SUCCEEDED — an unknown rating must never cost the member the add (US1-AC4). This is
    // the assertion that proves mc-service accepts `"rated": null` on the real write path: the key
    // is sent as null rather than omitted, because CreateMovieDto would 422 an omission.
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const movies = ((await moviesRes.json()).items ?? []) as Array<{
      title: string;
      rated: string | null;
    }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].title).toBe(UNRATED_MOVIE.title);
    expect(movies[0].rated ?? null).toBeNull();
  });

  test('abandoning mid-chain adds nothing (US4-AC7)', { tag: '@model-decision' }, async ({ page, request }) => {
    test.setTimeout(900_000);
    const name = `t047abandon${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // ── 059 US2: the children's question comes FIRST, before ownership ───────────────
    // Answered here so the rest of this test walks the flow it was written for. That the
    // question appears, and appears before ownership, is asserted by the dedicated tests below.
    await answerYesNo(page, /children/i, 'No');
    await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
      timeout: OWNERSHIP_TIMEOUT,
    });
    await answerYesNo(page, 'Do you own', 'Yes');
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
