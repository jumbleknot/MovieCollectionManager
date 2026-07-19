# Implementation Status / HANDOFF — Feature 041

**Updated**: 2026-07-18. **Branch**: `041-integration-test-ci-enforcement`. **PR**: **#80** (open, on the forge).
**Read this first**, then memory `project_mcm_041_integration_test_ci_enforcement` +
`project_mcm_agent_integration_ci` (authoritative per-bucket detail).

---

## 1. Bottom line

| User story | State |
|---|---|
| **US4** — cross-language no-false-green guards (T004/T005/T006) | ✅ **DONE**, green in CI |
| **US2** — mc-service integration in `app-e2e` | ✅ **DONE**, green in CI |
| **US3** — mcm-app BFF integration in `app-e2e` | ✅ **DONE**, green in CI |
| **US1** — un-quarantine the 8 agent tests | ✅ **DONE** — A+B+C all fixed, marker deleted, verified locally |
| **SC-003** (3/3) + **SC-004** (3/3) proofs | ✅ **DONE** — see [SC-003-SC-004-EVIDENCE.md](./SC-003-SC-004-EVIDENCE.md) |

`app-e2e` was fully green at **`58aef7b3`** (all required checks) — that commit is the proof US2+US3 work.
Everything after it is US1 work.

## 2. What is committed (in order)

| Commit | What |
|---|---|
| `f2514752` | T004 jest preflight + T005 cargo guard + T006 convention doc |
| `a63eedfb` | US2 + US3 `app-e2e` steps; `env.ts` loads `.env.docker` |
| `7d96ef7c` | runbook + this status doc |
| `a14d6526` | follow-up PRD (mc-service HTTP authz tests) |
| `a2bd0752`→`f65ee2d5`→`7e2a0730` | mc-service CI fixes (see §5) |
| `58aef7b3` | **US3 fixes — app-e2e GREEN here** |
| `04abb0a9` | un-quarantine buckets A+C (markers removed) |
| `cb55ee95` | **bucket A/C real fix** — forward `X-TMDB-Key` |
| `ca30f80b`, `0667b42b` | 🔴 security: stop logging the TMDB key (+ ruff) |

## 3. ⚠️ OWNER ACTIONS OUTSTANDING

1. **ROTATE THE TMDB KEY** (v3, starts `95b3…`) at themoviedb.org and update the Forgejo `TMDB_API_KEY`
   secret. It leaked in plaintext into CI job logs, the `agent-e2e-container-logs` **artifact**, and
   `~/mcm-ci-last-failure/movie-assistant-mcp-webapi.log` on the runner. **Purge those artifacts.** The
   committed fix only prevents RECURRENCE.
2. Nothing else — CI/secrets are otherwise healthy.

## 4. US1 — exact remaining work

### Buckets A (4 TMDB) + C (1 add-persist) — fixed at `cb55ee95`, verification in flight
**Root cause (my first diagnosis was WRONG — do not repeat it):** it is *not* a CI-secret/provisioning
problem. An in-container diagnostic proved the key was fine all along (job env 32 chars, container 32
chars, live TMDB call **from inside the container** → HTTP 200). The real cause:

> `web-api-mcp` authenticates to TMDB with the **caller's own v3 key forwarded per request as
> `X-TMDB-Key`**, with **no shared env/Vault fallback** (`server.py::_tmdb_key` raises otherwise — the
> "no-fallbacks decision 2026-06-19", FR-021/PRD-Vault). The raise surfaces as the generic
> *"That request couldn't be completed."*

The tests still assumed the **old shared-env-key** contract (their docstrings still said to start the
server with `TMDB_API_KEY=…`). They broke the day the fallback landed and **nobody noticed because the
integration suite never ran in CI** — the exact rot this feature exists to catch.

Fix applied (mirrors production, no mocking):
- `test_curator_enrich.py`, `test_resolution_realistic.py` → wrap each web-api-mcp call in
  `tmdb_key_scope(TMDB_KEY)`, as the production curator node does.
- `test_gateway_add_e2e.py` → send per-run `X-Agent-Config: {"tmdbKey": …}`, as the BFF does (gateway
  bridges it to `configurable.agent_config`; `_tmdb_key_of` reads `agent_config["tmdbKey"]`).
- All skip cleanly when `TMDB_API_KEY` is unset.

**C was NOT a cascade of A — that diagnosis was WRONG (second bad call on this bucket; do not repeat
it).** After the TMDB fix landed, `test_gateway_add_gated_until_approval_then_persists` still failed
with the same `approved add did not create the collection`. Real cause, proven from git history:

> Feature **040 US4** (`1e6396db`) inserted an ownership question — `add_stage="awaiting_ownership"`,
> `organizer.py::_ask_ownership` — **before** the approval gate. Commit `55116253` updated
> `test_add_flow.py` (the `_add_and_own` helper) but **never touched `test_gateway_add_e2e.py`**,
> because that file was quarantined out of CI and so nothing went red.

The old two-POST shape sent `resume={"decision":"approved"}` while the graph was waiting for an
ownership **answer** → no proposal applied → no collection. Both POSTs still returned **200** because
**AG-UI streams errors inside a 200**, and the test's only transport assertion is the status code —
which is why it read as a silent no-op. **Third instance of the exact rot this feature exists to catch.**

Fix: the test now drives three turns (add → plain `"yes"` message → `resume` approve), mirroring
`_add_and_own`, asserts nothing is persisted after *both* pre-approval turns, and uses a unique
message id per turn (a fixed `"m1"` across three turns on one thread risks checkpoint collision).

**Verified locally (RED→GREEN, same stack):** in the dev container against live Keycloak + mc-service
+ real TMDB, the pre-fix file fails with the identical assertion at the identical line 199; the fixed
file passes; full suite `-m "not golden and not ci_quarantine"` → **39 passed, 0 failed**. (The 9
`test_out_of_domain` errors there are the documented dev-container Ollama gap — "supervisor model not
reachable" — escalated by `MCM_REQUIRE_LIVE_STACK=1`; they pass in CI on `MODEL_PROVIDER=anthropic`.)
The same run also confirmed the always-build fix: agent-stack **built all 4 images** rather than
skipping.

> **Status when this doc was written**: run `0667b42b` was still in flight. The previous run
> (`cb55ee95`) confirmed at the transport level that the fix works — the web-api-mcp log shows a live
> `search/movie?...&query=Avatar` → **HTTP 200** with **zero** "No TMDB key" errors — but `app-e2e`
> still went red, so **something else in the agent step is failing**. FIRST STEP for the new session:
> get the **"Agent integration tests"** step summary (see §6) and fix what it names.

### Bucket B — ✅ DONE. **None of the 3 was a live-LLM failure — all 3 labels were wrong.**

The "Claude chose X over Y" comments mis-attributed *deterministic code behavior* to model
nondeterminism (same error as bucket C). Evidence:

| Quarantine claim | Reality |
|---|---|
| search: "Claude chose `render_selection` over `navigate_to_movie`" | `search.py` makes **no model call**, and the tests stub the classifier. `_run_owned` returns `_selection(...)` unconditionally — "even exactly one … never auto-navigate" ([search.py:381](../../agents/movie-assistant/src/nodes/search.py#L381)) |
| query: "Claude chose `render_collection_summary` over `render_movie_card`" | `query.py` imports **only** `RENDER_COLLECTION_SUMMARY`; both tests **stub** the extraction, bypassing its one model call |
| query: "Claude returned a summary, not 'isn't in your'" | `"is in your"`/`"isn't in your"` exist **nowhere in `src/`**; `query.py` has zero `movie_title` references |

All three asserted contracts feature **013** (`ee19724f`, 2026-06-13) deliberately removed —
[query.py:15-17](../../agents/movie-assistant/src/nodes/query.py#L15-L17): *"Locating ONE specific
film … is the **search** node's job (013 Inc5: query is count/list only; search owns all 'find')."*
They failed **deterministically** against removed behavior for a month. **Fourth instance of the rot.**

Disposition (all now deterministic, all un-quarantined):
1. `test_search_named_collection_single_match_navigates` → **rewritten** as
   `test_search_single_match_offers_button_and_never_auto_navigates` (asserts the button + **no**
   auto-open — pins the deliberate 013 decision).
2. `test_query_find_hit_renders_movie_card` → **deleted**; hit→tap→open is already
   `test_search_multi_turn_pick_navigates`.
3. `test_query_find_miss_says_not_in_collection` → **relocated** to
   `test_search_miss_says_not_in_that_collection` — the miss path moved to search and **had no test
   anywhere**, so this closed a real gap.
4. The one genuine model decision ("do I have X" ⇒ search) needed **no new work**: already pinned
   keyless in `tests/golden/dataset.json` as `us4-intent-find` + `inc5-intent-existence-is`.

**T015/T016/T017 done**: marker registration deleted from `pyproject.toml` (with a note not to
re-add it), app-ci reverted to `-m "not golden"`, and `git grep ci_quarantine` over tracked files
returns only the two "this is intentionally gone" comments.

**Verified locally** (dev container, live Keycloak + mc-service + movie-mcp/web-api-mcp,
`MCM_REQUIRE_LIVE_STACK=1`): `test_search_flow` + `test_query_flow` = **7 passed**; full suite under
the exact new CI expression `-m "not golden"` = **41 passed, 0 failed, 12 skipped** (the 9
`test_out_of_domain` errors are the unchanged dev-container Ollama gap; they pass in CI).

### (historical) Bucket B as originally mis-diagnosed — kept for the record
Still carry `@pytest.mark.ci_quarantine`:
- `test_query_flow.py::test_query_find_hit_renders_movie_card` — model chose `render_collection_summary`
  over `render_movie_card`.
- `test_query_flow.py::test_query_find_miss_says_not_in_collection` — returned a summary, not "isn't in your".
- `test_search_flow.py::test_search_named_collection_single_match_navigates` — chose `render_selection`
  over `navigate_to_movie` for a **single** match.

These assert the model's **exact** tool choice (the golden surface) so they're brittle by construction.
Per research **D2**, prefer: (a) **relocate** the exact-choice assertion into `tests/golden/` (record a
cassette against the runtime model) and reduce the live test to plumbing-level; (b) loosen to the valid
alternative; (c) fix the specialist prompt if genuinely wrong.
⚠️ **Do NOT loosen #3 blindly** — the adjacent *non*-quarantined test wants `render_selection` for
**multiple** matches, so `render_selection` on a **single** match may be a real UX regression (forcing a
click instead of navigating). Decide that one deliberately.

### Then finish US1
- **T015** delete the `ci_quarantine` marker registration from `agents/movie-assistant/pyproject.toml`.
- **T016** revert the app-ci agent step to `-m "not golden"` (only once all 8 markers are gone).
- **T017** verify `grep -r ci_quarantine agents/movie-assistant/tests` is empty.
- **T018/T021/T027** the three SC-003 broken-on-purpose proofs; **T030-T032** the SC-004 partial-down matrix.

## 4b. ✅ FIXED — CI ran agent/MCP code from a STALE IMAGE

**`app-e2e` never rebuilds the gateway/MCP images, so agent-layer source changes are NOT under test.**

Evidence: after pushing the TMDB log-redaction fix, the captured `movie-assistant-mcp-webapi.log` had
**0 redacted lines and 7 raw `api_key=<32-hex>` lines** — the fix simply wasn't running.

Mechanism (all three combine):
- `scripts/agent-stack.mjs::buildImages()` **skips** the build when the tag already exists
  (`image <tag> present (skip; use --build to force)`).
- The Nx target `up-agents-prod` runs `node scripts/agent-stack.mjs` with **no `--build`**.
- The runner is **persistent**, and app-e2e's "Reset stateful CI data" step removes **containers +
  volumes but NOT images**.

⇒ Every app-e2e run reuses whatever `movie-assistant-*` images happen to be on the runner. This is a
**false-green vector for the whole agent layer** — precisely the class of problem feature 041 exists to
remove — and it may well explain the still-red agent step (the running gateway/MCP code is not the code
in the checkout).

**Fix applied — the default was inverted rather than a flag added to one call site.**
`scripts/agent-stack.mjs` now **builds every time**; `--no-build` is the explicit local-loop opt-out
and **throws under `CI=true`**. Rationale: adding `--build` to the app-e2e step would have left the
trap armed for every other/future caller (dast already brings the stack up too), whereas flipping the
default makes staleness impossible by construction — and it matches what the same job already does
unconditionally for `mc-service` and `mcm-bff`. Docker layer cache keeps it cheap when `agents/**` /
`mcp-servers/**` are unchanged. Note the images are tagged `agent-gateway` / `movie-mcp` /
`web-api-mcp` / `spreadsheet-mcp` — **not** `movie-assistant-*` (those are the *container* names), so
the "prune `movie-assistant-*` images" idea above would have been a no-op.

Touched: `scripts/agent-stack.mjs` (`resolveBuildMode()` exported + entrypoint guard),
`scripts/__tests__/agent-stack.guard.test.mjs` (new), `infrastructure-as-code/project.json`,
`.forgejo/workflows/app-ci.yml` (comment only — no flag needed), `docs/runbooks/devcontainer.md`,
`docs/proposals/MCM-Testing-Strategy.md`.

**Verify on the next app-e2e run**: the bring-up step must show `building agent-gateway:latest …`
(not `image … present (skip)`), and the captured `movie-assistant-mcp-webapi.log` must contain
**redacted** lines and **zero** raw `api_key=<32-hex>` — that is the end-to-end proof the running
container carries the checkout's redaction fix.

### ✅ Adjacent gap found + fixed while fixing this
`scripts/__tests__/*.test.mjs` **ran in no workflow** — `guardrails.yml` only invoked the `--selftest`
entrypoints. Proof it had rotted unnoticed: `sast-scan.guard.test.mjs` could not even import
(`Cannot find package 'ajv'` — never added to the root `package.json`), so a guard test for the SAST
orchestrator sat 0%-executed. Same false-green class this feature exists to remove.

Fixed: `ajv@^8.17.1` added to root devDependencies (+ lockfile) and a **`Script unit tests`** step
added to the `guardrails` / `naming` job (which already runs `pnpm install --frozen-lockfile`).
**53/53 pass.** All seven files are node-only — no docker, no network, no `${{ secrets }}` — so the
job stays keyless.

⚠️ The step uses an **unquoted** shell glob (`node --test scripts/__tests__/*.test.mjs`) deliberately:
bash expands it, so it does not depend on the runner's Node having `--test` glob support, and
`node --test <dir>` does **not** discover a `__tests__/` directory (it errors "Cannot find module").
Note the root `pnpm-lock.yaml` changed → app-ci's `pull_request` `paths` includes it, so app-ci runs
on this PR too.

## 5. CI mechanics learned the hard way (don't re-derive)

- **The `ci` host user has NO sudo** → you cannot install host packages. `mc-service` integration
  therefore runs in a **`rust:1-bookworm` container** (`--network host`, mounted workspace) — the same
  pattern the Web E2E Playwright step uses. It needs `-e MC_SERVICE_PORT=3001` because `health_test`
  calls `Config::from_env()` and `.env.local` is gitignored.
- **`env.ts` loads `.env.docker`** for BFF secrets but **must exclude** `AGENT_RATE_LIMIT_REQUESTS` /
  `AGENT_SESSION_COST_CEILING_USD` — those are the container's raised ceilings, and the in-process
  rate-limiter test asserts the defaults (20 req / $0.50).
- **app-e2e has no Ollama** (`MODEL_PROVIDER=anthropic`) and the **gateway is BFF-fronted** (not
  host-published) → the 4 Ollama config tests + `agent-config-run-revoked` **self-skip** when their dep
  is unreachable (owner-approved; legitimate per the convention).
- **~24 mc-service HTTP tests stay documented-`#[ignore]`d** — see `docs/proposals/PRD-McServiceHttpAuthzIntegration.md`.
- **Do not write diagnostics into `~/mcm-ci-last-failure/`** — the failure-collection step `rm -rf`s it.

## 6. How to monitor / debug CI (the loop that worked)

- Access details: memory `reference_mcm_ci_monitor_access` (token path, API base, SSH).
- **Status** (the only reliable signal): `GET /repos/jumbleknot/mcm/commits/<sha>/statuses?limit=100`,
  read `app-ci / app-e2e (pull_request)`. `trigger-cd` sits `pending` on PRs — it is **not** required.
- **Step logs are NOT exposed by the API.** For a *test-assertion* failure the fastest path is to ask the
  owner to paste the failing step's summary from the Forgejo UI. For *container/bring-up* evidence, SSH
  and read `~/mcm-ci-last-failure/` (per-container logs + `*.health.json` + `_ps.txt`).
- A full green `app-e2e` is ~28-35 min; an early-step failure surfaces in ~10-25 min.

## 7. Two real bugs this feature already caught

1. **A month-old regression** — the `X-TMDB-Key` contract change silently broke 5 tests (§4).
2. **🔴 A credential leak** — httpx logs every request at INFO including TMDB's `api_key` **query param**,
   so each *successful* call wrote the user's key to stdout → CI artifacts. Only visible once 041 made
   the calls succeed. The identical leak had already been closed on the OTel-span path
   (`observability.tool_span`) but the logging path was missed. Fixed in
   `server.py::_silence_credential_logging` (httpx/httpcore → WARNING + a root redaction filter).

Both were invisible **because the integration tier never ran in CI** — which is the whole thesis of this
feature, now demonstrated twice.
