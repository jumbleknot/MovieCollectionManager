# PRD — Integration-Test CI Enforcement (Un-quarantine the Agent Suite + Run mc-service / mcm-app Integration in CI)

**Status:** Proposed

**Created:** 2026-07-17

**Context:** Direct follow-up to **PR #77** (`ci(agent): run the LIVE integration suite in app-e2e`),
which closed the gap that *no project's `test:integration` had ever executed in CI* — only the
`-m golden` subset ran (keyless replay, guardrails). Wiring the **agent** suite into `app-e2e`
immediately surfaced **9 pre-existing failures** the un-run suite had been hiding for ~a month (the
predicted rot). Eight of those are now `@pytest.mark.ci_quarantine` (deselected via
`-m "not golden and not ci_quarantine"`) so the gate could land as a real blocker on the ~43 that
pass; the ninth was a genuine test gap and was fixed. That PR deliberately left **two threads open**,
which this PRD scopes for pickup as a feature.

**Related:**
[.forgejo/workflows/app-ci.yml](../../.forgejo/workflows/app-ci.yml) (the `app-e2e` job),
[agents/movie-assistant/tests/integration/](../../agents/movie-assistant/tests/integration/),
[agents/movie-assistant/pyproject.toml](../../agents/movie-assistant/pyproject.toml) (the `ci_quarantine` marker),
[backend/mc-service/](../../backend/mc-service/) (`test:integration` — needs a replica-set Mongo),
[frontend/mcm-app/jest.integration.config.js](../../frontend/mcm-app/jest.integration.config.js) (BFF integration — needs Keycloak + Redis),
memory `project_mcm_agent_integration_ci` (the quarantine buckets + un-quarantine plan),
[PRD-TestHardening.md](./PRD-TestHardening.md) (the constitution's test-integrity standard this enforces).

---

## 1. Problem Statement

The constitution mandates integration tests against **real** dependencies (§Test Type Integrity;
never mocked). PR #77 proved that mandate was **unenforced**: a whole test tier existed, was written,
and never ran — so it rotted silently. Two concrete gaps remain after PR #77.

### Gap 1 — 8 agent integration tests are quarantined (filed defects, not silence)

Eight `agents/movie-assistant/tests/integration` tests fail on the CI/Claude environment and are
deselected from the gate. They are tracked, commented, and marked — but the gate is only as strong as
the set it runs, and these represent real signal that is currently muted:

- **TMDB / web-api-mcp (4)** — `test_curator_enrich` ×3 + `test_resolution_realistic::test_avatar_…`.
  The web-api-mcp container answers `200 OK` on `/mcp` but the live `search_title` / `get_movie_details`
  TMDB call inside returns *"That request couldn't be completed."* Root cause unconfirmed: the
  container's TMDB key/egress, a rate limit, or a real bug.
- **Live-LLM tool-choice (3)** — `test_query_flow` ×2 + `test_search_flow::…navigates`. These assert
  the model's **exact** tool choice / response string; on Claude the graph picks a different (often
  valid) tool (`render_collection_summary` vs `render_movie_card`; `render_selection` vs
  `navigate_to_movie`). They are 012-era, written/validated against a different model. Model *decisions*
  are the golden-cassette surface — asserting them in a live integration test is brittle by construction.
- **Add-persist (1)** — `test_gateway_add_e2e::test_gateway_add_gated_until_approval_then_persists`.
  Approved-add did not create the collection on Claude/CI. Highest-value to chase: a real
  approval-resume-drops-the-write bug and a model/timing flake look identical here.

### Gap 2 — mc-service and mcm-app integration suites still don't run in CI at all

The agent suite was not special — it was simply the first to be wired in. **`mc-service`** and
**`mcm-app`** have their own `test:integration` targets that **no workflow runs**:

- `mc-service test:integration` (the Rust cascade-delete / repository suite) needs a **replica-set**
  MongoDB. `app-ci`'s `mc-service-checks` runs `test:unit` only, rationalizing "integration needs a
  replica-set Mongo, not run here."
- `mcm-app test:integration` (BFF against **real** Keycloak + Redis, per `jest.integration.config.js`)
  runs nowhere.

The key insight: **`app-e2e` already stands up everything both need** — the replica-set
`mc-service-store-mongo` (+ `rs-init`), Keycloak with the realm, and Redis. So the app-ci rationale for
skipping them is **void inside `app-e2e`**; the deps are already warm. They rot for the same reason the
agent suite did, and the next latent defect in either is currently invisible.

---

## 2. Goals

- **G1.** Every `@pytest.mark.ci_quarantine` marker in the agent integration suite is removed — each
  by fixing the underlying issue so the test passes on the CI/Claude environment (or, where the test
  itself is wrong, by correcting it), until the `and not ci_quarantine` filter can be dropped from
  `app-ci`.
- **G2.** `mc-service test:integration` runs in CI against the real replica-set Mongo (+ Keycloak for
  JWT validation) and gates every PR.
- **G3.** `mcm-app test:integration` runs in CI against real Keycloak + Redis and gates every PR.
- **G4.** The same **skip-must-not-report-green** discipline established for the agent suite (a
  misconfigured run fails, it does not silently skip to a false pass) applies to every newly-wired
  integration suite.
- **G5.** No regression to `app-e2e` reliability or to its wall-clock beyond a small, justified
  increase; the fast-fail ordering (cheap checks before the emulator legs) is preserved.

## 3. Non-Goals

- Re-litigating the agent CI wiring itself (PR #77 — landed and green).
- Broadening the golden-cassette harness's scope beyond relocating any tool-choice assertions that
  belong there (that relocation is in-scope for Gap 1; a redesign of golden is not).
- Running the **optional-profile** integration tests (OPA / LangFuse / OTel / Vault / Unleash /
  OpenSearch) in the default gate — they stay legitimately skipped unless their profile is up.
- Provisioning a *separate* integration-test stack; the intent is to reuse `app-e2e`'s existing stack.

---

## 4. Proposed Solution

Three workstreams. A is test-quality remediation (agent); B and C extend the proven PR #77 pattern to
the other two projects. They are independent and can land in sequence.

### 4.1 Workstream A — Fix + un-quarantine the 8 agent tests (Gap 1)

Handle each bucket on its merits (full per-test plan in memory `project_mcm_agent_integration_ci`):

- **TMDB (4):** first *diagnose* live — `docker exec movie-assistant-mcp-webapi printenv TMDB_API_KEY`
  and inspect the failing TMDB response in an `app-e2e` run (or via Claude Code in the dev container).
  If the container lacks a valid key / egress, fix the provisioning (it should get the key
  `gen-ci-env` writes to `mcp-servers/web-api-mcp/.env.local`); if it is a rate limit, make the tests
  resilient; if a real bug, fix it. Un-quarantine as each is proven.
- **Live-LLM tool-choice (3):** decide per test — **move the model-decision assertion into the
  golden-cassette harness** (where model decisions are the tested surface), **loosen** to accept the
  valid alternative tool, or — if the behavior is genuinely wrong on Claude — **fix the
  supervisor/specialist prompt**. Prefer relocation to golden: it removes model-sensitivity from the
  live gate entirely.
- **Add-persist (1):** reproduce against the live stack and determine real-bug vs model/timing; fix
  the code or harden the test's wait/assert accordingly.

Definition of done: the `ci_quarantine` marker is gone from all 8, and `app-ci`'s step reverts to
`-m "not golden"`.

### 4.2 Workstream B — Run `mc-service test:integration` in CI (Gap 2)

Add a step to `app-e2e` (after the stack is up, before the heavy web/emulator legs — the PR #77
placement) that runs `pnpm nx test:integration mc-service` against the already-running replica-set
`mc-service-store-mongo`. Point `MC_DB_URL` at the published Mongo; ensure the runner has the Rust
toolchain (`mc-service-checks` already installs it — confirm availability in the `kvm` host job or set
it up). Apply the same skip-must-fail discipline (G4) if the suite has stack-absent guards.

### 4.3 Workstream C — Run `mcm-app test:integration` in CI (Gap 3)

Add a step running `pnpm nx test:integration mcm-app` (jest, `jest.integration.config.js`) against the
already-running Keycloak + Redis, with the `.env.e2e.local` / `.env.docker` the job already generates.
The suite uses Redis db 1 and real Keycloak (ROPC + admin) — the same credentials `app-e2e` already
has. Same skip-discipline (G4).

**Cross-cutting:** consider factoring the PR #77 skip-escalation idea into a small shared convention
(an env flag + a documented "legitimate skip" allowlist per suite) so B and C do not each reinvent it.

---

## 5. Acceptance Criteria

- **AC1 (G1).** `grep -r ci_quarantine agents/movie-assistant/tests` returns nothing; `app-ci`'s agent
  step runs `-m "not golden"`; that step is green in an `app-e2e` run.
- **AC2 (G2).** An `app-e2e` run executes `mc-service test:integration` (the cascade-delete transaction
  suite) against the real replica-set Mongo and passes; a deliberately-broken repository change makes it
  fail (proving it is a real gate, not a no-op).
- **AC3 (G3).** An `app-e2e` run executes `mcm-app test:integration` against real Keycloak + Redis and
  passes; the same broken-on-purpose check proves the gate bites.
- **AC4 (G4).** For each newly-wired suite, a run with the stack intentionally partially-down **fails**
  (does not skip-to-green) — the skip-escalation holds.
- **AC5 (G5).** `app-e2e` wall-clock increase is bounded and justified; fast-fail ordering preserved;
  the collision / secret / naming gates stay green.

## 6. Risks & Mitigations

- **The tool-choice tests keep flaking even after relocation** → prefer moving them to golden cassettes
  (deterministic replay) over loosening live assertions; a loosened live assertion is the next
  quarantine waiting to happen.
- **`app-e2e` becomes a monolith / too slow** → each suite is fast-fail-ordered and cheap relative to
  the emulator legs; if wall-clock becomes a problem, split integration into its own `needs:`-gated job
  that reuses the same bring-up, rather than dropping coverage.
- **The `annoy`/`build-essential`-style host-provisioning surprise recurs** for the Rust/JS suites →
  enumerate each suite's host prerequisites up front (Rust toolchain, node, Mongo shell) and verify on
  the `kvm` runner before wiring, exactly as the agent suite's C++ toolchain gap was handled.
- **A quarantined test hides a real product bug** (esp. add-persist) → treat the add-persist item as
  potential-bug-first, not test-flake-first.

## 7. Rollout & Sequencing

1. **Workstream A first** — it is the debt PR #77 explicitly took on, and un-quarantining is the
   highest-signal work (some of it may be a real product bug). Land per-bucket; each un-quarantine is
   independently shippable.
2. **Workstream B / C** — extend the pattern; can proceed in parallel with A since they touch different
   suites. Wire, prove the gate bites (AC2/AC3), keep the skip-discipline.
3. Update `docs/runbooks/` (or CLAUDE.md test-run protocol) to state that the integration tier now runs
   in CI for all three projects, and how to run each locally against the stack.

## 8. Priority

| Gap | Bites when | Severity | Effort | Order |
|---|---|---|---|---|
| **1 — 8 quarantined agent tests** | every agent-layer change (muted signal; one may be a real add-persist bug) | **Medium-High** | Medium (judgment-heavy; per-test) | **1st** |
| **2 — mc-service integration un-run** | every mc-service change (cascade-delete transaction path untested in CI) | **Medium** | Low–Medium (reuse app-e2e stack + Rust toolchain) | 2nd |
| **3 — mcm-app integration un-run** | every BFF change (real-Keycloak/Redis session/rate-limit path untested in CI) | **Medium** | Low (reuse app-e2e stack) | 3rd |

---

> **Next step:** promote to a feature via `/speckit-specify` (candidate `041-integration-test-ci-enforcement`)
> — spec stays capability-focused (the integration tier is enforced in CI for every project; no
> misconfiguration reports a false green), with the per-bucket fixes, the `app-e2e` step wiring, and the
> shared skip-escalation convention as the *mechanism* in `plan.md`. Read memory
> `project_mcm_agent_integration_ci` first — it holds the authoritative quarantine list, root-cause
> reads, and the per-test un-quarantine plan.
