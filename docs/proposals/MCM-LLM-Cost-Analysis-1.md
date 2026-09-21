# Cost-effective LLM options for the MCM ecosystem agents

Date: 2026-09-20 · Scope: read-only review of `E:\Programming\VSCode\MovieCollectionManager` plus the Anthropic console usage/cost export for 2026-08-22 → 2026-09-20 · Out of scope by request: Claude Code as the coding assistant, Ollama for local agent testing.

---

> ## ⚠️ CORRECTIONS — read before acting on anything below
>
> **Added 2026-09-21**, while turning Phase 1 into [`specs/075-llm-cost-phase-1/`](../../specs/075-llm-cost-phase-1/spec.md). This document was written from a **read-only** review, and several of its premises do not survive contact with the running code. **One is a blocker that would have failed Phase 1 on its first model call.** The measured spend in §0 is sound and remains the basis for the work — these corrections are about the *recommendations*, not the numbers.
>
> Each was verified by executing something, not by reading. Full evidence in [`specs/075-llm-cost-phase-1/research.md`](../../specs/075-llm-cost-phase-1/research.md); the R-numbers are its findings.
>
> ### 🔴 BLOCKER — `claude-sonnet-5` rejects `temperature`, so the headline recommendation could not have worked (R13)
>
> `models.py`'s `_build_real_chat_model` passes `temperature=spec.temperature` unconditionally, and `ModelSpec` always carries `0.0`. Measured, one live call per model:
>
> | Model | `temperature=0.0` |
> |---|---|
> | `claude-haiku-4-5` | accepted |
> | `claude-sonnet-4-6` | accepted |
> | `claude-opus-4-6` | accepted |
> | **`claude-sonnet-5`** | **400 — `` `temperature` is deprecated for this model`` ** |
> | **`claude-opus-5`** | **400 — same** |
> | **`claude-opus-4-8`** | **400 — same** |
>
> Sonnet 5 and Opus 5 both work fine *without* it. Consequences:
>
> 1. **Every `SUPERVISOR_MODEL=claude-sonnet-5` call would have returned 400.** The cached-supervisor recommendation — the largest single lever in this document — was unshippable as written. Phase 1 must fix the parameter first.
> 2. **The escalation tier is already non-functional on `main`, and this document does not notice.** §2A calls it "latent" and says it "costs nothing today", true only because nothing routes there. It is pinned to `claude-opus-4-8`, which also 400s — so the frontier escape hatch would fail on first use the moment `mcm.agent.frontier-escalation` was enabled. A pre-existing defect, not one this work introduces.
> 3. **OpenWiki is unaffected** — it sets `temperature` nowhere in its dist, so §2B's recommendation stands.
>
> **Why nothing caught it**: the generator guard checks only an output cap; `select_model_config`'s tests are pure and never call a provider; the golden suite replays cassettes and never constructs a real model. Every gate was green and truthful about a narrower claim than the one being relied on. Spec 075 adds the missing instrument — a live check that every resolvable model is invocable with the parameters this repo actually sends.
>
> ### 🟠 The model ids here are a generation behind (R13)
>
> Live from `GET /v1/models` on 2026-09-21: `claude-sonnet-5` and `claude-opus-5` are current; **`claude-sonnet-4-6` and `claude-opus-4-8` are superseded** (still served). Spec 075 moves escalation to `claude-opus-5` — same list price, current, and it works once the parameter is dropped. Note for whoever enables that tier: Opus 5 runs adaptive thinking **by default** where 4.8 did not, so escalation output tokens will not resemble the dormant tier's historical zero.
>
> **`claude-haiku-4-5` is still the current Haiku** — there is no Haiku 5 — so every fast-tier target recommended here was already current.
>
> ### 🟠 The `golden` surface must NOT take the cached-tier supervisor (R3)
>
> §1 and §3 group "CI/golden/devcontainer" for `SUPERVISOR_MODEL=claude-sonnet-5`. Including `golden` is wrong twice over:
>
> - **`test:golden-live` is the pre-deploy gate for production, and production runs the code defaults.** It deliberately sets no per-node pin, mirroring `compose.prod.yaml`. Pinning a different model there makes the gate certify a configuration that never ships.
> - **Cassettes are keyed by model id**, so a pin there misses all 31 committed supervisor cassettes, or forces a second parallel set at double the re-record cost.
>
> Only `app-e2e` and the dev container take the pin. The $22 that matters is in `app-e2e`; the deploy gate's $5.62 was already proportionate, as §0 says.
>
> ### 🟠 A bare `SUPERVISOR_MODEL` pin follows whichever provider is active (R12)
>
> §3 Phase 1 says to set `SUPERVISOR_MODEL` in the CI job env. But `app-ci.yml` declares `provider: choice [anthropic, ollama]` and the `app-e2e` job reads `MODEL_PROVIDER` from it, so that job genuinely runs both ways. Measured:
>
> ```
> MODEL_PROVIDER=ollama + SUPERVISOR_MODEL=claude-sonnet-5
>   → ModelSpec(provider='ollama', model_id='claude-sonnet-5')   # a Claude id sent to Ollama
> MODEL_PROVIDER=ollama + ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5
>   → ModelSpec(provider='ollama', model_id='qwen2.5')           # correct
> ```
>
> Every pin must be **provider-scoped**. Spec 075 teaches `select_model_config` to resolve `<PROVIDER>_SUPERVISOR_MODEL` ahead of the bare name, so a pin cannot reach the wrong provider on any surface.
>
> ### 🟠 The prompt change is shared with Ollama, which this document never considers (R1, R11)
>
> `classify_intent` is used by **both** providers, and Ollama — not Anthropic — is the default. Splitting the prompt into a `cache_control`-marked system block therefore changes what `qwen2.5` sees too. Verified by execution: `langchain_ollama` silently drops an unknown key on a `text` content part, so **one message shape serves both providers with no branch**, and the marker is inert on Ollama and on Haiku (whose 4,096-token minimum the ~2,650-token prefix does not clear).
>
> Two things follow that this document does not mention:
>
> - **Replay never constructs `ChatOllama`** — `build_chat_model` returns a `ReplayChatModel` — so no CI gate executes that adapter. Spec 075 adds an offline unit test for it, because the failure mode is a dependency bump, not an authoring mistake.
> - The rendered Ollama system content gains a **leading newline** (the converter accumulates with `content += f"\n{text}"`). Harmless, but part of the cassette key.
>
> ### 🟡 The generator guard does NOT need relaxing (R6)
>
> §1.1(c) warns the guard "will flag an id it doesn't know" and suggests relaxing the assertion. It will not. `openwiki@0.5.2`'s own resolver matches `/^claude-(?:haiku|sonnet|opus)-(?:4|5)(?:[-.@]|$)/u`, and `@langchain/anthropic`'s table carries an explicit `"claude-sonnet-5": 16384`. Measured with the bump applied: **20 passed, 0 failed, 0 skipped** — the skip count being the part that matters, since those two assertions skip when openwiki is absent and a skip reads as a pass. **Spec 075 forbids relaxing that guard** (FR-004): it is the only mechanical check on the property that once produced a ~50% zero-page rate at exit 0.
>
> ### 🟡 "Confirm on the console the next day" is not a test (R7)
>
> §3 Phase 1 says: *"Confirm on the console the next day that `mcm-ci-e2e` shows `input_cache_read` rows; that is the whole test."* It is not. Caching is a prefix match: one interpolated byte and the cache-read rate drops to zero with **no error raised and no test failing**. An operator reading a dashboard once cannot defend that. Spec 075 makes it two in-repo assertions — an offline check that the static prefix is byte-stable, and a live check that a repeated classification is served from cache, gated so a missing credential **fails** rather than skipping.
>
> ### 🟡 The re-record is 43 cassettes, one of which an Anthropic key cannot regenerate (R5, R9)
>
> §3 says "Re-record cassettes" as a single step. Cassettes are keyed on `sha256(model_id + normalized prompt)`, and Phase 1 changes **both**:
>
> | Keyed id | Count | Invalidated by | Credential needed |
> |---|---|---|---|
> | `claude-haiku-4-5` (intent) | 31 | prompt shape | Anthropic |
> | `claude-sonnet-4-6` (extraction) | 11 | specialist id change | Anthropic |
> | **`qwen2.5`** (topic confinement) | 1 | prompt shape | **a local Ollama** |
>
> That last row is the trap. It is also the *only* measurement of live `qwen2.5` behaviour on the new message shape — and skipping it fails the keyless merge gate, which resolves the Ollama tier because `guardrails` sets no `MODEL_PROVIDER` (verified: removing that one cassette takes the gate from 51 passed to 42 passed + 9 errors).
>
> ### ✅ What held up
>
> The §0 spend measurements; Haiku 4.5's 4,096-token minimum cacheable prefix and Sonnet 5's 1,024; the cache read/write pricing; the ≈65% break-even that keeps production on Haiku; and the central insight that the dominant gateway cost is an uncacheable static classifier prompt rather than "Sonnet specialists". **Phases 2–4 are unreviewed** — they were out of scope for spec 075, and the corrections above should be assumed to apply to them in spirit.

---

## 0. Measured spend, 22 Aug – 20 Sep 2026 (30 days)

**Total: $74.89** across five keys, all on Haiku 4.5 and Sonnet 4.6 (no Opus calls at all — the escalation tier really is dormant).

| Key | 30-day cost | Share | Tokens (in / cache-write / cache-read / out) | What it says |
|---|---|---|---|---|
| `mcm-wiki-maintain` (OpenWiki, Sonnet 4.6) | **$39.61** | 53% | 1.5k / 4.41M / 52.0M / 498k | 23 run-days, **$1.72 per run-day** median-ish; Sept 19–20 alone were $6.43 + $6.15 (32% of the wiki total) with 3–7× the usual output (a merge burst plus post-upgrade regeneration — see interpretation below). **Prompt caching is already doing its job: 92% of input tokens are cache reads at $0.30/M.** Cost splits $16.56 cache writes / $15.59 cache reads / $7.46 output. |
| `mcm-ci-e2e` (app-e2e, live agent integration) | **$26.02** | 35% | Haiku 22.0M in / 69k out; Sonnet 608k in / 129k out | **$22.24 of it is Haiku input** — the ~2.7k-token supervisor prompt sent uncached (in:out ratio 319:1). Sonnet specialists are only $3.78. Zero cache usage on this key. |
| `mcm-cd-golden` (golden-live gate per deploy) | **$5.62** | 8% | Haiku 4.45M in / 12.6k out; Sonnet 257k in / 26k out | Exactly **67 runs** (every run is 66,461 Haiku input tokens + 3,833 Sonnet — ~25 supervisor calls + 10 extractions), **$0.084 per deploy**. Fine as is. |
| `devcontainer-secret-key` (local `MODEL_PROVIDER=anthropic` runs) | $3.51 | 5% | Haiku 3.06M in / 9k out; Sonnet 74k in / 13k out | 7 days of use, same uncached-supervisor shape as CI. |
| `mcm-secret-key` (**the owner's own BYOK key in the prod Movie Assistant** — not an SDLC surface) | $0.13 | <1% | 143k Haiku in / 440 out; Sonnet 593 in / 225 out | The one real production-user data point. Five days of use: two real sessions (Aug 22 ≈12 turns $0.04, Aug 23 ≈27 turns $0.09) and three single-turn days at ≈3.4k Haiku tokens each. **≈$0.003 per turn**, and almost all of it is the supervisor classify — Sonnet was called only 3–4 times in the whole month. A user's turns are spaced out, so nothing here would hit a 5-minute cache. |

Two things the numbers overturn in the plan below:

1. **The gateway's cost is not "Sonnet specialists", it is Haiku supervisor input**: $29.96 of the $35.34 gateway total is Haiku, and 96% of that is the static classifier prompt. Haiku 4.5 has a **4,096-token minimum cacheable prefix** and the prompt is ~2,650 tokens, so `cache_control` on Haiku is a no-op. The cheapest Anthropic-only fix is counter-intuitive: **move the supervisor to Sonnet 5 with the prefix cached** ($0.20/M on hits, 1,024-token minimum) — a cached Sonnet 5 classify call costs ≈$0.0005 vs ≈$0.0027 uncached on Haiku, i.e. roughly 5× cheaper *and* a stronger classifier. Modelled on the 30-day volumes: gateway Haiku spend $30 → ≈$8–11 depending on hit rate (CI runs are bursts, so hits should be ≥95%).
2. **OpenWiki is already 92% cache reads, so a cheaper vendor only wins if its cache-hit price is low *and* its caching actually engages on an agent loop.** Web research (section 2B) gives realistic hit rates per provider from the Deep Agents framework OpenWiki is built on: ~80% on OpenAI, ~50% on Gemini's implicit cache, near-Anthropic on DeepSeek's automatic cache. On those numbers Gemini 3.8 Flash models to ≈$25 (barely better than Sonnet 5 at ≈$26, and its prices double in January), GPT-5.6 Terra ≈$38 (no saving), GPT-5.6 Luna ≈$4, and DeepSeek V4.1 Flash ≈$2–4 — with tool-calling reliability as the risk on the two cheap ones.

Modelled 30-day totals at the same token volumes (list prices; gateway cache hit rate assumed 95% in CI bursts, wiki hit rates per provider as researched in section 2B):

| Scenario | Gateway (CI + golden + devcontainer) | OpenWiki | Total | vs today |
|---|---|---|---|---|
| Today (Haiku 4.5 sup + Sonnet 4.6 spec; Sonnet 4.6 wiki) | $35.34 | $39.61 | **$74.89** | — |
| Anthropic-only: Sonnet 5 supervisor cached + Haiku specialists; wiki Sonnet 5 | ≈$10–13 | ≈$26.4 | **≈$37–40** | ≈ −48% |
| Anthropic-only gateway + wiki on DeepSeek V4.1 Flash (80–92% cached) | ≈$10–13 | ≈$2–4 | **≈$12–17** | ≈ −80% |
| + gateway on Gemini 3.1 Flash-Lite / GPT-5.6 Luna (no caching) | $8.0 / $6.4 | ≈$2–4 | ≈$9–12 | ≈ −86% |
| Everything on DeepSeek V4.1 Flash (cached) | ≈$2.0 | ≈$2.2 | **≈$4–5** | ≈ −94% |

Interpretation: at ~$75/month the org bill is modest and the Anthropic-only changes halve it with no new vendor. The prod-user picture is different in kind: a real member costs ≈$0.003 per turn (≈$0.30 for a hundred turns a month), so for users the problem is not the bill but that Claude is their only cloud option and every turn is priced at full uncached Haiku. The cached-Sonnet-5 supervisor trick does **not** help them — isolated turns never hit the 5-minute cache, and a cache *write* at $2.50/M makes a lone Sonnet 5 classify ≈2× the price of Haiku — so prod should keep Haiku as the code default and CI should take Sonnet 5 via `SUPERVISOR_MODEL`. The gateway's multi-vendor work (Phase 3) is justified by **user** choice and by CI resilience (spec 048 records CI going red when the Anthropic balance ran out) rather than by the org's own bill. The Sept 19–20 wiki spike ($12.58, a third of the month's wiki spend in two days) had two known causes: an unusually high number of PRs and merges, and an OpenWiki upgrade that forced regeneration of many pages — and more regeneration is still queued behind backlog issues #525 and #526, so the next month's wiki bill will run above the $1.72/run-day baseline until that backlog clears. That makes the OpenWiki provider decision the most time-sensitive item here.

## 1. Summary

The repository has exactly **two workloads that spend Anthropic tokens on the org's own keys**, plus the production assistant, which spends on **end users' own keys (BYOK)**. Efficient user spend is a goal in its own right — a member who opts in pays per turn, and the per-user `costLimitUsd` ceiling means an expensive model translates directly into fewer turns before the assistant stops answering.

| # | Surface | What the model does | Model today | Who pays | Relative spend |
|---|---------|---------------------|-------------|----------|----------------|
| A | Movie Assistant gateway (`agents/movie-assistant`) in **CI** (`app-e2e` web + mobile flows, live agent integration tests) and the **cd-deploy golden-live gate** | 4 tiny single-shot prompts per conversation turn: intent label, entity JSON, organize-plan JSON, query-filter JSON. No tool calling, no long context. | `claude-haiku-4-5` (supervisor), `claude-sonnet-4-6` (curator/organizer/query), `claude-opus-4-8` (escalation, flag-off, never routed) | Org: `ANTHROPIC_API_CI_E2E`, `ANTHROPIC_API_CD_GOLDEN` | **$31.64 / 30 days** (CI $26.02 + golden $5.62); 85% of it is the uncached Haiku supervisor prompt |
| B | **OpenWiki** knowledge-bundle generator (`wiki-maintain.yml` → `scripts/wiki-maintain.mjs` → `nx wiki-update`) | Agentic ReAct loop over the repo: reads files, plans, writes `openwiki/**` pages. 25+ turns, tool-heavy, large context, 16k output cap. | `claude-sonnet-4-6` | Org: `ANTHROPIC_API_WIKI_MAINTAIN` | **$39.61 / 30 days** (53% of the bill), ≈$1.72 per run-day, already 92% cache reads |
| C | Movie Assistant in **production** | Same as A | Same as A — the code defaults apply because `compose.prod.yaml` deliberately sets no `SUPERVISOR_MODEL`/`SPECIALIST_MODEL` | **End users (BYOK, feature 018)** — the shared prod key is "typically EMPTY" | Measured on the owner's own key (`mcm-secret-key`): ≈$0.003/turn, $0.13 for the month; today a member's only choices are Claude at list price or self-hosting Ollama |
| D | DAST job (`app-ci.yml` `dast`) | None — key only lets the gateway boot; spider is passive | n/a | Org: `ANTHROPIC_API_CI_DAST` | Zero inference |
| E | BFF key probe (`agent-config-probes.ts`) | `GET /v1/models` to validate a user's key on save | n/a | n/a | Zero tokens |
| F | Dev container `MCM_ANTHROPIC_API_KEY` | Feeds A and B when a developer runs them locally with `MODEL_PROVIDER=anthropic` / `wiki-execute` | as A/B | Org / developer | $3.51 / 30 days on 7 days of use |
| G | Golden gate in `guardrails.yml` | Cassette **replay** — keyless, no network | none | — | Zero |

>**⚠️ Items 1(a) and 1(c) below are corrected at the top of this document.** 1(a) omits the `temperature` blocker and wrongly includes `golden` in the surfaces that take the cached-tier supervisor; 1(c)'s warning that the generator guard needs relaxing is unfounded (measured 20 passed / 0 failed / 0 skipped). 1(b) and 1(d) stand.

**Recommended approach, in order of effort vs. payoff:**

1. **Anthropic-only wins (do first, this week) — the data says they roughly halve the org bill.** (a) **CI/golden/devcontainer supervisor → `claude-sonnet-5` with the static prompt prefix marked `cache_control`**, set via `SUPERVISOR_MODEL` in the job env rather than the code default: Haiku 4.5 cannot cache a 2.7k prompt (4,096-token minimum), so CI's classifier is paying full price on 29M input tokens a month; in a CI burst a cached Sonnet 5 call is ≈5× cheaper than an uncached Haiku call and is the better classifier. Prod keeps Haiku as the code default — a lone user turn would pay the cache *write* and cost ≈2× Haiku. (b) **Specialists → `claude-haiku-4-5`** as the code default: the three extraction prompts are 120–520 tokens returning a JSON object; Haiku handles them and they are too short to cache anyway, so cheapest-per-token wins here — $5.3 → ≈$1.8 for the org, and a 3× cut on the (rare) specialist call for prod users. (c) For OpenWiki, move to `claude-sonnet-5` ($2/$10 vs $3/$15; cache hits $0.20 vs $0.30) — a straight −33% on a workload that is already 92% cache reads — verify with `node --test scripts/__tests__/wiki-maintain.guard.test.mjs` first because that guard reads `@langchain/anthropic`'s max-token table and will flag an id it doesn't know. (d) Adding `cache_control` to the prompt is harmless on Haiku (ignored below the minimum), so the code change can ship once and take effect wherever the model allows it.
2. **Move OpenWiki to a cheaper provider — the biggest and most urgent line.** OpenWiki is 53% of the bill and the #525/#526 regeneration backlog will push it higher before it falls. The measured run is 92% cache reads, so list input price is the wrong number to compare; modelled on realistic per-provider hit rates (section 2B), Sonnet 5 lands at ≈$26, Gemini 3.8 Flash ≈$25 (implicit caching only reaches ~50%), GPT-5.6 Terra ≈$38, GPT-5.6 Luna ≈$4, and DeepSeek V4.1 Flash via `openai-compatible` ≈$2–4. Take Sonnet 5 immediately, then trial DeepSeek on real merge runs; the existing `wiki-maintain.mjs` verifier judges success by pages that landed, not by the generator's exit code, so it is already the right harness to A/B providers safely. Tool-calling reliability, not prose, is what decides whether a cheap model actually saves money here.
3. **Add one more provider adapter to the gateway (`langchain-openai`) and expose it to users as a third BYOK choice.** The `models.py` seam is provider-agnostic by design; an `openai_compatible` provider (base URL + key) reaches Gemini Flash-Lite, OpenAI Luna, DeepSeek V4.1 Flash and OpenRouter without further code. The same adapter serves two audiences: CI switches to a sub-$0.50/M model (≈5–10× reduction on surface A), and a member who picks "OpenAI-compatible" in the Profile screen and pastes, say, a Gemini or DeepSeek key pays ≈5–15× less per turn than on Claude. The BFF side (types, UI, probe, encrypted store, e2e seeds) is a real feature, but it is the single largest lever on user spend and should be scoped together with the gateway adapter rather than deferred. Re-record the golden cassettes on the new CI provider.
4. **Make user spend visible and steerable.** LangFuse already records per-turn cost; surface the running per-user figure next to `costLimitUsd` in the config UI, and consider an "economy" default (Haiku for every tier) with Sonnet as an opt-in for members who want it — the approval gate, not the model, is the safety net, so a cheaper extractor costs the user a clarifying question at worst, never a bad write.

## 2. Every place the Anthropic key is used

Search: `rg -i anthropic` over tracked files, excluding `node_modules`, `dist`, `build`, `.git`, `secrets/`, `.env*`, lockfiles. Claude Code configuration (`.claude/`, `CLAUDE.md`, devcontainer Claude Code install) is excluded per the brief.

### A. Movie Assistant agent gateway — `agents/movie-assistant`

Files: `src/models.py` (selection + `ChatAnthropic` build), `src/graph.py` (`_default_classifier`), `src/runtime_nodes.py` (`_default_extract`, `_default_plan`, `_default_query_extract`), `src/nodes/{supervisor,curator,organizer,query}.py` (the prompts), `src/provider_errors.py`, `src/flags.py` (`mcm.agent.frontier-escalation`).

Design facts that matter for cost:

- **Code-orchestrated tools.** The LLM never picks MCP tools or forges write args; it only classifies and extracts (README "Code-orchestrated tools (key decision)"). This is the single most important fact: the model needs *instruction following + JSON output*, not agentic reasoning.
- **Per turn, at most two model calls**: supervisor classify (~2,650 tokens of static prompt + the user message → a one-word label, temperature 0) then one specialist extraction (120–520 token prompt → small JSON, temperature 0). Search, navigate, import, export, approval gate and all disambiguation stages are pure code.
- **Escalation (`claude-opus-4-8`) is latent**: hard-pinned to Anthropic, gated by an Unleash flag that defaults off; `escalation_or_base` degrades to the specialist when no Anthropic key is present. It costs nothing today. **⚠️ Correction: it is also BROKEN today.** `claude-opus-4-8` rejects the `temperature` this code always sends (measured — see Corrections), so every escalation would 400 on first use. It is additionally a superseded id; spec 075 moves it to `claude-opus-5`. It should stay pinned to Anthropic (the invariant in `openwiki/invariants/model-provider-scoping.md` exists to keep golden cassettes stable).
- **Golden cassettes are keyed by `model_id`** (`ReplayChatModel(cassette, spec.model_id)`), so changing any default model id means re-recording with `LLM_CASSETTE_MODE=record`.
- **Where it runs on the org's key**: `app-ci.yml` `app-e2e` job (`MODEL_PROVIDER` defaults to `anthropic`; web Playwright agent specs + Maestro mobile flows + live agent integration tests `-m "not golden"`), and `cd-deploy.yml` `test:golden-live` (`MCM_REQUIRE_LIVE_MODEL=1`). Spec 048 records "~52 live-model E2E flows stay on live Anthropic" (decided 2026-08-07) — that decision was about tier correctness, not about which vendor.
- **Prod** (`infrastructure-as-code/docker/agents/compose.prod.yaml`): `MODEL_PROVIDER=anthropic`, code-default ids, per-user BYOK key injected per run via `X-Agent-Config`; shared key optional and typically empty. Per-user `costLimitUsd` ceiling is enforced in the BFF.

Cost per conversational turn at today's list prices. The console export confirms the shape: measured supervisor calls average ≈2.7k input tokens and 3–9 output tokens (in:out ratio 319–354:1 on every gateway key), specialist calls ≈300 in / 60 out — and **no gateway key has ever recorded a cache read or write**:

| Provider / models | Supervisor call (≈2.7k in / 3 out) | Specialist call (≈0.5k in / 60 out) | ≈ per turn |
|---|---|---|---|
| Today: Haiku 4.5 + Sonnet 4.6 | $0.0027 | $0.0024 | **$0.005** |
| All Haiku 4.5 | $0.0027 (cannot cache: 4,096-token minimum) | $0.0008 | $0.0035 |
| **Sonnet 5 supervisor, prefix cached (95% hits) + Haiku 4.5 specialists** | ≈$0.0006 | $0.0008 | **≈$0.0014** |
| OpenAI GPT-5.6 Luna ($0.20/$1.20) | $0.0005 | $0.0002 | $0.0007 |
| Gemini 3.1 Flash-Lite ($0.25/$1.50) | $0.0007 | $0.0002 | $0.0009 |
| DeepSeek V4.1 Flash ($0.30/$1.20; cache-hit input $0.006) | $0.0008 → ≈$0.00002 with the static prefix cached | $0.0002 | ≈$0.0003–0.001 |

Any of the sub-$0.50/M models is a 5–15× reduction. Quality risk is concentrated in one place: the supervisor's intent taxonomy (10 labels with many near-miss rules — `search` vs `navigate` vs `query` vs `enrich`). The repo already documents that qwen2.5 misclassifies edge cases that Claude gets right ("exit search" → `out_of_domain`), so **any candidate must pass the golden pair suite in record mode before it becomes the CI provider**. Flash-Lite / Luna / DeepSeek Flash class models are the realistic floor; anything smaller is likely to fail it. (Groq was considered and excluded by the owner on vendor-history grounds.)

### B. OpenWiki generator — `infrastructure-as-code/project.json` `wiki-update`, `scripts/wiki-maintain.mjs`, `.forgejo/workflows/wiki-maintain.yml`

- Env: `OPENWIKI_PROVIDER=anthropic`, `OPENWIKI_MODEL_ID=claude-sonnet-4-6`, `OPENWIKI_MAX_OUTPUT_TOKENS=16384` (load-bearing — the 4096 fallback caused a ~50% zero-page rate), `openwiki@0.5.2` pinned in both the toolchain image and the CI job.
- Credential precedence `ANTHROPIC_API_KEY` then `MCM_ANTHROPIC_API_KEY` (`CREDENTIAL_ENV_NAMES`); CI secret `ANTHROPIC_API_WIKI_MAINTAIN`.
- Work: open-ended agentic documentation — read many files, reason about what changed since the marker, write OKF-conformant pages under `openwiki/**` within `policy.yaml`. Outcome: an always-current proposal PR after each merge burst. Budget: 16 pages / 20 min per run, not monetary; the generator emits no token/cost data.
- This is the workload that actually needs a capable, tool-using model with a long context, and it is the one whose cost scales with repo size and merge frequency.

**What is known about OpenWiki's caching per provider (web research, Sept 2026).** Nobody has published a per-provider cache-rate comparison for OpenWiki specifically, but three sources pin the picture down well enough to model:

- OpenWiki is built on LangChain's Deep Agents, and the Deep Agents team measured their built-in caching strategy per provider on their eval suite: **Anthropic (explicit `cache_control` breakpoints) −77% cost on Haiku; OpenAI (automatic longest-prefix caching, no breakpoints) −80% on GPT mini; Gemini (implicit caching, "no explicit savings guarantee") −49% on Flash**. Longer agent conversations cache better, and loading new tools/skills mid-run can bust the prefix. The 92% cache-read ratio on `mcm-wiki-maintain` is that Anthropic middleware at work — it is not something the repo configured.
- OpenWiki PR #884 (open, Sept 2026) adds the same `cache_control` middleware for Bedrock and reports a real mid-sized-repo run: 111 model calls, **94.7% of input served from cache, read:write 17.7:1, 83.9% reduction in input billing**. That is the same shape as the MCM console data (92% reads, 11.8:1), which says the MCM runs are already near the ceiling of what caching can do on Anthropic. The PR also states plainly that OpenWiki adds no caching for other providers beyond what Deep Agents does automatically.
- Gemini's docs: implicit caching applies automatically with a **4,096-token minimum** on 3.x Flash; cached input is billed at **$0.075/M for 3.8 Flash** (through 2026-12-31) and **$0.025/M for 3.1 Flash-Lite**; **3.5 Flash-Lite has no context caching at all**. OpenAI bills cached input at 90% off across models. DeepSeek's cache is automatic and bills hits at $0.006/M.
- A field report on running OpenWiki headless (Towards AI, 2026) found Sonnet failing repeatedly on **malformed tool calls** while Opus 4.8 completed cleanly, and concludes "pick your model for tool-calling reliability first, prose quality second — the capable model that finishes is cheaper than the cheap model that doesn't." The repo's own history (feature 043's ~50% zero-page rate) is the same lesson. This is the main risk with DeepSeek and Luna, and it is exactly what `wiki-maintain.mjs`'s pages-landed verifier measures.

Candidate replacements, modelled on the measured 30-day token profile (4.41M cache-write, 52.0M cache-read, 498k output; total input 56.4M) with **provider-realistic hit rates from the sources above**, not list price. OpenWiki natively supports OpenAI, Anthropic, Gemini, OpenRouter, Bedrock, Nebius/Fireworks/Baseten/NIM and any OpenAI-compatible endpoint (`OPENWIKI_PROVIDER=openai-compatible` + `OPENAI_COMPATIBLE_BASE_URL` + a non-empty `OPENAI_COMPATIBLE_API_KEY`):

| Option | Price in / cached-in / out per M | Assumed hit rate | Modelled 30-day cost | Notes |
|---|---|---|---|---|
| `claude-sonnet-4-6` (today) | $3 / $0.30 / $15 | 92% (measured) | **$39.61** | — |
| `claude-sonnet-5` | $2 / $0.20 / $10 | 92% (same middleware) | **≈$26** (−33%) | Same vendor, no workflow change, one env value. Check the guard test. Zero quality risk. |
| `gemini-3.8-flash` | $0.75 / $0.075 / $3.75 (both double on 2027-01-01) | ~50% (Deep Agents measured −49% on Gemini implicit caching) | **≈$25** (−37%); ≈$10 if it reached 90% | Strong agentic model, 1M context, native provider. Only marginally better than Sonnet 5 at the realistic hit rate, and its prices double in January. Needs a Gemini key + egress allowlist entry. |
| `gpt-5.6-terra` (OpenWiki's default) | $2 / $0.20 / $12 | ~80% (Deep Agents measured −80% on OpenAI) | ≈$38 (−4%) | No saving worth the switch. |
| `gpt-5.6-luna` | $0.20 / $0.02 / $1.20 | ~80% | ≈$4 (−90%) | Cheapest native-provider option, but the weakest tier — the zero-page / malformed-tool-call risk is real. |
| DeepSeek `deepseek-flash` (V4.1) via openai-compatible | $0.30 / $0.006 / $1.20 (peak; half off-peak) | 80–92% (automatic; same prefix shape) | **≈$2–4** (−90–95%) | Best price by a wide margin. Unknowns: tool-call reliability on a 25-turn ReAct loop, the undocumented `openai-compatible` path (issue #120: dummy key, maybe a longer timeout), and 1M-context truncation behaviour. |
| OpenRouter (`:floor` routing) | varies | depends on routed provider | varies | One key, many models, `max_price` ceilings; 5.5% fee on credits. Useful for the A/B without new vendor accounts, but caching only if the routed provider honours it (issue #39 asks for provider pinning for exactly this reason). |

Recommendation for B, in order: (1) `claude-sonnet-5` **now** — certain −33%, one env value, no quality risk, and the #525/#526 regeneration backlog will run on it either way; (2) trial DeepSeek V4.1 Flash against real merge runs, judged by pages landed / OKF lint / policy — it is the only option whose saving is large *and* survives a realistic cache assumption; (3) `gpt-5.6-luna` as the second cheap candidate if DeepSeek's tool-calling is not reliable enough; (4) treat `gemini-3.8-flash` as a quality alternative rather than a cost play unless a trial run shows a hit rate well above 50%. Do not use OpenRouter for the production wiki job unless provider pinning lands.

### C–G. Non-spending or someone-else's-spend surfaces

- **Prod BYOK (C)**: users choose `ollama` or `anthropic` and supply their own key (`frontend/mcm-app/src/types/agent-config.ts`, `agent-config-store.ts`, `agent-config-crypto.ts`). No org spend, but every opted-in member pays the code-default Haiku+Sonnet rate per turn, capped by their `costLimitUsd`. Three things reduce what they pay: the Phase 1 Haiku-specialist default reaches them automatically (the cached-Sonnet supervisor does not — see the Phase 1 prod caveat); a third `openai-compatible` provider choice lets them bring a Gemini / OpenAI / DeepSeek / OpenRouter key (types, UI in `movie-assistant-config.tsx`, `probeOpenAiCompatible` mirroring `probeAnthropic` — most vendors expose `GET /v1/models` — the SSRF guard from `agent-config-ssrf.ts` reused for the base URL, e2e seeds, Maestro flows alongside `assistant-config-enable-anthropic.yaml`); and the per-user model-tier choice in item 4 of the summary (all Phase 3). The escalation tier stays Anthropic-only and flag-off, so a non-Anthropic user simply never reaches it (`escalation_or_base` already degrades to the specialist).
- **DAST (D)**: `ANTHROPIC_API_CI_DAST` exists only because `agent-stack.mjs` refuses to boot the gateway with `MODEL_PROVIDER=anthropic` and no key. Once an `openai_compatible` provider exists, or by booting with `MODEL_PROVIDER=ollama` and any `OLLAMA_BASE_URL`, this secret can be retired — zero cost either way, one less key to rotate.
- **Key probe (E)**: `GET https://api.anthropic.com/v1/models` — free.
- **Dev container (F)**: `MCM_ANTHROPIC_API_KEY` deliberately not named `ANTHROPIC_API_KEY` so Claude Code keeps billing the subscription, not the API. Whatever provider CI adopts, add the matching `MCM_<VENDOR>_API_KEY` passthrough and egress-allowlist host (`.devcontainer/egress-allowlist.json`, `init-firewall.sh`).
- **Golden replay (G)**: keyless. Untouched by any of this.

## 3. Concrete implementation plan

> **⚠️ Phase 1 as written below is superseded.** It carries the `temperature` blocker, the `golden` grouping error, the bare-pin error and the console-check "test" — see the Corrections at the top. The executable version, with TDD checkpoints and two ordered merges, is [`specs/075-llm-cost-phase-1/tasks.md`](../../specs/075-llm-cost-phase-1/tasks.md). The text below is kept as the original reasoning, not as instructions. Phases 2–4 have not been reviewed.

Phase 1 — no new vendor, ~1 day:

- `agents/movie-assistant/src/models.py`: `_FAST_DEFAULTS["anthropic"] = "claude-sonnet-5"` and `_BALANCED_DEFAULTS["anthropic"] = "claude-haiku-4-5"` (or set `SUPERVISOR_MODEL` / `SPECIALIST_MODEL` in the CI job env and prod compose to avoid touching code). `src/nodes/supervisor.py` `classify_intent`: split the prompt into a static system block carrying `cache_control: {"type": "ephemeral"}` (langchain-anthropic supports it on content blocks) and a one-line human message with the user text — the static part is ~2,650 tokens, above Sonnet 5's 1,024-token minimum. Confirm on the console the next day that `mcm-ci-e2e` shows `input_cache_read` rows; that is the whole test. Re-record cassettes (`LLM_CASSETTE_MODE=record pnpm nx test:golden movie-assistant`), run `test:golden` in replay, then `app-e2e`.
- `infrastructure-as-code/project.json`: `OPENWIKI_MODEL_ID=claude-sonnet-5`; run `scripts/__tests__/wiki-maintain.guard.test.mjs`; if the `@langchain/anthropic` table check fails, either wait for a langchain bump or relax that specific assertion since `OPENWIKI_MAX_OUTPUT_TOKENS` is explicit (the test's own comments say the explicit cap is the premise).
- Update `openwiki/invariants/model-provider-scoping.md`, `docs/runbooks/agent-layer.md`, `compose.prod.yaml` header comment, `CLAUDE.md` AI Agent Layer section.

Prod caveat: `compose.prod.yaml` intentionally leaves the model env vars unset so the code defaults rule, which means the Haiku-specialist default ships the user saving with the next gateway image; note it in the compose header comment and in `openwiki/invariants/model-provider-scoping.md`. The supervisor is the opposite case. The owner's own prod key shows what a member's traffic looks like — a handful of turns on a day, sometimes exactly one — so the 5-minute cache entry is almost always expired by the next turn. Break-even for cached Sonnet 5 against uncached Haiku ($0.0027) is a ≈65% hit rate (at 0% hits ≈$0.0067, at 50% ≈$0.0037, at 80% ≈$0.0018, at 95% ≈$0.0006), which real users will not reach. So: Haiku stays the supervisor code default for prod, and CI/golden/devcontainer set `SUPERVISOR_MODEL=claude-sonnet-5` in their env — the override exists for exactly this. The genuinely cheaper supervisor for prod users is a provider whose caching is automatic and whose miss price is already low (DeepSeek V4.1 Flash at $0.30/M miss, $0.006/M hit; Gemini Flash-Lite at $0.25/M), which is Phase 3.

Phase 2 — OpenWiki provider trial, ~1 day of setup plus a few real merge cycles (start this before the #525/#526 regeneration backlog is worked, so the bulk of that work runs on the cheaper model):

- Add a `wiki-update` env override path (`OPENWIKI_PROVIDER`, `OPENWIKI_MODEL_ID`, `OPENAI_COMPATIBLE_BASE_URL`, provider key secret) so the CI job can be switched by workflow variable without a code change; keep `OPENWIKI_MAX_OUTPUT_TOKENS=16384` explicit for every provider — the 4096-fallback lesson is provider-independent.
- Run the DeepSeek V4.1 Flash variant on `main` for several runs and compare `.maintenance-state.json` outcomes (pages landed, verification verdicts, retries, zero-page attempts) against the Sonnet history already committed; capture the provider's own usage report per run so the cache-hit rate is a measurement rather than an assumption. If it fails on tool calls, try `gpt-5.6-luna` next, then fall back to Sonnet 5.
- Egress allowlist (`api.deepseek.com` / `api.openai.com` / `generativelanguage.googleapis.com` as applicable), `wiki-maintain.guard.test.mjs` updates for the new host / model-id pattern, and `CREDENTIAL_ENV_NAMES` in `wiki-maintain.mjs` gains the new secret name.
- Off-peak note: DeepSeek halves prices outside 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; the merge-triggered job cannot choose its hour, but the debounce sleep in `wiki-maintain.yml` could be biased toward off-peak later if the spend ever matters again.

Phase 3 — third provider for the gateway **and** for BYOK users, ~1 week end to end:

- `pyproject.toml`: add `langchain-openai`. `models.py`: `provider == "openai_compatible"` → `ChatOpenAI(model=..., base_url=env["OPENAI_COMPATIBLE_BASE_URL"], api_key=env["OPENAI_COMPATIBLE_API_KEY"], temperature=...)`; defaults tables gain an entry; `runtime_env`/`resolve_*` learn the new key name and keep the per-user no-fallback rule; `provider_errors.py` maps the OpenAI SDK's error classes the way it maps Anthropic's (spec 065). Keep `escalation` pinned to Anthropic.
- Ask the models to return JSON via `response_format={"type":"json_object"}` where the provider supports it; the existing `json.loads` + defensive `{}` fallback stays.
- CI: `MODEL_PROVIDER=openai_compatible`, new secret(s), workflow `provider` input gains the option, `dast-leak-scan.sh`/`check-no-argv-secrets.mjs`/`secret-scan.mjs` learn the new secret name (they currently guard `ANTHROPIC_API_KEY` by name — FR-015 says the variable name must stay, so add rather than rename).
- Validate with the golden suite in record mode against 2–3 candidates (Gemini 3.1 Flash-Lite, GPT-5.6 Luna, DeepSeek V4.1 Flash) and pick the cheapest one that passes all pairs, especially the `search`/`navigate`/`query`/`enrich` boundaries and the "exit search" cancel case.
- BFF/UI: `AgentProvider` gains `'openai_compatible'`; config carries `openAiCompatibleBaseUrl` + encrypted `openAiCompatibleKey` + optional per-user `modelId`; `isRunnable` extended; `X-Agent-Config` header carries the new fields; `runtime_env` maps them onto the env keys the adapter reads and keeps the no-shared-fallback rule (018 review #7). Publish a short "recommended cheap providers" note in the Profile screen help text with the model ids the golden suite passed on, so users are steered to configurations that are known to work rather than guessing.

## 4. Things I could not determine from the repo

- ~~Actual monthly spend per key~~ — now measured (section 0): $74.89 / 30 days, wiki 53%, CI 35%. The console export does not break `mcm-ci-e2e` down by workflow run, so PR-triggered vs main-push spend, and the cost of one `app-e2e` run, remain estimates (a typical CI day is $0.45–1.30, median $0.69; the heaviest, Aug 29, was $2.17).
- ~~Why Sept 19–20 wiki runs cost 3.5–4× a normal run-day~~ — explained by the owner: a high volume of PRs/merges plus an OpenWiki upgrade that forced regeneration of many pages, with more regeneration outstanding under backlog issues #525 and #526. Expect elevated wiki spend until that backlog is worked off — which is the argument for landing the OpenWiki provider change before the regeneration, not after.
- Prod user spend now has one data point (the owner's `mcm-secret-key`: ≈$0.003/turn, ~42 turns and $0.13 in 30 days). Whether other members' usage looks the same, and how often anyone approaches `costLimitUsd`, is still unknown; LangFuse (`observability.py`, per-turn cost) has the data if the observability profile runs in prod, but nothing in the repo aggregates it per user.
- Whether the CI runner could host Ollama with a mid-size model fast enough for `app-e2e` (the workflow already accepts `provider: ollama`); on a capacity-1 CPU runner it almost certainly cannot, which is why cloud sub-dollar models are the practical floor for CI.
- DeepSeek prices come from a third-party tracker (the official page could not be fetched); confirm on the vendor console before committing.

## Sources

- Anthropic console exports `claude_api_cost_2026_08_22_to_2026_09_20.csv` and `claude_api_tokens_2026_08_22_to_2026_09_20.csv` (supplied by the owner)
- [Claude pricing (platform.claude.com)](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude prompt caching — minimum cacheable prompt length](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI API pricing](https://openai.com/api/pricing/)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [DeepSeek API pricing tracker (BenchLM, Sept 2026)](https://benchlm.ai/deepseek/api-pricing)
- [OpenRouter: lowest-cost inference guide](https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/)
- [OpenWiki README — supported providers](https://github.com/langchain-ai/openwiki)
- [OpenWiki PR #884 — Bedrock prompt caching, with measured 94.7% cache-read run](https://github.com/langchain-ai/openwiki/pull/884)
- [OpenWiki issues (#29 Gemini, #26 OpenAI-compatible, #39 OpenRouter provider pinning, #43/#44 exit-0 partial output)](https://github.com/langchain-ai/openwiki/issues)
- [OpenWiki releases (v0.3.3–v0.4.0 provider/caching/max-token notes)](https://github.com/langchain-ai/openwiki/releases)
- [LangChain: Prompt caching with Deep Agents — measured −77% Anthropic / −80% OpenAI / −49% Gemini](https://www.langchain.com/blog/deep-agents-prompt-caching)
- [Gemini API context caching (4,096-token implicit minimum on 3.x Flash)](https://ai.google.dev/gemini-api/docs/caching)
- [Running OpenWiki for Real: Why the Model You Pick Decides Everything (Towards AI)](https://pub.towardsai.net/running-openwiki-for-real-why-the-model-you-pick-decides-everything-b6cfd1180c38)
- [OpenWiki issue #120 — local / OpenAI-compatible endpoints](https://github.com/langchain-ai/openwiki/issues/120)
- Repo files: `agents/movie-assistant/src/models.py`, `src/graph.py`, `src/runtime_nodes.py`, `src/nodes/*.py`, `agents/movie-assistant/README.md`, `scripts/wiki-maintain.mjs`, `infrastructure-as-code/project.json`, `.forgejo/workflows/{app-ci,cd-deploy,wiki-maintain,guardrails}.yml`, `infrastructure-as-code/docker/agents/compose.prod.yaml`, `frontend/mcm-app/src/bff-server/agent-config-probes.ts`, `frontend/mcm-app/src/types/agent-config.ts`, `openwiki/invariants/model-provider-scoping.md`, `docs/runbooks/agent-layer.md`, `specs/048-test-harness-remediation/spec.md`, `.devcontainer/devcontainer.json`.
