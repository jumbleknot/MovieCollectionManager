# MCM Testing Strategy

The canonical, repo-wide testing strategy for MovieCollectionManager. It describes **what we test,
how, where, and in what order** across every project in the monorepo — the Rust backend
(`mc-service`), the Expo frontend + BFF (`mcm-app`), the Python agent layer (`movie-assistant` +
the MCP servers), and the shared infrastructure.

> **Relationship to other docs.** This is the strategy/reference. The **executable rules an agent
> must follow** live in [`CLAUDE.md`](../CLAUDE.md) (test commands, run protocol, E2E modes,
> per-project gotchas) and the **per-feature task format** lives in
> [`docs/templates/feature-test-tasks-template.md`](templates/feature-test-tasks-template.md). The
> [constitution](../.specify/memory/constitution.md) sets the non-negotiable principles (TDD, Test Type Integrity,
> Evaluation gate, Platform Parity). `MCM-Testing-Strategy.docx` is the **superseded** May-2026
> efficiency analysis — its nine strategies are now realized and folded into this doc and CLAUDE.md
> (see §11).

---

## 1. Principles (non-negotiable)

1. **TDD is mandatory.** Test cases written → user approval → tests **fail (RED)** → implementation
   → tests **pass (GREEN)** → refactor. No production code without a failing test first. The
   per-task format makes RED/GREEN explicit (see §10 and the task template).
2. **Test Type Integrity — never mock the dependency under integration.** Unit tests isolate a
   function/method (mocks/stubs allowed). **Integration tests run against the REAL collaborators**
   (real MongoDB, real Keycloak/Redis, real MCP servers + `mc-service` + TMDB). The only
   cassetted dimension anywhere is the **LLM** in the agent golden gate, and only there.
3. **Tests assert the SPEC, not the implementation.** When a test and the code disagree, the spec
   wins; never weaken an assertion to match broken behavior. (013 lesson: a test that encoded the
   implementation's intent passed *together with* the bug.)
4. **E2E is required for every feature — backend included.** Unit + integration prove a component in
   isolation; only E2E proves the real path through every layer. A backend-only change still runs
   the consuming client's E2E. **Rebuild + redeploy the changed service/container first**, or the
   run validates stale code (§6.6).
5. **Coverage floors:** `mc-service` ≥70% line (tarpaulin); `mcm-app` unit ≥70% line (Jest).
6. **Stable selectors + independent state.** E2E uses `data-testid`/ARIA roles, never fragile CSS;
   every test resets its own state (§7).
7. **RTK active.** All AI-assisted sessions run with RTK (Rust Token Killer) compressing command
   output (~85–90% reduction) so the context window holds reasoning, not test boilerplate (§7.3).

---

## 2. The test pyramid (per layer)

| Layer | What it proves | Real collaborators? | Where |
|---|---|---|---|
| **Unit** | one function/method/component | mocks allowed | inline (Rust), `*.test.tsx` (frontend), `tests/unit/` (agent) |
| **Pure-resolver adversarial + property** | code-orchestrated resolution against the *messy* shapes the LLM/real data emit | none (direct calls) | agent `tests/unit/test_resolvers_*` + `tests/fixtures/adversarial.py` |
| **State-machine transition** | each `(stage, input) → next state` of a multi-turn workflow, derived from the spec | none (stubbed reads) | agent `tests/unit/test_state_machine_transitions.py` |
| **Golden (model decisions)** | the LLM's routing/extraction/plan decisions | LLM cassetted (only) | agent `tests/golden/` + `tests/integration/test_golden_pairs.py` |
| **Integration** | service↔service / service↔DB / agent↔MCP contracts | **all real** | Rust `tests/integration/`, frontend `tests/integration/`, agent `tests/integration/` |
| **E2E (web + mobile)** | critical user flows on the real client + full stack | **all real** | `frontend/mcm-app/tests/e2e/{web,mobile}` |

Most coverage lives at the bottom (fast, deterministic); E2E is the thin, expensive top that proves
the wiring. The agent layer adds two bands the others don't need — **adversarial/property resolver
tests** and **golden model-decision tests** — because its inputs are an adversarial LLM (see §5).

---

## 3. `mc-service` (Rust / Axum / MongoDB)

- **Unit tests** live in an inline `#[cfg(test)] mod tests` at the **bottom of the same source
  file** (not a separate file). Domain rules, value objects, the `Specification<T>` combinators,
  mapping, error translation. Repository ports are mocked with `mockall`.
  - `pnpm nx test mc-service` · single: `pnpm nx test mc-service -- --test collection_create`
- **Integration tests** in `backend/mc-service/tests/integration/` (sibling to `src/`) — each file a
  separate test binary compiled against the crate. Run against a **replica-set-enabled MongoDB**
  (the cascade-delete transaction needs it). Cover the CQRS handlers end-to-end through real Mongo,
  DAC authorization (`authorize_collection_access`, owner⊇contributor⊇viewer, unauthorized→404),
  cursor pagination, collation uniqueness (E11000 → typed domain errors).
  - `pnpm nx test:integration mc-service` (requires `--profile app` + `--profile keycloak`)
- **Lint:** `pnpm nx lint mc-service` (cargo clippy).
- **Coverage ≥70%:** `cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests
  --out Lcov`.
- **Auth is layer-not-handler** — `KeycloakAuthLayer` enforces RBAC on the protected sub-router, so
  tests don't re-assert auth per handler; DAC is asserted in the application-layer integration tests.

## 4. `mcm-app` (Expo frontend + BFF)

### 4.1 Unit (Jest / jest-expo)

- `*.test.tsx` colocated in `src/` (≈81 files); hooks, components, BFF server modules, generative-UI
  components, the dock. **≥70% line coverage enforced.** Run: `pnpm nx test mcm-app` · single:
  `pnpm nx test mcm-app -- --testNamePattern "name"`.
- React Native Web renders `testID` → `data-testid` (the E2E locator attribute).
- Type-check (no Nx target): `cd frontend/mcm-app && pnpm exec tsc --noEmit`.

### 4.2 BFF integration (real Keycloak + Redis + mc-service)

- `frontend/mcm-app/tests/integration/*.integration.test.ts` via a dedicated
  `jest.integration.config.js` (**not** the package.json jest block). `pnpm nx test:integration
  mcm-app`. Node env, `maxWorkers:1` (shared Redis db-1 + live BFF), `forceExit`.
- Real tokens via the **test-only `mcm-bff-test` ROPC client**; call `ensureRopcAudienceMapper()` in
  `beforeAll` for any test hitting `validateJwt`/mc-service. The ROPC grant must never be enabled on
  the production client.
- **Route-coverage gate:** `route-coverage.integration.test.ts` + `route-coverage-map.ts` fail if
  any `+api.ts` route lacks a test or a justified exclusion. Headless-untestable happy paths (login
  PKCE, refresh rotation, verify-email) are justified E2E exclusions.

### 4.3 Web E2E (Playwright)

- `tests/e2e/web/*.spec.ts` (≈21 specs). Run: `pnpm nx e2e mcm-app` (starts/reuses Expo on :8081).
- **Shared fixture + session reuse** (§7.1/7.2): `global-setup.ts` logs in **once** (storageState),
  seeds the read-only fixture collections via the **BFF API** (10–20× faster than UI), and warms
  `/home` + a collection + a movie-detail screen so the first test doesn't eat Metro's cold compile.
- **Final E2E runs against the containerized BFF** (the dev container, `:8082`, `X-BFF-Source:
  dev-container` asserted fail-fast) only after the Metro suites are green; the prod-HTTPS container
  is reserved for CI/CD. The same app+BFF code runs in every mode; only the server fronting it and
  the cookie/TLS posture change.

### 4.4 Mobile E2E (Maestro)

- `tests/e2e/mobile/*.yaml` (≈41 flows; `_`-prefixed files are reusable sub-flows). Run: `pnpm nx
  e2e:mobile mcm-app` · single: `maestro test tests/e2e/mobile/<flow>.yaml --env …`.
- **Android-only ritual** (this machine): QEMU `10.0.2.2` is broken → `adb reverse tcp:8081
  tcp:8081`; start Metro from `frontend/mcm-app` (not repo root); emulator `-no-snapshot-load -gpu
  swiftshader_indirect`. The installed APK is rebuilt only on a **native** change (see CLAUDE.md
  "do you even need to rebuild?").
- **Agent mobile flows prefer the CI harness** (`android-e2e.yml`, Metro-less embedded-bundle APK)
  because Metro OOM-crashes after ~1–2 agent `/run` calls locally.

### 4.5 Platform parity

When a feature spans **both** frontend clients, every E2E scenario is mirrored across Playwright
(web) and Maestro (mobile); the feature's tasks.md carries a **Platform Parity Table** with any
`N/A` justified. Backend-only features omit the table but not the E2E regression.

## 5. Agent layer (`movie-assistant` + MCP servers) — the highest-risk seam

The agent is **code-orchestrated**: the LLM only *classifies / extracts / plans / phrases*; **code**
resolves entities and drives every MCP tool, routing writes through the HITL gate. This keeps the
domain flows deterministic and golden-gateable — but it concentrates risk in two places the other
layers don't have: the **pure resolution functions** and the **multi-turn state machines**. The live
model emits *messy-but-valid* shapes that idealized fixtures never produce, so a fixture that shares
the code's blind spot passes *together with* the bug. Hence the extra bands below.

### 5.1 Unit + the SC-004 token-leak scan

- `pnpm nx test movie-assistant` (≈47 `tests/unit/` files). Includes the **token-leak scan**
  (`test_token_leak_scan.py`, `-m leak_scan`) — an AST scan over the agent + both MCP source trees
  asserting no auth-token-named variable is ever logged (SC-004).
- Lint: `pnpm nx lint movie-assistant` (ruff + mypy).

### 5.2 Pure-resolver adversarial matrices

Every code-orchestrated resolver (`resolve_option`, `_match_movie`, `_resolve_op_movie`,
`_unique_exact_match`, `_resolve_target`, `_split_title_year`, `references_current_screen`, the
search collection/title resolution) is tested **directly** (not only through-the-graph with clean
stubs) against the **shared adversarial catalogue** `tests/fixtures/adversarial.py`:

- echoed `"Title (Year)"` labels, full-name picks, **bare-prefix collisions** ("Avatar" ⊂ "Avatar:
  The Way of Water"), **subset/superset same-year** ("Back to the Future" ⊂ "Looking Back to the
  Future…", both 1985), **partial names** ("harry potter" → several), **sentence-like titles** ("I
  really want this movie" — contains "this" but must resolve by title), same-title/different-year
  duplicates (uniqueness is `(title, year)`), string-vs-int years, case/whitespace/punctuation,
  no-year titles, no-match, and multi-match (ambiguous → reported, never silently guessed).
- `tests/unit/test_resolvers_adversarial.py`.

### 5.3 Property-based invariants (Hypothesis)

`tests/unit/test_resolvers_properties.py` — invariants that hold for *all* inputs, not just the
catalogue: **closure** (a result is always one of the inputs), **soundness** (a resolved movie's
title always article-insensitively matches the query — never an unrelated film), **exact resolves**
(an exact full `(title, year)` always resolves to that element), **discriminator respected** (a
specified year is never violated), **ambiguity preserved** (an ambiguous input never silently
resolves).

### 5.4 Recorded-output → resolver bridge

`tests/unit/test_recorded_phrasing_resolves.py` feeds the **recorded model outputs from the golden
cassettes** through the resolvers and asserts correct resolution. The golden gate proves the model
*decision*; the bridge proves the *code* handles that decision's real shape — different failure
modes, and the bug usually lives in the second.

### 5.5 State-machine transition tables (spec-derived)

`tests/unit/test_state_machine_transitions.py` — for each multi-turn workflow with a `*_stage` state
machine (search / add / organize disambiguation), a table asserting `(stage, input-class) → expected
next state + emitted tool`, **derived from the spec's acceptance criteria, NOT the implementation**.
This is the band that catches spec↔impl drift (e.g. a single-result search auto-navigating when the
spec says "1+ results → buttons"). **Every workflow transition = one row.**

### 5.6 Golden model-decision gate (LLM cassetted)

The **only** place an external dependency is faked, and only the LLM dimension:

- `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` — keyless, deterministic CI gate;
  drift → `CassetteMissError`. The **mergeable** gate.
- `LLM_CASSETTE_MODE=record …` (needs `ANTHROPIC_API_KEY`) — re-record vs Claude; a live-model run is
  the **pre-deploy** gate.
- Cassettes are keyed by `sha256(model_id + prompt)`, so **any** supervisor/organizer/query prompt
  change invalidates the relevant cassettes — delete + re-record. Pins only the narrow LLM
  touchpoints: `classify_intent`, curator `extract_entities`, `plan_operations`, `extract_query`.
- **Record the ADVERSARIAL inputs on BOTH the runtime and the gate models.** Routing/extraction bugs
  are often model-specific (Claude dropped a sentence-like title that qwen2.5 parsed; a "…to movie
  collection" destination cued navigate). A clean-exemplar dataset gives false confidence.

### 5.7 Agent integration (all real)

`pnpm nx test:integration movie-assistant` — vs **real** Keycloak / MCP servers / `mc-service` /
TMDB / Ollama (skips cleanly when absent). Plus `tests/integration/test_resolution_realistic.py`:
the resolvers against **real** TMDB + seeded mc-service data, with the catalogue's hard cases seeded
(a unit stub can't reproduce a real search returning a bare title alongside its sequels).

### 5.8 Agent E2E (containerized)

The agent flows are exercised through the clients (web Playwright `agent-*`/`assistant-*` specs,
mobile Maestro) against the **containerized production-node gateway + MCP + dev BFF** — `pnpm nx
up-agents-prod infrastructure-as-code` then `pnpm nx e2e:agents mcm-app` (or `node
scripts/agent-e2e.mjs <spec>`). Run **isolated per spec file** (parallel trips the per-user
rate-limit + ~5-min token-expiry). **The required E2E must DISCRIMINATE new-vs-old behavior** (assert
the exact divergent input) **and the deployed artifact must be verified** (§6.6).

## 6. E2E & deployment discipline

1. **Iterate on Metro; finalize on the container.** All coding + unit/integration/iterative E2E run
   against Metro (fast inner loop). Final E2E validation runs against the **dev BFF container**
   (`:8082`) — the real `@expo/server` production server, proven via `X-BFF-Source`.
2. **Bounded retry, not flake-masking.** ≤1 explicit, visible retry per E2E test (`retries:1` web;
   `scripts/maestro-e2e.mjs` logs `⟳ RETRY 1/1` mobile). A genuine regression fails both attempts.
3. **Diagnose flaky-vs-broken deterministically.** The dev-container path is deterministic
   (~54s/93 web tests). Before blaming "the machine/Metro/emulator," reproduce against the container
   ×3 and compare a known-green baseline on the same clean machine. A swallowed 4xx looks like
   flakiness — instrument the boundary first.
4. **Stable selectors, no runtime patches.** A test must fail if the feature is broken; never "fix"
   the app inside the test.
5. **Cross-client parity** (§4.5).
6. **Rebuild + verify the deployed artifact before E2E.** `nx docker-build mcm-app` rebuilds the BFF
   image; **`scripts/agent-stack.mjs` skips rebuilding an existing image unless you pass `--build`**
   — a container recreated from a non-rebuilt image silently runs old code. After a rebuild, confirm
   the running container actually carries the change (`docker exec agent-gateway grep -c <new-token>
   src/…`). A green E2E against a stale gateway is the trap to avoid.

## 7. Efficiency & hygiene

### 7.1 Shared fixture — seed once, read many

`tests/e2e/fixtures/base-dataset.ts` defines the read-only **`E2E Browse`** collection (a scenario
matrix of movies spanning every contentType/rating/owned/ripped/media/genre/decade — §7.4), an
empty **`E2E Mutation`** for write tests, and an **`E2E Default`** for the auto-redirect test. Read
tests assert against the fixture; write tests create throwaway records cleaned up in `afterEach`.
**Tests must not read their own writes** across tests. Global setup seeds via the **BFF API** (no UI,
no Playwright output), and must never delete `E2E Browse`/`E2E Default` — only wipe non-fixture
movies from `E2E Mutation` at startup.

### 7.2 Session reuse

Playwright `storageState` is set globally so a single Keycloak login serves the whole run
(~40 logins → 1). Only `auth.spec.ts` logs in explicitly (`test.use({ storageState: undefined })`
for its unauthenticated cases). Eliminates SSO-session pollution and ~4k login tokens/run.

### 7.3 RTK output compression

RTK is **mandatory** for AI-assisted sessions (`rtk init --global`; verify `rtk gain` ≥80% after the
first test run). It strips test boilerplate while **always preserving full failure output**
(stack traces, assertion detail) and changed `git diff` hunks. Complementary reporter settings:
Playwright `dot` reporter, Jest `--silent`/`verbose:false`, cargo `-- --quiet`.

### 7.4 Scenario matrix

For any feature with combinatorial attributes, define the **test-data matrix in `tasks.md`** that
becomes the exact content of the fixture — making the tested combinations explicit and auditable
(e.g. `ripped=true + ownedMedia empty`). Derive exact assertion counts from the fixture
(`FIXTURE_MOVIES`). The agent analogue is the **adversarial catalogue** (§5.2): an explicit,
ever-growing matrix of the messy shapes the model/real-data produce.

### 7.5 Robust cleanup

Write tests tear down in **`afterEach` via BFF API calls** (reliable regardless of UI state), never
in-body UI clicks. A crashed run is recovered by deleting all collections with the known test
prefixes (`E2E`, `Playwright`, `Maestro` — each with a trailing space). MongoDB uniqueness makes
stale data cause
hard-to-diagnose re-run failures, so teardown reliability matters.

## 8. Run protocol & order

Run only what the change touches; widen on green (the legacy "Smart Test Run Order"):

1. **Isolated test** (fastest first — unit ms, E2E minutes): the single touched test.
2. **User-story suite** for the touched story (see the Feature Branch Test Scope table in CLAUDE.md).
3. **Full suite** — final validation only, not after every change.

**When a test fails:** read the output (don't guess) → run it in isolation → fix the **implementation**
(not the test, unless the test contradicts the spec) → re-run the single test → re-run the story
suite. **Never weaken an assertion to match broken behavior.**

## 9. Final validation checklist (before marking a feature complete)

- [ ] `pnpm nx test mc-service` — Rust unit
- [ ] `pnpm nx test:integration mc-service` — Rust integration (live replica-set Mongo)
- [ ] `pnpm nx test mc-service` coverage ≥70% (`cargo tarpaulin …`)
- [ ] `pnpm nx lint mcm-app` / `pnpm nx test mcm-app` (≥70%) / `pnpm exec tsc --noEmit`
- [ ] `pnpm nx test:integration mcm-app` — BFF integration (live Keycloak + Redis + mc-service)
- [ ] `pnpm nx e2e mcm-app` — web E2E (REQUIRED for **every** feature, backend included)
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E
- [ ] **Agent features also:** `pnpm nx test movie-assistant` (incl. leak scan) · `LLM_CASSETTE_MODE=replay
      pnpm nx test:golden movie-assistant` · `pnpm nx lint movie-assistant` · `pnpm nx
      test:integration movie-assistant` · `pnpm nx e2e:agents mcm-app` (rebuild gateway/BFF first)
- [ ] `rtk gain` — >80% compression confirmed

If a deployed service/container was changed, **rebuild + redeploy it first** or the E2E validates a
stale image.

## 10. TDD checkpoint format

Every TDD task pair makes RED/GREEN explicit (see the task template for the full format):

```text
- [ ] T027 Write unit tests (RED). Scenarios: …  Verify RED: <cmd>  Expected: N failures.
- [ ] T028 Implement …; pass T027 (GREEN).        Verify GREEN: <cmd>  Expected: N passes, 0 fail.
```

If `Verify RED` shows 0 failures the test is wrong — stop and fix it before implementing.

## 11. Cross-check vs the legacy strategy doc

The superseded `MCM-Testing-Strategy.docx` (May 2026) proposed nine improvements. Each is now
realized; the agent-correctness bands (§5) are net-new since then.

| # | Legacy strategy | Status / where it now lives |
|---|---|---|
| 1 | Shared fixture (seed once, read many) | ✅ `tests/e2e/fixtures/base-dataset.ts` + `global-setup.ts` (§7.1) |
| 2 | Session reuse (storageState) | ✅ Playwright global storageState; only `auth.spec.ts` re-logs in (§7.2) |
| 3 | Scenario matrix for data coverage | ✅ fixture matrix + tasks.md table; agent **adversarial catalogue** (§7.4, §5.2) |
| 4 | Smart test run order | ✅ CLAUDE.md "Test Run Protocol" (§8) |
| 5 | Mobile/Web parity table | ✅ Platform Parity Table in tasks.md (§4.5); constitution principle |
| 6 | TDD checkpoint protocol (RED/GREEN) | ✅ task template + §10 |
| 7 | Robust cleanup (afterEach via API) | ✅ §7.5 + prefix-based crash cleanup |
| 8 | CLAUDE.md additions (scope / on-fail / final validation) | ✅ all three sections in CLAUDE.md (§8, §9) |
| 9 | RTK output compression | ✅ mandatory prerequisite (§7.3) |

**Net-new since the legacy doc (this strategy's additions):** the agent-layer correctness bands —
pure-resolver **adversarial matrices** (§5.2), **property invariants** (§5.3), the **recorded-output
bridge** (§5.4), **spec-derived state-machine transition tables** (§5.5), the **golden model-decision
gate** with adversarial inputs on both models (§5.6), and the **deploy-discrimination** rule (§6.6).

## 12. Maintenance discipline

- **Every new resolver joins the catalogue + a property test the moment it is written.** The
  adversarial harness only catches what is registered with it.
- **Every bug found in live/manual testing becomes a permanent catalogue entry** (and, if model-
  driven, a golden dataset row recorded on both models) — fixtures converge on the real failure
  surface, not the developer's happy path.
- **Every workflow transition is a row in the transition table**, written from the spec.
- **When you change an LLM prompt, re-record the golden** (delete the stale cassettes first) and
  verify on the runtime model, not just the gate model.
- **When you change a deployed service, rebuild its image and verify the running container** before
  trusting any E2E result.
