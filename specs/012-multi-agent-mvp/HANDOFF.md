# Handoff — Feature 012 Multi-Agent MVP (implementation in progress)

**Branch**: `012-multi-agent-mvp` | **Updated**: 2026-06-09 (session 11) | **HEAD**: `c33ef78` (SC-008 observability DONE + live-verified; `8972c10` T059 nav/prefill; `53a5836` T070 update/move) | **Tree**: clean.

### START HERE (session 12)

> **012 IS FUNCTIONALLY COMPLETE — all Success Criteria met.** SC-008 observability landed this session (`0a6c8cd`→`c33ef78`, [[project_mcm_observability_sc008]]): LangFuse v3 (per-turn cost/latency) + OTel (otel-lgtm) + Vault (secret injection) + an error-rate circuit breaker, all **env-gated (no-op by default, SC-005)** behind `--profile observability`. **Live-verified:** T067/SC-008 (5 Claude turns → LangFuse API → cost+p95 within budget + breach visible), T030a (Vault wins over env), T030b (OTel span → collector). 299 unit + leak-scan + ruff + mypy. **Durable gotchas:** copilotkit pins langchain 1.x → **langfuse v3 SDK only** (v2-light server impossible); LangFuse v3 self-host needs the MinIO bucket pre-created (compose `langfuse-minio-init`); register a **prefix-match** Claude model price (response model has a date suffix) or cost=0; export `ANTHROPIC_API_KEY` + pop `SUPERVISOR/SPECIALIST_MODEL` for the verify run. **Three follow-ups closed (`fdf9aa0`):** OTLP **metrics** → Prometheus (agent run/failure/breach counters; delivered via OTLP push rather than a `/metrics` pull endpoint — same outcome in Grafana), **MCP-server OTel** (movie-mcp + web-api-mcp, name-only leak-safe `tool_span`), and **web-api-mcp TMDB-key Vault** injection. **Remaining documented deferrals (the only non-MVP gaps):** OpenSearch append-only audit, Unleash flags/kill-switch (the `AGENT_KILL_SWITCH` env flag stays), OPA policy.

> **T059 navigate/prefill is LIVE-GREEN (`8972c10`):** web `assistant-navigate.spec.ts` — navigate→collection screen (23.5s) + prefill→add-movie form (14.2s); mobile `assistant-navigate.yaml` GREEN on Pixel_7-35. **Two durable gotchas:** (1) the prefill phrasing "let me add a movie to my X collection" classifies as `add` on the RUNTIME model (qwen2.5) — only "open the add movie form for my X collection" routes to `navigate` on BOTH qwen2.5 and Claude (golden exemplar fixed); (2) **Metro OOMs (exit 134, heap limit) after ~1–2 agent `/run` E2E calls** even at 8 GB — symptom is a deceptive `no_token`/`runtime_info_fetch_failed`/empty-dock; run assistant web E2E one/two tests at a time and **restart Metro between batches** ([[project_expo_devserver_degradation]]). Individual tests pass on fresh Metro (proof it's env, not code).

> **T070 update/move is fully LIVE-GREEN (`53a5836`):** integration `test_organize_batch.py` **6/6** vs real movie-mcp→mc-service+Keycloak; web `assistant-organize-update-move.spec.ts` **2/2 (59.7s)**; mobile `assistant-organize-move.yaml` GREEN. **Gotcha (recurs): restart the host gateway from source (`e:/tmp/start-gateway-prod.ps1`) before any agent E2E** — the running :8123 from a prior session has stale pre-change organizer code.

**Status:** all 3 user stories COMPLETE web + mobile; **ALL Success Criteria met (SC-001–011)** — SC-008 observability closed this session. The golden gate (`LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`) + token-leak scan + `agent-gates.yml` CI all green. Read this file's session-11/10/9/8 notes + the linked memories first.

**Open follow-ups: none required for the MVP** — only the documented deferrals above (OpenSearch/Unleash/OPA, `/metrics`, web-api-mcp TMDB Vault). The branch is ready to finish (merge/PR).

**Validation snapshot (session 10):** movie-assistant **272 unit** + ruff + mypy + **golden 17/17 keyless**; **T070 LIVE — integration 6/6, web E2E 2/2 (59.7s), mobile move** all GREEN vs the real stack.

**Session 10 — T070 US2 organize update + move slice DONE + LIVE-verified** (commits `f69f892`→`b347d9d`→`7de5b54`→`53a5836`, [[project_mcm_us2_update_move]]). Extends organize beyond remove-only: **update** (owned/ripped/childrens flags + add/remove tags; full-replace payload composed from a `list_movies` read via `proposals.compose_movie_payload`) + cross-collection **move** (`Operation.move` = guarded add-to-dest THEN remove-from-source, no data loss). MVP: move dest existing-only (unresolvable → reported, never auto-created). Golden matcher now gates `(op,title,to-ci)` — move dest asserted, update `changes` not (model-phrasing-sensitive). **Round-trip finding: mc-service request DTOs have no `deny_unknown_fields`**, so re-adding/updating a movie read from `list_movies` (carries ids + `createdAt`/`updatedAt`) round-trips cleanly — the extra server fields are silently ignored.

**RC2 — multi-turn ambiguous "add \<X\> to this" DONE** (commit `caf94b0`, [[project_mcm_us3_context]]). When the title is ambiguous the organizer (which resolves "this") isn't reached on turn 1; the curator now normalizes a current-screen reference to the canonical `"this"` marker (mirrors `organizer._add`'s guard), which survives the pick via the existing `target_collection_name` preservation → the organizer resolves it against the per-turn `ui_snapshot` after the pick. Pure code, no golden re-record. Graph-level TDD (275 unit + golden 17/17). **Unit-only** — the two parent capabilities (ambiguous-add T069e/f + US3 "this" T055/T056) are already live-verified; RC2 just connects them.

**All US1/US2/US3 capabilities are complete** (add incl. ambiguous + ambiguous-"this", organize remove/update/move, context-"this", navigate/prefill) — LIVE-verified web + mobile except RC2 (unit-only by design). **SC-008 observability + the Control-Tower partial (LangFuse/OTel/Vault/circuit-breaker) are DONE + live-verified** (this session). The MVP is feature-complete; what remains are the documented non-MVP deferrals only.

**Recur gotchas (from memory):** mobile E2E — re-set `adb reverse tcp:8081`+`tcp:8099` right before each run; seed collections via a SINGLE exact-title assistant add (chained adds hit TMDB ambiguity). Re-recording golden after any classify_intent/extract/plan prompt change needs `ANTHROPIC_API_KEY` from `agents/movie-assistant/.env.local` (runner reads os.environ, doesn't auto-load it) + delete stale cassettes first (record APPENDS). "watchlist" must NEVER appear anywhere (user rule). Never print the live Keycloak gateway secret.

### Session-9 — closeout docs (T065/T065a/T068) + T059 `navigate`/`prefill` UI-action tools (full navigate intent)

**Docs closeout committed** (`7c7c759`): agent-layer READMEs, root `CLAUDE.md` AI-agent section, `api-specs/agent-bff-api.yaml` finalize (v1.0.0), template AI-agent profile, Completion Checklist (all SC met except SC-008/T067 observability — infra-deferred).

**T059 DONE — user chose the FULL `navigate` intent path** (not the lean follow-on). Unit-only TDD (no live E2E this session — the navigator is pure code + golden-gated). Agent: `src/tools/ui_action_tools.py` (pure builders + allowlist + HITL flag), new `navigate` intent → `src/nodes/navigator.py` (PURE-code target resolution against the user's OWN downscoped `list_collections`/`list_movies` + `ui_snapshot` current-screen; unresolvable → clarify; emits one allowlisted `navigate_to_collection`/`navigate_to_movie`/`prefill_add_movie` tool call), `navigator` added to MCP allowlist (read-only) + `build_graph`/`runtime_nodes` wiring. BFF: `bff-api/agent/ui-action+api.ts` enforces T026 `authorizeUiAction` at **dispatch** (the CopilotKit `/run` stream is opaque, so emission can't be inspected mid-stream — client asks BFF to authorize {type,target} BEFORE navigating; 403 → audited + discarded). Client: `components/agent/ui-action-tools.tsx` (`useUiActionTools` → `useRenderTool` effect component authorizes then `router.push`; module-level dedupe so a re-opened dock never re-navigates) + `NewMovieScreen` optional `title`/`year` prefill params (absent → unchanged blank form, SC-005). **Golden re-recorded vs Claude** (classify_intent prompt changed: +`navigate` label/examples) — record 15/15, replay 15/15 keyless (single-entry, drift-proof) + 2 navigate exemplars. **GREEN: movie-assistant 257 unit + lint + golden 15/15; mcm-app 915 unit + lint + tsc.** Follow-up: live web+mobile E2E for a navigate flow; multi-turn ambiguous-"this" (RC2).

### Session-8 — US3 (context-aware "this") COMPLETE on web AND mobile (AC1 + AC2 GREEN live both clients; SC-005 additive)

> **UPDATE (end of session 8): the "blocker" below was root-caused + resolved — US3-AC1 web E2E is GREEN.** It was a **deep-load-only** dock-agent reset (a fresh `page.goto('/collections/:id')` remounts the app tree ~1–2 s after a turn and resets CopilotKit; US3-independent — reproduces with all US3 client changes disabled). **Client-side in-app navigation (login→home→open a collection) does NOT trigger it** (3-way probe: HOME ✅ · in-app-nav-to-collection ✅ · deep-load-collection ❌). Real users reach collections via the FR-009 home→default redirect (= client-side nav) so are unaffected. **Fix = the E2E navigates in-app** (`openCollectionViaHome` in `assistant-context.spec.ts`), never deep-loads a collection before driving the dock. **`assistant-context.spec.ts` AC1+AC2 = 2/2 GREEN live (~25 s); SC-005 dev-container regression 95/6-skip (additive).** The earlier `auth_failed: no_token` + `runtime_info_fetch_failed` were SECONDARY (the token expiring during the stuck retry loop), not the cause.

**MOBILE T056 ALSO GREEN (Pixel_7-35) — US3 now COMPLETE on web AND mobile (SC-001 parity).** `assistant-context.yaml`: AC2 clarify on home → create empty collection (UI form) → in-app nav → "add Coherence to this" → approval targets the on-screen collection → approve → Done → re-navigate-to-verify → teardown. **Surfaced + fixed a real latent bug:** after approve→resume the agent message list repeats a `render_movie_card` tool-call id, so `buildDockItems` emitted a **duplicate FlatList key** — a harmless `console.error` on web but a blocking LogBox RedBox on Android that hid "Done". Fixed by prefixing dock item ids with the message index (unique keys) + a regression unit test (`assistant-dock-tools.test.tsx`; 911 mcm-app unit GREEN). Mobile verify uses re-navigation (the on-screen movie list, loaded empty pre-add, doesn't auto-refresh after the assistant's backend write). No APK rebuild (JS-only).

**Remaining US3:** **T059** `navigate_*`/`prefill_*` UI-action tools (separate generative-UI capability; uses the built `ui-action-authorizer` T026) + multi-turn ambiguous-"this" persistence. A **deep-load hardening** follow-up (make a fresh refresh-on-a-collection survive the remount; low priority — real users use in-app nav) is logged in research R15. The original investigation block is kept below for context.

#### (original) US3 IMPLEMENTED + proven at backend; AC1 web E2E blocked by a PRE-EXISTING dock issue

**What's done (all unit/integration GREEN — 910 mcm-app TS unit + 207 movie-assistant PY unit; tsc + ruff + mypy + eslint all clean):**
- **US3 = context-aware "add \<movie\> to this"** resolves the on-screen collection (US3-AC1); unresolvable "this" → clarify (US3-AC2). Built spec-first as **research R15** (read it) + the SDD updates (`spec.md` US3-AC1/2 + FR-013/14; contract `agent-bff-routes.md` corrected — the old inline `/run` `uiState` body is obsolete since T029's CopilotKit-runtime body).
- **Mechanism = the proven subject-token bridge pattern** (out-of-band, NOT the run body, NOT checkpointed): client `useReportUiState` (on screen focus) → BFF `POST /bff-api/agent/ui-state` (`sanitizeUiState` = sole sanitization point → cache per user → 204) → `/run` reads the cache + sets the `X-UI-Snapshot` header on the `HttpAgent` → gateway pure-ASGI `UiSnapshotMiddleware` → `inject_ui_snapshot` → `config["configurable"]["ui_snapshot"]` → runtime organizer wrapper threads it into state → pure-code resolution `references_current_screen` + `_resolve_current_collection` (id-match against `list_collections`; no LLM ⇒ no golden re-record).
- **Files:** `agents/movie-assistant/src/nodes/organizer.py` (T058 resolution), `src/graph.py` (`GraphState.ui_snapshot`), `src/runtime_nodes.py` (config→state thread), `src/runtime_context.py` (`UiSnapshotMiddleware`/`get_ui_snapshot`/`parse_ui_snapshot`), `src/agui_identity.py` (`inject_ui_snapshot`), `src/gateway.py` (middleware register). Frontend: `src/hooks/use-ui-state.tsx` (provider; **plain credentialed fetch**, NOT apiClient), `src/app/_layout.tsx` (UiStateProvider wraps Stack+dock), the collection/movie-detail/home routes (report), `src/app/bff-api/agent/ui-state+api.ts` (route), `run+api.ts` (read+inject), `bff-server/agent-gateway-client.ts` (`X-UI-Snapshot` header), `bff-server/cache-service.ts` (`set/getAgentUiSnapshot`). Tests: `tests/unit/test_context_resolution.py` (9), `test_runtime_nodes.py` (+1), `test_runtime_context.py`/`test_agui_identity.py` (+bridge), `src/hooks/use-ui-state.test.tsx` (3), `agent-gateway-client.test.ts` (+2); T028a auth-guard + route-coverage map include `agent/ui-state`.
- **Live-proven:** gateway diagnostics confirmed the sanitized collection snapshot flows all the way to the organizer and `_resolve_current_collection` MATCHES the on-screen id and builds the proposal (interrupt fires). **US3-AC2 (clarify on home) PASSES web E2E live.**

**THE BLOCKER (next session's #1 task) — PRE-EXISTING, NOT US3 logic:** the **CopilotKit assistant dock cannot run the agent from a non-home screen.** US3-AC1's web E2E (`assistant-context.spec.ts`, "add Coherence to this" on a collection screen) fails: BFF logs `auth_failed: no_token` on `/bff-api/agent/run` + the browser logs `[CopilotKit] runtime_info_fetch_failed: Failed to fetch` on `…/run/info`, and the dock stays **empty** (not even the local user message renders) even though the gateway processed the run. **Isolation proof:** a minimal probe (open dock on a collection screen, send "hello") fails IDENTICALLY with ALL US3 client changes disabled (`UiStateProvider` removed + the collection-route `useReportUiState` removed); the SAME run from **home** succeeds (US1 `assistant-add` reject passes 19 s on the same stack). So US3 merely surfaces a gap — the assistant was only ever exercised from home. **Likely area:** the CopilotKit runtime `/info` probe (despite `useSingleEndpoint`) + the short-lived `mcm_access_token` cookie / `createRefreshingFetch` (`utils/agent-fetch-refresh.ts`) interaction on a deep route. **Best debugged interactively** (a real browser + network panel on a collection screen with the dock open) — headless E2E only shows the symptom. Once fixed, run `E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-context.spec.ts` (AC1+AC2) then the mobile T056 flow (still to author).

**Remaining US3:** (a) fix the dock-on-non-home-screen run (above) → then AC1 web E2E + T056 mobile; (b) **T059** `navigate_*`/`prefill_*` UI-action tools (separate generative-UI capability, uses the built `ui-action-authorizer` T026 — NOT required by AC1/AC2); (c) multi-turn ambiguous-"this" persistence (logged in tasks.md T059 note). **Stack left UP:** host gateway :8123 (production nodes, US3 code, background task `bqcvepd47`), Metro web :8081 (`bwcux0fcj`), movie-mcp :8766, web-api-mcp :8765, mc-service :3001, Ollama :11434. **Gateway launcher:** `e:/tmp/start-gateway-prod.ps1` (computes the secret into env without printing it).

---

(Latest: **US2 (organize by conversation) COMPLETE — backend + live integration + web AND mobile E2E.** Session 7 closed the tail: **T063** golden organize-plan exemplar ("plan" decision kind in the runner + 3 US2 exemplars recorded vs Claude; replay 11/11; also removed the banned term "watchlist" from US1 exemplars) + **T049** mobile organize E2E **GREEN live on Pixel_7-35**. Session 6 built T051/T050a/b/T053/T052 + T047 integration 3/3 live + T048 web E2E live. **MVP organize scope = multi-item REMOVE** (update/move are follow-ups; proposals/apply/movie-mcp `update_movie` already built). Before: session 5 T069 ambiguous-add; session 4 T032 golden; session 3 US1 complete. Read the session-6/7 blocks + "Where we are".)

**START-HERE for the fresh session (read first):**
0. **US1 + US2 are COMPLETE and proven live on web AND mobile.** US1 add (incl. ambiguous-title disambiguation, T069) and US2 organize (multi-item remove) both run end-to-end through the real gateway, web (Playwright) + mobile (Maestro/Pixel_7-35). **Next picks:** **US3** (context-aware "this"/current-screen, T054–T059), the **organize update/move slice** (the proposals/apply/movie-mcp `update_movie` layers already support it — only the organizer needs to build update `OrganizeOp`s + compose the full-replace payload from a read; see [[project-mcm-us2-organize]]), or **Phase 6** gates (T031/T064 token-leak SC-004, T060 decline, T061 kill-switch, T062 expiry, T030x observability). **Mobile E2E gotchas (recur):** Maestro can clear `adb reverse` on session start — re-set `tcp:8081`+`tcp:8099` right before each run (a dropped 8099 tunnel = Keycloak `ERR_CONNECTION_REFUSED` in the SSO Chrome tab → login skips); seed organize collections via a SINGLE exact-title assistant add (chained adds hit TMDB ambiguity, e.g. "Primer").
1. **T069 is DONE — ambiguous-title add works e2e on web + mobile.** Was the headline open item; now closed as a designed slice (research **R14**, spec US1-AC7/8/9 + FR-002a/FR-005b, tasks T069a–g). The flow: ambiguous title → assistant offers matches → user picks ("the first one"/"the 2003 one"/re-typed title) → single film resolves → approval → approve → added once. Default-collection resolution (`isDefault`); no-default → clarify (never auto-creates). Pick resolution is **pure code** (`supervisor.resolve_option`), not an LLM call (so no golden re-record — T069g N/A). **T069f remains a follow-up only if the APK ever changes** (it's JS-only today). The term "watchlist" must not be used anywhere (user).
2. **Live stack state (this session left it UP, but background procs belong to the OLD session — a fresh session can't address them; verify ports, restart per the runbook below if down):** gateway **:8123** (host, production nodes, all fixes, from source), Metro web **:8081**, web-api-mcp **:8765**, movie-mcp **:8766**, mc-service **:3001**, Ollama **:11434**. Verify: `netstat -ano | grep LISTENING | grep -E ":(8081|8123|8765|8766|3001|11434)"`. To re-test the assistant in a browser use **:8081** (NOT :8082 — that dev container points at a stale tool-free gateway image).
3. **Other open follow-ups (all logged, none blocking):** T063 US2/US3 golden exemplars + CI gate wiring; T060/T061/T062/T064/T065/T067/T068 Phase 6; **US4** (conversational collection *query/read* — out of 012 scope, in spec.md Out of Scope); known minor issues B (TMDB junk matches) + C (clarify copy).
4. **Durable findings to honor (memory):** [[project_golden_pair_cassette_harness]], [[project_supervisor_intent_prompt]] (verify classifier on BOTH qwen2.5 runtime + Claude gate; re-record intent cassettes after any prompt change), [[project_agent_run_token_refresh]], [[project_copilotkit_react_native]], [[project_mcp_transport_exceptiongroup]], [[project_langgraph_config_injection_future_annotations]], [[project_agui_interrupt_value_json_string]], [[project_keycloak_token_exchange_v2]]. **Code-orchestration decision** (LLM only extracts/plans; code drives MCP tools) still holds.

### Session-6 commits (newest first)
`d8c4da5` **T048 organize web E2E (GREEN live) + T049 mobile flow** · `9794f09` **T047 organize integration (live) + plan seam** · `f808af1` **T052 render_collection_summary** · `eb820a1` **T050b+T053 organizer organize path** · `c6ddf8f` **T050a organize proposals + apply** · `036783c` **T051 movie-mcp update/delete tools**.

**DONE (session 6) — US2 organize by conversation (backend + live integration + live web E2E):**
- **T051 — movie-mcp `update_movie` + `delete_movie`** (thin wrappers over mc-service PUT/DELETE; full-replacement update; idempotency key; 4xx→`McServiceToolError`, 404→skipped_missing). 4/4 integration GREEN vs real mc-service.
- **T050a — organize proposals** (`OrganizeOp` typed plan op; `build_organize_proposal` batch of update/remove items, deterministic keys, target_collection=None since a batch may span collections; `chunk_operations` ≤50 FR-009b; `ProposalItem.movie_payload`). `apply_proposal` extended for update+remove; runtime execute maps 404→skipped_missing.
- **T050b+T053 — organizer organize path.** `plan_operations` (model decision → `{collection, operations:[{op:remove,title}]}`); the organizer resolves titles→movieIds via `list_movies`, skips+reports unresolved, builds a **chunked** batch; **sequential approval** via `GraphState.pending_batches` + a conditional approval-gate self-loop (`route_after_approval`) — each batch its own interrupt; lifecycle reset only after the last. runtime_nodes wires paginated `list_movies` + `_default_plan` + a `plan` seam on `RuntimeNodeConfig`. **MVP scope = remove-only** (update/move follow-up).
- **T052 — `render_collection_summary`** generative-UI tool (pure prop builder) emitted in the organize preview + universal RN adapter `render-collection-summary.tsx` registered in the dock (wishlist reuses it).
- **T047 — organize integration 3/3 GREEN live** (real movie-mcp→mc-service + real Keycloak exchange): remove batch applies on approval, **drift item 404→skipped_missing without aborting the batch**, reject persists nothing. Run: `KEYCLOAK_URL=http://localhost:8099 MOVIE_MCP_URL=http://127.0.0.1:8766/mcp pnpm nx test:integration movie-assistant -- -k organize_batch`.
- **T048 — organize web E2E GREEN live (21.9s)** vs the production-node host gateway: seeds a collection via the BFF, "remove Zorgon and Quaffle from <c>" → qwen2.5 plan → batch preview → approve → exactly those removed (proves live LLM plan extraction). **T049 mobile flow authored** (self-contained add→organize→verify), live emulator run pending.
- **Tallies:** movie-assistant **185 unit** (proposals/organize-flow/approval-gate) + T047 3/3 live + T051 4/4 live; **SC-005 dev-container 95/4-skip** (T052 dock change additive); ruff+mypy+tsc+eslint clean. Stack left UP: gateway :8123 (organize code), movie-mcp :8766 (update/delete tools), web-api-mcp :8765, mc-service :3001, Ollama :11434, Metro :8081, dev-container :8082. **Remaining US2: T049 mobile live + T063 golden organize-plan exemplar.**

### Session-5 commits (newest first)
`fed601c` **T069f mobile ambiguous-add GREEN + dock auto-scroll** · `2d336f3` **T069e ambiguous-add web E2E (GREEN live)** + T069f flow · `3d5ab8d` **T069a–d disambiguation state machine**.

**DONE (session 5) — T069 multi-turn ambiguous-add hardening (the headline open item), as spec→plan→TDD:**
- **Root cause (systematic-debugging Ph1):** disambiguation was bolted on as the implicit flag `match_confidence=="ambiguous"` + a supervisor `enrich→add` hack — not a state machine. Four RCs: RC1 ordinal picks dead-end (only re-typed titles continued), RC2 spoken collection dropped on the ambiguous branch (`curator._reply` didn't carry it), RC3 no real default collection (created a literal "my collection"), RC4 no lifecycle reset (stale options/intent leaked into the next turn).
- **Design (research R14):** first-class pending-add state machine on `GraphState.add_stage` (`"" | awaiting_pick | awaiting_collection`) + `resolved_pick`. Supervisor routes; `resolve_option(text, options)` resolves picks **in pure code** (year → typed-title → ordinal → 1-based index; length-guarded title match). Curator: details-for-pick short-circuit, preserves target across every branch, re-offers on unresolvable pick, `awaiting_collection` threads the named collection. Organizer: `isDefault` resolution; generic/empty target with **no default → clarify listing collections** (user decision: never auto-create). Reset on approve/reject/decline.
- **User decisions:** harden **in-place as 012 US1 defect**; no-default → **clarify** (not auto-create); **"watchlist" must not appear anywhere**.
- **Tests:** `test_disambiguation_flow.py` (6, TDD RED→GREEN) + `test_graph.py` adjusted to the stage contract → **171 movie-assistant unit GREEN**, ruff+mypy clean, golden replay 8/8 (no prompt change ⇒ T069g N/A). **Web ambiguous E2E `assistant-add-ambiguous.spec.ts` GREEN live (32s)** vs production-node host gateway (proves multi-turn state survives across AG-UI turns); **mobile `assistant-add-ambiguous.yaml` GREEN live on Pixel_7-35** (movie added once, verified in mc-db). **SC-005 dev-container regression 95/3-skip (~1min).**
- **Real dock fix found via the mobile run:** `assistant-dock.tsx` `FlatList` had no auto-scroll → on a long thread the post-approval "Done" lands below the fold (write succeeded; only off-screen). Added `ref`+`onContentSizeChange`/`onLayout`→`scrollToEnd`. Additive; web E2E re-verified.
- **Note (pre-existing, not from T069):** gateway logs `Deserializing unregistered type ...ApplyResult from checkpoint` (a dataclass in state) — harmless warning; future `LANGGRAPH_STRICT_MSGPACK` may require registering it.
- **Stack left UP** (started from current source this session): host gateway **:8123** (production nodes, my code), web-api-mcp :8765, movie-mcp :8766, mc-service :3001, Ollama :11434, dev-container `mcm-bff-dev` :8082 (rebuilt with the dock fix). **Metro was restarted to all-platform then OOM'd (exit 134) at the end of the full suite — restart fresh before more web work.** Emulator stopped.

### Session-4 commits (newest first)
`53b0e60` T014a done · `453b389` **T069 logged** · `a49051c` **fix: continue add after disambiguation** · `f29ab84` **fix: supervisor skips non-user turns (no spurious decline)** · `05d2ce7` **fix: agent-run token refresh** · `8911286` defer US4 (collection-query out of scope) · `2725030` **fix: supervisor over-declined in-domain queries** · `62c072d` T032 docs · `6c7a31b` nx test:golden + marker · `21f1332` golden runner + Claude cassettes · `f6f0651` golden dataset + compare_decision · `17f751b`/`69be482` decision-fn refactors · `e8bdd8c` cassette dispatch · `6107126` cassette core + research R13. (`2a2c990` README Claude Plugins = user, mid-session.)

**DONE (session 4):**
- **T032 — golden-pair regression harness + cassette/replay (TDD RED→GREEN, COMMITTED; design = research R13).**
  Model-decision golden gate: asserts supervisor **intent** + curator **extraction** (the two graph LLM
  calls) on US1 exemplars against the shipped model (Claude); CI replays recorded responses deterministically
  with **no key**. Cassette seam `src/eval/cassette.py` wraps `build_chat_model` on `LLM_CASSETTE_MODE`
  (`replay`→`ReplayChatModel`, never imports a provider; `record`→wraps real; unset unchanged); keyed
  `sha256(model_id+prompt)`, replay miss → `CassetteMissError` (drift fails loudly — **proven**). Refactored
  the two inline LLM blocks into pure `supervisor.classify_intent` + `curator.extract_entities`
  (behaviour-preserving). Dataset `tests/golden/dataset.json` (**JSON**, 5 US1 pairs) + pure `compare_decision`;
  runner `tests/integration/test_golden_pairs.py` (`-m golden`, forces `MODEL_PROVIDER=anthropic` + drops
  `.env.local` Ollama per-node overrides; skips cleanly w/o key+cassette). Nx `test:golden` target + `golden`
  marker. **5/5 live-green vs Claude (haiku/sonnet) + 5/5 replay-green keyless; movie-assistant 160 unit; ruff+mypy
  clean.** Real signal caught during record: live Claude read bare "tell me about X" as `out_of_domain` → enrich
  exemplar rephrased to an explicit in-domain look-up (matcher NOT loosened). **T063 → partial** (US1 exemplars +
  gate mechanism done; US2/US3 exemplars + CI-workflow wiring remain). **Run:** `LLM_CASSETTE_MODE=replay pnpm nx
  test:golden movie-assistant` (keyless CI gate); `LLM_CASSETTE_MODE=record …` to re-record vs Claude (key in
  `agents/movie-assistant/.env.local`).
  - **Process note:** initially (mis)ran the superpowers brainstorming/writing-plans flow and produced a
    parallel `docs/superpowers/` spec+plan — corrected per SDD (user caught it): deleted those, folded the
    cassette-mechanism design into `research.md` **R13** (SDD = source of truth), implemented directly against
    `tasks.md` T032/T063.
- **Supervisor intent classifier fix (COMMITTED) — live bug.** Users got the `decline` copy ("I can only help
  with your movie collections.") for in-domain questions. Root cause: under-specified `classify_intent` prompt
  (no label defs/examples/in-domain rule) → model labelled "tell me about <movie>" / "how many movies" as
  `out_of_domain` → decline. Reproduced on **qwen2.5 (runtime) AND Claude**. Fix = label defs + "anything about
  movies/films/collections is IN DOMAIN, never out_of_domain" + few-shot; in-domain-unsupported → `clarify`
  (copy now states capabilities). +3 golden intent exemplars + re-recorded intent cassettes (6/6 vs Claude).
  See [[project_supervisor_intent_prompt]]. **Verify classifier on BOTH models; re-record intent cassettes after any prompt change.**
- **Scope decision (2026-06-07, user):** conversational **queries/reads of the user's existing collection**
  ("how many movies in this collection", "what's in my Watchlist", "tell me about a movie I own") are **out of
  012 scope** — logged in `spec.md` Out of Scope as a candidate future **US4** (query/browse intent + movie-mcp
  collection-read surfaced conversationally). 012 stays add/enrich/organize. Unsupported in-domain → `clarify`.
- **Known minor issues (deferred — user chose "log, don't fix now"):** (B) US1 **enrich/TMDB search returns junk
  matches** (e.g. "tell me about king of new york" → "Jose Altuve PART 2"); curator/web-api-mcp search-quality.
  (C) `clarify` copy "look up details about a movie" can over-promise (users read it as "look up a movie I own",
  which is the deferred US4). Both are quick follow-ups when prioritized.
- **Multi-turn ambiguous-add still not working end-to-end → T069 hardening pass (logged 2026-06-07).** The add
  flow was only ever built/tested for the **single-shot exact title** (T037 "Coherence"). The **ambiguous-title**
  path (most franchises) needed FIVE consecutive live fixes this session — classifier prompt
  ([[project_supervisor_intent_prompt]]), agent-route token refresh ([[project_agent_run_token_refresh]]),
  render-tool spurious-decline guard, disambiguation→add continuation, collection-target preservation (last three
  in `graph._supervisor_node` + `curator`) — and a user still couldn't complete an add. Per systematic-debugging
  Phase 4.5 (fixes piling up ⇒ question the design), STOPPED reactive patching and **logged a dedicated hardening
  slice = T069**: ordinal/positional picks ("the first one"), a **real default-collection** (don't create a literal
  "my collection"), multi-turn `GraphState` robustness audit, and **ambiguous-path web+mobile E2E** (today only the
  exact-title single-shot is covered). Decision pending: 012-US1 defect-hardening vs a separate spec'd feature.
- **Live stack left running this session:** host **production** gateway on `:8123` (restarted from source with
  the classifier fix; `WEB_API_MCP_URL`+`MOVIE_MCP_URL` set → production nodes), movie-mcp `:8766`, web-api-mcp
  `:8765`, Metro web `:8081` (→ 8123). Test the assistant on **:8081** (the `:8082` dev container is a stale
  tool-free image). Background task IDs: gateway `bba19sjst`, Metro `bnzfsaiet`.

Read this first, then `tasks.md` (checkboxes current) + `plan.md`/`research.md`. Implementation
handoff for a fresh session: current state, exact commands, durable findings, next picks.

## Where we are

Phase 1 (Setup) **done**. Phase 2 (Foundational) **done**. **US1 (Phase 3) — the MVP is functionally
COMPLETE and proven end-to-end live in a browser.** This session (session 2) finished the deploy-coupled
tail: T040 render-movie-card adapter, the production-node factory (gateway-gated), T036 live add flow,
T045 authz parity, the gateway cut-over + subject-token bridge, the gateway AG-UI add proof, the dock
HITL approval UI, **T037 web E2E (GREEN, 2/2 live in a browser)**, the SC-002 approval audit on /run, and
the SC-005 additivity regression. The whole add pipeline runs through the real gateway surface:
**CopilotKit dock → BFF /run (subject token) → gateway production nodes → Ollama classify/extract →
web-api-mcp/TMDB enrich → organizer → approval_gate interrupt → ApprovalRequest card → approve → resume
(fresh token) → movie-mcp → mc-service write** (verified via the BFF API; reject persists nothing).

**US1 IS COMPLETE — web AND mobile E2E both GREEN.** No remaining US1 items. Next is Polish (Phase 6)
and US2/US3 (separate stories).

**DONE (session 3):**
- **T038 mobile E2E + T033a — DONE (GREEN end-to-end on the Pixel_7-35 emulator).**
  `frontend/mcm-app/tests/e2e/mobile/assistant-add.yaml`: clearState logged-out start → SSO login →
  open dock → "add the movie Coherence (2013) to my collection {unique}" → approval_request card
  ("Coherence") → approve → "Done" → idempotent teardown (Profile→home refresh, delete the created
  collection by unique name). Full live stack; **Ollama accessed directly on the Windows host
  (`localhost:11434`), no container.** **T033a needed NO rebuild** — the latest CI APK (run
  27078620783, commit `3171ca0`) is native-identical to HEAD (every commit since is JS-only);
  `gh run download 27078620783 -n app-debug-apk` → `adb install -r`. **CopilotKit-on-RN required four
  JS/Metro fixes** (the real work — see [[project_copilotkit_react_native]]): `metro.config.js`
  stubs `@segment/analytics-node` (→jose→node:crypto, unbundlable); `src/assistant-polyfills.ts`
  installs `crypto.getRandomValues` + streaming-fetch/TextEncoder (imported first, suppresses its own
  LogBox warning that was eating the dock tap); `.env.local` native URLs → `localhost` (KC cookie
  origin vs pinned `KC_HOSTNAME=localhost:8099`) + `adb reverse tcp:8081 tcp:8099`. tsc+eslint clean;
  web+android bundles build; mcm-app 896 unit GREEN. **Run:** bring up the agent stack (gateway :8123
  prod nodes + movie-mcp :8766 + web-api-mcp :8765 + Ollama + Metro :8081), `adb reverse tcp:8081
  tcp:8099`, then `maestro test tests/e2e/mobile/assistant-add.yaml --env E2E_TEST_USER=… --env
  E2E_TEST_PASSWORD=… --env COLLECTION_NAME="t038-add-$(date +%s)"`.
- **T024a — write-tool resilience + 409→`skipped_duplicate` (TDD RED→GREEN, COMMITTED).** `invoke_tool`
  retries transient transport failures (httpx `TransportError`/`OSError`, **unwrapped from the MCP
  streamable-HTTP `ExceptionGroup`** — [[project_mcp_transport_exceptiongroup]]) + upstream 5xx with
  exponential backoff (`max_retries=2`, injectable `sleep`); deterministic 4xx never retried; exhausted
  retries **dead-letter** (audit `logger.error` no-token/PII + user-facing "couldn't complete"). Added
  `ToolOutcome.status`: movie-mcp `server.py` write handlers catch mc-service 4xx/5xx → re-raise
  `McServiceToolError` carrying a `mc-service-status:<code>` sentinel (`tools.tool_error_from_http_status`);
  `invoke_tool` parses it; `approval_gate` execute maps **409 → skipped_duplicate** (mc-service returns
  409 CONFLICT for `DuplicateMovie`/`DuplicateCollectionName`). **141 movie-assistant unit + 6 movie-mcp
  unit + write_resilience integration (real unreachable-port dead-letter) + add_flow 3/3 (live duplicate →
  skipped_duplicate end-to-end) + movie-mcp writes/server 8/8 GREEN; ruff+mypy clean.**
- **LLM provider approach revised — env-scoped (research R1, user-approved; docs-only, COMMITTED).**
  Was "Ollama default everywhere incl prod, Claude fallback"; now **Ollama for dev/test/iterative E2E;
  Anthropic Claude for the golden-pair regression suite *and* production** (`MODEL_PROVIDER=anthropic`:
  supervisor→claude-haiku-4-5, specialists→claude-sonnet-4-6, escalation→claude-opus-4-8). Rationale: the
  golden gate must validate the shipped model; Claude meets the prod quality/availability bar without
  self-hosted GPU/HA. **No code change** — `src/models.py` already switches on `MODEL_PROVIDER`. Updated
  research.md R1 (+ revision note + alternatives), plan.md, quickstart.md (prod=Claude env table),
  tasks.md (T032/T063 golden=Claude, T030a, stack/policy notes), this HANDOFF. **Not a constitution
  deviation** (it pins the golden gate, not a vendor). Future T032/T063 harness + prod deploy implement
  against this; both need `ANTHROPIC_API_KEY` (Vault, T030a).
- **C4 agent-layer diagrams now show the external LLM (COMMITTED).** Added an `LLM Provider (External model
  API)` node — outside the software ecosystem, alongside Keycloak/Vault — called by the gateway runtime
  (`gw_runtime -->|LLM inference (chat + tool-calling)| llm`), in `docs/MCM-Architecture.md` (with-agentic
  C4) and the constitution's agent C4. Hosting intentionally unspecified (provider configured per env).
  Constitution bumped v1.5.2 → **v1.5.3** (diagram correction; no principle redefined).
- **CLAUDE.md APK-build guidance (COMMITTED).** Added a "do you even need to rebuild?" step: pure-JS
  changes never need an APK rebuild; before a ~20-min CI build, `git diff <last-CI-APK-commit> HEAD --
  frontend/mcm-app/{package.json,android,app.json}` — if empty, just `gh run download` + `adb install`
  the existing artifact (how T038's APK was sourced).

Then **Polish (Phase 6) — the recommended next work**: T060 out-of-domain decline (live), T061 kill-switch,
T062 proposal expiry, T030/T030a/T030b observability/Vault/OTel (several = documented MVP deferrals),
T031/T064 token-leak scan, **T032/T063 golden-pair harness (now Claude-backed — R1)**, T065 docs. US2/US3
are separate stories (US2 mobile flows T049/T056 will reuse the [[project_copilotkit_react_native]] fixes).

**Latest test tallies (all GREEN, session 3):** movie-assistant **141 unit** + integration (T024a
write_resilience + add_flow live); mcm-app **896 unit** + agent suites; **T037 web E2E 2/2** (host
production gateway, `E2E_AGENT_PRODUCTION=1`); **T038 mobile E2E GREEN** (Pixel_7-35 emulator); **SC-005
dev-container regression 95 passed / 2 skipped** (the 2 skipped = assistant-add.spec, needs the prod
gateway); ruff + mypy + tsc + eslint clean.

### Session 3 commits (newest first)
`23f530f` minor diagram tweak (user) · `4fc4497` external LLM in C4 diagrams · `fda33c6` R1 provider
revision (env-scoped) · `ac8d8b5` APK-build docs · `40a032d` **T038 mobile E2E GREEN (US1 complete)** ·
`b7628d4` **T024a** write-tool resilience + 409→skipped_duplicate.

### Session 2 commits (newest first)
`e1692fb` SC-005 guard · `b137077` SC-002 audit on /run · `da3baf2` T037 browser GREEN · `8d3be29`
approval UI · `5686a6f` gateway AG-UI add proof · `6c8c393` cut-over + subject-token bridge · `ebb620f`
T045 authz · `d452712` T036 live · `6a23ae6` production-node factory · `6c2fcda` T040 render-movie-card.

### How to bring the agent stack up (for T037 / live agent work)
1. `movie-mcp`: `cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server`
2. `web-api-mcp`: `cd mcp-servers/web-api-mcp && WEB_API_MCP_PORT=8765 WEB_API_MCP_HOST=127.0.0.1 TMDB_API_KEY=<from .env.local> uv run python -m src.server`
3. **host gateway (production nodes) on the Metro loopback :8123** — secret via
   `uv run python -c "import sys;sys.path.insert(0,'tests/integration');import kc_admin;print(kc_admin.gateway_secret(kc_admin.admin_token()))"`:
   `WEB_API_MCP_URL=http://127.0.0.1:8765/mcp MOVIE_MCP_URL=http://127.0.0.1:8766/mcp AGENT_GATEWAY_CLIENT_ID=agent-gateway AGENT_GATEWAY_CLIENT_SECRET=<secret> KEYCLOAK_URL=http://localhost:8099 SUPERVISOR_MODEL=qwen2.5:latest SPECIALIST_MODEL=qwen2.5:latest uv run uvicorn src.gateway:create_app --factory --host 127.0.0.1 --port 8123`
4. **fresh Metro** (long-session OOM = exit 134): `cd frontend/mcm-app && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec expo start --web --port 8081` (drop `--web` for mobile so the android bundle is served).
5. run T037: `E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-add.spec.ts --retries=0` (Ollama qwen2.5 must be up; "Coherence" is the exact-resolving title).

**For T038 / mobile agent work (additional to the above — see [[project_copilotkit_react_native]]):**
- APK: no rebuild needed while native deps are unchanged — `gh run download <latest android-apk run> -n app-debug-apk -D <dir>` then `adb install -r app-debug.apk` (latest known-good: run 27078620783).
- Emulator ritual: `emulator -avd Pixel_7-35 -no-snapshot-load -gpu swiftshader_indirect`; then **`adb reverse tcp:8081 tcp:8081` + `adb reverse tcp:8099 tcp:8099`** (QEMU 10.0.2.2 is broken here).
- **`frontend/mcm-app/.env.local` native URLs must be `localhost`** (NOT 10.0.2.2): `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8081`, `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099` (matches the pinned `KC_HOSTNAME=localhost:8099` → OAuth cookie origin; else "Restart login cookie not found"). Restart Metro `--reset-cache` after changing. (Gitignored; currently left at localhost.)
- Run: `maestro test tests/e2e/mobile/assistant-add.yaml --env E2E_TEST_USER=testuser --env E2E_TEST_PASSWORD=<from .env.e2e.local> --env COLLECTION_NAME="t038-add-$(date +%s)"`.
- Git-Bash gotcha: `adb shell`/`pull` to `/sdcard` needs `MSYS_NO_PATHCONV=1` (else the path mangles to `C:\Program Files\Git\sdcard`).

### Env left running by session 2 (stop when done)
host gateway :8123, movie-mcp :8766, web-api-mcp :8765, fresh Metro :8081, rebuilt dev-container
`mcm-bff-dev` :8082, plus the shared stack + the original containerized (tool-free) `agent-gateway`.
Teardown: stop the host gateway/MCP/Metro background processes; `docker compose rm -sf mcm-bff-dev`.

### Foundational DONE (`[X]` in tasks.md)
- **T015–T018, T020** — state/no-token invariant, model provider switch, supervisor node, per-agent
  MCP allowlists, compiled LangGraph graph + AG-UI gateway.
- **T021** movie-mcp READ tools (GREEN vs real mc-service) · **T022** web-api-mcp TMDB tools (GREEN vs
  real TMDB; key in gitignored `mcp-servers/web-api-mcp/.env.local`).
- **T026** BFF ui-state sanitizer + ui-action authorizer (12/12) · **T028/T028a** BFF agent route +
  auth-guard regression · **T029** CopilotKit dock + live web E2E (`assistant.spec.ts` 2/2).
- **T023** `bff-server/agent-subject-token.ts` — RFC 8693 subject-token mint (9 unit + real-Keycloak
  integration GREEN) · **T025** `bff-server/agent-gateway-client.ts` — mode-aware gateway URL + AG-UI
  `HttpAgent` factory (6 unit). Wired into `run+api.ts` (per-request runtime, best-effort subject-token
  attach; config-gated so unchanged when unconfigured).
- **T024** gateway re-exchange + OPA + per-request capture + acquire seam — **pieces 1–4, 24 tests
  (23 unit + 1 real-Keycloak integration) GREEN**. See "T024" below. **MCP transport split to US1.**
- **T066** existing web E2E regression GREEN (additivity proof). **T033** partial (gateway
  containerized on `backend-network`; Nx Python targets + full `--profile agents` boot still pending).
- **T027** BFF per-user rate + cost limits — `bff-server/agent-rate-limiter.ts` (7 unit + 4 real-Redis
  integration GREEN). `checkAgentRequestRateLimit` (20/60 s), `enforceAgentCostCeiling` pre-flight
  (throws before any work → "no action"), `recordAgentCost` (micro-USD accrual; T030 supplies the
  LangFuse per-turn cost). Cost primitives `addAgentCostMicros`/`getAgentCostMicros` in `cache-service`.
  **Wired into `run+api.ts` POST only** (the `/info` GET is a handshake). Env: `AGENT_RATE_LIMIT_REQUESTS`/
  `_WINDOW_MS`/`AGENT_SESSION_COST_CEILING_USD`. **Re-verified live:** bff image rebuilt + recreated,
  auth-guard 2/2 vs container, SC-005 dev-container E2E **95/95 (~1.0 min)**.
- **T027a** gateway per-agent tool-call limiter — `agents/.../src/tools/agent_rate_limit.py`
  `AgentToolRateLimiter` (sliding window per `(agent, scope)`, per-agent overrides, injectable clock) +
  `build_default_limiter(env)` (`AGENT_TOOL_CALL_LIMIT`/`_WINDOW_SECONDS`, defaults 30/60 s); breach →
  typed `AgentRateLimitExceeded` (FR-018 graceful degradation). 7 unit GREEN; ruff + mypy clean.
  **The `limiter.check(agent, scope)` call site lands with the US1 MCP tool transport** (same split as T024).
- **T019** guardrails — `src/guardrails/output_validators.py` (pure): `scan_for_pii`/`redact_pii`
  (email/phone/Luhn card), `detect_prompt_injection` (instruction-override heuristics on untrusted
  tool/MCP output), `validate_structure` (Pydantic → typed `StructuralValidationError`/`GuardrailError`),
  `guard_user_input`/`guard_tool_output` → `GuardResult{text,pii,injection}`. `src/guardrails/rails.co`
  = real NeMo Colang movie-domain rails (in/out-of-domain intents + decline flow); `test_rails_config.py`
  asserts it parses (no LLM). **15 unit GREEN; ruff + mypy clean.** Call sites (`guard_tool_output` at the
  MCP boundary + NeMo rails on the model) wire with the US1 transport; **live decline = T060**.

### US1 (T034–T046) — 9 of 10 slices DONE (committed, GREEN). Only the deploy-coupled tail remains.
**Whole add pipeline assembled + proven end-to-end deterministically** (full movie-assistant unit suite
**125 GREEN**; mcm-app **880 unit**; SC-005 dev-container web E2E **95/95**). Done: A write-tools (`686aa75`),
B proposals (`1fd9aca`), F1 MCP servers+token transport (`fd9effb`), F2 gateway adapter (`d9f1ba6`),
C curator+enrichment (`4c35f4f`, incl. T035 live vs real TMDB), D organizer (`e464647`), E approval-gate
core (`c030540`), I graph assembly+routing+interrupt/resume (`95eb7e4`), H BFF resume route+auth-guard
(`de594bd`). **`test_add_flow_graph.py` proves route→enrich→propose→interrupt→resume(approved)→apply-once /
reject→zero-writes** via stub tools + MemorySaver (SC-006/FR-007).

**REMAINING = Slice G+J (the deploy-coupled tail):** ~~(1) `render-movie-card.tsx` client adapter (T040) +
CopilotKit `useRenderTool`~~ **DONE this session (T040, TDD — see "T040 client adapter" below)**;
~~(2) **production node switch-over**~~ **FACTORY BUILT + GATEWAY-GATED this session (TDD — see
"production node factory" below)**; the ContextVar→`config` subject-token bridge at graph
invocation is the one remaining deploy-side wire (see that section); ~~(3) **T036 LIVE**~~ **DONE this session (3/3 GREEN — see "T036 LIVE add flow" below; fixed a
real externalIds defect)**; ~~(4) authz parity T045~~ **DONE this session (2/2 LIVE — cross-user 404 parity + agent
write denied + no-escalation token; helpers in `tests/integration/kc_admin.py`)**; (5) web/mobile
E2E T037/T038 (mobile gated on T033a APK). All of these need the `--profile agents` deploy (movie-mcp +
gateway-with-real-nodes); the pure logic they wire is already built + unit-tested.

US1 was built in dependency-ordered vertical slices, each TDD'd + committed:
- **Slice A — T043 movie-mcp write tools** (`686aa75`): `add_movie` + `create_collection` thin httpx
  wrappers (`mcp-servers/movie-mcp/src/tools.py`); `idempotency_key`→`Idempotency-Key` header (mc-service
  ignores it; at-most-once from mc-service uniqueness → dup surfaces 409→`skipped_duplicate`). **4 integration
  vs real mc-service GREEN** (`-k writes`, `tests/integration/test_writes.py`).
- **Slice B — T041 (part) proposals.py** (`1fd9aca`): `EnrichedMovieCandidate` (Pydantic snake_case +
  camelCase aliases — validates web-api-mcp output directly), `Proposal`/`ProposalItem`/`CollectionRef` +
  `StrEnum`s, `idempotency_key=sha256(thread,proposal,item)`, `build_add_proposal` (create-if-missing →
  both writes in ONE batch proposal, FR-005a/FR-006). **6 unit GREEN.**

**T036 LIVE add flow — DONE this session (3/3 GREEN).** `tests/integration/test_add_flow.py`
drives the REAL organizer + approval_gate (`build_runtime_nodes`, stub curator with a
deterministic candidate — TMDB is T035) through the live Slice-F2 streamable-HTTP transport to a
running **movie-mcp → real mc-service** with a **real Keycloak RFC 8693 downscoped token per
call**, subject token via `config["configurable"]` (validates the config-injection path live).
Proves create-if-missing (create+add in ONE approval, applied once), reject persists nothing
(FR-007), duplicate retry → exactly one movie (SC-006, via mc-service per-collection uniqueness).
**Caught + fixed a real defect:** `to_movie_payload` emitted `externalIds: {source,id}` but
mc-service's `ExternalIdentifier` is `{system, uniqueId, url?}` → 422 "missing field `system`"
(TDD: unit test corrected + payload fixed). **Run:** start movie-mcp
(`cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 MC_SERVICE_URL=http://localhost:3001
uv run python -m src.server`) then `MOVIE_MCP_URL=http://127.0.0.1:8766/mcp pnpm nx test:integration
movie-assistant -- -k add_flow`. (movie-mcp left running on :8766 this session.) **Note:** this
exercised the WRITE path with the real downscoped token end-to-end but NOT the full gateway/BFF/
AG-UI surface — that is T037/T038 (web/mobile E2E) + the gateway production cut-over.

**T040 client adapter — DONE this session (TDD; self-contained, no deploy).**
`frontend/mcm-app/src/components/agent/render-movie-card.tsx`: presentational `RenderMovieCard`
(universal RN — poster/title/year/genres/overview + source badge; omits poster/year when null so no
`null` leaks), zod `renderMovieCardParameters`, and `useRenderMovieCardTool()` (CopilotKit
`useRenderTool` registration, **render-only** — preview, no `handler`/write). `assistant-dock.tsx` now
registers the tool + consumes `useRenderToolRegistry()` and renders `render_movie_card` tool calls
inline via `buildDockItems` (maps assistant `toolCalls`→registry→component; skips unknown tool names /
unparseable args — never crashes the chat; preserves the existing `assistant-msg-*` text testIDs).
**6 unit (RenderMovieCard) + 1 integration-style unit (dock renders the card from a mocked tool call) GREEN;
tsc + eslint clean; full mcm-app unit suite 886/887** (the 1 = a pre-existing parallel-load timeout in
`movie-detail-screen.test.tsx` that passes 12/12 in isolation — not agent-related). Live tool-call
round-trip = web E2E (T037, deploy-coupled). **NOTE:** message shape is AG-UI
`assistant.toolCalls[].function.{name,arguments(JSON string)}`; render-tool args arrive JSON-encoded.

**Production node factory — BUILT + GATEWAY-GATED this session (TDD; Slice G item 2).**
`src/runtime_nodes.py`: `build_runtime_nodes(cfg)` assembles the REAL curator/organizer/
approval_gate from `RuntimeNodeConfig` (injectable transport `call`, identity `authorize`/
`exchange`, `limiter`/`cache`, model-backed `extract`). Curator = web-api-mcp closures
(token-free); organizer (`list_collections` read) + approval_gate (`execute` writes) are
`(state, config: RunnableConfig)` wrappers that read `subject_token`+`user_id` from
`config["configurable"]` and build per-run closures over `invoke_tool` +
`acquire_downscoped_token` (per-call downscoped token → movie-mcp). `build_runtime_graph(env,
*, config?, classifier?, checkpointer?, force?)` injects them ONLY when
`production_nodes_enabled(env)` (both `WEB_API_MCP_URL`+`MOVIE_MCP_URL` set) — else returns the
tool-free `build_graph()`. `gateway.create_app()` now calls `build_runtime_graph(os.environ)`
(logs which graph). **5 unit GREEN** (gating predicate + factory-compiled graph add-flow with
injected stubs: web calls carry NO token, movie calls carry the downscoped token, apply-once on
approve, zero writes on reject); ruff + mypy clean; full movie-assistant **130 unit**; default
graph unchanged (SC-005 safe). **GOTCHA fixed (durable — [[project_langgraph_config_injection_future_annotations]]):**
`from __future__ import annotations` stringifies the `config: RunnableConfig` annotation →
LangGraph silently skips config injection → node gets `config=None` → identity path dead. Do
NOT use future-annotations in node modules. **TWO deploy-side follow-ups remain (need the live
stack):** (a) bridge `runtime_context.get_subject_token()` (ContextVar from SubjectTokenMiddleware)
→ `config["configurable"].subject_token`+`user_id` at graph invocation (depends on how
`ag_ui_langgraph` passes config; only testable live — until wired, enabled production nodes
return a graceful "no caller identity" on movie-mcp, never an unauth call); (b) map upstream 409
→ `skipped_duplicate` in the approval-gate `execute` (invoke_tool currently collapses status to a
generic error → surfaces as `failed`; lands with T024a/T036). The Postgres checkpointer (T020) is
still MemorySaver here — a separate deploy concern.

**T037 WEB E2E — GREEN (2/2 live in a browser) — the US1 MVP is real end-to-end.**
`tests/e2e/web/assistant-add.spec.ts`: approve creates-if-missing + adds "Coherence" exactly once
(verified via BFF API); reject persists nothing (FR-007). Drives the WHOLE live stack: CopilotKit
dock → BFF /run (subject token) → **host gateway with production nodes** (`SUPERVISOR_MODEL`/
`SPECIALIST_MODEL=qwen2.5:latest`) → real Ollama classify/extract → web-api-mcp/TMDB → organizer →
approval_gate interrupt → ApprovalRequest → approve → resume → movie-mcp → mc-service.
**To reproduce:** (1) movie-mcp :8766 + web-api-mcp :8765 up; (2) host gateway on **127.0.0.1:8123**
(the Metro loopback) with production env — `WEB_API_MCP_URL`/`MOVIE_MCP_URL` + `AGENT_GATEWAY_CLIENT_ID`
+ secret (fetch via `kc_admin.gateway_secret`) + `KEYCLOAK_URL=http://localhost:8099` + Ollama +
`SPECIALIST_MODEL=qwen2.5:latest`; `uv run uvicorn src.gateway:create_app --factory --host 127.0.0.1
--port 8123`; (3) **fresh Metro** `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec expo start --web
--port 8081` (long-session OOM = exit 134 → restart fresh); (4) `pnpm nx e2e mcm-app -- tests/e2e/web/
assistant-add.spec.ts --retries=0`. **Two fixes this session:** curator now carries the spoken
collection → `target_collection_name` (TDD); `coerceApprovalPayload` parses the JSON-string
`event.value` (CopilotKit `useInterrupt` value is a STRING — see
[[project_agui_interrupt_value_json_string]]). Existing `assistant.spec` still 2/2 (additive).
**SC-002 audit on /run resume — DONE this session (TDD).** `extractApprovalDecision(bodyText)` in
`bff-server/agent-resume.ts` parses the CopilotKit runtime POST body
(`body.forwardedProps.command.resume.decision` + `command.interruptEvent` JSON string →
proposalId); `run+api.ts` POST records `logger.audit('approval_decision', {userId, threadId,
proposalId, decision})` best-effort (cloned body, never blocks) before the run applies. **Verified
live** (audit line emitted on the approve E2E). 4 unit GREEN. (`resume+api.ts` still holds the same
audit for non-CopilotKit clients.) **SC-005 additivity regression — GREEN this session (95 passed, 2 skipped).** Rebuilt the
dev-container with this session's frontend (`pnpm nx docker-build mcm-app` →
`docker compose --profile bff-dev up -d --force-recreate mcm-bff-dev`) then
`E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → **95/95 + assistant.spec, ~1.0 min**. The 2
skipped are `assistant-add.spec` (guarded `test.skip(E2E_AGENT_PRODUCTION!=='1')` — it needs the
host production-node gateway, not the tool-free containerized one; run T037 with
`E2E_AGENT_PRODUCTION=1` + the host gateway up). Proves the dock approval UI / render-movie-card /
tool-call rendering are additive (SC-005). **REMAINING US1:** T038 mobile E2E (gated on T033a APK);
T024a 409→skipped_duplicate.

**Dock HITL approval UI — DONE this session (TDD; T037 blocker #1 cleared).**
`frontend/mcm-app/src/components/agent/approval-request.tsx`: `ApprovalRequest` (per-item-visible
preview — create-collection / add with movie title+year — + Approve/Reject, double-submit guard;
**4 unit GREEN**) and `useApprovalInterrupt()` — CopilotKit `useInterrupt({renderInChat:false})`
that catches the `on_interrupt` AG-UI custom event (ag_ui_langgraph emits our LangGraph
`interrupt(approval_request)` as `event.value`), renders `ApprovalRequest`, and `resolve({decision})`
resumes the run. Wired into `assistant-dock.tsx` (renders `approvalElement` in the panel). tsc +
eslint clean; mcm-app **891 unit** (8 agent suites/43 GREEN). **ARCHITECTURE (important):**
CopilotKit's interrupt resume re-runs through the **/run** runtime endpoint
(`copilotkit.runAgent({forwardedProps:{command:{resume}}})`) — which already mints a FRESH subject
token per POST — **NOT the dedicated `resume+api.ts` (T044)**. So `resume+api.ts` is unused by the
CopilotKit flow (kept for the contract / non-CopilotKit clients) and the **SC-002
`approval_decision` audit must be added to `/run` when `command.resume` is present** (FOLLOW-UP —
needs body-peek of the CopilotKit runtime payload; not required for the add to function). The live
interrupt→approve→write round-trip is the web E2E (T037 spec, still to write).

**Gateway AG-UI add — PROVEN END-TO-END this session (`test_gateway_add_e2e.py`, 1 GREEN).**
The deploy cut-over validated through the FULL gateway AG-UI HTTP endpoint in-process (FastAPI
`TestClient`): `POST /agent/movie-assistant` (`Authorization: Bearer <real subject token>`) →
`SubjectTokenMiddleware` → `IdentityAwareAGUIAgent` (config bridge) → `build_runtime_graph`
PRODUCTION nodes → curator enrich via REAL web-api-mcp/TMDB → organizer via REAL movie-mcp → real
mc-service (downscoped token from a REAL Keycloak RFC 8693 exchange) → approval_gate `interrupt()`
(nothing written) → second POST `forwardedProps.command.resume={decision:approved}` → write
persisted. Observable via mc-service: collection absent pre-approval, collection + 1 movie
post-approval. This is the composition T036 (nodes) + the bridge test (header→config) never ran
together. Per constitution (cassette ONLY the LLM): the 2 LLM calls (classify + extract) are
stubbed deterministically; **TMDB, movie-mcp, mc-service, Keycloak exchange are all REAL** (live
Ollama routing is T029). Uses an EXACT-resolving title (**"Coherence" 2013** → single TMDB result
→ matchConfidence=exact; "The Matrix" is ambiguous — T035). **DEPLOY half DONE.** Remaining for the
BROWSER add (T037): the dock **HITL approval UI does not exist** (renders text + render_movie_card
only — no `approval_request` interrupt render / approve-reject / resume wiring); build it
(CopilotKit `useInterrupt`/`useHumanInTheLoop` → BFF `resume+api.ts`) before T037 can go green.
Also: the **curator does not map the spoken collection name → `target_collection_name`** (extract
returns `collection`, curator drops it; the proof supplies it via AG-UI `state`) — wire that for a
real message-driven add. Start the MCP servers: movie-mcp `MC_MCP_PORT=8766`, web-api-mcp
`WEB_API_MCP_PORT=8765` (both left running this session).

**Gateway cut-over + subject-token bridge — DONE this session (TDD; follow-up (a) above).**
`src/agui_identity.py` `IdentityAwareAGUIAgent(LangGraphAGUIAgent)` overrides `prepare_stream`
(runs in the request task, where the ContextVar IS visible) to inject the captured subject token
+ decoded `user_id` into `config["configurable"]` BEFORE the graph stream is built — bridging the
ASGI-boundary ContextVar into the task-safe per-run channel the real nodes read. Pure helpers
`subject_user_id` (JWT `sub` decode, no verify) + `inject_subject_identity` (no-op without a
token → SC-005 unchanged). `gateway.build_app` now uses `IdentityAwareAGUIAgent`; `clone()`
(per-request) preserves the subclass via `type(self)`. **5 unit + 2 integration GREEN** — the
integration drives the FULL ASGI path via FastAPI `TestClient` (`Authorization: Bearer` →
`SubjectTokenMiddleware` → ContextVar → `prepare_stream` → `config["configurable"]` → a recording
node), plus the no-token no-injection case. **Cut-over is now CODE-COMPLETE:** with both MCP URLs
set, `create_app()` builds production nodes (earlier commit) AND feeds them the BFF subject token.
Remaining is the actual deploy (set `WEB_API_MCP_URL`+`MOVIE_MCP_URL` on the gateway, run
movie-mcp + web-api-mcp) + the web E2E (T037). **GOTCHA reminder:** the bridge relies on the
ContextVar being visible in `prepare_stream` (same request task) — it is; the nodes then read
`config`, NOT the ContextVar (which is unreliable in LangGraph's per-node tasks).

**Slice F (KEYSTONE) — design APPROVED + SDK-VALIDATED (mcp 1.27.2); F1 DONE, F2 next.**
Transport = **stateless streamable-HTTP** (`FastMCP(stateless_http=True, json_response=True)`); servers stay
containers (movie-mcp on backend-network, web-api-mcp outbound-only). Downscoped token flows **out-of-band**
(never an LLM-visible arg — SC-004): gateway client sets a per-call **dynamic `httpx.Auth`** (reads the token
from a ContextVar → `Authorization: Bearer`), passed via `streamablehttp_client(url, auth=...)` (confirmed it
forwards auth to the httpx client; per-transport `headers`/`auth` are deprecated, auth-on-client is the path).
movie-mcp captures the header via a **pure-ASGI `TokenCaptureMiddleware`** → ContextVar (no `get_http_headers()`
in this SDK; same pattern as the gateway's SubjectTokenMiddleware). Tool exposure = **manual MCP→LangChain
adapter** (no `langchain-mcp-adapters` — its static-header model can't carry a per-call token).

- **F1 DONE** (`fd9effb`): `movie-mcp/src/server.py` (5 tools) + `context.py` (ContextVar + middleware,
  `get_request_token` fail-closed) + `web-api-mcp/src/server.py` (2 tools, TMDB key from env, no middleware).
  Tested via the SDK's **in-memory client session**: movie-mcp 4 integration vs real mc-service + 4 middleware
  unit; web-api-mcp 2 integration vs real TMDB. mc-service/TMDB errors → MCP tool errors (isError, FR-018).
- **F2 NEXT** — gateway `src/tools/mcp_tools.py` adapter: per allowed tool, a LangChain tool whose coroutine
  composes `is_tool_allowed(agent,tool)` → `AgentToolRateLimiter.check` → (movie-mcp only)
  `acquire_downscoped_token` + set the client ContextVar → `call_tool` over streamable-HTTP → `guard_tool_output`
  → typed result / structured tool-error. Build arg schemas from the server's `list_tools().inputSchema`.
  **Unit-test the composition with an injected call**; the **real HTTP transport validates live in the
  curator/organizer integration tests (Slice C/T035, D/T036)** against a running movie-mcp/web-api-mcp
  (uvicorn `python -m src.server` or `--profile agents`). Seams ALL ready: `identity.acquire_downscoped_token`,
  `runtime_context.get_subject_token`, `agent_rate_limit.AgentToolRateLimiter`, `guardrails.guard_tool_output`.
  **Token-management refinements (from the 2026-06-07 review — see [[project_agent_token_propagation]]):**
  (1) **Bridge the subject token into LangGraph `config["configurable"]` at graph entry** and have the F2
  adapter read it from there — do NOT bet on the `runtime_context` ContextVar surviving across async task
  boundaries deep in the graph (we've been bitten twice by ContextVar-across-task fragility; `config` is the
  explicit, task-safe, non-checkpointed per-run channel). `get_subject_token()` stays the capture point at the
  ASGI boundary; the graph-entry node copies it into `config`. (2) Call `acquire_downscoped_token` **per tool
  call** (it re-checks the ≤60 s cache + re-exchanges on expiry) — never once per turn — so a long tool burst
  can't use an expired cached token. (3) The gateway→movie-mcp `_call_token` ContextVar is the one place a
  ContextVar is unambiguously safe (set synchronously in the same coroutine that awaits the httpx call).

Remaining slices: C curator, D organizer, E approval_gate, G render_movie_card(+client adapter),
H BFF resume route(+T028a), I supervisor routing, J authz parity(T045)+E2E(T037/T038).

### Foundational REMAINING
- ~~**T019** guardrails~~ **DONE this session** — see below.
- **T024a** write-tool resilience (retry/backoff + dead-letter → user-facing failure) — lands WITH the
  US1 MCP transport (needs a real write tool to exercise).
- ~~**T027 / T027a** rate/cost limits~~ **DONE this session** — see below.
- **T030 / T030a / T030b** observability/Vault/OTel (LangFuse, OpenSearch audit, Unleash kill-switch;
  Vault secret injection; Tempo/Prometheus/Loki) — several may be documented-deferral for the MVP.
- **T031 / T032** token-leak scan (SC-004) + golden-pair regression harness + CI cassette/replay.
- ~~**T033** finish~~ **DONE this session** (targets + wiring) — `deploy` added to all three `project.json`
  (Nx infers `dependsOn: build`), via root `compose --profile agents`; validated by `nx deploy web-api-mcp`
  end-to-end. Full `--profile agents` boot (19 GB model pull + external volumes) remains a documented
  one-time provisioning deferral (local loop uses `scripts/agent-gateway-local.ps1`).

Then **US1 (T034–T046)**: curator/organizer/approval_gate/write tools/resume route — this is where the
**T024 MCP transport** lands (wires `movie-mcp/server.py` + the in-process MCP client onto the seam).

### T024 — what was built (the identity chain)
The gateway-side downscoping is complete and real-Keycloak-verified:
- `src/tools/token_exchange.py` `reexchange_for_mc_service` — RFC 8693 via `agent-gateway`; NO `audience`
  param (the client's mappers stamp `aud=[movie-collection-manager, mc-service]`); TTL capped ≤60 s.
- `src/tools/opa.py` `authorize_exchange` — config-gated (skip+allow when `OPA_URL` unset; OPA is NOT
  deployed — env placeholder only), FAILS CLOSED when configured-but-erroring; sends only
  user_id/audience/agent_origin (no token).
- `src/runtime_context.py` `SubjectTokenMiddleware` + `get_subject_token()` — **pure ASGI** middleware
  (NOT Starlette `BaseHTTPMiddleware`, whose separate task breaks ContextVar propagation) captures the
  BFF `Authorization: Bearer` subject token per request; never checkpointed.
- `src/tools/identity.py` `acquire_downscoped_token` — **the seam US1 plugs into**: OPA-authorize →
  re-exchange → `(user,audience)` cache bounded by ≤60 s TTL. `authorize`/`exchange`/`cache` injected.
- Integration `tests/integration/test_token_reexchange.py` asserts `aud=[movie-collection-manager,
  mc-service]` + `agent_origin=true` + TTL ≤60 s vs live Keycloak (self-sufficient conftest fetches the
  agent-gateway secret via the BFF service account; skips without the live stack/T012).

### Keycloak token-exchange (v2) — TWO preconditions (durable; recurred in T024, will recur again)
Keycloak 26.x **standard token exchange** (`standard.token.exchange.enabled=true`) is filter-/
mapper-based, not free downscoping:
1. **Requester must be within the subject token's `aud`** — else `access_denied: "Client is not within
   the token audience"`. So the user's `movie-collection-manager` login token carries `agent-subject-token`
   in `aud` (audience mapper on the login client, applied by the T012 script).
2. **The downscope target must be an "available" audience on the requester** — else `invalid_request:
   "Requested audience not available"`. Satisfied by an `oidc-audience-mapper` for the target ON the
   requester client. We avoid the `audience` param entirely and let the mappers stamp the aud (also
   sidesteps precondition 2). Debug exchange failures by reading Keycloak's `error_description` directly —
   the BFF/agent modules redact the body (SC-004); use a throwaway probe.

### `aud=[movie-collection-manager, mc-service]` decision (user-approved 2026-06-07)
R3 wants `aud=mc-service` but **mc-service is unchanged in 012** and validates `aud⊇movie-collection-manager`
(`axum-keycloak-auth 0.8.3` → `jsonwebtoken set_audience`, non-empty-intersection). So the gateway-exchanged
token carries BOTH: `movie-collection-manager` (accepted by unchanged mc-service) + `mc-service` (R3 binding
signal). Provably additive — both the BFF (`aud.includes||azp`) and mc-service ignore extra audiences.

### Local env state (LEFT UP — ready to re-run)
- Containers UP: `agent-gateway`, `mcm-bff-dev`, `mc-service`, `keycloak-service`, `mcm-redis`, `mc-db`,
  keycloak-db, mailpit (`docker ps`). **The bff-dev image was rebuilt this session with the `resume+api.ts`
  route** (SC-005 re-verified 95/95 after). The gateway runs the **tool-free** graph (real US1 nodes not yet
  cut over — Slice G+J). `movie-mcp` / `web-api-mcp` are NOT running as servers (start over HTTP for T035/T036).
- **Keycloak T012 FULLY applied** (user re-ran the script this session): `agent-subject-token` +
  `agent-gateway` clients with all audience mappers + `agent_origin` claim + TTLs; login-client audience
  mapper present. OPA is NOT deployed (gated off).
- Creds: `frontend/mcm-app/.env.local` has `AGENT_SUBJECT_TOKEN_*`; `.env.docker` has `AGENT_GATEWAY_URL`.
  The agent re-exchange integration fetches the `agent-gateway` secret at runtime via the service account
  (no agent `.env.local` cred needed).

### Verify commands (all currently GREEN)

```bash
pnpm nx test movie-assistant                    # 125 unit (curator/organizer/approval/graph add-flow/F2/T024/T027a/T019)
pnpm nx lint movie-assistant                    # ruff + mypy clean
pnpm nx test:integration movie-assistant -- -k reexchange   # T024 re-exchange vs real Keycloak (1)
pnpm nx test:integration movie-mcp -- -k "writes or server"  # T043 writes + MCP server vs real mc-service (8)
pnpm nx test:integration web-api-mcp -- -k server            # web-api-mcp server vs real TMDB (2)
# T035 curator enrich vs real TMDB — needs a running web-api-mcp (skips if down):
#   cd mcp-servers/web-api-mcp && WEB_API_MCP_PORT=8765 TMDB_API_KEY=<key from .env.local> uv run python -m src.server
#   WEB_API_MCP_URL=http://127.0.0.1:8765/mcp pnpm nx test:integration movie-assistant -- -k enrich   # (3)
pnpm nx test mcm-app                            # 880 BFF unit (incl. agent-rate-limiter 7 + agent-resume 9)
pnpm nx test:integration mcm-app -- --testPathPattern=agent-rate-limiter   # T027 rate+cost vs real Redis (4)
BFF_BASE_URL=http://localhost:8082 pnpm nx test:integration mcm-app -- --testPathPattern="agent-route-auth|route-coverage"  # T028a run+resume 401/403 + coverage (9) — needs bff-dev container
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app            # SC-005 regression (95/95) — needs gateway+bff-dev up
```

See the kickoff at the bottom for next picks.

### T029 fixes (this session) — two real wiring bugs + one infra gotcha
1. **AG-UI `HttpAgent`, not `LangGraphHttpAgent`.** `run+api.ts` bound the runtime with
   `@copilotkit/runtime`'s `LangGraphHttpAgent` (LangGraph-**Platform** REST protocol → `/threads`,
   `/runs`) which **404s** against our gateway (a native **AG-UI** endpoint via `ag_ui_langgraph`).
   Fixed: `new HttpAgent({url})` from **`@ag-ui/client`** (added as a direct dep, pinned `0.0.53`
   to match what CopilotKit already resolves). Verified the gateway returns 200 + a clean complete
   AG-UI stream via a direct Node `HttpAgent.runAgent()` repro.
2. **`useSingleEndpoint` on `CopilotKitProvider`.** The client otherwise GETs runtime sub-paths
   (`${runtimeUrl}/info`, `/agents`); Expo Router is an **exact-path** file router (`run+api.ts` =
   one path) so those **404**. Single-endpoint sends everything to the one `run` POST.
3. **Metro OOMs on long sessions / the full 95-test suite.** Repeated `exit 134` = V8
   `Reached heap limit`, NOT a code bug (the dock E2E passes clean on a fresh Metro). Start Metro
   **fresh** for E2E; `NODE_OPTIONS=--max-old-space-size=8192` + `COPILOTKIT_TELEMETRY_DISABLED=true`
   help but the **full ×5-worker suite still exhausts heap mid-run** (~52/95 then the server dies).

### Findings A & B — BOTH ROOT-CAUSED AND FIXED (this session). Full dev-container regression now GREEN.

**RESULT: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → 95/95 passed (~1.0 min), deterministic,
Metro-free.** This is SC-005/T066 green (includes `assistant.spec` 2/2 in-container AND the previously
failing `movies.spec`). The earlier diagnoses in the prior handoff were both WRONG — corrected below.

**Finding A — root cause was NOT network/`host.docker.internal`. It was a prod-bundle `import.meta` crash.**
The exported `@expo/server` runtime leaves `globalThis.__ExpoImportMetaRegistry` undefined. Metro rewrites
`import.meta.url` in bundled deps → `globalThis.__ExpoImportMetaRegistry.url`; the Metro **dev** server
populates that registry but the **prod export does not**. So when CopilotKit's runtime lazily `require`s its
adapter at request time, that module's top-level `createRequire(import.meta.url)` threw
`TypeError: Cannot read properties of undefined (reading 'url')` — **asynchronously inside the streaming
`respond` pipeline**, so the route's try/catch never caught it and the client just hung 90 s. The gateway
logged zero POSTs because the BFF crashed before forwarding. Works on Metro (dev bundle), hung in-container
(prod bundle) — exactly the observed split. **Fix (two parts):**
1. **Containerize the gateway on `backend-network`** + set `AGENT_GATEWAY_URL=http://agent-gateway:8000`
   in `frontend/mcm-app/.env.docker` (it was unset → defaulted to the container's OWN `localhost:8123`
   loopback). The BFF now reaches the gateway by service DNS; verified bff-dev→gateway `/health` 200.
2. **Polyfill `globalThis.__ExpoImportMetaRegistry` in `frontend/mcm-app/server.js`** (a flat
   `{ url: pathToFileURL(__filename).href }`, set before `createRequestHandler` loads the bundle — faithful
   to Metro's single shared registry; lets `createRequire` resolve the deployed `node_modules`).
   Verified: gateway logged `POST /agent/movie-assistant 200 OK`, zero `url` TypeErrors.
- Also fixed the **gateway Dockerfile**: added `build-essential` to the build stage (`nemoguardrails → annoy`
  has no cp313 wheel → compiles from source → needs `g++`).

**Finding B — root cause was NOT "session invalid / login screen". It was the dock overlapping the FAB.**
Reproduced cleanly: the page snapshot showed a fully **authenticated** screen (movie list + "Add movie"
FAB + "Assistant" toggle, NO login screen). The real failure: `page.click('collection-screen-add-movie')`
→ `<div data-testid="assistant-dock"> subtree intercepts pointer events` → retried 170× → 90 s timeout.
The dock toggle was `position:absolute, right:16, bottom:16` — directly on top of the bottom-right add-movie
FAB — so every `movies.spec` test failed in `beforeEach → clickAddMovie`. This is a **real T029
additive-only regression (SC-005)**, exactly the snag the prior handoff *warned* about ("dock overlay is
bottom-right absolute — watch for overlapping existing tap targets"). It is NOT a Keycloak/session/Redis
issue (KC_HOSTNAME pin verified intact; global-setup login + seeding succeeded every run).
**Fix:** moved the dock to **bottom-left** (`assistant-dock.tsx` styles only — every existing primary action
in this app is a bottom-right FAB; bottom-left is unoccupied app-wide; container already `pointerEvents="box-none"`).
Do NOT chase the "delete `.auth/user.json`" red herring — global-setup overwrites it with a fresh login every run.

### SC-005/T066 — CLOSED (dev-container). Notes for next time
- The **dev-container path is the deterministic regression** (95/95 ~1 min, 5 workers across files, no Metro
  JIT/OOM). Use it, not Metro, for the additivity gate. The Metro full-suite OOM (handoff T029 #3) is a
  Metro-only memory issue and is now moot for the gate.
- To reproduce: bring up the gateway (`pwsh scripts/agent-gateway-local.ps1 -Build`), rebuild+recreate the
  BFF container (`pnpm nx docker-build mcm-app` → `docker compose --profile bff-dev up -d mcm-bff-dev`),
  then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`.

### Local env left by this session (LEFT UP — ready to re-run)
- **`agent-gateway` container UP** on `backend-network` (host Ollama via `host.docker.internal`, no host
  port — constitution boundary preserved). `mcm-bff-dev` container UP (rebuilt with both fixes). Shared
  stack (Keycloak/Redis/Mongo/mc-service) UP.
- Re-run the deterministic regression any time: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`.
- New committed artifacts: `frontend/mcm-app/server.js` (registry polyfill), `agents/movie-assistant/Dockerfile`
  (`build-essential`), `frontend/mcm-app/.env.docker.example` + `.env.docker` (`AGENT_GATEWAY_URL`),
  `frontend/mcm-app/src/components/agent/assistant-dock.tsx` (bottom-left), `scripts/agent-gateway-local.ps1`.
- Teardown when done: `pwsh scripts/agent-gateway-local.ps1 -Down`; `docker rm -sf mcm-mcm-bff-dev-1`.
  (Metro is untouched — still the default dev inner loop.)

---

## (historical) THE original remaining piece — T029 final: live web E2E  ✅ DONE

### Commits (newest first)
- `chore(012)` commit pnpm-lock
- `f9a493c` BFF agent route → CopilotKit runtime endpoint (T029 server side)
- `08f739c` T029 CopilotKit overlay (client) + corrected BFF-runtime finding
- `16b3dd9` T029 spike (gateway emits AG-UI natively)
- `0f004ec` BFF agent AG-UI route + auth-guard (T028/T028a)
- `7504d81` Foundational agent core + AG-UI gateway (TDD)
- (earlier) Phase-1 scaffold + deferred setup (committed by the user)

### tasks.md done (`[X]`): T001–T014, T015, T016, T017, T018, T020, T028, T028a
### Verified green
- `pnpm nx test movie-assistant` → 41 unit · `pnpm nx test:integration movie-assistant` → 5 (gateway boot + real-graph + build_chat_model vs Ollama)
- `pnpm nx test mcm-app` → **837 unit** · `pnpm nx test:integration mcm-app -- --testPathPattern=agent-route-auth` → T028a 2/2 (real BFF + Keycloak) · route-coverage 5/5
- `pnpm exec tsc --noEmit` (mcm-app) → clean
- End-to-end smoke: real Ollama (`qwen2.5`) routes "organize"→organizer, out-of-domain→decline through the live gateway emitting native AG-UI.

## (historical — ✅ DONE) THE remaining piece — T029 final: live web E2E

Goal: open the dock on web, send a message, assert the AG-UI response renders. This also
validates **CopilotKit rendering on real react-native-web DOM** (the unit render test used
react-test-renderer, NOT a browser — unproven) and the runtime `/info` + single-endpoint handshake.

### Bring up the stack (4 things)
```powershell
# 1. Ollama (installed; models pulled) — confirm running:
& "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" list   # expect qwen2.5 + qwen2.5:32b

# 2. Agent Gateway (FastAPI + ag_ui_langgraph, real graph):
cd agents/movie-assistant ; uv run uvicorn src.gateway:create_app --factory --host 127.0.0.1 --port 8123
#   verify: curl http://127.0.0.1:8123/health  → {"status":"ok"}

# 3. Keycloak/Redis/mc-service already run as containers (docker compose --profile app --profile keycloak up -d if not)

# 4. Metro/BFF: cd frontend/mcm-app ; pnpm exec expo start --port 8081
```

### Write + run the E2E
- New spec: `frontend/mcm-app/tests/e2e/web/assistant.spec.ts` — login via the existing Playwright global setup (storageState), open `testID=assistant-dock-toggle`, type into `assistant-dock-input`, tap `assistant-dock-send`, assert an `assistant-msg-assistant` row appears (text contains the stub "organizer:"/"curator:"/decline copy for now).
- Run: `pnpm nx e2e mcm-app -- tests/e2e/web/assistant.spec.ts`
- Then the **existing E2E regression** (SC-005, T066): `pnpm nx e2e mcm-app` must stay green — the auth-gated dock overlay must not disturb existing flows.

### Likely snags to expect (not yet resolved)
- **CopilotKit on react-native-web**: rendering + SSE transport in a real browser is unproven. May need RNW-specific shims or CopilotKit web config.
- **Runtime handshake**: the RN client GETs runtime `/info` then POSTs. The BFF route exports GET+POST (both auth-gated) delegating to `copilotRuntimeNextJSAppRouterEndpoint`. May need `useSingleEndpoint` on `CopilotKitProvider` (in `src/hooks/use-assistant.tsx`) — confirm against client behavior.
- The dock overlay is bottom-right absolute — watch for it overlapping existing E2E tap targets.

## Key architecture findings (don't re-derive)
- **MCP tools are CODE-ORCHESTRATED, not LLM-tool-called (decided 2026-06-07, US1 Slice C).**
  Specialist nodes call MCP tools in deterministic code via the single `tools/mcp_tools.invoke_tool`
  choke point; the **LLM only produces typed intent** (curator: entity extraction; organizer/US2: a
  structured operation **plan**) + phrasing — it never picks MCP tools or generates their args. ⇒ **No
  `build_agent_tools`/`StructuredTool`/agent-executor layer** (don't build one). Writes execute ONLY from a
  validated candidate + the **user-approved** `Proposal` with **deterministic** idempotency keys, so an LLM
  hallucination/injection can't forge a write payload or break at-most-once. **Exception:** generative-UI
  (`render_*`, `navigate_*`) stay LLM-emitted AG-UI tool calls rendered client-side (CopilotKit
  `useRenderTool`). **Apply the SAME pattern to the organizer (Slice D) + US2** (LLM plans via structured
  output → code orchestrates writes through `invoke_tool`). Extraction/plan is still a model call (injection
  surface) → guardrails (T019) + the approval gate stay load-bearing. (Plan.md "Technical approach" updated.)
- **Gateway = FastAPI + `ag_ui_langgraph.add_langgraph_fastapi_endpoint` + `copilotkit.LangGraphAGUIAgent`** wrapping the compiled graph; emits AG-UI natively. Entry: `agents/movie-assistant/src/gateway.py` `create_app()`. NOT a `langgraph-api` CLI.
- **BFF route = CopilotKit RUNTIME endpoint** (`bff-api/agent/run+api.ts`): `CopilotRuntime` + `ExperimentalEmptyAdapter` + **`HttpAgent` from `@ag-ui/client`** (`{url: <gateway>/agent/movie-assistant}`), behind requireAuth→requireMcUser. The RN client needs a runtime endpoint (`runtimeUrl`), NOT raw AG-UI (research R6); this is the framework's standard bridge, compliant (not bespoke translation). **NOTE (fixed in 313c5e8):** must be the AG-UI `HttpAgent`, NOT `LangGraphHttpAgent` (LangGraph-Platform protocol → 404 vs our AG-UI gateway). Client provider needs **`useSingleEndpoint`** (Expo Router exact-path vs CopilotKit `/info` sub-path).
- **`@copilotkit/runtime` eager-imports its OpenAI adapter** → `openai` + `@ai-sdk/openai` are installed as eager-import satisfiers (unused; we use the empty adapter + LangGraph). Other adapters lazy-load. Follow-up: drop these if a runtime version lazy-loads adapters.
- **PROD-BUNDLE `import.meta` GOTCHA (bit us as Finding A):** the exported `@expo/server` runtime does NOT populate `globalThis.__ExpoImportMetaRegistry`, but Metro rewrites bundled deps' `import.meta.url` → `globalThis.__ExpoImportMetaRegistry.url`. Any bundled dep doing `createRequire(import.meta.url)` (CopilotKit runtime's lazy adapter does) crashes ONLY in the container/prod export, NOT under Metro dev — and the throw is async inside the SSE `respond` pipeline so the route try/catch misses it and the client just hangs. Mitigated by a registry polyfill in `frontend/mcm-app/server.js`. **If you add other ESM-interop server deps and they hang/500 only in-container, suspect this first.** A future `@expo/server` may fix it natively (then the polyfill is a harmless no-op via the `if (!…)` guard).
- **jest transformIgnorePatterns** extended to transform `@copilotkit`/`@ag-ui`/`uuid` (ESM) — see `frontend/mcm-app/package.json`.
- **Model provider is environment-scoped** (research R1, revised 2026-06-07): **Ollama for dev/test/iteration** (`supervisor`→qwen2.5, specialists→qwen2.5:32b; host gateway `localhost:11434`); **Anthropic Claude for the golden-pair suite + production** (`MODEL_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`: supervisor→claude-haiku-4-5, specialists→claude-sonnet-4-6); escalation always Opus. The golden-pair gate runs on Claude (the shipped model). Switch = env only — `src/models.py` `select_model_config` (pure) + `build_chat_model` already support both. (Was: Ollama-default-everywhere + Claude-fallback.)
- **Tooling gotcha**: running the same `pnpm exec jest <file>` repeatedly returns a CACHED (stale) result via the RTK wrapper. Use `pnpm nx test mcm-app --skip-nx-cache [-- --testPathPattern=…]` for fresh runs.

## Gated / deferred
- **OPA not deployed** — only `OPA_URL` env placeholder; no compose service/policy. `opa.authorize_exchange` is config-gated (skip+allow when unset). Stand up an OPA container + Rego policy before enforcement is meaningful (or keep gated for the MVP with a deferral note).
- **T033a** Android APK rebuild (CopilotKit → react-native-reanimated, native) — required before any **mobile** E2E; use the CI `android-apk` workflow (Windows CMAKE wall). T038/T049/T056 mobile flows gated on it.
- **Heavy guardrails** (`nemoguardrails`/`guardrails-ai`, T019) — install on py3.13 proven; not yet wired.
- **Full `--profile agents` boot** (T033) — needs `ollama-models` + `agent-db-data` external volumes + ~19 GB model pull; the local loop uses `scripts/agent-gateway-local.ps1` (host Ollama, MemorySaver) instead.
- **Framework DEBUG logging leaks headers (SC-004 carry-over for T030/T030b — added session 8 with T031):** the T031 token-leak scan (`-m leak_scan`) proves *our* source never logs a token, and `movie-mcp`/`web-api-mcp` have **no app logging at all** (leak-safe but also no audit trail). It can NOT catch **framework** logging: uvicorn/httpx/the MCP server at `DEBUG`/trace emit full request headers, incl. the gateway→movie-mcp `Authorization: Bearer <downscoped>` and BFF→gateway subject-token hops. When wiring observability (T030/T030b): pin httpx/`httpcore`/`uvicorn.access` ≥ INFO (never log headers) in deployed gateway + MCP servers; any logging added to the MCP servers must redact `Authorization`/token (mirror the BFF logger); re-run `-m leak_scan` after adding any log statement (it scans all 3 src trees).

## Suggested kickoff for the fresh session
> "Continue feature 012. Read `specs/012-multi-agent-mvp/HANDOFF.md` (Where-we-are first), then `tasks.md`. **US1 is COMPLETE — web (T037) AND mobile (T038) E2E both GREEN**; the full add pipeline runs through the real gateway (CopilotKit dock → BFF /run → production-node gateway → Ollama → TMDB enrich → approval gate → approve → resume → movie-mcp → mc-service), with T024a resilience (retry/backoff + dead-letter; 409→skipped_duplicate), SC-002 audit on /run, and SC-005 additivity green (95 passed/2 skipped). **The LLM provider is now env-scoped (R1): Ollama for dev/test, Anthropic Claude for the golden-pair suite + production** (`MODEL_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`) — config-only, `src/models.py` already supports it. **No remaining US1 items.** Pick the next work: **Polish (Phase 6)** is the recommended track — e.g. **T032/T063 golden-pair harness** (now Claude-backed — the deployment gate per the constitution; CI replays cassettes of only the LLM, the live gate runs Claude), T060 out-of-domain decline (live, guardrails already built), T061 kill-switch, T062 proposal expiry, T031/T064 token-leak scan (SC-004), T030/T030a/T030b observability/Vault/OTel (several are documented MVP deferrals), T065 docs. **US2/US3** are separate stories (US2 mobile flows T049/T056 will reuse the CopilotKit-RN fixes — [[project_copilotkit_react_native]]). Use **TDD** (RED→GREEN; real deps for integration — bring up the stack per 'How to bring the agent stack up'). Honor the **code-orchestration decision** (LLM only extracts/plans; code drives MCP tools) and the durable findings in memory ([[project_copilotkit_react_native]], [[project_mcp_transport_exceptiongroup]], [[project_langgraph_config_injection_future_annotations]], [[project_agui_interrupt_value_json_string]], [[project_keycloak_token_exchange_v2]]). The agent stack may be torn down — bring it up via the HANDOFF commands."
