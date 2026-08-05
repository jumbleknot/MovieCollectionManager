# Handoff — 047 PR B (US1 navigate, US3 large import)

**Date**: 2026-08-04 · **PR A is MERGED** (PR #135 — all 10 required contexts green)

Read [plan.md](./plan.md) then [tasks.md](./tasks.md) first. This file holds only what those cannot
tell you: what PR A changed under you, what the two gating research questions now look like, and
the traps that cost real time in the PR A session.

The original [HANDOFF.md](./HANDOFF.md) is still accurate for the feature as a whole; its
"do not rebuild these" list in particular still applies.

---

## Start here

**T001 and T002 still gate everything. Neither is answered.**

| Task | Question | Status |
|---|---|---|
| **T001** | What actually emits `"Sorry — I couldn't complete that just now."` for a navigate request? | **ANSWERED 2026-08-04 — Phase 3 unblocked.** `_degrade_node`, reachable only via the supervisor's model call. The specialist-model cause below is **eliminated for navigate**; H1 is downstream of H3; the pagination defect is a *different* bug with a *different* symptom. [RQ-1 evidence](./research.md#rq-1-evidence). |
| **T002** | Does `@copilotkit/react-native`'s `useAgent` expose agent state / `STATE_DELTA`? | **ANSWERED 2026-08-05 — Option A viable, FR-014a stands.** But three things about the question were wrong: the transport is `STATE_SNAPSHOT` (`StateDeltaEvent` is imported and never constructed), a counter not declared on `GraphState` is dropped **silently**, and super-step snapshots fire per NODE so an apply loop needs `manually_emit_state`. [RQ-2 evidence](./research.md#rq-2-evidence). |

PR A did not touch either. **Both have since been answered** (2026-08-04 and 2026-08-05), each by
measurement with a re-runnable probe in [evidence/](./evidence/). Phase 2b (FR-039), Phase 3 (US1)
and Phase 5 (US3) are all implemented.

---

## NEW EVIDENCE FOR T001 — a cause the plan's hypothesis list does not include

> **Followed up 2026-08-04 and this is now settled — read the outcome before acting on the section
> below.** Adding this as H4 was the right call and it was indeed the cheapest to eliminate: a
> navigate turn makes **exactly one** model call, the supervisor's, so `SPECIALIST_MODEL` is not on
> that path at all. It stays live for **add** (where PR A reproduced it) and for any deployed
> environment — under 018 the model is per-user, and `runtime_env` keeps the gateway's model pins
> whenever the member's provider matches the base env's, so the gateway's pinned id can be applied
> to a member's own Ollama that never had it installed. Full verdict in
> [RQ-1](./research.md#rq-1-evidence).

The plan lists three candidates for the generic reply: an open circuit breaker, a classifier
exception, or misclassification into a model-backed node. **There is a fourth, and it was
reproduced in the PR A session:**

> **A model-provider 404 from a missing/misconfigured specialist model.**

The gateway makes **two** model calls on an add turn — `SUPERVISOR_MODEL` to classify, then
`SPECIALIST_MODEL` for the curator. Ollama answers an uninstalled model with **404**, the
specialist node degrades, and the member sees exactly that sentence with nothing naming the cause.

**The signature, in the gateway log:**

```
POST http://…:11434/api/chat  "HTTP/1.1 200 OK"     ← supervisor, fine
POST http://…:11434/api/chat  "HTTP/1.1 404 Not Found"  ← specialist, missing model
```

How it was found: five `agent-add-ownership` E2E tests failed with the generic reply. The control —
the **pre-existing** 040 test, untouched by the feature — failed identically, which is what ruled
out a regression. Pointing `SPECIALIST_MODEL` at an installed model made the control pass in 12.8 s
and all five pass in 50.4 s.

**Rule this out before attributing the member's report to pagination or a breaker.** It is cheap to
check and it produces a symptom indistinguishable from the other three at the UI.

`scripts/agent-stack.mjs` now fails loudly on this (see Environment below), so it should not recur
locally — but the member's report came from a deployed environment, where the same class of
misconfiguration is possible.

---

## What PR A changed under you

### The add flow is now a four-stage chain

`awaiting_ownership` → `awaiting_media` → `awaiting_ripped` → `awaiting_rip_quality` → proposal.
Relevant to **US3** because the write proposal it builds goes through the **same approval gate**
US3 rewrites for bounded-concurrency apply. `apply_proposal` now receives items carrying
`owned_media` / `ripped` / `rip_quality`; keep them threaded when you touch that loop.

### Two patterns worth copying rather than re-deriving

1. **A stage guard needs BOTH `graph.py` and `curator.py`.** `graph.py` keeps the turn in the flow;
   `curator.py` must ALSO pass through for that stage, or entity extraction runs on a bare reply,
   finds no film, clears `candidate`, and drops the member to *"What movie would you like me to
   look up?"* mid-flow. 040 added the passthrough for one stage; 047 added three more and had to
   widen it. If US3 adds a stage, update both.

2. **An ANSWER to a pending question is never a new command.** `graph.py`'s ownership guard now
   checks whether the reply resolves against the pending question *before* consulting the
   classified intent, using the same pure resolvers the node will use. This was a real bug: a
   prose-like reply (`"Selected: none"`) could classify as `query`/`search` and silently discard
   the member's in-progress add. **It is provider-dependent** — it passed on local Ollama and
   failed on Anthropic in CI. The import guard already had this shape; the navigate guard
   (`navigate_stage`) does NOT, and US1 touches it. Worth a look.

### Shared resolver

`resolve_option` now does trim+casefold equality **before** the substring step. US1's navigate
resolution inherits this. The Hypothesis invariants for it live in
`tests/unit/test_resolvers_properties.py` — note the `assume()` guards, which encode the premise
rather than assuming `.upper()` round-trips (it does not, for the Turkish dotless i).

---

## Test-scope traps — the theme of the PR A session

Four separate false-greens. Three were fixed in the tooling; the fourth caught the session itself.

### 1. `pnpm nx e2e mcm-app` skips every agent spec

All ten `agent-*.spec.ts` gate on `E2E_AGENT_PRODUCTION=1`. Without the containerized stack they
skip and the run reports green. **Set `E2E_REQUIRE_AGENT_STACK=1`** on any pre-PR run — the shared
gate (`tests/e2e/web/setup/agent-stack-gate.ts`, added by PR A) then fails with the bring-up
commands instead of skipping.

### 2. A skipped integration test reads as a pass — THE ONE THAT BIT US

The agent tier was run with movie-mcp and spreadsheet-mcp up but **web-api-mcp down**:
`89 passed, 17 skipped`, reported as verification. One of those 17 was `test_gateway_add_e2e.py`,
which the feature had genuinely broken. It reached CI and failed `app-e2e`.

With all servers up the same suite is `95 passed, 11 skipped`.

> **Always run the integration tiers with `MCM_REQUIRE_LIVE_STACK=1`, and watch the SKIP COUNT.**
> If it moves, something stopped being tested. Verified: the flag converts that exact skip into a
> failure naming the unreachable server.

### 3. A node-level test passing does not mean the graph-level path works

The zero-rip-quality path was "verified" by calling the organizer node directly. It passed. The
same path **failed through the full graph**, because the supervisor guard escaped first. If a
change touches routing, drive `build_graph(...)`, not the node.

### 4. The SAST gate passes vacuously in the dev container

`security/sast/reports/findings.json` ends up **empty** because semgrep cannot reach its rule
registry through the egress allowlist (fail-closed; the reason is recorded in
`scanners[].error`). Running `check-sast-findings.mjs` locally then passes on zero findings and
proves nothing. To test allowlist entries, feed the gate a **synthetic** `findings.json` with the
exact scanner/id/location triples, and include a negative control.

---

## Environment — what works, what cannot

| Thing | Status |
|---|---|
| Agent stack bring-up | `KEYCLOAK_SERVICE_CLIENT_SECRET=$(grep '^KEYCLOAK_SERVICE_CLIENT_SECRET=' infrastructure-as-code/docker/stacks/auth.env \| cut -d= -f2-) node scripts/agent-stack.mjs` — the export is required or it dies with `service-account admin token failed (401)` |
| Ollama models | The gateway resolves `host.docker.internal` to the **nested `dev-ollama`**, which has `qwen2.5` but **not** the default `SPECIALIST_MODEL=qwen2.5:32b`. Use `SPECIALIST_MODEL=qwen2.5 node scripts/agent-stack.mjs`. The script now checks both models against the same endpoint and exits non-zero. |
| `scripts/agent-e2e.mjs` | **Does not work in the dev container** — it shells to `nx e2e`, which needs host chromium (uninstallable here). **This is a fact about the nx target, NOT about E2E: Playwright itself runs fine here** in the official image — see the row below and the recipe in [devcontainer.md](../../docs/runbooks/devcontainer.md). A later session read this row as "E2E is impossible here" and wrote off work as unverifiable for several commits. |
| Playwright | Must run in the official image, **with `--user "$(id -u):$(id -g)" -e HOME=/tmp`** or its artifacts land root-owned and block the next run. |
| Client changes | The Expo web bundle is baked into the **BFF image** — `pnpm nx run mcm-app:build` + container recreate, or a containerized E2E validates the previous bundle. |
| Mobile E2E (T099) | **Cannot run here by design** — the release APK needs Gradle plugin-graph egress the firewall deliberately blocks. CI owns it. |
| `.env.local` | Does not exist on the devcontainer path; secrets come from `stacks/auth.env`. See devcontainer.md §"Integration tests". |

`docs/runbooks/e2e-testing.md` and `docs/runbooks/devcontainer.md` were updated with all of the
above during PR A.

---

## Maestro limitation that will affect US3 if it adds mobile flows

Two instances of the same generative-UI component in one transcript are **not addressable**.
`tapOn` takes the first hierarchy match, and `enabled:` does not disambiguate a component disabled
via React state (`accessibilityState` does not reach the Android view's enabled flag).

US4's rip-quality toggle list is `N/A` on mobile for this reason — see the parity-table note in
[tasks.md](./tasks.md). **The clean fix, if US3 needs it:** give the component a question-scoped
testID (the organizer already emits distinct tool ids). Not done in PR A because it changes the
tool contract and mobile cannot be verified locally.

Also: both blocks of a flow file share one `${COLLECTION_NAME}`. Adding the same film to the same
collection twice hits mc-service's `(title, year)` uniqueness, the write is skipped, no `movieId`
comes back, and `navigate_to_movie` never fires — the approval card appears and the detail screen
never arrives.

---

## Ambient obligation, not PR B's but do not let it lapse

Six SCA advisories are allowlisted in `security/sast/allowlist.yaml` and **expire 2026-08-31**,
after which the gate re-blocks:

- `fast-uri`, `ip-address` — pnpm-workspace override bumps (one-line, same shape as the
  `brace-expansion` bump already there; `fast-uri` already has a `<3.1.4` override this advisory
  bypasses)
- `aiohttp` ×3 — `uv.lock` regeneration across `agents/movie-assistant` and the MCP servers
- `cryptography` — same, but it sits in the **RFC 8693 token-exchange path** and wants real review

They were accepted as **risk**, not assessed as not-exploitable, and the justifications say so.

---

## Before opening PR B

Unchanged from [HANDOFF.md](./HANDOFF.md), plus:

- Golden suite must pass **without re-recording** — PR A confirmed the cassettes are unchanged, so
  a needed re-record means something touched a prompt or classification path.
- `pnpm nx preflight infrastructure-as-code` before pushing.
- PR head must be a **real branch** — `git push origin HEAD:<branch>` then `POST …/pulls` with the
  `git credential fill` credential. Never AGit.
- `pnpm nx wiki-update` is **paid** and LLM-backed; `wiki-maintain.yml` triggers on push to main,
  so the bundle regenerates post-merge. `okf-lint` is free and should pass.
