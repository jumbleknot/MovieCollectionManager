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
| **US1** — un-quarantine the 8 agent tests | 🟡 **buckets A+C fixed (verifying)**, **bucket B outstanding** |

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

**C was always a cascade of A** (its LLM calls are stubbed → deterministic): no key → enrich yields no
candidate → no proposal → the approved add writes nothing. **Never a product bug.**

> **Status when this doc was written**: run `0667b42b` was still in flight. The previous run
> (`cb55ee95`) confirmed at the transport level that the fix works — the web-api-mcp log shows a live
> `search/movie?...&query=Avatar` → **HTTP 200** with **zero** "No TMDB key" errors — but `app-e2e`
> still went red, so **something else in the agent step is failing**. FIRST STEP for the new session:
> get the **"Agent integration tests"** step summary (see §6) and fix what it names.

### Bucket B (3 live-LLM tool-choice tests) — NOT started
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

## 4b. 🚨 START HERE — CI runs agent/MCP code from a STALE IMAGE (found at handoff)

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

**Suggested fix** (verify before adopting): pass `--build` in the app-e2e bring-up (or add an
`up-agents-prod:rebuild` target / prune the `movie-assistant-*` images in the reset step). Weigh the
wall-clock cost (image builds) against correctness — correctness should win for a gate. Note the local
`--build` flag already exists: `node scripts/agent-stack.mjs --build`.

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
