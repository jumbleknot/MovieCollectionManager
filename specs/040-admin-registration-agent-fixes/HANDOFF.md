# Feature 040 — Session Handoff

> ## ✅ FEATURE COMPLETE (2026-07-16) — 56/58 tasks done, 2 justified N/A, 0 open
>
> All four user stories are implemented and verified against the **live stack on fresh images**
> (agent gateway on Claude, `MODEL_PROVIDER=anthropic`). Final regression:
>
> | Suite | Result |
> |---|---|
> | agent unit + golden replay | **852/852** + **41/41** |
> | spreadsheet-mcp unit | **34/34** |
> | mc-service lib (no backend change needed — T003) | **148/148** |
> | mcm-app lint + unit | clean + **1143/1143** |
> | mcm-app integration | **110 passed / 3 skipped** |
> | web E2E (full) | **136 passed / 33 skipped** |
> | agent web E2E | T007 **2/2** · T032 **2/2** · T045 **1/1** |
> | mobile flows | authored + registered in CI (`ci-mobile-agent-flows.sh`) — run on the CI emulator by design |
>
> **Four real defects the regression caught (all fixed):** a DS-compliance violation in the US3 admin
> screen (would have failed CI); the US3 routes unmapped in the route-coverage gate (FR-024/SC-012);
> `gen-dev-env.mjs` minting `AGENT_CONFIG_ENC_KEY` as hex when the BFF decodes base64 (broke every
> agent-config save → no dock; latent since 039, and the same footgun was mis-hinted in
> `compose.prod.yaml` — would have 500'd in PROD); and a stale `test_reimport_real_sample` assertion.
>
> **Two justified N/A:** T033 (mobile admin-registration — needs an mc-admin identity a Maestro flow
> cannot seed; see the Platform Parity Table) and T057 (`rtk gain` — RTK's rewrite hook doesn't
> intercept in this dev container, so there's no representative data).
>
> **Environment learnings are now documented** — see `docs/runbooks/devcontainer.md`
> ("Running the stacks + tests in THIS container") and the DinD callout in `CLAUDE.md`. Key ones:
> Ollama is unreachable **from the gateway** (so Claude is the only in-container model path);
> `pnpm nx e2e` can't run here (chromium uninstallable — use the Playwright image with
> `--network host`); agent E2E needs `E2E_AGENT_PROVIDER=anthropic` + the `compose.agent-e2e.yaml`
> limit override + **one spec file per invocation**; integration needs `BFF_BASE_URL=:8082` +
> `KEYCLOAK_SERVICE_CLIENT_SECRET` + `AGENT_CONFIG_ENC_KEY`; and when published ports look
> unreachable, **re-apply `init-firewall.sh`** — never widen `ALLOWED_DOMAINS`.
>
> **Remaining before merge:** open the PR to the **forge** `origin` (not the GitHub mirror) and let
> `guardrails` + `app-ci` run — the mobile flows and the containerized agent E2E get their real
> exercise there. Tear the local agent stack down with `node scripts/agent-stack.mjs --down`.


**Branch**: `040-admin-registration-agent-fixes` · **Status**: complete, tree clean, ready for PR to the forge `origin`.

Read first: [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md) (every task carries its evidence) · [research.md](./research.md).
Repo rules: [CLAUDE.md](../../CLAUDE.md) · [docs/agent-layer.md](../../docs/agent-layer.md) · [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md) · [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md).

## What shipped (by story)

| Story | Change | Verified by |
|---|---|---|
| **US1** — navigate to a collection | `navigate_stage` + bare stage-anchored buttons in `navigator._clarify`; classifier routes `"navigate to <X> collection"` → `navigate` (**golden surface** — re-recorded, FR-023 approval recorded) | test_navigator/test_routing; golden 41/41; `agent-navigate-collection.spec.ts` 2/2; mobile flow in CI |
| **US2** — large import | supervisor re-asks an unparsed answer; import node degrades gracefully (always a message); `skip_rate_limit` on dedup reads; **T024** parsed-sheet stashed by handle (`import:parsed:<handle>`, TTL refreshed per read) instead of re-checkpointing the whole dataset | test_import_* (incl. the T019 multi-turn FR-016 guard); `test_import_flow.py` 4/4 live; spreadsheet-mcp store tests |
| **US3** — admin disables self-registration | `app_settings` single-doc store; `bff-api/admin/settings` (mc-admin, audited); public `auth/registration-status`; `register+api` fail-closed enforcement; admin screen + login-screen hide | 16 BFF unit; `admin-registration.integration.test.ts` 3/3 (real Keycloak+Mongo); `admin-registration.spec.ts` 2/2 |
| **US4** — TMDB add ownership | `awaiting_ownership` stage (Yes/No before the add); `to_movie_payload(owned=False)` default threaded via `ProposalItem.owned`; `approval_gate` emits `navigate_to_movie` | ~30 unit add-flow tests; `test_add_flow.py` 4/4 live; `agent-add-ownership.spec.ts` 1/1 (owned=false + detail nav); mobile flow in CI |

**No mc-service change was needed** (T003) — it already honors `owned`; only the agent passes the boolean.

## Durable gotchas worth keeping

- **`render_selection` → `selection-options`** (pick/control groups) vs **`render_disambiguation` → `disambiguation-options`** (curator movie candidates). The US1 collection buttons AND the US4 ownership Yes/No are BOTH `selection-options`; ownership is kind `ownership` ⇒ the **`control`** group. Mixing these up broke both new specs initially. Documented in [docs/agent-layer.md](../../docs/agent-layer.md).
- **The spreadsheet upload store is single-use** (`read_upload` deletes on first read) — which is why T024 had to ADD a parsed-data store rather than checkpoint a re-parse key (research D3.4).
- **`_match_collection` matches a collection NAME as a substring of the USER'S TEXT** (not the reverse) — that's why "my E2E collection" disambiguates rather than resolving.
- **Running anything in the DinD dev container**: see [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md) → *"Running the stacks + tests in THIS container"*, and the callout in CLAUDE.md. (Claude — not Ollama — is the only in-container model path; Playwright must run in its own image with `--network host`; agent E2E needs the limit override + one spec file per invocation.)

## Follow-ups (NOT blockers)

- **`test_reimport_real_sample`** — the assertion was corrected to tolerate the sample's 3 intentional "Expected Import Failure" rows (the import correctly partial-succeeds: ~100 applied, 1 invalid row isolated). If the product should instead reject `owned=false + ownedMedia` at PLAN time (skip, not fail), that's a separate product decision.
- **Agent integration isn't run in CI** (`agent-gates.yml` = lint + unit + golden replay only), which is why the stale reimport assertion went unnoticed for so long. Worth considering.
- **T057 `rtk gain`** — re-check on a workstation session where RTK's rewrite hook is active.
