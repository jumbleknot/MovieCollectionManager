# Quickstart: validating the search-cancel fix

**Feature**: `050-fix-search-cancel-exit` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

How to see the bug, then prove it is gone. Every command below is run from the repository root
unless stated otherwise.

## Prerequisites

- The devcontainer (or an equivalent host toolchain) — see [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md).
- The agent's Python environment resolves on first use via `uv`; no manual setup step is needed.
- The E2E steps additionally need the local stacks up — see [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md). The unit steps need nothing running.

## 1. See the bug (no code changes, no stack)

This is the whole defect in one command. It drives the real search node with stub reads, in the
state the movie card leaves behind (no search stage), with the value the cancel button posts.

```bash
cd agents/movie-assistant && uv run python - <<'PY'
import asyncio
from langchain_core.messages import HumanMessage
from src.nodes.search import build_search_node

COLLS = [{"collectionId": "wish", "name": "Wish List", "isDefault": True}]
reads = []

async def list_collections(): return COLLS
async def list_movies(cid, term): reads.append((cid, term)); return []
async def web_search(q, y): reads.append(("web", q)); return {"results": []}

async def main():
    node = build_search_node(list_collections=list_collections,
                            list_movies=list_movies, web_search=web_search)
    out = await node({"messages": [HumanMessage(content="exit search")]})
    print("REPLY:              ", out["messages"][-1].content)
    print("TOOL CALLS:         ", [c["name"] for c in (out["messages"][-1].tool_calls or [])])
    print("READS PERFORMED:    ", reads)
    print("search_stage after: ", repr(out.get("search_stage")))

asyncio.run(main())
PY
```

**Expected on `main` (the bug), measured 2026-08-09:**

```text
REPLY:               I couldn't find "exit search" in your "Wish List" collection. Want to look elsewhere?
TOOL CALLS:          ['render_selection']
READS PERFORMED:     [('wish', 'exit search')]
search_stage after:  'awaiting_pick'
```

**Expected after the fix:**

```text
REPLY:               Okay — exited search.
TOOL CALLS:          []
READS PERFORMED:     []
search_stage after:  ''
```

Note the last two lines especially: a correct cancel performs **no read at all** and leaves the
workflow **cleared**, not re-entered.

## 2. Unit tier — the regression tests

```bash
# The primary RED: a cancel with no live search stage must exit.
pnpm nx run movie-assistant:test -- tests/unit/test_state_machine_transitions.py -k cancel -q

# Routing is deterministic — the classifier is never consulted for a cancel (FR-010).
pnpm nx run movie-assistant:test -- tests/unit/test_graph.py -k cancel -q

# The reply itself: acknowledges, names no collection, offers no continuation (FR-002/003/007).
pnpm nx run movie-assistant:test -- tests/unit/test_search.py -k cancel -q
```

**Before the fix**: each of the three reports failures. Confirm the *count* is non-zero — a
selector that matches nothing also prints no failures, which is not a RED.

**After the fix**: `0 failed`, with a non-zero collected count in each.

Then the whole unit suite, to prove nothing else moved:

```bash
pnpm nx run movie-assistant:test
```

## 3. Lint and type checks

```bash
pnpm nx run movie-assistant:lint     # ruff + mypy, both must be clean
```

## 4. Client tier

The client's behaviour does not change; this run confirms it still posts the canonical value, which
is one half of the [cancel control contract](./contracts/search-cancel-control.md).

```bash
pnpm nx run mcm-app:test -- render-movie-card
```

## 5. E2E tier — web

```bash
pnpm nx run mcm-app:e2e -- --grep "cancel from the web card"
```

The existing test passes on the broken code, so **it must be seen to fail first**. Run it before
the fix with the strengthened assertion in place; if it is green at that point the assertion is
still not testing the assistant's reply and must be corrected before proceeding.

## 6. E2E tier — mobile

```bash
# See docs/runbooks/android-emulator.md for bringing the emulator up.
pnpm nx run mcm-app:e2e-mobile -- --flow tests/e2e/mobile/agent-search.yaml
```

Covers FR-008 / US3: the same acknowledgement, from the same agent-side fix.

## 7. Manual check (the reported path, end to end)

1. Sign in and open a collection so it is the on-screen context — the bug needs an on-screen
   collection to name, and this is where the reporter hit it.
2. Open the assistant dock and search for a movie you do not own, e.g. `find Inception`.
3. Choose **Search the web**, then pick a result. A movie card appears.
4. Press **Cancel** on the card.

**Pass**: a brief acknowledgement that the search has ended. **Fail**: any mention of a collection,
any "couldn't find", or any further set of search buttons.

5. Send an unrelated message, e.g. `how many movies do I have`. It must be answered on its own
   terms, with no reference to the cancelled search (FR-006).

## What "done" means

Every box below, per [spec.md § Success Criteria](./spec.md) and
[openwiki/invariants/feature-validation-checklist.md](../../openwiki/invariants/feature-validation-checklist.md):

- [ ] Step 1 prints the post-fix output — empty reads, empty tool calls, cleared stage
- [ ] All three unit selectors went RED before the fix and are GREEN after, with non-zero counts
- [ ] Full `movie-assistant:test` suite green
- [ ] `movie-assistant:lint` clean (ruff + mypy)
- [ ] Client component test green
- [ ] Web E2E seen RED with the strengthened assertion, then GREEN
- [ ] Mobile flow green
- [ ] Manual check passes on the reported path
- [ ] Backlog item #149's acceptance criterion verified before the item is closed
