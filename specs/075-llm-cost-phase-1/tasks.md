# Tasks: LLM cost reduction, phase 1 — no new vendor

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)
**Branch**: `075-llm-cost-phase-1` · **Created**: 2026-09-21

Format per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md),
AI-agent-layer variant. **No Platform Parity Table** — this feature adds no assistant
flow and no UI surface; it changes which model answers an existing one. The consuming
clients' E2E still runs (T024), per the template's "required even for backend-only".

**Two merges** (FR-020). Merge 1 is four tasks and touches no application code. Do not
start merge 2 until merge 1 is merged, so a red pipeline names its own cause.

> **Worktree**: `pnpm nx` targets need a real `CI=true pnpm install --frozen-lockfile`
> inside the worktree (~4 min); a `node_modules` symlink covers `node --test` and bare
> `uv run pytest` but not Nx.
>
> **Credential**: never export `ANTHROPIC_API_KEY` into your shell. Use the
> `VAR=value command` prefix form shown in each task.

---

# Merge 1 — the generator (US1)

## T001 — Point the knowledge-bundle generator at the current Sonnet

**Type**: Config change | **Time**: 5 min | **Risk**: None

**Spec reference**: FR-001, FR-002, FR-003

**File(s)**: `infrastructure-as-code/project.json`

Set `targets.wiki-update.options.env.OPENWIKI_MODEL_ID` to `claude-sonnet-5`.
Leave `OPENWIKI_MAX_OUTPUT_TOKENS`, `OPENWIKI_PROVIDER`, the pinned `openwiki` version
and every other env value untouched.

**Then reword one sentence in the same target's `metadata.description`.** It currently
recounts the original defect using `claude-sonnet-5` as its example of an id that was
*absent* from the old table ("`claude-sonnet-5` was NOT in that table, so it silently
got 4096"). True of `openwiki <= 0.4.x`, but once this target *pins* that id the
paragraph reads as though the pin were the known-bad case. Rewrite it to name the id as
historical (e.g. "the id pinned at the time was absent from that table…") while keeping
the literal string `4096` — a guard asserts on it (T002).

**Done when**: `OPENWIKI_MODEL_ID` is `claude-sonnet-5`, the description still contains
`4096`, and the history paragraph no longer implies the currently-pinned id is unsafe.

---

## T002 — Verify the generator guard with the new id

**Type**: Verification | **Time**: 2 min | **Risk**: None

**Spec reference**: FR-004

```bash
node --test scripts/__tests__/wiki-maintain.guard.test.mjs
```

**Expected**: `pass 20`, **`fail 0`, `skipped 0`**.

> **Watch the skip count.** Two of the four cap assertions `t.skip(...)` when `openwiki`
> is absent from `/usr/local/lib/node_modules`, and a skip reads as a pass. This was run
> against `claude-sonnet-5` during research (R6) and gave 20/0/0 — anything less means
> the guard did not actually check the id.

**If it fails, the model id is wrong — do not relax the guard** (FR-004). It is the only
mechanical check on the property that once produced a ~50% zero-page rate at exit 0.

---

## T003 — Update the generator's runbook

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**Spec reference**: FR-019

**File(s)**: `docs/runbooks/wiki-maintenance.md`

Correct every mention of the generator's model id. Record *why* the change was made
(cost: same vendor, same middleware, −33% on a workload already 92% cache reads) so the
next reader does not treat it as a taste change.

**Do NOT hand-edit** `openwiki/runbooks/wiki-maintenance.md` or
`openwiki/process/wiki-maintenance.md`. Both carry a `resource:` line
(`docs/runbooks/wiki-maintenance.md` and `infrastructure-as-code/project.json`
respectively), so they are derived summaries — fix the source and let regeneration
follow.

**Done when**: the runbook names `claude-sonnet-5`, and `git status` shows no manual
edit under `openwiki/` for this task.

---

## T004 — Open merge 1

**Type**: Process | **Time**: 10 min | **Risk**: None

**Spec reference**: FR-020, SC-002

```bash
git push origin HEAD:075-generator-sonnet-5
# then POST …/pulls with the `git credential fill` credential — never MCM_FORGE_TOKEN,
# and never an AGit push (a refs/pull/N/head runs with NO Actions secrets)
```

**Done when**: the PR is green and merged. Land this **before** the #525/#526
regeneration backlog is worked, so that bulk runs on the cheaper model.

---

# Merge 2 — the gateway (US2, US3, and the blocker)

## T005 — Test: every resolvable model is invocable with the parameters we send

**Type**: Test (new file) | **Time**: 45 min | **Risk**: Medium

**Spec reference**: FR-028. Covers the blocker in [research.md](./research.md) R13.

**Scenarios covered**:
- US2-AC1 precondition: the cached-tier supervisor must actually answer at all.

**File(s)**: `agents/movie-assistant/tests/integration/test_model_invocability.py`

For **every** Anthropic model id this repo can resolve — the fast default, the balanced
default, the escalation default, and each id pinned by a workflow or compose file —
build the model through `build_chat_model` (the real seam, not a hand-rolled
`ChatAnthropic`) and make one minimal call. Assert no 4xx. Keep `max_tokens` tiny; this
costs a handful of tokens per model.

Gate with `require_live_credential` from `tests/integration/live_model.py` so it fails
rather than skips under `MCM_REQUIRE_LIVE_MODEL=1`, and wrap calls in `invoke_or_skip`
so a 529 reads as capacity, not as a parameter defect. Mark it **`not golden`** — it
must not enter the keyless replay gate.

**Verify RED**:
```bash
cd agents/movie-assistant && ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  MCM_REQUIRE_LIVE_MODEL=1 uv run pytest tests/integration/test_model_invocability.py -v
```
**Expected RED**: failures for `claude-opus-4-8` (today's escalation default) and for any
Sonnet-5/Opus-5 id under test — `400 … '`temperature` is deprecated for this model'`.
`claude-haiku-4-5` and `claude-sonnet-4-6` pass.

> If this shows 0 failures, the test is not exercising `build_chat_model`'s parameter
> path — the whole point is that the *current* code sends `temperature` unconditionally.

---

## T006 — Stop sending a sampling parameter to models that reject it; move escalation to the current frontier

**Type**: Implementation | **Time**: 1 h | **Risk**: Medium

**Spec reference**: FR-026, FR-026a, FR-027

**Prerequisite**: T005 complete and verified RED.

**File(s)**: `agents/movie-assistant/src/models.py`

1. `_build_real_chat_model` must stop passing `temperature` unconditionally on the
   Anthropic path. Decide by model id, and **default to omitting** for an id not
   recognised (FR-026a) — omitting never errors, sending can, so the safe default is the
   one that cannot 400 a model generation nobody has met yet. Measured support (R13):
   accepted by `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`; **rejected**
   by `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8`.
2. `_ESCALATION_DEFAULT` → `claude-opus-5`. Same list price as the superseded id, current
   generation, and — unlike the id pinned today — it works once the parameter is dropped.
   Leave the provider pin (`escalation` forces `anthropic`) and the default-off flag
   exactly as they are.
3. Carry a comment recording *why* the parameter is conditional, with the measured
   table. Without it the next person "tidies" it back to unconditional.

Do **not** change the Ollama path — it accepts `temperature` and relies on it.

**Verify GREEN**:
```bash
cd agents/movie-assistant && ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  MCM_REQUIRE_LIVE_MODEL=1 uv run pytest tests/integration/test_model_invocability.py -v
```
**Expected GREEN**: 0 failures — every resolvable id answers.

**Also run the touched suite**:
```bash
pnpm nx test movie-assistant
```
**Expected**: previously passing tests still pass (`tests/unit/test_models.py` and
`test_agent_config_injection.py` assert on the escalation default — update their
expectations as part of this task, not as a follow-up).

---

## T007 — Test: a provider-scoped model pin resolves ahead of a bare one

**Type**: Test | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-007a, FR-007b. Covers [research.md](./research.md) R12.

**File(s)**: `agents/movie-assistant/tests/unit/test_models.py`

`select_model_config` is pure, so this is offline and cannot skip. Assert:

| env | expected |
|---|---|
| `MODEL_PROVIDER=anthropic`, `ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5` | cached tier |
| `MODEL_PROVIDER=ollama`, `ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5` | `qwen2.5` — **inert** |
| `MODEL_PROVIDER=ollama`, `SUPERVISOR_MODEL=qwen2.5:14b` | `qwen2.5:14b` — bare name still works |
| both set, `MODEL_PROVIDER=anthropic` | scoped wins |

The second row is the one that matters: it is the regression that would send a Claude id
to Ollama on a `provider: ollama` dispatch.

**Verify RED**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "provider_scoped"
```
**Expected RED**: the first and fourth rows fail — `select_model_config` does not read
the scoped name yet, so it falls through to the tier default.

---

## T008 — Resolve a provider-scoped override ahead of the bare one

**Type**: Implementation | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-007b

**Prerequisite**: T007 complete and verified RED.

**File(s)**: `agents/movie-assistant/src/models.py`

Resolution order per node becomes:
`env[f"{PROVIDER.upper()}_SUPERVISOR_MODEL"]` → `env["SUPERVISOR_MODEL"]` → tier default
(and the same for the specialist). This moves a convention currently implemented only in
`scripts/agent-stack.mjs` into the pure function the canonical invariant names as the
single place model selection happens, so a pin can no longer reach the wrong provider on
*any* surface.

**Record why `runtime_env`'s pop list is not extended.** It pops exactly
`SUPERVISOR_MODEL`, `SPECIALIST_MODEL` and `ESCALATION_MODEL` when a per-user config
switches provider, so that an Anthropic user never inherits an Ollama id. This task adds
a *family* of scoped names it does not pop — and it must not need to, because a scoped
name is inert on the wrong provider by construction: a run with `MODEL_PROVIDER=ollama`
reads `OLLAMA_SUPERVISOR_MODEL`, never `ANTHROPIC_SUPERVISOR_MODEL`. Leave the pop list
alone and put that reasoning in a comment beside it, or the next reviewer reads the
three-name list as an oversight and "fixes" it. FR-016 is preserved by the design, not
by the pop list.

**Verify GREEN**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "provider_scoped"
```
**Expected GREEN**: 0 failures.

---

## T009 — Test: the built classification messages survive the Ollama adapter

**Type**: Test (new file) | **Time**: 45 min | **Risk**: Low

**Spec reference**: FR-025, FR-022. Covers [research.md](./research.md) R11.

**File(s)**: `agents/movie-assistant/tests/unit/test_ollama_adapter_accepts_shape.py`

**Feed the messages `classify_intent` actually builds** through
`ChatOllama._convert_messages_to_ollama_messages` — do not hand-build a fixture message.
A hand-built fixture asserts a shape that can drift away from the real one; taking the
builder's own output means the guard tracks the prompt.

`ChatOllama(model="qwen2.5", base_url="http://127.0.0.1:1")` constructs without
connecting, so this is offline, needs no server, and cannot skip. Assert the converted
system message carries the instruction text and **no** `cache_control`, and that the
user turn carries the user's text.

> Note from R1: the converter accumulates with `content += f"\n{text}"` from an empty
> string, so the rendered system content has a **leading newline**. Expected, not
> corruption — assert accordingly.

**Verify RED**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "ollama_adapter"
```
**Expected RED**: fails to import/call the message-building helper — it does not exist
while `classify_intent` still returns a single concatenated string.

> This is why the test consumes the builder rather than a fixture: a fixture-based
> version would pass immediately, and a test that was never RED is not a TDD test.

---

## T010 — Test: the cacheable prefix is byte-identical across calls

**Type**: Test (new file) | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-006, SC-006

**Scenarios covered**:
- US2-AC5: a later edit that breaks prefix stability fails and names prefix drift.

**File(s)**: `agents/movie-assistant/tests/unit/test_supervisor_prompt_cache.py`

Build the classification messages twice with **different** user text. Assert the system
block is byte-identical between the two, and that it carries
`cache_control: {"type": "ephemeral"}`. Offline, no credential, cannot skip.

Write the failure message to name **prefix instability** as the cause and point at the
static block — the next person to see this will have just edited the intent taxonomy and
will otherwise read it as a flake (SC-006).

**Verify RED**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "prompt_cache"
```
**Expected RED**: fails — there is no separable static block to compare while the prompt
is one string ending in `f"Message: {last}"`.

**Then verify the test can actually catch what SC-006 promises** — after T011 lands,
temporarily interpolate something per-call into the static block (a timestamp, a counter)
and re-run:

```bash
pnpm nx test movie-assistant -- --testNamePattern "prompt_cache"   # with the prefix deliberately broken
```
**Expected**: 1 failure, and **the message names prefix instability and points at the
static block** — not a bare `assert a == b` diff of two 2,650-token strings. Revert the
mutation afterwards.

> This step is the difference between having an assertion and having a *usable* one.
> SC-006 is a claim about the failure message, so the only way to verify it is to read
> the message a real break produces. An unreadable diff here means the next person
> treats the failure as a flake, which is exactly the outcome this test exists to
> prevent.

---

## T011 — Split the classification prompt into a cached static block and a user turn

**Type**: Implementation | **Time**: 1.5 h | **Risk**: Medium

**Spec reference**: FR-005, FR-006, FR-012, FR-022

**Prerequisite**: T009 and T010 complete and verified RED.

**File(s)**: `agents/movie-assistant/src/nodes/supervisor.py`

Extract the ~2,650-token taxonomy into a module-level constant and a small builder that
returns:

```
[ SystemMessage(content=[{"type": "text", "text": <static>,
                          "cache_control": {"type": "ephemeral"}}]),
  HumanMessage(content=<user text>) ]
```

`classify_intent` invokes the model with that list instead of the concatenated string.
**The static text must interpolate nothing** — no timestamp, no id, no f-string hole
(FR-006). Everything volatile goes in the human turn, after the marker.

Keep the return contract exactly: lowercase, strip, and map anything outside `INTENTS`
to `"ambiguous"`.

One shape, **no provider branch** (R1) — verified inert on Ollama and on the fast
Anthropic tier, honoured on the cached tier.

**Verify GREEN**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "prompt_cache|ollama_adapter"
```
**Expected GREEN**: 0 failures.

**Also run the touched suite**:
```bash
pnpm nx test movie-assistant
```
**Expected**: previously passing unit tests still pass. The golden suite will now fail —
that is T015/T016, and it is the intended loud miss.

---

## T012 — Test: a repeated classification is served from cache

**Type**: Test (new file) | **Time**: 1 h | **Risk**: Medium

**Spec reference**: FR-009, FR-010, FR-011, SC-003

**Scenarios covered**:
- US2-AC1: the second of two successive classifications reports cache reads > 0.
- US2-AC2: with no credential under the gate flag, it **fails** rather than skipping.
- US2-AC3: on the fast tier the marking is ignored and the call still succeeds.

**File(s)**: `agents/movie-assistant/tests/integration/test_prompt_cache_effectiveness.py`

Pin the cached tier via a local env `Mapping` passed to `select_model_config` — it is
pure, so no process-env mutation is needed. Classify twice in succession against the
real provider with `LLM_CASSETTE_MODE` unset. Assert on the **second** response:
`usage_metadata["input_token_details"]["cache_read"] > 0`.

Add a second case on the fast tier asserting the call **succeeds** (the marker is
ignored below its 4,096-token minimum) — FR-012/US2-AC3.

Gate with `require_live_credential`; wrap in `invoke_or_skip`. Mark **`not golden`**.

The failure message for a zero `cache_read` must name prefix instability and say that a
provider outage would have surfaced as a capacity failure instead — FR-011.

**Verify RED**:
```bash
cd agents/movie-assistant && ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  MCM_REQUIRE_LIVE_MODEL=1 uv run pytest tests/integration/test_prompt_cache_effectiveness.py -v
```
**Expected RED**: 1 failure — `cache_read` is 0, because nothing has yet selected the
cached tier for this call.

**Canonical order**: write and RED this test *here*, after T011, and leave it RED until
T013 pins the burst surfaces. It is RED for a different reason before T011 (no cacheable
block exists at all) but that is not the state this test is for — the assertion under
test is "the cached tier serves a repeat from cache", and that only becomes meaningful
once the block exists. Do not reorder it ahead of T011.

> **Instrument check**: drop `MCM_REQUIRE_LIVE_MODEL=1` and a missing credential becomes
> a **skip** at exit 0. Always read the skip count, not just the exit code.

---

## T013 — Select the cached-tier supervisor on the burst surfaces

**Type**: Implementation / Config | **Time**: 45 min | **Risk**: Medium

**Spec reference**: FR-007, FR-007a, FR-008

**Prerequisite**: T012 verified RED; T008 complete (scoped resolution must exist first).

**File(s)**: `.forgejo/workflows/app-ci.yml`, `.devcontainer/devcontainer.json`

Add to the **`app-e2e` job env** (not workflow-wide) and to the dev container:

```yaml
ANTHROPIC_SUPERVISOR_MODEL: claude-sonnet-5
```

**Use only the provider-scoped name.** A bare `SUPERVISOR_MODEL` follows whichever
provider is active, and `app-ci.yml` offers `provider: choice [anthropic, ollama]` — so a
bare pin sends a Claude id to Ollama on that dispatch (R12, measured).

Do **not** touch `test:golden` or `test:golden-live`: they keep the code defaults so the
pre-deploy gate certifies what production runs (R3). Do **not** touch
`compose.prod.yaml`'s env — production pins nothing by design (FR-008).

**Also fix the stale comment in the file you are already opening.**
`.devcontainer/devcontainer.json:135` describes the re-record path as
"golden's surface is Claude — claude-haiku-4-5 / claude-sonnet-4-6". After T014 the
specialist is `claude-haiku-4-5`, so leaving it would put a stale id directly beside the
new pin — the worst place for one, because the next reader takes the neighbouring line
as current.

**Verify GREEN**:
```bash
cd agents/movie-assistant && ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  MODEL_PROVIDER=anthropic ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5 \
  MCM_REQUIRE_LIVE_MODEL=1 uv run pytest tests/integration/test_prompt_cache_effectiveness.py -v
```
**Expected GREEN**: 0 failures — the second call reports a non-zero cache read.

---

## T014 — Test: the extraction specialist resolves to the fast tier

**Type**: Test | **Time**: 15 min | **Risk**: Low

**Spec reference**: FR-013, SC-004

**Scenarios covered**:
- US3-AC1: every extraction pair still yields its expected structured output (the model
  change this asserts is what T015's re-record then exercises end to end).

**File(s)**: `agents/movie-assistant/tests/unit/test_models.py`

Assert that `select_model_config("curator"|"organizer"|"query", {"MODEL_PROVIDER": "anthropic"})`
resolves to `claude-haiku-4-5`. Offline, pure, cannot skip.

**Verify RED**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "balanced|specialist"
```
**Expected RED**: assertion error — resolves to `claude-sonnet-4-6`.

---

## T014a — Drop the extraction specialist default to the fast tier

**Type**: Implementation | **Time**: 15 min | **Risk**: Medium

**Spec reference**: FR-013, FR-008, SC-004

**Prerequisite**: T014 complete and verified RED.

**File(s)**: `agents/movie-assistant/src/models.py`

Change `_BALANCED_DEFAULTS["anthropic"]` to `claude-haiku-4-5`. This is a **code
default**, not a deployment setting — that is precisely what carries the saving to BYOK
users with the next gateway image (FR-008), because `compose.prod.yaml` pins nothing.

**Comment the tier convergence.** After this change `_FAST_DEFAULTS["anthropic"]` and
`_BALANCED_DEFAULTS["anthropic"]` both hold `claude-haiku-4-5`, so on Anthropic the two
tiers resolve identically and `SUPERVISOR_MODEL` vs `SPECIALIST_MODEL` stops being a
distinction without an explicit override. That is intended — the extraction prompts are
120–520 tokens returning a small object, work the fast tier handles, and they are far
too short to cache under any model, so cheapest-per-token wins. Say so in the file, or
the duplicated value reads as a copy-paste error and someone "restores" the balanced id.
The tables stay separate because the Ollama column still differs (`qwen2.5` vs
`qwen2.5:32b`) and because a future provider may diverge again.

**Verify GREEN**:
```bash
pnpm nx test movie-assistant -- --testNamePattern "balanced|specialist"
```
**Expected GREEN**: 0 failures.

**Also run the touched suite**:
```bash
pnpm nx test movie-assistant
```
**Expected**: previously passing unit tests still pass.

---

## T015 — Re-record the Anthropic cassettes

**Type**: Fixture regeneration | **Time**: 45 min + model time | **Risk**: High

**Spec reference**: FR-017

**Prerequisite**: T006, T011 and T014 complete. **Spends real money.**

42 of 43 cassettes are invalidated: 31 supervisor cassettes by the prompt shape, 11
extraction cassettes by the specialist id (`claude-sonnet-4-6` → `claude-haiku-4-5`).

```bash
cd agents/movie-assistant && ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" \
  LLM_CASSETTE_MODE=record uv run pytest tests/integration -m golden
```

**The assertions are semantic, not snapshot** (`assert intent == "out_of_domain"`), so a
recording that captures a wrong answer fails at record time. A regression cannot be
laundered by re-recording — but it also means a RED here is a real classification or
extraction regression on the cheaper model, and it **blocks the change** rather than
being waived.

**Done when**: the record run is green and `git status` shows 42 changed cassettes.

---

## T016 — Re-record the Ollama cassette

**Type**: Fixture regeneration | **Time**: 30 min | **Risk**: Medium

**Spec reference**: FR-023, FR-024

**Prerequisite**: T011 complete. **Needs a local Ollama serving `qwen2.5` — an Anthropic
key cannot regenerate this one.**

`topic-confinement.qwen2-5.json` is keyed to `qwen2.5` and the prompt restructure moves
its key like every other.

```bash
ollama serve &            # if not already running
ollama pull qwen2.5
cd agents/movie-assistant && MODEL_PROVIDER=ollama LLM_CASSETTE_MODE=record \
  uv run pytest tests/integration/test_out_of_domain.py
```

This is also the **only** measurement of live `qwen2.5` behaviour on the new message
shape (R9). If the semantic assertions fail here, `qwen2.5` regressed: fall back to the
single-string shape on the Ollama path only, accepting the provider branch R1 otherwise
avoids. That fallback is sanctioned (FR-021), not a plan failure.

**Done when**: the keyless gate is green —
```bash
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
```
**Expected**: `51 passed` (was 51 before the change; skipping this task gives
`42 passed, 9 errors`).

---

## T017 — Update the canonical model-provider invariant

**Type**: Documentation | **Time**: 45 min | **Risk**: Low

**Spec reference**: FR-019, FR-019a

**File(s)**: `openwiki/invariants/model-provider-scoping.md`

This page has **no `resource:` line and is listed in `openwiki/protected.yaml`** — it is
**canonical**, so the learning is written *into* it, not into an upstream source.

| Bullet | Action |
|---|---|
| "Dev and test default to self-hosted Ollama" | **Leave unchanged** (FR-019a) |
| "The golden test surface and prod use Anthropic Claude (`claude-haiku-4-5` fast, `claude-sonnet-4-6` balanced)" | Correct the balanced id to `claude-haiku-4-5` |
| "The escalation tier is always Claude frontier (`claude-opus-4-8`)" | → `claude-opus-5` |
| — | **Add** the burst-surface category: CI e2e and the dev container take a cached-tier supervisor by provider-scoped override, while the golden gate and production keep the code defaults |

**Add a Gotcha**: newer models reject the `temperature` parameter with a 400, measured
per-model (R13) — this is exactly a "the obvious approach is wrong" item and belongs
here.

> **Fingerprint**: `protected.yaml` fingerprints the **`Gotchas`** anchor of this page.
> Adding that gotcha changes the passage, so **re-fingerprint in the same change**, per
> the gate's own instruction and the precedent set by feature 049. The model-id bullets
> above the Gotchas are not fingerprinted and need no ceremony.

**Done when**: `pnpm nx okf-lint infrastructure-as-code` and
`pnpm nx okf-governance infrastructure-as-code` both pass.

---

## T018 — Update the agent-layer runbook and the production compose header

**Type**: Documentation | **Time**: 30 min | **Risk**: None

**Spec reference**: FR-019, FR-008

**File(s)**: `docs/runbooks/agent-layer.md`,
`docs/runbooks/devcontainer.md`,
`infrastructure-as-code/docker/agents/compose.prod.yaml`

**`docs/runbooks/devcontainer.md:143`** names `claude-sonnet-4-6` as the re-record
surface. It is the last stale id outside the cassettes and the historical spec folders,
and it is easy to miss because this feature otherwise has no reason to open that file.
Correct it, and leave the surrounding "replay is keyless" statement alone — that is
still true.

Correct the per-node model reference in the runbook. In the compose header comment,
state that the file still pins **neither** `SUPERVISOR_MODEL` nor `SPECIALIST_MODEL`
**deliberately**, and why: the code defaults are production's configuration, which is
what ships the extraction saving to BYOK users, and a lone user turn would pay a cache
write and cost ≈2.5× more on the cached tier (R8).

**Done when**: all three files name the current ids, the compose header explains the
deliberate absence rather than merely noting it, and
`grep -rn "claude-sonnet-4-6\|claude-opus-4-8" --include=*.md --include=*.json --include=*.yaml .`
returns nothing outside `docs/proposals/`, `specs/0[0-6]*/` and the regenerated
cassettes — those are history and stay as they are.

---

## T018a — Verify the four invariants this feature must NOT disturb

**Type**: Verification | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-014, FR-015, FR-016, FR-018. Covers [research.md](./research.md) R10.

These four are *preservation* requirements — nothing in this feature is supposed to
change them, which is exactly why they are the ones that get broken without anyone
noticing. Each already has a home in an existing suite; this task names them so a
reviewer can see they were checked rather than assumed.

| Requirement | What must still hold | Where it is asserted |
|---|---|---|
| **FR-014** | Escalation stays provider-pinned and flag-off; nothing routes to it. T006 changes only its model **id**. | `tests/unit/test_models.py` — `select_model_config("escalation", …)` forces `provider="anthropic"` whatever the base provider; `escalation_or_base` still degrades to the specialist without a key |
| **FR-015** | A per-user run uses that user's credential alone — no shared fallback. | `tests/unit/test_agent_config_injection.py` — `runtime_env` drops an ambient key when the run carries none; `resolve_anthropic_key` reads only the per-run value |
| **FR-016** | A BYOK provider switch inherits no model id from the other provider. | same file — the pop list, **plus** the scoped-name reasoning recorded in T008 |
| **FR-018** | The merge gate needs no credential. | `guardrails.yml` runs `test:golden` in replay; the two new live tests are marked `not golden` so they are never collected there |

```bash
pnpm nx test movie-assistant -- --testNamePattern "escalation|runtime_env|agent_config"
env -u ANTHROPIC_API_KEY -u MCM_ANTHROPIC_API_KEY \
  bash -c 'cd agents/movie-assistant && LLM_CASSETTE_MODE=replay uv run pytest tests/integration -m golden -q'
```

**Expected**: the unit selection passes; the second command passes **with no credential
present at all** — `51 passed`, and no test errors reaching for a key.

> The second command is the real check for FR-018, and it is deliberately run with the
> credentials *unset* rather than merely absent from the command line. A new live test
> accidentally collected into the golden marker would pass on a developer machine that
> happens to have a key exported, and fail only in CI.

**Done when**: both commands pass and the `not golden` marking on
`test_prompt_cache_effectiveness.py` and `test_model_invocability.py` is confirmed by
their absence from the golden run's collected set.

---

## T019 — Full regression, then open merge 2

**Type**: Verification / Process | **Time**: ~1 h | **Risk**: Medium

**Spec reference**: all

Derive the tiers from what the diff touched — Python lint in particular is easy to miss
when only `test` was run.

```bash
pnpm nx affected -t lint test
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
ANTHROPIC_API_KEY="$MCM_ANTHROPIC_API_KEY" pnpm nx test:golden-live movie-assistant
pnpm nx e2e mcm-app          # official Playwright image; ~35 min
```

**Rebuild and redeploy the gateway before the E2E** or the run validates stale code —
then confirm the running container carries the change rather than assuming it.

Then push a real branch and open the PR via the forge API with the `git credential fill`
credential. Never an AGit push.

---

## Completion Checklist

Before marking `075-llm-cost-phase-1` complete, verify all success criteria from
[spec.md](./spec.md):

- [ ] **SC-001**: 30-day spend falls from $74.89 to $37–40 (≈−48%) at unchanged volumes
- [ ] **SC-002**: generator cost per run-day ≈$1.72 → ≈$1.15, no rise in zero-page runs
- [ ] **SC-003**: CI classification input served from cache — **gate**: T012 asserts >0; **confirmation**: >95% read from the billing export (was 0%)
- [ ] **SC-004**: cost per BYOK turn ≈$0.005 → ≈$0.0035
- [ ] **SC-005**: zero regressions in the recorded-interaction suite
- [ ] **SC-006**: a deliberate break of the static prefix fails a check that names prefix instability — **verified by mutation in T010, not by the test merely existing**
- [ ] **FR-014/015/016/018**: the four preservation invariants re-verified (T018a), including a golden run with the credentials unset
- [ ] **SC-007**: generator and gateway reached `main` as separate merges
- [ ] **SC-008**: both providers pass — keyless merge gate (Ollama tier) and pre-deploy gate (Anthropic tier)
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test movie-assistant` — unit tests pass, including the SC-004 token-leak scan
- [ ] `pnpm nx test:integration movie-assistant` — integration tests pass against the real stack
- [ ] `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` — `51 passed`
- [ ] `pnpm nx test:golden-live movie-assistant` — pre-deploy gate green on the code defaults
- [ ] `pnpm nx lint movie-assistant` — ruff + mypy clean
- [ ] `pnpm nx e2e mcm-app` — web E2E passes against a **rebuilt** gateway
- [ ] `pnpm nx okf-lint infrastructure-as-code` / `okf-governance` — knowledge bundle gates pass
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)

**SC-001 through SC-004 are measured from the vendor's billing export a day or more
after merge**, not from any test. The repository defends the *mechanism* (SC-003's
caching, SC-005's behaviour); the *amounts* are confirmed on the console. If the CI key
shows no cache-read rows a day later, check that the `app-e2e` job really sets the
provider-scoped variable name — see
[contracts/model-selection.md](./contracts/model-selection.md).
