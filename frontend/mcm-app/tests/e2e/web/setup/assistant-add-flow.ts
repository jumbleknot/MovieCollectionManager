/**
 * The ownership turn that every assistant-mediated add goes through (040 US4, extended by 047 US4).
 *
 * WHY THIS EXISTS. Feature 040 US4 put a question between "add <movie> to <collection>" and the
 * HITL approval card: the organizer resolves the target, then asks `Do you own "<title>"?` and
 * waits ([organizer.py](../../../../../agents/movie-assistant/src/nodes/organizer.py) —
 * `_ask_ownership`, reached on EVERY resolved add). The approval card is only built on the reply.
 * A spec that sends the add request and waits directly for `approval-request` therefore waits for
 * an element the graph will never emit until it is answered.
 *
 * That is exactly what happened. 040's own commit recorded the web E2E leg as DEFERRED, and the
 * feature's final validation ran `pnpm nx e2e mcm-app` with 33 specs SKIPPED — including all five
 * assistant add specs, which were never re-run against the new flow. Feature 051 forwarded
 * `E2E_AGENT_PRODUCTION` into the CI Playwright container, the five stopped skipping, and all five
 * failed on the same missing `approval-request` (backlog #150, cluster A). The specs were stale;
 * the product was not.
 *
 * Answering **"No"** is deliberate: it ends the ownership chain immediately, whereas "Yes" opens
 * 047 US4's media-formats → ripped → rip-qualities follow-ups. Specs that are about the approval
 * gate want the shortest honest route to it; the chain itself is covered by
 * `agent-add-ownership.spec.ts`, which is where a change to it should break.
 */
import { expect, type Page } from '@playwright/test';

/** TMDB enrichment + a model turn stand between the request and the question. */
export const OWNERSHIP_TIMEOUT = 180_000;

/**
 * Answer the "Do you own this movie?" question that precedes the approval gate.
 *
 * Asserts the question actually arrived before answering it, so a graph that stopped asking fails
 * here with "Do you own" not found — rather than silently proceeding and failing later on the
 * approval card, which is the ambiguous symptom this whole helper exists to remove.
 *
 * The Yes/No options render through `render_selection` (kind "ownership" → non-pickable ⇒ the
 * `control` button group) in the `selection-options` component — NOT the curator's
 * `disambiguation-options`.
 */
export async function answerOwnership(page: Page, answer: 'Yes' | 'No' = 'No'): Promise<void> {
  await expect(page.getByTestId('assistant-dock-panel')).toContainText('Do you own', {
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
