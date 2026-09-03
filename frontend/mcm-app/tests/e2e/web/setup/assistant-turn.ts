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
 * ## The mobile mirror is WEAKER, on purpose
 *
 * `tests/e2e/mobile/_await-turn.yaml` is the same idea for Maestro, which **cannot count elements**
 * — and the mobile suite has no tier split, which is what made item #337 a design task rather than a
 * relabelling. So it asserts only that an `assistant-msg-assistant` bubble EXISTS. Its callers open
 * with `clearState` and an empty dock, so for a flow's first turn that is the same statement this
 * file makes; for a later turn it is not, and those flows wait for the affordance the turn produces
 * instead of pretending to count.
 *
 * An earlier attempt rendered the count into the app (`assistant-turn-<n>`) so both runners could
 * read one number. MEASURED on CI run 2566: Android never exposed it — a 1 px `opacity: 0` View is
 * not `visibleToUser`, so it failed 3/3 while being present in the React tree throughout. Counting
 * here and existence there is the honest split, and it costs the app no test-only surface.
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
 * How long to let a turn's TOOL CALL land after its text has.
 *
 * ⚠️ A RISEN REPLY COUNT DOES NOT MEAN THE TURN IS FINISHED. The node emits text and tool call on one
 * `AIMessage`, but AG-UI streams `TEXT_MESSAGE_CONTENT` first and the tool call after — so the bubble
 * is on screen while the turn is still in flight. This was measured the expensive way on CI run 2570,
 * where the mobile mirror branched on a guard read in that gap and took the wrong path; the first
 * version of this file made the same assumption with a 5 s grace, which is the likeliest reading of
 * the two `flaky` web entries on run 2566 that were filed here as "did not offer".
 *
 * Bounded, not generous-by-default: 30 s is far longer than the render takes even under a
 * ten-worker run, and still an order of magnitude below the 150 s branch waits this replaces. The
 * point was never a shorter timeout — it was not spending the WHOLE budget discovering a branch was
 * not taken.
 */
export const OFFER_GRACE = 30_000;

/**
 * The selection buttons this turn offered, or `null` if it offered none.
 *
 * Call this only AFTER `awaitTurn`.
 */
export async function offeredSelection(page: Page, grace = OFFER_GRACE): Promise<Locator | null> {
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
    `the assistant answered this turn, but did not offer ${what} within ${OFFER_GRACE} ms.\n`
    + 'The turn ARRIVED (the reply count rose), so this is not the dropped-send defect of item #337. '
    + 'Read the gateway line `turn routed: intent=… node=… thread=…` for the turn at this timestamp '
    + 'before concluding anything — there are three distinct causes and they look identical here:\n'
    + '  1. a different `intent=` — the supervisor classified the utterance differently. A model '
    + 'decision; belongs in @model-decision, not in the gate.\n'
    + '  2. the expected `intent=` — the node took its other branch. That branch is PURE CODE in all '
    + 'three of these flows, so this is a real defect, not drift.\n'
    + '  3. no line at all — no turn reached the gateway, i.e. the client dropped the send.'
  );
}
