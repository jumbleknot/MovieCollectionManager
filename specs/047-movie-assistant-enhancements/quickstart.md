# Quickstart: validating Movie Assistant Enhancements & Fixes

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-08-02

How to prove each story works end to end. This is a validation guide — implementation detail lives
in `tasks.md`. Every command goes through Nx per the
[nx-task-runner](../../openwiki/invariants/nx-task-runner.md) invariant.

## Prerequisites

- The dev container, with the local stacks up — see
  [local-dev](../../openwiki/runbooks/local-dev.md) and
  [devcontainer](../../openwiki/runbooks/devcontainer.md).
- The agent gateway running with **production nodes enabled** (`MOVIE_MCP_URL` and
  `WEB_API_MCP_URL` set). Without both, `build_runtime_graph` returns the tool-free graph and none
  of these flows exercise real tools.
- A seeded member account with `mc-user`.
- For Stories 1 and 3, a **large** library — at least one collection with 2,500+ movies. The
  defects only appear at that scale, so a small seed will pass every check while the bug is still
  live. Seed it from `docs/test-data/large-import-sample.xlsx` ("Movies" tab).

## Fast loop (no stacks needed)

Most of this feature is pure code and is fully covered by unit tests:

```bash
pnpm nx run movie-assistant:test          # pytest tests/unit
pnpm nx run movie-assistant:lint          # ruff + mypy, must be clean
pnpm nx run mcm-app:test                  # component tests incl. the new multi-select
pnpm nx run mc-service:test               # Story 4 only — the movie-metadata endpoint
pnpm nx run movie-mcp:test                # Story 4 only — the get_movie_metadata wrapper
```

Integration and golden:

```bash
pnpm nx run movie-assistant:test:integration
pnpm nx run movie-assistant:test:golden   # must pass UNCHANGED — no re-record (see below)
```

> **The golden suite is a guard, not a formality.** Every resolver changed here is deterministic
> pure code and no prompt or classification path is touched, so the goldens must pass without being
> re-recorded. If they need re-recording, something changed that this plan says should not have —
> investigate before re-recording.

---

## Story 1 — Open a collection by name

**RQ-1 is ANSWERED** — [research.md#rq-1](./research.md#rq-1). On a turn classified `navigate`
the generic reply comes only from `_degrade_node`, reachable only through the supervisor's model
call; the pagination defect is a *different* bug with different symptoms. No reproduce-and-diagnose
step is needed before validating this story.

### Seed the large-library fixture first (T003)

US1's defect only reproduces at scale — against a handful of movies every version of the navigator
passes. One collection of 2,500 movies is 50 keyset pages, comfortably past the navigator's
30-call/60 s budget.

```bash
# Web E2E — opt-in, idempotent (a rerun tops up rather than re-seeding; ~5 s when already seeded).
E2E_LARGE_LIBRARY=1 pnpm nx e2e mcm-app
E2E_LARGE_LIBRARY=1 E2E_LARGE_LIBRARY_SIZE=3000 pnpm nx e2e mcm-app   # override the size

# Agent integration tier — seeds the same "E2E Large Library" collection via mc-service and
# asserts a name-only navigation issues ZERO list_movies calls and completes under 5 s.
MCM_REQUIRE_LIVE_STACK=1 pnpm nx run movie-assistant:test:integration -- -k navigate_large_library
```

The fixture is deliberately **not** deleted afterwards: re-seeding 2,500 movies per run would
dominate the suite. Titles are deterministic (`Large Library Title NNNNN`) so "already present" is
decidable without stored state, and mc-service's `(title, year)` uniqueness makes a partially
seeded run resume rather than duplicate.

Then validate:

- The app opens that collection (SC-001), in under 5 s (SC-002).
- Navigating to a **movie** by name still opens its detail screen.
- Naming a collection that does not exist offers the collection buttons with a reason — not the
  generic reply (FR-004, SC-003).
- Watch the tool calls: a name-only navigation must issue **no** `list_movies` pagination
  (FR-002). This is the check that actually proves the fix; timing alone can pass by luck.

```bash
pnpm nx run mcm-app:e2e --spec tests/e2e/web/agent-navigate-collection.spec.ts
```

## Story 2 — Answer an import question once

1. Import a small sheet containing a row titled `Three Billboards Outside Ebbing, Missouri `
   (**with the trailing space** — this is the whole point; a trimmed fixture cannot reproduce it).
2. When asked how it should be sorted, **tap** an option → accepted, moves on.
3. Repeat with a fresh import and **type** the title back without the trailing space → accepted
   (FR-006).
4. Confirm the question is never re-asked (SC-004) and that the question shows how many decisions
   remain (FR-008).
5. Reply with nonsense twice → the third prompt offers a way out of the import (FR-010).
6. After import, confirm the stored title has no trailing whitespace (FR-011).

```bash
pnpm nx run mcm-app:e2e --spec tests/e2e/web/agent-import-disambiguate.spec.ts
```

## Story 3 — Import a large spreadsheet

1. Upload `docs/test-data/large-import-sample.xlsx`, "Movies" tab (2,000+ rows).
2. A preview appears with create/update/skip counts (FR-019) — it does not stall.
3. Approve. A single progress line advances (FR-014a) and is replaced by the report (FR-014b).
4. Time it: under 10 minutes (SC-006). Confirm every eligible row landed — check the count, not
   just that the run finished.
5. **Interruption**: start another 2,000-row import, kill the browser tab mid-apply, sign back in.
   Applied rows are still there (FR-016a) and the assistant reports where it stopped (FR-016b).
6. Re-upload the same file → the outstanding rows are created and **no duplicates** appear (FR-018).
7. A 5,001-row file is refused up front with no preview and no writes (FR-015).

```bash
pnpm nx run movie-assistant:test:integration   # scale + concurrency + idempotency
pnpm nx run mcm-app:e2e --spec tests/e2e/web/agent-import.spec.ts
```

> A green run is not enough here. Check the **applied count against the sheet's eligible row
> count** — a partial import that reports success is exactly the failure mode this story exists to
> remove.

## Story 4 — Record how I own a movie

### 4a — The domain publishes the accepted formats (do this first)

Story 4 depends on mc-service serving the option list ([RQ-4](./research.md#rq-4),
[contracts/movie-metadata.md](./contracts/movie-metadata.md)). All three layers ship in one PR, so
validate the bottom one first — otherwise a failure in the assistant is indistinguishable from a
failure in the endpoint. This ordering does the disambiguation that a PR split would otherwise have
been spent on.

```bash
# authenticated — reuses the ROPC token helper from feature 046
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/movie-metadata
# → {"mediaFormats":["DVD","Blu-Ray","Blu-Ray 3D","UHD Blu-Ray"]}
```

- Without a token → `401`. Without `mc-user`/`mc-admin` → `403`. Both come from the existing layers.
- Every returned string must be accepted by `add_movie` in `ownedMedia` — post one and confirm it
  round-trips rather than eyeballing the list.
- Confirm the drift guard: add a variant to `MediaFormat` locally and check the build **fails**
  until the new value is published. If it compiles, the exhaustive match was not implemented and the
  whole point of RQ-4's resolution has been lost.

### 4b — The assistant flow

Run this **twice** — once from a web search card, once from a typed `add <title> to <collection>` —
because the clarification made both paths the same flow (FR-031), and only running one proves half
of it.

1. Answer **no** to "Do you own this?" → added as not owned, no formats, no rip quality; lands on
   the detail screen (unchanged behaviour).
2. Answer **yes** → the media-format toggle list appears, showing **exactly** the values 4a
   returned (FR-021). Toggle two on, one back off, confirm → only the two carry forward (FR-020a).
3. Answer **no** to ripped → added owned, with formats, not ripped, no quality.
4. Repeat, answer **yes** to ripped → the rip-quality toggle list appears; confirm a selection.
5. Approve → the created movie carries exactly what was chosen (SC-011); verify on the detail
   screen, not just in the assistant's reply.
6. Answer **yes** to owned but confirm **zero** formats → still added as owned (FR-028).
7. Abandon mid-flow with an unrelated request → nothing is added (FR-029).
8. Type `dvd, blu-ray` instead of tapping → same result (FR-036).
9. **Metadata unavailable**: stop mc-service (or make the tool fail) and add a movie as owned → the
   assistant skips the format question and still completes the add with no formats recorded. It must
   **not** offer a guessed list — that would put domain values back in the agent and defeat RQ-4.

```bash
pnpm nx run mcm-app:e2e --spec tests/e2e/web/agent-add-ownership.spec.ts
```

## Story 5 — Back out of a web search result

1. Search a movie → "search the web" → pick a result.
2. The card shows both "Add to collection" and a cancel action (FR-032).
3. Cancel → the search ends with an acknowledgement, nothing is added, neither action still invites
   an add (FR-033).
4. The next message is handled fresh, with no leftover search context (FR-034).
5. Confirm the cancel produced **zero** write tool calls.

```bash
pnpm nx run mcm-app:e2e --spec tests/e2e/web/agent-search.spec.ts
```

## Before calling it done

Follow [feature-validation-checklist](../../openwiki/invariants/feature-validation-checklist.md) in
full — including the web E2E regression, which is required even though most of this change is in the
agent layer. Additionally:

- `pnpm nx run movie-assistant:lint` clean (ruff + mypy, no warnings, no errors).
- New code at ≥ 70 % coverage.
- Golden suite green **without re-recording**.
- Mobile check for the two new client surfaces — the multi-select and the cancel action must work on
  Android, not only web (FR-020b, FR-035). See
  [android-emulator](../../openwiki/runbooks/android-emulator.md).
- CI green via [ci-diagnostics](../../openwiki/runbooks/ci-diagnostics.md), and the PR opened
  against a **real branch** — never an AGit push, which runs with no Actions secrets.
