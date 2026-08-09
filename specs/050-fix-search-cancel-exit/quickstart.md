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

**`pnpm nx run mcm-app:e2e` does not work in the dev container** — chromium cannot be installed
here. That is a fact about the nx target, not about E2E; run Playwright in its official image
([devcontainer runbook §3](../../docs/runbooks/devcontainer.md)). First bring the agent stack up —
the specs are gated and would otherwise *skip*, which reads as green:

```bash
# The gateway and the client bundle are BAKED, not mounted: rebuild or you test the old code.
SPECIALIST_MODEL=qwen2.5:latest node scripts/agent-stack.mjs
docker run --rm --entrypoint sh agent-gateway:latest -c "grep -c 'if is_search_cancel(text):' /app/src/nodes/search.py"   # expect 1

cd frontend/mcm-app
SVC_SECRET=$(grep '^KEYCLOAK_SERVICE_CLIENT_SECRET=' ../../infrastructure-as-code/docker/stacks/auth.env | cut -d= -f2-)
docker run --rm --network host --env-file ./.env.e2e.local \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -v /workspaces/mcm:/workspaces/mcm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e E2E_BFF_TARGET=dev-container -e CI=true \
  -e E2E_AGENT_PRODUCTION=1 -e E2E_REQUIRE_AGENT_STACK=1 -e TMDB_API_KEY="$TMDB_API_KEY" \
  -e KEYCLOAK_URL=http://localhost:8099 -e KEYCLOAK_REALM=grumpyrobot \
  -e KEYCLOAK_SERVICE_CLIENT_ID=mcm-bff-service -e KEYCLOAK_SERVICE_CLIENT_SECRET="$SVC_SECRET" \
  -e KEYCLOAK_CLIENT_ID=movie-collection-manager \
  -w /workspaces/mcm/frontend/mcm-app mcr.microsoft.com/playwright:v1.60.0-noble \
  node_modules/.bin/playwright test tests/e2e/web/agent-search.spec.ts --project=chromium --workers=1 --reporter=line
```

`E2E_REQUIRE_AGENT_STACK=1` turns a skipped agent spec into a failure — without it a missing stack
reports green. `--user` is not optional: omit it and Playwright's artifacts land root-owned in the
working tree and block the next run.

**Seeing this one RED requires the pre-fix gateway image**, since the test runs against the
container, not the source. Run it before rebuilding, or the RED is unrecoverable.

## 6. E2E tier — mobile

**Not run locally, by policy.** [openwiki/runbooks/android-emulator.md](../../openwiki/runbooks/android-emulator.md)
splits mobile E2E by flow type: **agent flows must run in CI** (`android-e2e.yml`) against a
Metro-less standalone APK, because the local path drives them through the Metro dev server, which
OOM-crashes after a handful of agent `/run` calls and fails with a misleading black screen. The
rule holds inside the dev container too, even though the emulator runs natively there.

So `tests/e2e/mobile/agent-search.yaml` is authored and reviewed here and **verified by CI** — a
documented routing decision, not an environment limitation.

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

- [X] Step 1 prints the post-fix output — empty reads, empty tool calls, cleared stage
- [X] All unit selectors went RED before the fix and are GREEN after, with non-zero counts
- [X] Full `movie-assistant:test` suite green — 1124 passed, 2 skipped (both hypothesis input filters, pre-existing)
- [X] `movie-assistant:lint` clean (ruff + mypy)
- [X] Client component test green — 19 passed; `mcm-app:lint` clean for the changed files
- [X] Web E2E seen RED with the strengthened assertion (pre-fix gateway image), then GREEN
- [X] Agent E2E sweep, isolated per spec file: `agent-card-navigate`, **`agent-search` 3/3**, `agent-add-external-link` pass; `agent-navigate-movie` and `agent-disambiguation` fail **identically on `main`** under a controlled baseline → pre-existing, filed as item #150
- [X] Mobile flow — authored here, **verified by CI** per the agent-flow routing rule (§6)
- [X] Reported path covered by the `agent-search` E2E, which drives exactly it (search → web → pick → cancel → fresh next message) against the live stack. A human spot-check remains the operator's call.
- [X] Backlog item #149 verified, then closed with evidence
