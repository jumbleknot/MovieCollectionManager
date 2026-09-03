/**
 * Waiting for a TURN, not for a branch (064 US3, item #337).
 *
 * ## The rule this exists to make expressible
 *
 * `openwiki/invariants/testing-tiers.md`: a `@gate` assertion may block a merge only if the same
 * code and the same prompt cannot produce a different verdict on a re-run. Item #323 established
 * half of that — do not assert on the model's WORDING — and its replacement for a prose wait was to
 * count assistant replies and poll for the count to rise. Item #337 found the other half: a stable
 * testid is NOT sufficient either, because an element that renders only on one BRANCH is a decision
 * wearing an affordance's clothes.
 *
 * So: **wait for the turn, then look at what the turn produced.** The model must answer something;
 * it need not answer anything in particular, and it need not route the request to the node you had
 * in mind.
 *
 * ## Why the count comes from the app, not from a locator count here
 *
 * The mobile suite has no tier split, so `@model-decision` does not exist there — which is what made
 * item #337 a design task rather than a relabelling. Maestro cannot count elements, so the count has
 * to be in the tree for BOTH runners to read: the dock renders `assistant-turn-<n>`
 * (`assistant-dock.tsx`), Playwright resolves it as a locator and Maestro as an `id:`. The mobile
 * mirror of this file is `tests/e2e/mobile/_await-turn.yaml`.
 *
 * The marker counts exactly the `assistant-msg-assistant` nodes on screen — a tool-call-only message
 * renders a card or a button row, not a bubble, and is not an answer. `assistant-dock-turn-marker.test.tsx`
 * pins that the two measures agree; if they drifted, the web helper and the mobile sub-flow would be
 * waiting for different things.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * ## The one turn shape this does NOT see
 *
 * A turn that ends in an approval interrupt and nothing else renders `import-preview` /
 * `approval-request` through `useApprovalInterrupt`, which is not a dock item and not a bubble — so
 * the count does not rise. That shape is fine to wait for directly: an approval card is an
 * app-rendered affordance, not a branch, and `agent-import.spec.ts` correctly waits on it. Use this
 * helper where the question is "did the assistant answer", not "did the approval gate open".
 */

/**
 * How long one live turn may take.
 *
 * The same 150 s the branch waits used, and for the same reason: a cold gateway graph build plus a
 * multi-tool turn against a live provider. The difference is what is being waited FOR — a reply
 * that must arrive, rather than a branch that may not be taken.
 */
export const TURN_TIMEOUT = 150_000;

/** How many replies the assistant has given so far. */
async function replyCount(page: Page): Promise<number> {
  return page.locator('[data-testid="assistant-msg-assistant"]').count();
}

/**
 * Take a reading BEFORE sending, so the wait is "one more than there were" rather than "at least
 * one". A test that sends a second turn would otherwise pass instantly against the first reply.
 */
export async function beginTurn(page: Page): Promise<number> {
  return replyCount(page);
}

/**
 * Wait until the assistant has answered the turn that began at `before`.
 *
 * Model-INVARIANT: it does not care which intent the supervisor classified, which node answered, or
 * which affordance was rendered. Those are exactly the things that vary on a re-run.
 */
export async function awaitTurn(page: Page, before: number, timeout = TURN_TIMEOUT): Promise<void> {
  await expect
    .poll(() => replyCount(page), {
      timeout,
      message:
        'the assistant did not answer this turn at all — this is a TURN failure, not a branch '
        + 'failure. The gateway logs one `turn routed: intent=… node=… thread=…` line per turn '
        + '(064 US2); no line means no turn arrived, which is what a dropped client send looks like.',
    })
    .toBeGreaterThan(before);
}

/** Send a message through the dock and wait for the reply, in one step. */
export async function sendAndAwaitTurn(page: Page, text: string, timeout = TURN_TIMEOUT): Promise<void> {
  const before = await beginTurn(page);
  await page.fill('[data-testid="assistant-dock-input"]', text);
  await page.click('[data-testid="assistant-dock-send"]');
  await awaitTurn(page, before, timeout);
}

/**
 * The selection buttons this turn offered, or `null` if it offered none.
 *
 * Call this only AFTER `awaitTurn`. The turn is already complete, so a short grace window is enough
 * for the tool-call render to land — a long one would just be the old branch wait wearing a new
 * name, spending 150 s to discover that a branch was not taken.
 */
export async function offeredSelection(page: Page, grace = 5_000): Promise<Locator | null> {
  const options = page.locator('[data-testid="selection-options"]').last();
  try {
    await options.waitFor({ state: 'visible', timeout: grace });
    return options;
  } catch {
    return null;
  }
}

/**
 * Fail with the diagnosis rather than with "element not found".
 *
 * Used where the alternative branch cannot reach the test's end state. The point is not to keep the
 * test green — it is to make the red READABLE: the old failure said only that `selection-options`
 * never appeared after 150 s, which was true of a dropped turn, a differently-routed turn and a
 * genuinely different decision alike. Three sessions read it as the third.
 */
export function branchNotOffered(what: string): string {
  return (
    `the assistant answered this turn, but did not offer ${what}.\n`
    + 'The turn ARRIVED (the reply count rose), so this is not the dropped-send defect of item #337. '
    + 'Read the gateway line `turn routed: intent=… node=… thread=…` for the turn at this timestamp: '
    + 'a different `intent=` means the supervisor classified the utterance differently, which is a '
    + 'model decision and belongs in @model-decision; the expected intent means the node took its '
    + 'other branch, which is pure code and is a real defect.'
  );
}
