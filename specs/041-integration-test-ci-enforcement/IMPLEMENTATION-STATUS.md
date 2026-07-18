# Implementation Status — Feature 041

**Session date**: 2026-07-17 → 2026-07-18. **Branch**: `041-integration-test-ci-enforcement` (main merged in).

This records what landed, what was diagnosed, and the exact CI-iteration steps that complete US1 — so the
un-quarantine can be finished on an app-e2e run without re-deriving anything.

## Landed & locally verified

| Task | What | State |
|---|---|---|
| T004 | jest `globalSetup` preflight `frontend/mcm-app/tests/integration/setup/preflight.global.js` — throws when `MCM_REQUIRE_LIVE_STACK=1` and any of BFF/Keycloak/Redis/Mongo is down; no-op locally. Dependency-free. | ✅ committed, no-op/throw unit-verified |
| T005 | cargo guard `scripts/mc-service-integration-guard.mjs` = the new `test:integration` runner. Runs the Cargo `[[test]]` binaries, requires each to execute ≥1 test (zero-executed/all-ignored ⇒ FAIL), bans **bare** `#[ignore]` (documented `#[ignore="reason"]` allowed). | ✅ committed, selftest + real run |
| T006 | reconciled `contracts/skip-escalation-convention.md` with the code (incl. the documented-`#[ignore]` deviation). | ✅ committed |
| T019/T020 | `app-e2e` **mc-service integration** step (+ guarded host Rust toolchain) vs the live replica-set Mongo (`27017`, `directConnection`) + Keycloak. | ✅ committed (CI-unrun) |
| T024/T025 | `app-e2e` **mcm-app BFF integration** step; `env.ts` now also loads gen-ci-env's `.env.docker` for the BFF client secrets; step overrides host-reachable URLs. | ✅ committed (CI-unrun) |

**Local validation (against a stack that happened to be up):** mc-service `collections_test` 23/0 and `health_test`
4/0 passed against the live replica-set Mongo + Keycloak — US2 code is green. (`movies_test` "failures" were the
local Mongo overloading under the 128-test large_collection load — an infra artifact, not a regression.) mcm-app
integration's local failures were pure credential mismatch (dev realm secret ≠ local `.env`), which the CI
`.env.docker` path resolves.

## Diagnosis (US1 buckets — evidence-based, in memory `project_mcm_agent_integration_ci`)

- **Bucket A (4 TMDB tests) = CI-side provisioning, NOT code/test.** The TMDB v3 key is valid (local *and* inside
  the running devcontainer's `web-api-mcp`); "Coherence" 2013 resolves to exactly 1 result. The CI "That request
  couldn't be completed" is the **Forgejo `TMDB_API_KEY` Actions secret** (empty/invalid/rate-limited) and/or TMDB
  egress on `movie-assistant-mcp-network`. **Owner action** (agreed): verify/rotate that secret + confirm egress.
- **Bucket C (add-persist) ≈ cascade of Bucket A.** `test_gateway_add_e2e` **stubs both LLM calls**, so the failure
  is deterministic code — not model/timing. `curator.py` degrades a failed TMDB enrich to a "couldn't complete"
  reply with **no `pending_proposal`** → `approval_gate` returns `{}` on resume → nothing is written → "collection
  not created". Fixing Bucket A should resolve C. The `apply_proposal` create→add path is clean.
- **Bucket B (3 tool-choice tests)** assert the live model's *exact* tool choice + phrasing (the golden surface):
  - `test_query_find_hit_renders_movie_card` — model chose `render_collection_summary` over `render_movie_card`.
  - `test_query_find_miss_says_not_in_collection` — model returned a summary, not "isn't in your".
  - `test_search_named_collection_single_match_navigates` — model chose `render_selection` over `navigate_to_movie`
    for a **single** match. The adjacent non-quarantined test wants `render_selection` for **multiple** matches, so
    this may be a **real behaviour question** (single-match-should-navigate), not just brittleness — do NOT loosen
    blindly. Resolution (research D2) needs a live-model run: relocate the decision to a golden cassette (record
    against the runtime model) and reduce the live assertion to plumbing-level, or fix the specialist prompt.

## Remaining to finish US1 (CI-iteration; each needs a live app-e2e run)

1. **Bucket A/C**: owner fixes the Forgejo `TMDB_API_KEY` secret → an app-e2e run confirms the 4 TMDB tests + the
   add-persist test pass with a valid key. Optionally add 429/5xx retry-backoff to `web-api-mcp`'s TMDB client
   (helps the real enrich/add flows too — research D1). Then delete their `@pytest.mark.ci_quarantine`.
2. **Bucket B**: a live-model run to (a) confirm current tool choices, (b) relocate each exact-choice assertion to
   `agents/movie-assistant/tests/golden/` (record the cassette) or fix the prompt if genuinely wrong, (c) reduce
   the live assertion to plumbing-level. Then delete their markers.
3. **T015/T016**: once all 8 markers are gone, delete the `ci_quarantine` marker registration from
   `agents/movie-assistant/pyproject.toml` and revert the app-ci agent step to `-m "not golden"`.
4. **Broken-on-purpose proofs (T018/T021/T027)** and the **SC-004 partial-down matrix (T030-T032)** run on app-e2e.

## Why not un-quarantined this session
Un-quarantine requires *verified-green*, and the authoritative env is a CI app-e2e run: buckets A/C are gated on
the owner's TMDB-secret fix; bucket B needs a live-model decision + cassette recording. Blindly removing markers
would risk a red gate or masking the single-match-navigate behaviour question. The wiring + guards + diagnosis are
landed so the un-quarantine is a short, well-scoped CI-iteration.
