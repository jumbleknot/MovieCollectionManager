---
type: Convention
title: Testing tiers and what gates a merge
description: The unit / integration / golden / E2E test tiers used across mc-service, mcm-app, and the agent gateway, and which of them actually block a merge in CI versus which are informational.
tags: [testing, tdd, ci, gates]
timestamp: 2026-07-26T20:11:56+00:00
---

# Testing tiers and what gates a merge

TDD is mandatory across the repo (tests written → approved → red → implementation → green →
refactor). Below that policy, each project exposes the same four Nx-invoked tiers with
project-specific meaning:

| Tier | mc-service | mcm-app | Agent Gateway |
|---|---|---|---|
| **Unit** | inline `#[cfg(test)]` modules, bottom of the tested file | Jest, ≥70% line coverage enforced | `pytest tests/unit` |
| **Integration** | `tests/integration/`, requires MongoDB | requires Keycloak + Redis running | `pytest tests/integration`, requires live stack |
| **Golden** | — | — | `pytest tests/integration -m golden` — cassette-recorded LLM behavior |
| **E2E** | exercised indirectly via mcm-app E2E | Playwright (web) + Maestro (mobile) | mobile agent flows via Maestro |

All tiers run through Nx (`pnpm nx test <project>`, `pnpm nx test:integration <project>`) — see
[Nx as the task runner](/openwiki/invariants/nx-task-runner.md) for why direct tool invocation is
discouraged.

## The golden tier is a MARKER, not a directory

This is the trap most likely to cost the next person a session. The golden tier is entered by
`@pytest.mark.golden` on a test **that lives under `tests/integration/`** — not by where the file
sits:

- `nx test:golden` runs `pytest tests/integration -m golden`.
- `tests/golden/` holds **only** cassettes, `dataset.json` and `compare.py` — no tests, and neither
  selector globs it. **Moving a test into `tests/golden/` makes it run nowhere**, silently: the run
  still exits 0, just with a smaller collection.
- `app-ci`'s agent step selects `-m "not golden"`. The two selectors are therefore complementary and
  exhaustive over `tests/integration/` (measured: 62/113 + 51/113 = 113), so **adding the marker
  enrols a test in the keyless replay gate and deselects it from the live-key job in one change**.

That property is what let feature 048 move the 9 topic-confinement tests off the live model without
touching any workflow: they assert a *model decision*, which is what the golden tier is for, and they
had been erroring `app-ci` whenever the Anthropic balance ran out.

## Where each gate runs

| Gate | Command | Where | Credential |
|---|---|---|---|
| Golden — merge | `LLM_CASSETTE_MODE=replay nx test:golden` | `guardrails.yml` | **none** (cassette replay) |
| Golden — pre-deploy | `nx test:golden-live` | `cd-deploy.yml`, before build/promote/webhook | `ANTHROPIC_API_CD_GOLDEN` |
| Agent integration | `nx test:integration movie-assistant -- -m "not golden"` | `app-ci` `app-e2e` | `ANTHROPIC_API_CI_E2E` |
| MCP integration | `nx test:integration movie-mcp` / `spreadsheet-mcp` / `web-api-mcp` | `app-ci` `app-e2e` | `TMDB_API_KEY` (web-api-mcp only) |

Quality gates run **at merge or at deploy, never on a timer** (product-owner constraint): a scheduled
gate can only ever report damage that already shipped.

**`web-api-mcp` was the one integration tier that ran nowhere, and 059 enrolled it.** 048 FR-013 had
excluded it for two reasons it recorded as unresolved rather than merely unexamined: outbound egress
from the runner to `api.themoviedb.org` was unconfirmed, and "which key a CI run should spend" was
unsettled because TMDB keys are per-user in this design. Both are now answered:

- **The credential question was answerable by inspection.** `TMDB_API_KEY` was *already* a job-level
  env on `app-e2e` and already passed into the E2E container. The per-user design governs the
  **runtime** request path, not this suite; a CI run spends the CI key. The step inherits the
  job-level binding rather than re-declaring the secret.
- **The egress question was answered by running it**, deliberately — an unconfirmed path that fails
  loudly on its first run beats one that stays unexamined. Measured on run 1816:
  `9 passed in 1.12s`, **0 skipped**. The runner can reach TMDB.

**The order was the load-bearing part.** The skip-escalation went into that suite's conftest
*before* the enrollment, never after. Measured with the key absent from both the environment and
`.env.local`: the suite gave **`5 skipped`, exit 0** — indistinguishable from a pass. Enrolling first
would have opened exactly the window where CI reports green for a suite that ran nothing, which is
the failure this whole section exists to prevent.

A related trap worth naming, because it made the first attempt at that measurement report a false
green: `TMDB_API_KEY= pytest …` does **not** reproduce a missing key. The conftest reads
`os.environ.get(k) or _ENV.get(k)`, so an *empty* variable falls through to `.env.local`. Reproducing
the CI condition locally means moving the file aside, not blanking the variable.

## What actually gates CI

**The integration tier gates CI.** The `app-ci` workflow's `app-e2e` job runs `test:integration` for
all three projects (agent, mc-service, mcm-app) with a live-stack requirement flag that **escalates a
skip into a failure**. Before this was added, no project's integration tier ran anywhere in CI — only
a keyless golden subset — and it silently rotted for roughly a month without anyone noticing.

**The full web E2E regression (`pnpm nx e2e mcm-app`) is required for every feature, including
backend-only changes** — a Rust-only or Python-only change is only proven end-to-end by driving it
through the BFF from the client's perspective.

## Which AGENT assertions may block a merge

**An agent assertion may block a merge only if the same code and the same prompt cannot produce a
different verdict on a re-run.**

Stated as a property of the assertion, not of its failure history: a test is not promoted for having
been lucky, nor demoted for having been unlucky.

| Blocks a merge | Does NOT block |
| --- | --- |
| the turn reaches the gateway and a reply renders | which words the model chose |
| the approval gate pauses and resumes | which tool the model selected |
| a chosen option navigates to the right route | how options were ranked |
| a tool call reaches mc-service and persists | whether TMDB returned this title first |
| an error surfaces to the member | whether the model classified an utterance as X |

**Borderline falls into the gate only if the deterministic half can be asserted on its own.**
Splitting a test is expected; guessing is not. Where a model-decision test is the ONLY coverage of a
wiring path, the wiring assertion stays in the gate — split out, not moved wholesale.

### The rule is ENFORCED, because stating it was not enough

The table above already said that "which words the model chose" must not block a merge. It was still
violated three times, and one of those violations reddened the gate on a run where nothing was
broken: `assistant-add-ambiguous.spec.ts` required the assistant's reply to contain the word
"matches", the model answered with a raw JSON blob instead, and the locator polled **283 times**
against a present, stable element. It was never waiting for the app — only for a particular
sentence (item #323).

`scripts/__tests__/agent-test-classification.test.mjs` now fails the build on a prose assertion
inside a `@gate` test.

**The discriminator is the LOCATOR, not the string.** `toContainText('Pirates')` against an
approval card asserts what the app rendered from data; the identical call against
`assistant-msg-assistant` asserts how the model phrased itself. No string heuristic can separate
those, and one that tried would either miss real cases or ban legitimate ones. Aliasing the locator
to a variable first is the same violation and is caught too.

> ⚠️ **The trap is that a prose assertion is usually doing DOUBLE DUTY — asserting *and* waiting.**
> All three violations sat immediately before the assertions that actually mattered (no proposal was
> built; the collection now exists), and deleting the prose line outright would have made those pass
> vacuously, before the assistant had even replied. Each needs a model-invariant *wait* in its place:
>
> - **waiting for a reply** → count `assistant-msg-assistant` before the turn and poll for the
>   count to increase. The model must answer something; it need not answer anything in particular.
> - **waiting for a write** → poll the API for the effect (`findCollection(...) !== undefined`)
>   rather than for the model's confirmation wording. "Done" is phrasing and is free to vary; the
>   row appearing is the behaviour the test exists to prove.
>
> Both are what the test meant all along, which is why neither weakens it.

### A stable testid is NOT sufficient — the BRANCH matters too

Asserting on a testid instead of prose is necessary and **not sufficient**. Measured over 30
single-worker runs on one unchanged tree (item #323, criterion 3):

```
28/30  agent-import-disambiguate  — selection-options never appeared (150 s timeout, x2)
29/30  agent-import               — import-preview never appeared (x1)
30/30  the other nine @gate tests
```

`selection-options` is a perfectly stable testid; the app renders it reliably. The obvious reading —
that the model chose not to offer a selection — was **wrong**, and item #337 records the investigation
that settled it. Two things were true instead, and both matter more than the tagging question:

**1. The branch is decided by PURE CODE, in all three cases.**

| flow | what decides whether `selection-options` renders |
| --- | --- |
| `agent-import-disambiguate` | `resolve_tab_collection` — asks whenever the tab name has **0 or >1** exact case-folded collection matches. A tab named `unmatched-<epoch>` can only ever be 0. |
| `agent-navigate-collection` | `_resolve_collection` — returns a target only when `len(matches) == 1`. Two `<prefix>`-matching collections force the ask. |
| `agent-card-navigate` | `_run_owned` — emits `render_selection` on **both** branches, matches and no-matches alike. There is no resolve-directly path at all. |

The only model input in these three flows is the **supervisor's intent classification** — which node
answers, not what that node then renders.

**2. The turn was being dropped in the CLIENT, before it was ever sent.** Features 053/054 fixed
exactly this once: a message sent while the assistant was still answering was silently lost, and the
fix was a queue in `useAssistantRun`. That fix reached **two of five send paths**.
`request-import-file.tsx`, `disambiguation-options.tsx` and `render-movie-card.tsx` each kept their
own agent handle and returned early on `isRunning`. The first of those dropped the import turn
*after* the upload had already staged a single-use file handle server-side — so the file was stranded
and no turn ever arrived to consume it. Run 2541's client evidence shows it exactly: a run in flight
at `49.183`, the upload completing at `49.241`, and no run POST afterwards in a ring marked
`complete — nothing dropped`.

> ⚠️ **A DROPPED TURN AND A DIFFERENT BRANCH LOOKED IDENTICAL, AND THAT IS WHAT COST THREE SESSIONS.**
> Both presented as `selection-options` timing out after 150 s. Nothing in the bundle separated them,
> because `record_turn(intent)` is an OTel counter and the classified intent reached **no log** —
> so "the supervisor routed this elsewhere", "the node took its other branch" and "no turn arrived"
> were one indistinguishable red. Feature 064 logs one
> `turn routed: intent=… node=… thread=…` line per turn, from a single site wrapping every
> `_classify` return, so absence of a line now means absence of a turn.

### The supported way to wait for a turn

Feature 064 added the primitive item #337 asked for, on both surfaces:

- **web** — `tests/e2e/web/setup/assistant-turn.ts`: `beginTurn` reads the current
  `assistant-msg-assistant` count, `awaitTurn` waits for it to rise, and `offeredSelection` then
  looks at what the turn produced within a **bounded** grace window (30 s — the tool call streams AFTER
  the text, so a guard read the instant the bubble appears races the render);
- **mobile** — `tests/e2e/mobile/_await-turn.yaml` waits for an `assistant-msg-assistant` bubble to
  EXIST. Maestro cannot count elements, so the mobile statement is deliberately weaker than the web
  one; its callers open with `clearState` and an empty dock, so for a flow's first turn the two
  coincide, and a flow needing a later turn waits for the affordance that turn produces.

> ⚠️ **A TEST AFFORDANCE THE RUNNER CANNOT SEE IS WORSE THAN NONE.** The first attempt rendered the
> count into the app as a 1 px, `opacity: 0` `assistant-turn-<n>` View so both runners could read one
> number. MEASURED on CI run 2566: Android never exposed it — an alpha-0 node is not `visibleToUser`
> — and `agent-card-navigate.yaml` failed 3/3 against a marker that was in the React tree the whole
> time, costing a full `maestro-agent-flows` cycle to discover. `assistant-msg-assistant` was already
> waited on by `assistant-add.yaml` and `assistant-config-enable*.yaml`, i.e. **proven on that
> surface rather than assumed** — and using it adds no test-only surface to the product. Prefer an
> affordance some flow already asserts on to one you reason should work.

Wait for the turn, **then** look at the branch. A test that reaches for the branch first is back to
spending its whole budget discovering that the branch was not taken — and
`agent-test-classification.test.mjs` now fails on that ordering inside a `@gate` test.

The mobile win is concrete: `ci-mobile-agent-flows.sh` retries each flow 3x with 150 s waits, so one
unluckily-branched turn cost ~7.5 minutes and, on 2026-09-02, let `maestro-agent-flows` burn **45
minutes** before item #326's step ceiling killed it. After the split, the branch wait is seconds and
`agent-disambiguation.yaml` no longer fails at all when the curator resolves directly — it asserts
the rendered card, which both branches reach.

`KNOWN_BRANCH_WAITS` is now **empty**. It is still asserted EXACT, so it can only shrink, and
`agent-send-path.test.mjs` fails the build if any component outside `useAssistantRun` drives the
agent or guards a send on `isRunning` — the invariant that decayed silently between 054 and #337.

### What this costs, said plainly

The gate stops proving that the assistant makes the **right decision**. It proves only that the
machinery around the decision works. That is a real reduction in what a green tick means, and it is
the price of a gate that means something when it is **red**.

### The evidence that forced it

Two `app-ci` runs on **identical code** (sha `1fada7a`), same worker count, same stack:

| run | counts |
| --- | --- |
| #1684 | `failed=0 flaky=0 passed=177 did-not-run=0 skipped=0` |
| #1685 | `failed=1 flaky=7 passed=166 did-not-run=3 skipped=0` |

Every alternative explanation was excluded by a **measured counter**, not by argument: `verdict=healthy`
at 93 gateway posts per 100 tests (not the #173 collapse), `refresh_429=0` and `session_evicted=0`
(not contention), `minted 8 worker identities` (not the shared identity of #169), item #179's gateway
livelock fixed, and zero identity/login/403/fixture errors. All eight affected entries were
model-decision assertions.

A required gate that fails on identical code roughly half the time is not gating. It taxes every pull
request with a coin flip and teaches people to re-run — the habit that hid five stale specs for three
weeks (#150) and caused a sound fix to be reverted on a two-run inference (#166/#173).

### Where the non-blocking ones run

Tagged `@model-decision`, excluded from the pull-request gate by the `grepInvert` that
`playwright.config.ts` applies when `E2E_TIER=gate` — **not** by a `--grep-invert` CLI flag, which
Playwright 1.60 accepts here and silently ignores (`--grep CORS` lists 1 test, `--grep-invert CORS`
lists all 177). A CLI-based split would have run everything while looking correct. Run as a second
non-blocking selection in the SAME job on pushes to `main` and on `workflow_dispatch`. They keep
running, keep publishing counts through the same bundle channel the gate uses, and cannot silently
stop — a tier that quietly stopped running would read as one that is passing, which is the failure
this arrangement exists to avoid. **Nothing leaves the gate without a tier that runs it** (051 SC-001,
054 FR-017).

## Gotchas

- **A skip is a failure in CI, not a soft pass.** Locally, a missing dependency skips a suite
  cleanly; in CI, an unexpected skip is treated as a broken test harness and fails the job.
  Legitimately-optional skips must be added to an explicit allowlist per suite — never used as a way
  to turn a red run green. Three flags carry this: `MCM_REQUIRE_LIVE_STACK=1` (integration suites,
  incl. both MCP servers), `E2E_REQUIRE_AGENT_STACK=1` (agent E2E), and `MCM_REQUIRE_LIVE_MODEL=1`
  (the pre-deploy golden gate). **Watch the SKIP COUNT** — a skipped suite exits 0 and reads as a pass.
- **A whitelisted skip reason outlives the thing it excused.** `"no cassette"` sat in the agent
  suite's allowlist long after every one of the 41 golden pairs had a cassette, where it could only
  ever mask a future regression. Measure before adding one, and re-measure before keeping it.
- **A missing fixture must fail, not skip.** Under `LLM_CASSETTE_MODE=replay` an absent cassette
  fails the run. It used to skip, so deleting every cassette produced a green golden gate — a gate
  that cannot fail is not a gate.
- **"It can't run in this environment" is a conclusion to distrust.** A credential-driven skip is
  almost always a missing *file*, not a missing *capability*. In 2026-08 the agent integration suite
  produced 38 credential errors and was written off as un-runnable in the dev container; the cause was
  one absent gitignored `frontend/mcm-app/.env.local`, which `gen-dev-env.mjs` skipped silently
  because the file did not exist, and one command fixed it (13 passed / 38 errors → 51 passed / 0
  failed). Before retiring a tier to CI, name the specific missing input and check whether a generator
  or documented command supplies it — see
  [local-dev.md](../../docs/runbooks/local-dev.md) §"A credential-driven skip is a missing file".
- **A skip reason that cannot be acted on is itself a defect.** Every credential skip in this repo
  names the variable, the file it is read from, and the command that fixes it. "Needs the live stack"
  is what got a tier retired by accident; if you meet a message like that, fix the message.
- **A generator that silently no-ops is a gate that skips to green, one layer down.** `syncEnvFile`
  returned early on a missing path and reported success. Same failure mode, different disguise — the
  false conclusion it produced was "unrunnable" rather than "passing".
- **Agent/MCP images are rebuilt on every CI run, not reused.** Before this was enforced, CI could
  test whatever image happened to be cached on the runner — an `agents/**` or `mcp-servers/**` change
  could go untested against its own code.
- **If a deployed service/BFF container was changed, rebuild + redeploy it before the E2E run** — the
  E2E suite otherwise validates a stale image and reports false confidence. `scripts/agent-e2e.mjs`
  recreates **only the BFF**: the gateway and the three MCP servers keep whatever image is on the
  daemon, so an `agents/**` or `mcp-servers/**` change needs `scripts/agent-stack.mjs` first. Don't
  trust the rebuild either — interrogate the running container (`docker exec … python -c "from
  src.tools import <new symbol>"`), which is one command and turns "I rebuilt it" into evidence.
- **A test that walks a fixed turn SEQUENCE is coverage that a new question silently invalidates.**
  Inserting one question at the front of the assistant's add chain (059) turned **34** existing tests
  red across the unit, integration and E2E tiers — every one of them a helper that answered by turn
  *order* rather than by stage *name*. The rule is to **add a turn**, never to relax an assertion to
  "some stage": the ordering is usually the guarantee the feature is about, and a relaxed assertion
  stops proving the question is asked at all. Prefer helpers that match a reply to its question by
  name, so the next inserted question lengthens the walk instead of silently redirecting every
  caller's "yes" to a different question.
- **The dangerous ones are the sequence-walkers that DON'T go red.** Two in 059. A gateway
  integration test walked a fixed answer list under a comment claiming it matched "by STAGE rather
  than by a fixed number of turns" — it never did; the list slid by one, the test still reached the
  approval gate, and it passed while exercising a *different* flow than the one it documents. And
  three E2E specs sharing an `answerOwnership` helper were missed entirely by the feature's own task
  list, two of them `@gate`; they surfaced only from a red CI run. **A green that survives a change
  to the thing under test proves nothing** — when you change a flow, grep for every caller of the
  shared helper, not just the files the plan named.
- **Golden tests are the model-cost-bearing surface.** All intent mapping, dedup, and resolution logic
  is pure code and unit/property tested at zero model cost; only actual model *decisions* (intent
  classification, phrasing) are exercised by the golden cassette suite, keeping the expensive tier
  small and stable. See [Model-provider scoping](/openwiki/invariants/model-provider-scoping.md) for
  why golden cassettes are recorded against Claude specifically.
- **Nx target caching differs by tier**: `test` is cached, `test:integration` is explicitly
  uncached (`nx.json` `targetDefaults`) because it depends on live external state that Nx cannot see.

Full CI-enforcement rationale and evidence that the gate genuinely catches regressions:
`specs/041-integration-test-ci-enforcement/SC-003-SC-004-EVIDENCE.md`; day-to-day test-run ordering
and the mandatory final validation checklist live in `CLAUDE.md`'s Test Run Protocol section.
