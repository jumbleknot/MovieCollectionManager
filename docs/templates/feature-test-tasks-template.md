# Template: Feature Test Tasks

**Usage**: Copy this template when writing `tasks.md` for any new feature. Replace all `[placeholder]` values. Delete sections that do not apply (e.g., documentation tasks have no RED/GREEN cycle).

This template is referenced from the repo-root `CLAUDE.md` — do not move it.

---

## Template: Test Task (with TDD checkpoint)

Use this format for every task that writes or modifies a test.

````markdown
### T[NNN] — [Task title in imperative form]

**Type**: [Test | Test refactor | New file] | **Time**: [estimate] | **Risk**: [None | Low | Medium | High]

**Spec reference**: [spec.md#user-story-N] (which acceptance scenarios this task covers)

**Scenarios covered**:
- US[N]-AC[N]: [Acceptance criterion text from spec.md]

**File(s)**: `path/to/test/file.spec.ts`

[What the test does — behaviour verified, selectors/assertions, required setup.]

**Verify RED** (run before implementing — test must fail):
```bash
[exact command to run the test in isolation]
```
**Expected RED**: [N] test(s) failing — `[expected failure message / assertion error]`

> If this shows 0 failures, the test is trivially passing and must be fixed before implementation. A passing test that was never RED is not a TDD test.
````

---

## Template: Paired Implementation Task

Every test task must have a corresponding implementation task immediately after it.

````markdown
### T[NNN+1] — [Implementation title — mirrors the test task]

**Type**: Implementation | **Time**: [estimate] | **Risk**: [None | Low | Medium | High]

**Spec reference**: [same as the paired test task]

**Prerequisite**: T[NNN] complete and verified RED.

[What to implement — specific files, functions, API calls, or config.]

**Verify GREEN** (run after implementing — test must pass):
```bash
[same command as the test task's Verify RED]
```
**Expected GREEN**: 0 failures — `[summary line, e.g., "5 passed"]`

**Also run the touched suite** (regression check — not the full suite):
```bash
pnpm nx e2e [project] -- [path/to/touched/file]   # web E2E; or: pnpm nx test [project] -- --testNamePattern "..."  (unit)
```
**Expected**: previously passing tests still pass.
````

---

## Template: Documentation / Config Task (no RED/GREEN)

````markdown
### T[NNN] — [Task title]

**Type**: [Documentation | Config change | Utility script] | **Time**: [estimate] | **Risk**: None

**Spec reference**: [FR-NNN] or [SC-NNN]

[What to do — sections to add, config keys, files to create.]

**Done when**: [Concrete observable condition confirming completion.]
````

---

## Template: Platform Parity Table

Add one to every **multi-client** feature's `tasks.md`, before the Completion Checklist (see "Adapting to project type" below — skip for backend/single-client features). Use **real** flow filenames from the project's mobile E2E flow directory — verify they exist (e.g., `ls <app>/tests/e2e/mobile/`) rather than guessing.

```markdown
## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: [scenario] | [spec filename] | [flow filename] | ✅ |
| US2-AC1: [scenario] | [spec filename] | [flow filename] | ✅ |
| US3-AC1: [scenario] | [spec filename] | N/A — [justification] | N/A |
| US4-AC1: [scenario] | [spec filename] | [create: new-flow.yaml] | ❌ Gap |
```

**Column definitions:**

- **Scenario**: `US[N]-AC[N]: [brief description]` — maps to a spec.md acceptance criterion
- **Web (Playwright)**: spec filename, or `N/A` + justification
- **Mobile (Maestro)**: flow filename, or `N/A` + justification, or `[create: filename.yaml]` for a gap
- **Status**: `✅` (both covered), `N/A` (justified gap), `❌ Gap` (needs a resolution task)

**N/A justification examples** (must be written, never blank):

- `N/A — web routing behavior only (auto-redirect uses browser URL; not applicable to the native navigator)`
- `N/A — mobile uses native layout without a column visibility toggle`
- `N/A — toolchain/process task, not a UI flow`

Every `❌ Gap` needs a corresponding task in the list.

---

## Template: Completion Checklist

Add at the end of every `tasks.md`. Order = cheapest feedback first; `rtk gain` last (it measures the runs above).

```markdown
## Completion Checklist

Before marking `[NNN]-[feature-name]` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: [Success criterion text]
- [ ] **SC-002**: [Success criterion text]
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test [project]` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration [project]` — integration tests pass
- [ ] `pnpm nx lint [project]` — no lint errors
- [ ] `pnpm nx e2e [project]` — web E2E passes
- [ ] `pnpm nx e2e:mobile [project]` — mobile E2E passes (mobile flows require a logged-out start between runs)
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)
```

---

## Adapting to project type

This template is shaped for a **frontend app** (web + mobile clients). Adapt per project:

- **Frontend app** (e.g., an Expo app): use all sections. Include the **Platform Parity Table** and the `e2e` / `e2e:mobile` checklist lines. Web tests via Playwright (`tests/e2e/web/`), mobile via Maestro (`tests/e2e/mobile/`).
- **Backend service** (e.g., a Rust/Axum service): **omit** the Platform Parity Table (no UI surface of its own). Keep the TDD checkpoint format; the checklist is unit + integration + lint + coverage, e.g.:
  - `pnpm nx test [project]` — unit tests pass
  - `pnpm nx test:integration [project]` — integration tests pass (DB/contract)
  - `pnpm nx lint [project]` — no lint errors
  - coverage tool meets the threshold (e.g., `cargo tarpaulin … --out Lcov` ≥70%)
  - **`pnpm nx e2e [frontend-app]` — full-stack E2E regression of the consuming client(s) (REQUIRED even for backend-only features).** A backend change is exercised by clients through the API surface; the E2E suite is the only check that proves the real user path still works end-to-end. **First rebuild + redeploy the changed service** (`pnpm nx build [service]`, then recreate its container) — a stale deployment makes the E2E validate old code. Run against the deployed (not in-memory) service using whatever target the consuming app provides for a containerized backend (e.g., MCM repo: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`).
- **AI agent layer** (e.g., a LangGraph agent + MCP servers, Python via `@nxlv/python`): keep the TDD checkpoint format. Checklist = unit + integration + lint + the agent-specific gates:
  - `pnpm nx test [agent]` — unit tests pass (Python/`pytest`); **include the SC-004 token-leak scan** here (no auth token in state/logs/traces — an AST scan over the agent + MCP source; runnable in isolation via a `leak_scan` marker).
  - `pnpm nx test:integration [agent]` — integration vs **real** MCP servers + real `mc-service` + the external API (e.g. TMDB) + real Keycloak; **never mock the dependency under integration**. Skips cleanly when the live stack is absent.
  - The **golden-pair regression suite is the deployment gate** (constitution §Evaluation): `LLM_CASSETTE_MODE=replay pnpm nx test:golden [agent]` replays recorded responses of **only the LLM** (keyless, deterministic, drift → loud failure) — the mergeable CI gate; a live-model record run is the pre-deploy gate. **Cassette ONLY the LLM dimension** — MCP/`mc-service`/external APIs stay real.
  - `pnpm nx lint [agent]` — no lint errors (e.g. ruff + mypy).
  - **`pnpm nx e2e [frontend-app]` + `e2e:mobile`** — the consuming client(s)' full-stack E2E (REQUIRED — an agent feature is exercised by the clients through the BFF → gateway). Rebuild + redeploy the changed gateway/BFF first or the run validates stale code.
  - **Platform Parity Table** applies only when the agent feature spans multiple *frontend* clients (e.g. an assistant flow on both web + mobile — then mirror each E2E across Playwright + Maestro).
  - **Code-orchestration resolution coverage — the layer most prone to LLM-output bugs (012 Phase 9 / research R17 lesson).** When the design is code-orchestrated (the LLM only extracts / classifies / plans; CODE resolves entities + drives tools), the pure resolution / normalization functions (pick or option resolution, title ↔ entity matching, target / collection resolution) are the **highest-risk seam** — the live model emits *messy-but-valid* shapes that idealized fixtures never produce, and a fixture that shares the code's blind spot passes *together with* the bug. The unit/integration/golden gates above do NOT cover this by themselves. Required for each such resolver:
    - **Direct adversarial unit matrices** (test the resolver DIRECTLY, not only through-the-graph with clean stubs) against a **shared fixture catalogue** of the shapes the model actually emits: echoed `"Title (Year)"` labels, full-name picks, **bare-prefix collisions** (a short name that is a prefix of longer ones — e.g. "Avatar" ⊂ "Avatar: The Way of Water"), same-key / different-attribute duplicates (uniqueness is often `(name, year)`, not name alone), string-vs-int discriminators, case / whitespace / punctuation, no-match, and multi-match (ambiguous → reported, never silently guessed).
    - **Property-based invariants** (e.g. Hypothesis): a non-None result is always one of the inputs; an exact full-name input resolves to that element; a specified discriminator (e.g. year) is never violated by the result; an ambiguous input never silently resolves.
    - **A recorded-output → resolver bridge test:** feed the *recorded* model outputs from the golden cassettes through the resolvers and assert correct resolution. The golden gate proves the model **decision**; the bridge proves the **code** handles that decision's real shape — they are different failure modes, and the bug usually lives in the second.
    - **Integration fixtures must reproduce real data VARIETY**, not clean happy-path seeds — seed the hard cases (prefix collisions, same-name/different-year) and run the resolvers against **real** MCP / external-API results (a unit stub can't reproduce, e.g., a real search returning a bare title alongside its sequels).
    - **Discipline:** every bug found in *live / manual* testing becomes a permanent entry in the adversarial catalogue, so the fixtures converge on the real failure surface instead of the developer's idealized happy path. **And every NEW resolver joins the catalogue + a property test the moment it is written** — the adversarial harness only catches what is registered with it (013 Inc5 lesson: resolvers added without registering them regressed on exactly the shapes the catalogue exists to cover).
  - **Multi-turn state-machine coverage — derive the table from the SPEC, not the implementation.** A deterministic workflow built on a `*_stage` state machine (search / add / organize disambiguation) needs a **spec-derived transition table** asserting, for each `(stage, input-class)`, the expected next state + emitted tool — written from the spec's acceptance criteria, NOT the code. (013 Inc5 lesson: a single-result collection search auto-navigated, contradicting the spec's "1 or more results → buttons"; the unit test passed *because it encoded the implementation's* intent. A table traced to the spec turns spec↔impl drift into a failing test. Every workflow transition = one row.)
  - **The model-decision golden must include the ADVERSARIAL inputs, recorded on BOTH the runtime and gate models.** A routing/extraction bug is often model-specific (013 Inc5: Claude dropped a sentence-like title — "I really want this movie" → `[]` — that qwen2.5 parsed; "move this movie to movie collection" misrouted only on the destination-name cue). Add the hard prompts to the golden dataset and re-record on **each model the deploy actually uses** — a clean-exemplar dataset gives false confidence.
  - **The required E2E must DISCRIMINATE new-vs-old behavior AND verify the deployed artifact.** An E2E that also passes on the old code gives false confidence (013 Inc5: the committed agent specs were green against a *stale* gateway). Assert the exact divergent input, and after rebuilding the gateway/BFF confirm the running container actually carries the change (grep the deployed source / a one-call probe) — a container recreated from a non-rebuilt image silently runs old code.
- **Platform Parity Table applies only when a feature spans multiple *frontend* clients.** A backend feature omits the table but NOT the E2E regression line above.

> **Definition of Done includes a green full-stack E2E regression — for every feature, backend included.** Unit + integration prove a component in isolation; only E2E proves the real path through every layer. For a backend service with no UI of its own, run the E2E suite of each consuming frontend app. (Feature 011 lesson: a backend-only authz change still required the consuming app's E2E to confirm the user flow wasn't broken — and the deployed service must be rebuilt first or the run is meaningless.)

**Invocation (all project types):** Nx targets are the primary path (constitution: Monorepo Build Tool). Single-test runs stay Nx-first via argument passthrough:

- Web single test: `pnpm nx e2e [project] -- [file] --grep "..."`
- Unit single test: `pnpm nx test [project] -- --testNamePattern "..."`
- Documented exceptions (no Nx target): `pnpm exec tsc --noEmit` (type-check) and a single Maestro flow (`maestro test <flow>`).

---

## Full example: a test task pair (reflects the real fixture + filter pattern)

Mirrors the verified pattern in `movies.spec.ts` — resolve the read-only BROWSE fixture's id via the BFF, apply a filter chip, and assert the exact row count **derived from `FIXTURE_MOVIES`** (the single source of truth).

### T007 — Write filter-by-contentType exact-count test

**Type**: Test | **Time**: 30 min | **Risk**: None

**Spec reference**: spec.md#user-story-1

**Scenarios covered**:
- US1-AC2: applying the contentType filter shows only movies of that type
- US1-AC3: the displayed count matches the fixture count for that contentType

**File**: `tests/e2e/web/movies.spec.ts`

Navigate to the BROWSE fixture (resolve its id via the BFF — collections aren't deep-linkable by name), click the `contentType = Movie` filter chip, assert the exact row count from `FIXTURE_MOVIES`.

```typescript
import { FIXTURE_MOVIES, FIXTURE_COLLECTIONS } from '../fixtures/base-dataset';

test('filters movies by contentType = Movie', async ({ page }) => {
  const res = await page.request.get('/bff-api/collections');
  const id = (await res.json()).items.find((c) => c.name === FIXTURE_COLLECTIONS.BROWSE).collectionId;
  await page.goto(`/collections/${id}`);
  await page.waitForSelector('[data-testid="movie-list-container"]', { timeout: 15000 });

  await page.click('[data-testid="filter-chip-contentType-Movie"]');
  await page.waitForTimeout(700); // filter debounce + reload
  const expected = FIXTURE_MOVIES.filter((m) => m.contentType === 'Movie').length; // derived, not hardcoded
  await expect(page.getByTestId('movie-list-item-row')).toHaveCount(expected);
});
```

**Verify RED**:
```bash
pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "filters movies by contentType"
```
**Expected RED**: 1 failing — `Error: expected count 5 but had 0` (filter chip not yet wired).

### T008 — Implement contentType filter chip

**Type**: Implementation | **Time**: 2 hrs | **Risk**: Low

**Spec reference**: spec.md#user-story-1

**Prerequisite**: T007 complete and verified RED.

Render a `contentType` filter section in `movie-filter-panel.tsx` and wire it to the existing `GET /bff-api/collections/{id}/movies?contentType=Movie` query param.

**Verify GREEN**:
```bash
pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts --grep "filters movies by contentType"
```
**Expected GREEN**: `1 passed`.

---

## Rules for using this template

1. **Verify RED is mandatory** — confirm the expected failure before implementing. A test that passes before implementation must be fixed first.
2. **Exact failure output** — write the expected RED message specifically (include the assertion text), so an unexpected failure is obvious. "1 failing" is not enough.
3. **Isolation first** — Verify RED/GREEN use a single test or file (`--grep`/file path), never the full suite. The full suite is the Final Validation Checklist only.
4. **Derive counts from the fixture** — exact-count assertions compute expectations from `FIXTURE_MOVIES`, never hardcode, so changing the fixture updates expectations automatically (FR-010).
5. **Writes go to the MUTATION fixture, reads to BROWSE** — never mutate the read-only BROWSE collection whose exact counts other tests depend on. Tear down via the BFF in `afterEach` (not UI) so cleanup runs even on failure.
6. **N/A justifications must be written** — never leave a parity cell blank.
7. **Documentation/config tasks skip RED/GREEN** — use the documentation task format.
8. **Mobile cold start** — the first `/home` navigation of a run triggers a cold Metro web-bundle compile; use a 60s wait budget. Restart the Expo dev server before long runs (it degrades over heavy sessions).
