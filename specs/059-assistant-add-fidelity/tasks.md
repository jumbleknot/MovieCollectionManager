---

description: "Task list for 059 — assistant add fidelity"
---

# Tasks: Assistant add fidelity — the real rating, and the children's question

**Input**: Design documents from `/specs/059-assistant-add-fidelity/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: REQUIRED. This repository's test-authoring convention applies in full — every test task
carries a **Verify RED**, every implementation task a **Verify GREEN**. The one exception is marked
explicitly: T005 is a *characterization guard* that must pass before and after.

> **A Verify RED showing 0 failures is a failed task, not a passed one.** Check the *collected*
> count as well as the failure count — a `-k` selector that matches nothing also reports no
> failures, and this repository has been bitten by exactly that.

> **A skip is not a pass.** The web-api-mcp integration suite skips clean when `TMDB_API_KEY` is
> absent. Check the skip count is 0 before believing any green from it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 (item #163, rating) or US2 (item #162, children's question)

## Already done (during planning — do not redo)

These landed in `517f8a2` because the alternative was a hand-run verification, which the spec now
forbids (FR-020a). Listed so no one repeats them:

- `.devcontainer/init-firewall.sh` — `api.themoviedb.org` allowlisted for the dev-container shell
- `.devcontainer/verify/verify-firewall-allowlist.sh` — asserts TMDB reachable, default-deny intact
- `docs/runbooks/devcontainer.md` — records why the old "do NOT allowlist TMDB" is superseded

---

## Phase 1: Setup (baseline)

**Purpose**: know the starting state, so a later red is attributable to this feature.

- [x] T001 Record the pre-change baseline in this file: run `pnpm nx run web-api-mcp:test`, `pnpm nx run web-api-mcp:test:integration`, `pnpm nx run movie-assistant:test`, `pnpm nx run movie-assistant:test:integration` and note passed/failed/skipped counts for each
  - **Expected**: all green; web-api-mcp integration = 5 passed, **0 skipped** (a skip means `TMDB_API_KEY` is missing — fix that before starting, per [quickstart.md](./quickstart.md) §2)
  - The movie-assistant integration baseline matters for T024: four of its tests assert the add chain's first stage and will legitimately go red during US2.
  - **Measured** (2026-08-15, at `360faef`):

    | Target | Result |
    |---|---|
    | `web-api-mcp:test` | 7 passed, 0 failed, 0 skipped, 0.33 s |
    | `web-api-mcp:test:integration` | **5 passed, 0 failed, 0 skipped**, 0.67 s — matches expectation; the key is present |
    | `movie-assistant:test` | 1131 passed, 0 failed, 2 skipped, 14.02 s |
    | `movie-assistant:test:integration` | **102 passed, 0 failed, 11 skipped**, 164.68 s — the number T024 must return to |

- [x] T002 [P] Confirm TMDB egress and default-deny in the current container: `bash .devcontainer/verify/verify-firewall-allowlist.sh`
  - **Expected**: PASS, including `reachable: TMDB (api.themoviedb.org)` and `arbitrary host refused`
  - If TMDB is unreachable, the ipset is stale — re-run `sudo env FORGE_REGISTRY_HOST="$FORGE_REGISTRY_HOST" /bin/bash .devcontainer/init-firewall.sh`. Do **not** widen the allowlist further.
  - **Measured**: first run **FAIL (SC-009)** — but on `static.crates.io`/`index.crates.io`, *not* TMDB: TMDB was already reachable and default-deny already intact. Both crates hosts are Fastly-fronted with rotating IPs, i.e. the stale-ipset symptom the runbook describes. Re-running `init-firewall.sh` (182 allowlisted entries) fixed it without widening anything; the verifier then returned **PASS**, TMDB reachable, `example.com` refused.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: make the live check gate a merge in CI rather than only locally (FR-020a), and pin
today's behaviour of the callers this feature must not disturb.

- [x] T003 Add skip-escalation to `mcp-servers/web-api-mcp/tests/integration/conftest.py` so a missing `TMDB_API_KEY` FAILS when `MCM_REQUIRE_LIVE_STACK=1`, mirroring `mcp-servers/movie-mcp/tests/integration/conftest.py:67-98`
  - **This comes before enrollment, not after.** Enrolling a suite that still skips clean on an absent key is precisely the window in which CI reports green for a suite that ran nothing.
  - **Verify RED**: `cd mcp-servers/web-api-mcp && MCM_REQUIRE_LIVE_STACK=1 TMDB_API_KEY= uv run pytest tests/integration -q`
  - **Expected RED**: `skipped`, exit 0 — the failure mode this task removes
  - **Measured RED**: **the command as written does not reproduce the skip — it gave `5 passed`.** `conftest._cfg` reads `os.environ.get(key) or _ENV.get(key)`, so an *empty* `TMDB_API_KEY` falls through to `.env.local`, which exists locally and holds a real key. The condition CI actually has is the key absent from **both** sources, reproduced by moving the file aside for the run:
    `mv .env.local .env.local.bak; MCM_REQUIRE_LIVE_STACK=1 TMDB_API_KEY= uv run pytest tests/integration -q; mv .env.local.bak .env.local`
    → **5 skipped, exit 0** — the failure mode, confirmed.
  - **Measured GREEN**: same file-aside command → **5 errors, exit 1**, each carrying the escalation message. (They surface as pytest *errors* rather than *failures* because the skip is raised in the session-scoped `tmdb_api_key` fixture, i.e. during setup; the outcome is escalated and the exit code non-zero either way.) With the key present and `MCM_REQUIRE_LIVE_STACK=1` → **5 passed, 0 skipped, exit 0**.

- [x] T004 Enroll `web-api-mcp` in the CI integration step in `.forgejo/workflows/app-ci.yml`, alongside movie-mcp and spreadsheet-mcp, passing `TMDB_API_KEY` from the existing job-level env (line ~332) and setting `MCM_REQUIRE_LIVE_STACK: '1'`
  - Replace the "web-api-mcp is deliberately NOT enrolled (048 FR-013)" comment block (lines ~572-578) with the current position: egress from the shell is now allowlisted in the dev container and the credential question is answered by the existing CI secret. Do not delete the comment — 048's reasoning must remain readable next to its reversal.
  - Depends on T003: the `MCM_REQUIRE_LIVE_STACK` flag does nothing until the escalation exists.
  - **Verify**: `pnpm nx run web-api-mcp:test:integration` locally; CI is verified by T027, not by this edit.
  - **Measured**: workflow parses (`yaml.parse`); the enrolled step is in job `app-e2e`, which is the job whose env block already binds `TMDB_API_KEY: ${{ secrets.TMDB_API_KEY }}` — so the step inherits it rather than re-declaring the secret. Local target: **5 passed, 0 skipped**. 048's reasoning is quoted verbatim above its reversal, not deleted.

- [x] T005 [P] Characterization guard for the callers that must not change, in `agents/movie-assistant/tests/unit/test_import_transform.py` and `agents/movie-assistant/tests/unit/test_proposals.py`: the spreadsheet-import payload still carries `childrens: false` and its rating still comes from the spreadsheet column; `compose_movie_payload` (the organize/update path) still injects neither field (FR-007, FR-015, SC-007)
  - **This is a guard, not a RED/GREEN pair.** It must pass **before** implementation and still pass after. If it fails before, the premise of FR-007 is wrong and the plan needs revisiting — that is the finding, not a task failure.
  - **Verify**: `pnpm nx run movie-assistant:test -- tests/unit/test_import_transform.py tests/unit/test_proposals.py -q` → 0 failures now, and again after T012 and T021
  - **Measured (before implementation)**: **48 passed, 0 failed** — the guard holds, so FR-007's premise is confirmed rather than assumed. Four guards added to `test_import_transform.py` (rating from the MPAA column; `childrens` from the Children's column; `apply_create_defaults` still gives `childrens=False` and `rated=None`-present-as-null; and the import path does not route through `to_movie_payload`) and one to `test_proposals.py` (`compose_movie_payload` injects neither field, for a stored doc that has them and one that does not).

---

## Phase 3: User Story 1 — the rating on an added movie is the film's real rating (P1, item #163)

**Goal**: every assistant-mediated add records the film's actual US certification, or nothing at all.

**Independent test**: add a certified film and an uncertified film through the assistant; the first
carries its real rating, the second carries none and still succeeds. Needs nothing from US2.

### Tests for US1 (write first — these MUST fail before T011)

- [x] T006 [P] [US1] Unit tests for certification extraction in `mcp-servers/web-api-mcp/tests/unit/test_certification.py` — one case per row of [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), built from the measured shapes: `PG,PG` → `PG`; `R,R,""` → `R`; `NR,NR` → `NR`; `"",PG-13,PG-13` → `PG-13`; seven `""` then `NR` → `NR`; `""` only → `None`; no US block → `None`; `TV-14` → `None`; non-US blocks only → `None`
  - **Verify RED**: `pnpm nx run web-api-mcp:test -- tests/unit/test_certification.py -q`
  - **Expected RED**: collection error — the extractor does not exist yet
  - **Measured RED**: **1 error during collection, exit 1** — `ImportError: cannot import name 'extract_us_certification' from 'src.tools'`. 16 test functions written (the contract's nine rows, plus vocabulary round-trip, malformed/absent block, whitespace-only, the hyphen guard, and T007's two request tests).

- [x] T007 [US1] Unit test in `mcp-servers/web-api-mcp/tests/unit/test_certification.py` that `get_movie_details` requests `append_to_response=release_dates` and makes exactly **one** HTTP call, using an httpx `MockTransport` that records requests (FR-002a)
  - Same file as T006 — sequence, do not parallelize.
  - **Verify RED**: same command, `-k append_to_response`
  - **Expected RED**: 1 failed — the request carries no such parameter
  - **Measured RED**: **1 failed, 15 deselected** — `assert None == ['release_dates']`, the recorded request's query being `{'api_key': ['k']}`. Observing this RED *specifically* (rather than under T006's collection error, which masks every test in the file) meant staging T011: the pure extractor was added first, leaving the request untouched — at that point 14 passed and exactly these 2 request tests failed, each for its own reason.

- [x] T008 [P] [US1] Extend `mcp-servers/web-api-mcp/tests/integration/test_tmdb.py` with real-TMDB assertions on the stable films only: 412117 → `PG` (SC-001), 603 → `R`, 396535 → `NR`, 152747 → `PG-13` (the leading-empty case)
  - Do **not** pin the low-traffic `None` films here — their TMDB records are publicly editable and would drift; those cases live in T006.
  - **Verify RED**: `pnpm nx run web-api-mcp:test:integration -- -k certification -q`
  - **Expected RED**: 4 failed — `KeyError`/`None`, the candidate has no `rated` field
  - **Measured RED**: **4 failed, 5 deselected** — all four `KeyError: 'rated'` at `test_tmdb.py:93`, exactly as expected. Written as one parametrized case per film so the failing film names itself in the report.

- [x] T009 [P] [US1] Unit tests in `agents/movie-assistant/tests/unit/test_proposals.py` that `to_movie_payload` emits the candidate's rating, and `"rated": None` — **key present** — when the candidate has none (FR-004, research R5)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k rated -q`
  - **Expected RED**: ≥2 failed — the payload contains the literal `"NR"`
  - **Measured RED**: **4 failed, 3 passed, 28 deselected** — `AttributeError: 'EnrichedMovieCandidate' object has no attribute 'rated'`.
  - **The `-k` trap fired here, and is worth recording.** As first written, only 2 of the 6 new tests had "rated" in their *name*, so `-k rated` collected 2 (one of them T005's guard), both passed, and the task's own verify command reported **green on a suite whose subject does not exist yet**. It was caught by running the unmodified file (4 failed) — not by the selector. The tests were renamed so `-k rated` collects all of them. This is the failure the header warning describes, met in practice: the check that settles it is the *collected* count, not the colour.

### Implementation for US1

- [x] T010 [US1] Add `rated: str | None = None` to `EnrichedMovieCandidate` in `agents/movie-assistant/src/proposals.py`
  - Defaulted, so the disambiguation path that builds candidates from search results is unaffected.

- [x] T011 [US1] Implement the certification extraction in `mcp-servers/web-api-mcp/src/tools.py`: add `append_to_response=release_dates` to the existing `/movie/{id}` request, and a pure helper that walks `release_dates.results` → the US block → the **first non-empty** certification, validated against `{G, PG, PG-13, R, NC-17, NR, Unrated}`, else `None`. Return it as `rated` on the candidate.
  - Keep the helper pure and separately importable — it is what T006 tests.
  - **No renaming.** TMDB publishes `PG-13`/`NC-17` and the product stores `PG-13`/`NC-17` (research R1). Item #163's AC3 asks for `PG13`/`NC17`; implementing that literally sends a value mc-service rejects.
  - **Verify GREEN**: `pnpm nx run web-api-mcp:test -- tests/unit/test_certification.py -q` → 0 failures, ≥10 passed
  - **Measured GREEN**: **16 passed, 0 failed** in `test_certification.py`; whole unit suite **23 passed** (T001 baseline 7 + 16 new, so nothing was displaced). Helper is `extract_us_certification(details)` — pure, takes the whole details dict so an absent `release_dates` block is a `None` rather than a `KeyError`, and never raises.
  - **Also run**: `pnpm nx run web-api-mcp:test -q` → previously passing tests still pass

- [x] T012 [US1] Wire the rating through `to_movie_payload` in `agents/movie-assistant/src/proposals.py` — replace the literal `"rated": "NR"` with the candidate's value, defaulting to `None`
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -q` → 0 failures
  - **Measured GREEN**: `test_proposals.py` **35 passed**; T005's guard **54 passed** (still green after the change, which is the point of it); whole unit suite **1142 passed, 2 skipped** against the T001 baseline of 1131/2 — +11, matching exactly the 6 T009 + 5 T005 tests added, so no pre-existing test was displaced or silently dropped.

- [x] T013 [US1] Verify the live tier: `pnpm nx run web-api-mcp:test:integration -q`
  - **Expected GREEN**: 9 passed, **0 skipped**
  - **Measured GREEN**: **9 passed, 0 failed, 0 skipped, 0.91 s** (run with `--skip-nx-cache`; the first invocation replayed a cached result and printed no counts at all — a cache hit is not a test run).
  - **Instrument check on that green**, because 0.91 s for nine real TMDB calls is a shape a no-op also has. Ran quickstart §2's control: the same code against the real base returns `The Secret Life of Pets 2 | rated = PG`, and against an unreachable base raises `ConnectTimeout`. The suite does hit the network, and **SC-001's expected value is confirmed from the source, not from the fixture**.
  - The live shape matched [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md) on all four pinned films — no contract or fixture correction was needed.
  - If the shape differs from [contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), fix the contract **and** the T006 fixtures — never just the failing assertion.

- [x] T014 [P] [US1] Add two assertions to `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (`@model-decision`): "The Secret Life of Pets 2" (2019) added through the assistant has `rated` = `PG` (SC-001), and a film with no US certification is added successfully with a blank rating (US1-AC4, SC-003) — proving mc-service accepts `"rated": null` on the real write path, not just in the payload
  - **Verify**: `node scripts/agent-e2e.mjs agent-add-ownership`
  - **Written and typechecked**; the RUN is deferred to T025, which rewrites the same file — one stack rebuild and one (very slow, model-driven) suite execution covers both stories rather than two. Results are recorded under T025.
  - **Film choice, measured against live TMDB 2026-08-15** rather than assumed: "The Secret Life of Pets 2" (2019) resolves `exact` → `tmdb:412117`, `rated = PG`. For the uncertified case, research R3's `null` films were checked for *searchability* as well as rating — `Agnes` searches `ambiguous` (and R3's `tmdb:411397` is the **1995** film, not the 2021 one), so it would have detoured through disambiguation. **`Nightless Night` (2023, `tmdb:1245424`) resolves `exact` with no US block at all** and is what the spec uses.

**Checkpoint**: US1 is independently shippable here — merge-blocking unit + live coverage, and the
reported defect is fixed end to end.

---

## Phase 4: User Story 2 — every add records whether it is a children's movie (P2, item #162)

**Goal**: the member is asked, once, before the ownership question, and their answer is what gets
written.

**Independent test**: add a movie answering the new question both ways, and with both ownership
answers; the created movie carries exactly what was chosen. Needs nothing from US1.

### Tests for US2 (write first — these MUST fail before T020)

- [x] T015 [P] [US2] Unit tests for the stage machine in `agents/movie-assistant/tests/unit/test_organizer_add_chain.py`: the chain's first question is `awaiting_childrens`; `yes`/`no` advances to `awaiting_ownership` retaining the answer; an unparseable reply re-asks without advancing; abandonment adds nothing; a not-owned add still carries the answer (US2-AC5)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q`
  - **Expected RED**: ≥5 failed — the chain enters `awaiting_ownership` directly
  - **Measured RED**: **10 failed, 4 passed** (14 collected) — `assert 'awaiting_ownership' == 'awaiting_childrens'` on the entry point, and `AttributeError`/`None` on `ProposalItem.childrens`.

- [x] T016 [US2] Unit test in `agents/movie-assistant/tests/unit/test_organizer_add_chain.py` that `awaiting_childrens` is registered in **both** `graph._OWNERSHIP_STAGES` and `curator._OWNERSHIP_STAGES`, and **not** in `_MULTI_SELECT_STAGES` (research R6)
  - This is a guard, not a tautology: each omission fails differently at runtime and none of them fails loudly. Same file as T015 — sequence.
  - **Verify RED**: same command, `-k stages`
  - **Expected RED**: 2 failed — the stage is absent from both sets
  - **Measured RED**: **2 failed, 3 passed, 9 deselected** — one per set, as intended. Written as two separate tests rather than one with two assertions, so each omission names itself instead of hiding behind whichever assertion runs first. The selector needed the same fix as T009: the names were renamed to a `test_stages_…` prefix, because `-k stages` originally matched one test out of five.

- [x] T017 [P] [US2] Unit tests in `agents/movie-assistant/tests/unit/test_proposals.py` that `to_movie_payload(..., childrens=True)` emits `"childrens": true`, that it defaults to `False`, and that `build_add_proposal` carries the answer onto the `ProposalItem` (FR-010, FR-015)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k childrens -q`
  - **Expected RED**: ≥3 failed — the parameter does not exist
  - **Measured RED**: **5 failed, 2 passed, 34 deselected** — `TypeError: to_movie_payload() got an unexpected keyword argument 'childrens'`.

- [x] T018 [P] [US2] Unit test in `agents/movie-assistant/tests/unit/test_approval_gate.py` that an approval arriving on a later turn applies the checkpointed children's answer (research R9)
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_approval_gate.py -k childrens -q`
  - **Expected RED**: 1 failed
  - **Measured RED**: **2 failed, 17 deselected** — written as two (the `True` and `False` answers), since a gate that dropped the value entirely would still pass a `False`-only assertion.

- [x] T019 [P] [US2] Parity test in `agents/movie-assistant/tests/unit/test_proposals.py` that the add-time answer and the conversational update path set the **same field**: `to_movie_payload(..., childrens=True)` and `compose_movie_payload` with a `childrens` change both produce a payload whose `childrens` is `true` (FR-016)
  - FR-016 exists to stop two paths drifting; without this test nothing notices when they do. `compose_movie_payload` already accepts the flag (`proposals.py:255`) — this asserts the add path joins it rather than inventing a second vocabulary.
  - **Verify RED**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -k parity -q`
  - **Expected RED**: 1 failed — the add path has no `childrens` parameter yet
  - **Measured RED**: **1 failed, 40 deselected**. The test asserts the same KEY on both paths, not merely the same value — a `childrensMovie`/`isChildrens` spelling would satisfy every other test in the file and write a field mc-service ignores.

### Implementation for US2

- [x] T020 [US2] Add `childrens: bool | None = None` to `ProposalItem` and thread it through `_item` and `build_add_proposal` in `agents/movie-assistant/src/proposals.py`; add a `childrens: bool = False` keyword to `to_movie_payload` replacing the hardcoded `"childrens": False`
  - Leave `diff` untouched — FR-018a keeps the approval text unchanged.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_proposals.py -q` → 0 failures
  - **Measured GREEN**: **41 passed, 0 failed**. `ProposalItem.childrens` is `bool | None` — `None` distinguishes "never asked" (import, organize) from "answered no", while the payload still sends a concrete `False`, which is what was written before.

- [x] T021 [US2] Register `awaiting_childrens` in `agents/movie-assistant/src/graph.py` (`_OWNERSHIP_STAGES`, line ~166) and in the local mirror in `agents/movie-assistant/src/nodes/curator.py` (line ~122). Do **not** add it to `_MULTI_SELECT_STAGES`.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -k stages -q` → **5 passed, 9 deselected, 0 failures**

- [x] T022 [US2] Add `_ask_childrens` to `agents/movie-assistant/src/nodes/organizer.py` mirroring `_ask_ownership` (Yes/No via `render_selection`, tool id `add-childrens`), make it the stage the chain enters instead of `awaiting_ownership` (line ~280), and add the `awaiting_childrens` branch to the transition block (line ~482) which stores the answer and calls `_ask_ownership`. Reuse `_parse_ownership`; re-ask on `None`.
  - The collection question keeps its position ahead of this one (FR-008a) — the entry point that changes is the one reached *after* `add_target` is resolved.
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q` → **14 passed, 0 failed**
  - A `add_childrens` field was added to `GraphState` and to `_ADD_STATE_RESET` alongside the 047 answers, so a concluded or abandoned add cannot leak one member's answer into the next movie they add.

- [x] T023 [US2] Thread the answer through the proposal build (`_build_ownership_proposal`, `organizer.py:~390`) and the apply path (`approval_gate.py:~212`) so it reaches `to_movie_payload`
  - **Verify GREEN**: `pnpm nx run movie-assistant:test -q` → 0 failures across the whole unit suite; T005's guard still green
  - **Measured GREEN**: **1164 passed, 0 failed, 2 skipped** — the T001 baseline of 1131 plus exactly the 33 tests this feature adds, so nothing was displaced. T005's guard is green after the change as well as before, which is the whole point of it.
  - `childrens` is read from state inside `_build_ownership_proposal` rather than threaded through each caller, deliberately: the "not owned" branch reaches the proposal WITHOUT passing through the later stages, and that shortcut is precisely where a threaded value gets dropped (US2-AC5).
  - **30 other unit tests went red on the way, in six files** — `test_organizer.py`, `test_add_flow_graph.py`, `test_runtime_nodes.py`, `test_disambiguation_flow.py`, `test_session_expiry.py`, `test_context_resolution.py`. The task list anticipated this at the integration tier only; the same "walks a fixed turn sequence" problem exists at the unit tier, in six chain-walking helpers. Every one was fixed by adding a turn, never by relaxing an assertion. Two details worth keeping:
    - Each helper took the caller's `answer` as the FIRST reply, meaning it silently became the *children's* answer while every caller still read as "owned/not owned". They now match replies to stages **by name**, so the next question inserted into this chain lengthens the walk instead of redirecting every caller's answer to a different question.
    - `test_organizer.py` / `test_context_resolution.py` carry state between turns as the checkpointer does, and their carried-key lists needed `add_childrens` — without it the answer vanished mid-chain and the test failed for a reason that existed only in the harness. (The same bug appeared in this feature's own new helper and was fixed there too: it rebuilt the carried state each turn instead of accumulating it.)

- [x] T024 [US2] Update the movie-assistant **integration** tests that assert the chain's first pause — `tests/integration/test_add_flow.py:143` and `:352`, `tests/integration/test_gateway_add_e2e.py:202`, `tests/integration/test_metadata_unavailable_live.py:108` — all four assert `add_stage == "awaiting_ownership"` immediately after the add turn, which is now `awaiting_childrens`
  - This tier is not optional and not covered by the Playwright work in T025: it is the tier that proves the chain across a real graph run. FR-021's rule ("coverage that walks a fixed sequence must be updated") applies here first.
  - Add one turn to each affected flow rather than weakening the assertion — a test relaxed to "some stage" stops proving the ordering the story is about.
  - **Verify RED**: `pnpm nx run movie-assistant:test:integration -q` (before the update, after T022)
  - **Expected RED**: 4 failed — `assert 'awaiting_childrens' == 'awaiting_ownership'`
  - **Measured RED**: **7 failed, 95 passed, 11 skipped** — not the 4 predicted, and not the 4 predicted *tests*:
    - `test_add_flow.py` contributed **6**, not 2. Two are the cited assertions (`:143` inside the shared `_add_and_own` helper, `:352` in the explicit stage-by-stage walk); the other four are separate tests that fail through the shared helper.
    - `test_metadata_unavailable_live.py:108` failed as predicted.
    - **`test_gateway_add_e2e.py:202` did NOT fail — which is worse than failing.** It walks a FIXED answer list (`"yes"`, `"Selected: none"`, `"no"`) despite a comment claiming it answers "by STAGE rather than by a fixed number of turns". With the extra question the list slid by one: `"yes"` answered the children's question, `"Selected: none"` was unparseable at the ownership question and re-asked it, and `"no"` then answered ownership. The test still reached the gate and still passed — while exercising a *different* flow than the one it documents (not-owned, rather than owned-with-no-formats). It was fixed anyway (one longer, each answer labelled with the question it answers) and the misleading comment replaced with what is actually true. A green that survives a change to the thing under test proves nothing.
  - **Verify GREEN**: same command → back to the T001 baseline counts
  - **Measured GREEN**: **102 passed, 0 failed, 11 skipped** — identical to the T001 baseline.

- [x] T025 [US2] Update the E2E specs that walk the old turn sequence — 5 tests in `frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts` (lines ~70, 155, 215, 261, 303) and 1 in `frontend/mcm-app/tests/e2e/web/agent-add-external-link.spec.ts` (line ~78) — to answer the children's question first, and add new coverage: the question appears before ownership from both a card add and a typed add; abandoning at it adds nothing; and it is answerable **by tapping only and by typing only**, both producing the same movie (FR-012, SC-005)
  - The tap/type assertion belongs on the new question specifically — the existing "typed answers reach the same result as tapping" test (line ~261) covers the 047 questions, and updating it to pass is not the same as asserting the new one.
  - **If these pass unmodified, the question is not being asked** — that is a failure, not a convenience.
  - **Verify**: `node scripts/agent-e2e.mjs agent-add-ownership` and `node scripts/agent-e2e.mjs agent-add-external-link`
  - **Measured**: `agent-add-ownership` → **12 passed, 0 failed, 0 skipped, 0 flaky** (5 pre-existing, updated + 7 new: 5 for US2, 2 for US1). `agent-add-external-link` → **1 passed** (it now answers two Yes/No questions instead of one). Both files' every test carries `@model-decision`, so this tier does not block a merge — nothing deterministic was left here.
  - **Three environment findings, none of which was "it can't run here":**
    1. `node scripts/agent-e2e.mjs` fails instantly with `browserType.launch: Executable doesn't exist` — that is the *target*, not the tests. Playwright runs here only in its official image; the run used `mcr.microsoft.com/playwright:v1.60.0-noble` with `--network host`, `--user "$(id -u):$(id -g)"` and `-e HOME=/tmp` (omitting the user flags leaves root-owned artifacts that break the next run).
    2. The runbook's reason for forcing `E2E_AGENT_PROVIDER=anthropic` ("the DinD container has no reachable Ollama") **is superseded** — the nested `dev-ollama` container answers `200` on `localhost:11434` in the shared netns, and the seed gate passed on the ollama path. But a **new** reason applies: `SPECIALIST_MODEL=qwen2.5:32b` needs ~19 GB (4.7 GB + 14.2 GB CPU repack) against **15 GB** of RAM, and `llama-server` is OOM-killed — `Load failed … signal: killed`, Ollama answers `500`. Measured, not assumed: the 19 GB model was pulled first, then observed to fail. Anthropic is therefore still the right provider here, for a different reason than the one recorded.
    3. The gateway and MCP containers were running a **two-day-old image**. `scripts/agent-e2e.mjs` recreates only the BFF, so the stack was rebuilt with `scripts/agent-stack.mjs` and the running containers were then *interrogated* rather than trusted — `extract_us_certification` present and returning `PG-13` for the All-Is-Lost shape, `to_movie_payload` carrying a `childrens` parameter, `awaiting_childrens` in `_OWNERSHIP_STAGES`.
  - **Instrument check on the green**, because 12 model-driven flows in 1.5 min has the same shape as a suite that ran nothing. The decisive evidence is server-side, in mc-service's own log:
    - `CreateMovieDto { title: "The Secret Life of Pets 2", …, rated: Some(PG), … }` — **SC-001 proven on the real write path**, not merely in the payload builder.
    - `childrens: true` × 4 and `childrens: false` × 22 across the run — the member's answer is what gets written.
    - The 22 × `rated: Some(NR)` are **truthful**: they are all `Coherence`, which live TMDB really does publish as `NR` (checked, precisely because `NR` is the value the old bug produced). `Nightless Night` resolves to `None`, matching the blank-rating test.

- [x] T025a [US2] **Addendum — three MORE E2E specs walk the add chain, and two of them are `@gate`.** Found by CI, not by the task list: run 1816's `app-e2e` failed with `failed=3 flaky=0 passed=149 did-not-run=3 skipped=0`.
  - The task list named `agent-add-ownership.spec.ts` and `agent-add-external-link.spec.ts`. The real blast radius also includes `assistant-add.spec.ts` (**2 `@gate` tests**), `assistant-add-ambiguous.spec.ts` (**1 `@gate` test**) and `assistant-context.spec.ts` (2 `@model-decision`), all of which reach the chain through the shared `answerOwnership` helper in `tests/e2e/web/setup/assistant-add-flow.ts`.
  - **These were merge-blocking**, unlike everything T025 covers — `@gate`, not `@model-decision`. The local runs of the two named files could not have caught them, and did not.
  - The 3 `did-not-run` are a knock-on, not a separate fault: the `lifecycle` project declares `dependencies: ['chromium']`, so a red chromium project means it never starts.
  - **Fix**: a sibling `answerChildrens` helper, called explicitly at each of the four sites, rather than folding both questions into `answerOwnership`. A helper that silently swallowed both would make the *next* inserted question invisible too — and the ordering is the guarantee. Both helpers now delegate to one `answerChainQuestion(page, asks, answer)` that asserts the question's own TEXT before touching the buttons, because both questions render the same `selection-options` control and a bare `.last()` can match the previous question's still-mounted control.
  - **Verify GREEN**: the full gate tier, exactly as CI runs it (`E2E_TIER=gate`, official Playwright image) → **155 passed, exit 0**. Plus `assistant-context.spec.ts` on the model tier → **2 passed**.

**Checkpoint**: both stories complete and independently verifiable.

---

## Phase 5: Polish & cross-cutting

- [x] T026 [P] Run both linters — `pnpm nx run web-api-mcp:lint` and `pnpm nx run movie-assistant:lint` (ruff + mypy)
  - Derive checks from the diff, not from memory: a Python change means `lint` as well as `test`.
  - **Measured**: `web-api-mcp:lint` → ruff **All checks passed**, mypy **no issues in 4 source files**. `movie-assistant:lint` → ruff **All checks passed**, mypy **no issues in 43 source files**.
  - The diff also touches TypeScript (three E2E spec files), so two more tiers were derived from it and run: `mcm-app:typecheck` → **clean**, `mcm-app:lint` → **0 errors** (14 pre-existing warnings, all in files this feature does not touch).

- [x] T027 Verify in CI that the enrolled integration step actually ran web-api-mcp — read the run log via `node scripts/ci-status.mjs`, confirm a non-zero collected count for `tests/integration` and a skip count of 0
  - A workflow edit is not evidence that a step ran. If egress from the runner turns out to be blocked, this is where it surfaces — fix the runner path or revert T004 and record why, but do not silence it.
  - **Measured, run 1816** (`node scripts/ci-status.mjs failure --run 1816 --full` → the evidence bundle's `logs/step_mcp-integration-web-api`):

    ```
    tests/integration/test_server.py ..
    tests/integration/test_tmdb.py .......
    ============================== 9 passed in 1.12s ===============================
    NX   Successfully ran target test:integration for project web-api-mcp
    ```

    **9 collected, 9 passed, 0 skipped.** This is the positive evidence the task asks for — the step has its own named log, so it did not have to be inferred from the job's exit status.
  - **This settles 048 FR-013's open egress question by measurement**: the runner CAN reach `api.themoviedb.org`. It was enrolled *without* that being known, deliberately — an unconfirmed path that fails loudly on its first run beats one that stays unexamined — and the answer is yes. No revert needed.
  - The job as a whole FAILED on a later step (`web-e2e`), which is a separate defect this feature caused and fixed — see T025's addendum. The MCP step runs before it and is unaffected.

- [x] T028 [P] Manual confirmation per [quickstart.md](./quickstart.md) §4 — add "The Secret Life of Pets 2" through the assistant on the local stack, answer the children's question, and read the detail screen: Rated `PG`, and the children's flag as answered
  - **Confirmed, in two halves.** The *through-the-dock* half is what T025's E2E does on this same live stack, and mc-service's own log is the evidence — `CreateMovieDto { title: "The Secret Life of Pets 2", …, rated: Some(PG) }`. This session has no browser for a human to look at, so the read-the-detail-screen half was done by driving the identical chain end to end and reading back what that screen renders:

    | Step | Result |
    |---|---|
    | web-api-mcp enrichment (real TMDB) | Pets 2 → `'PG'`; Nightless Night → `None` |
    | `to_movie_payload` (real builder, member answers yes / no) | `rated='PG' childrens=True` / `rated=None childrens=False` |
    | POST to mc-service | **201** and **201** — the uncertified add is ACCEPTED, which is `"rated": null` being sent as a present key rather than omitted (research R5) |
    | read back | `The Secret Life of Pets 2 — Rated: PG, Children's: True` · `Nightless Night — Rated: (blank), Children's: False` |

    Before this feature the first row would have read `Rated: NR, Children's: False`. The seeded collection was deleted afterwards (`204`).

- [ ] T029 [P] Comment on backlog items #163 and #162 recording what their acceptance criteria got wrong — the `PG-13` → `PG13` rename that exists at no boundary (item #163 AC3, research R1) and `build_add_movie_payload`, which is `to_movie_payload` (both items, research R2)
  - `node scripts/backlog.mjs comment 163 --body-file …` / `… 162 …`. Correct the criteria before closing, not after.

- [x] T030 Close items #163 and #162 only once their criteria are met and verified — `node scripts/backlog.mjs update 163 --state closed`
  - Not when the PR merges. Verify first, then close.
  - **Both closed**, and both still open when the PR was opened — the trigger was the criteria being verified, not the PR existing. Each carries a criterion-by-criterion verification comment naming where each one is proven, posted **before** the close.
  - Waited for CI green on `dfbb405` first, deliberately: #162's AC8 is "the web E2E agent regression … passes", and two CI runs had already shown that claim to be false. Final verdict: **all 10 required contexts passed — mergeable**.
  - #163's AC3 is recorded as **corrected, not met** — the `PG13` rename does not exist and was not implemented. #163's scope note (backfilling movies already stamped with a false `NR`) is explicitly out of scope and left for a separate item.

- [x] T025b [US2] **Second addendum — the MOBILE flow walks the chain too.** Found by CI run 1822, after the web gate had gone green (`failed=0 flaky=2 passed=153 did-not-run=0 skipped=0`): the failing step moved to `maestro-agent-flows`, with `Assert that ".*Do you own.*" is visible... FAILED` on all three attempts.
  - `frontend/mcm-app/tests/e2e/mobile/agent-add-ownership.yaml` — both of its blocks gain the children's turn. It is the only add-chain flow in CI's list (`scripts/ci-mobile-agent-flows.sh`).
  - The ownership step now waits on the **question text** rather than `id: selection-options`: that id is already visible from the new question above it, so waiting on it again returns instantly and asserts against the wrong turn.
  - Tapping by id stays correct even though an **answered** control keeps its testID mounted (`selection-options` renders unconditionally, so duplicates accumulate and Maestro takes the first match): every button posts a **value**, and the graph applies it to whatever stage is pending. That is already why the existing `ripped` step works with an earlier ownership control in the transcript — now recorded in the flow.
  - `assistant-add.yaml` and the other mobile add flows are **not** in CI's list and were already stale against 040/047 (`assistant-add.yaml` goes straight from send to `approval-request`, answering no ownership question at all). A pre-existing gap, not this feature's regression, and unverifiable to fix blind.

- [x] T031 [P] Record the reusable learning in the knowledge base: the dev-container firewall now separates the FORWARD chain (runtime, never needed TMDB) from the OUTPUT chain (test runners, do), and web-api-mcp's integration tier is enrolled in CI — update `openwiki/invariants/testing-tiers.md` and/or `openwiki/runbooks/*` per [openwiki/INSTRUCTIONS.md](../../openwiki/INSTRUCTIONS.md) (write into the cited source, never into CLAUDE.md)
  - **Where it went, and why.** The FORWARD-vs-OUTPUT chain learning was already written into `docs/runbooks/devcontainer.md` during planning (`517f8a2`), so it was not duplicated. Everything else went into `openwiki/invariants/testing-tiers.md`, which is **[canonical]** — it cites no upstream `resource`, so per INSTRUCTIONS the learning belongs in the concept itself. Nothing was written into `CLAUDE.md`, and no generated OpenWiki page was hand-edited outside that canonical concept.
  - **What was recorded**: the enrollment and both of 048 FR-013's answers (credential by inspection, egress by measurement — run 1816's `9 passed`); that the skip-escalation had to come *first*, with the measured `5 skipped, exit 0`; and the `TMDB_API_KEY=` trap that does not reproduce a missing key. Plus three new Gotchas — the E2E runner rebuilds only the BFF (interrogate the container rather than trusting the build), a fixed-turn-SEQUENCE test gains a turn and never a relaxed assertion, and the dangerous sequence-walkers are the ones that do **not** go red.
  - **One correction to an existing line, made because it is the trap CLAUDE.md names.** The page said `@model-decision` tests are "excluded from the pull-request gate by `--grep-invert`". They are not: the selection is `grepInvert` applied inside `playwright.config.ts` under `E2E_TIER=gate`, and the CLI `--grep-invert` is accepted by Playwright 1.60 and does nothing here. Verified in the config and the workflow before changing the text.
  - **Governance**: the edit landed in a fingerprinted passage, so `check-openwiki-governance.mjs` failed until `openwiki/protected.yaml` was updated **in the same change** (the mechanism working as designed, not an obstacle). Both gates then pass — governance `✅ 947 paths, 63 concepts, protected passages intact`; `okf-lint ✅ 64 concepts conformant`.

---

## Dependencies

```text
Phase 1 (T001-T002)  →  everything
Phase 2 (T003→T004)  →  T013, T027      (US1's live gate; nothing in US2)
Phase 2 (T005)       →  re-run after T012 and T023
US1 (T006-T014)      ──┐
US2 (T015-T025)      ──┴→  Phase 5
```

- **T003 before T004.** The escalation must exist before the suite is enrolled: `MCM_REQUIRE_LIVE_STACK` does nothing without it, so enrolling first opens a window where a missing key skips clean and CI reports green for a suite that ran nothing.
- **US1 and US2 are independent.** They touch the same function (`to_movie_payload`) on different
  lines and the same E2E file in different tests — sequence them to avoid a conflict, but either can
  ship without the other.
- Within US1: T006/T008/T009 in parallel (T007 follows T006, same file) → T010 → T011 → T012 → T013 → T014.
- Within US2: T015/T017/T018/T019 in parallel (T016 follows T015, same file) → T020 → T021 → T022 → T023 → T024 → T025.
- T024 must follow T022: the integration tests cannot go red for the right reason until the chain actually changes.

## Parallel execution examples

```bash
# US1 test authoring — three files, no shared state
T006 mcp-servers/web-api-mcp/tests/unit/test_certification.py     # T007 follows, same file
T008 mcp-servers/web-api-mcp/tests/integration/test_tmdb.py
T009 agents/movie-assistant/tests/unit/test_proposals.py

# US2 test authoring
T015 agents/movie-assistant/tests/unit/test_organizer_add_chain.py  # T016 follows, same file
T017 + T019 agents/movie-assistant/tests/unit/test_proposals.py     # same file: sequence
T018 agents/movie-assistant/tests/unit/test_approval_gate.py
```

## Implementation strategy

**MVP = User Story 1.** It is the `priority/p2` bug, it puts false data in members' libraries on
every add, and it is fully proven by merge-blocking tiers. Shipping it alone is a coherent release.

**Then User Story 2**, which is additive and carries no data-correctness urgency.

**Do not defer Phase 2.** T003/T004 are what make the live check a gate rather than a habit — the
spec requires it (FR-020a). T005 is cheap and pays for itself the moment someone edits
`to_movie_payload` without noticing that three other callers share it.
