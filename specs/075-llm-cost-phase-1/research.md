# Phase 0 research: LLM cost reduction, phase 1

**Feature**: [spec.md](./spec.md) · **Date**: 2026-09-20

Every finding below was verified against the installed packages, the committed
fixtures or the vendor reference in this session. Where it contradicts
[the proposal](../../docs/proposals/MCM-LLM-Cost-Analysis-1.md), that is called out
explicitly — the proposal was written from a read-only review and three of its
premises do not survive contact with the code.

Installed versions this research is valid for: `langchain-core 1.6.2`,
`langchain-anthropic 1.7.2`, `langchain-ollama 1.1.0`, `anthropic 1.5.0`,
`openwiki 0.5.2`.

---

## R1 — One prompt shape works on BOTH providers, and this is the decision the whole feature rests on

**Decision**: Build the classification request as
`[SystemMessage(content=[{"type": "text", "text": <static>, "cache_control": {"type": "ephemeral"}}]), HumanMessage(content=<user text>)]`
— one shape, unconditionally, with no provider branch in `classify_intent`.

**Why this was in doubt**: `classify_intent` is shared by both providers, and the
default provider is Ollama, not Anthropic. `cache_control` is an Anthropic concept.
The obvious fear is that sending it to Ollama raises, forcing a provider branch into
a function that is deliberately provider-agnostic (it receives a `ChatModel`
protocol, not a spec, precisely so the golden harness can inject a cassette).

**What was verified**: `langchain_ollama/chat_models.py:1025-1067` iterates content
parts and dispatches on `content_part.get("type")`. A part with `"type": "text"`
takes the `content_part['text']` branch and **every other key on that dict is
ignored** — the `else: raise ValueError` arm is only reached by a part whose `type`
is neither `text`, `tool_use`, `image_url`, nor a recognised data block. A
`cache_control` key on a `text` part therefore passes through silently.

On the Anthropic side, `langchain_anthropic/chat_models.py:525` explicitly preserves
`("type", "text", "cache_control", "citations")` when converting a content block, so
the marker reaches the wire.

**Consequence**: FR-012 ("the marking MUST be inert where it cannot apply") is
satisfied by construction, on Ollama *and* on the fast-tier Anthropic model whose
4,096-token minimum the ~2,650-token prefix does not clear. No provider branch, no
conditional, no second code path to keep in sync.

**Alternatives rejected**:
- *Pass the provider into `classify_intent` and branch.* Breaks the provider-agnostic
  seam the golden harness depends on, for no benefit given the above.
- *Use the top-level `cache_control` request parameter instead of a content block.*
  `langchain_anthropic/chat_models.py:903` notes only the direct API accepts the
  top-level parameter; the content-block form is the portable one.

---

## R2 — The cache-effectiveness signal already exists on every response

**Decision**: Assert on `AIMessage.usage_metadata["input_token_details"]["cache_read"]`.

**Verified**: `langchain_anthropic/chat_models.py:2970` maps the provider's
`cache_read_input_tokens` onto exactly that key, alongside `cache_creation` from
`cache_creation_input_tokens`. Both are populated on every Anthropic response today —
nothing in this repository reads either. The feature does not add instrumentation; it
adds a reader and an assertion.

**Consequence**: the assertion required by FR-009 needs no new plumbing in the
gateway, no log parsing and no vendor API call beyond the model call it already makes.
It needs the *real* model (a replayed cassette carries no usage metadata), which puts
it in the live-model integration tier — see R7.

---

## R3 — The golden gate must NOT move to the cached tier (correcting the proposal)

**Decision**: `test:golden` and `test:golden-live` stay on the **code defaults**.
Only `app-e2e`'s containerized gateway and the dev container take the cached-tier
supervisor.

**The proposal says** "CI/golden/devcontainer set `SUPERVISOR_MODEL=claude-sonnet-5`".
Grouping `golden` with the other two is wrong, for two independent reasons:

1. **`test:golden-live` is the pre-deploy gate for production, and production runs the
   fast tier.** Its command is
   `LLM_CASSETTE_MODE= MODEL_PROVIDER=anthropic MCM_REQUIRE_LIVE_MODEL=1 uv run pytest tests/integration -m golden`
   — it deliberately sets **no** per-node model pin so the code defaults rule, which is
   exactly the production configuration (`compose.prod.yaml` pins nothing either).
   Pinning the cached tier there would make the gate certify a configuration that never
   ships. A deploy gate that validates something other than what deploys is not a gate.
2. **Cassettes are keyed by model id.** `test:golden` runs in replay. Pinning a
   different supervisor id would miss every one of the 31 committed supervisor
   cassettes and fail the merge gate, or force a second parallel set of cassettes to
   be recorded and maintained at double the re-record cost.

**What then covers the cached-tier supervisor?** The `app-e2e` live agent flows, which
drive the real gateway with that model and assert real routing outcomes, plus the new
cache assertion from R7. Deterministic coverage of the fast tier (what prod runs) comes
from the golden pairs; live coverage of the cached tier (what CI runs) comes from
`app-e2e`. Neither surface is unvalidated.

**Cost impact of this correction**: the deploy gate keeps its current $5.62/30 days
rather than shrinking. The spec already records that figure as proportionate and not a
target, so the correction costs nothing the feature was counting on. The $22 that
actually matters is in `app-e2e`, which is unaffected by this decision.

---

## R4 — Which variable, on which surface

**Decision**:

| Surface | Variable | Value | Reaches the model via |
|---|---|---|---|
| `app-e2e` containerized gateway | `ANTHROPIC_SUPERVISOR_MODEL` | cached tier | `scripts/agent-stack.mjs` maps it to a `-e SUPERVISOR_MODEL` on the container |
| `app-e2e` in-job live integration tests (`-m "not golden"`) | `SUPERVISOR_MODEL` | cached tier | read directly from the job env by `select_model_config` |
| Dev container | `ANTHROPIC_SUPERVISOR_MODEL` | cached tier | same as the CI gateway |
| `test:golden` / `test:golden-live` | *(unset)* | code default | R3 |
| Production | *(unset)* | code default | `compose.prod.yaml` pins nothing |

**Why two different names on one job**: `agent-stack.mjs` maintains this split
deliberately. `SUPERVISOR_MODEL` defaults to `qwen2.5` there and is passed straight
through on the Ollama path; setting it globally to an Anthropic id would send that id
to Ollama. The script therefore reads `ANTHROPIC_SUPERVISOR_MODEL` for the Anthropic
path and forwards it as `SUPERVISOR_MODEL` only into the container
(`scripts/agent-stack.mjs:417-420`). The in-job pytest process has no such indirection
and reads `SUPERVISOR_MODEL` itself. The seam already exists; this feature uses it
rather than adding one.

**Alternative rejected**: changing the fast-tier code default to the cached tier and
overriding *back* to the fast tier in production. Inverts the safe direction — a
missing override would then bill production users at cache-write rates (R8), and
`compose.prod.yaml` pins nothing by design.

---

## R5 — Re-record scope, exactly

**Verified inventory** — 43 committed cassettes:

| Keyed model id | Count | Invalidated by | Re-recorded as | Credential needed |
|---|---|---|---|---|
| `claude-haiku-4-5` (supervisor/intent) | 31 | prompt restructure only | `claude-haiku-4-5` | Anthropic |
| `claude-sonnet-4-6` (specialist/extract) | 11 | specialist default change | `claude-haiku-4-5` | Anthropic |
| `qwen2.5` (topic confinement) | 1 | prompt restructure only | `qwen2.5` | **a running local Ollama** |

**The one-line trap**: that last row is the only cassette this feature invalidates
that an Anthropic key cannot regenerate. `tests/integration/test_out_of_domain.py`
carries `topic-confinement.qwen2-5.json`, and the prompt restructure changes its key
like every other. Re-recording it needs Ollama serving `qwen2.5` locally. Missing this
produces a `CassetteMissError` in replay that looks like a regression in a suite
nobody associates with the Anthropic change.

**Why the key changes**: `cassette_key` hashes `model_id + "\n" + "\n".join("{role}: {text}")`
over a normalized input (`src/eval/cassette.py:32-49`). `_normalize` already handles a
list of LangChain messages — so the message-list shape needs no cassette-layer change —
but it stringifies each message's `content`, so the structured block (including the
`cache_control` dict) becomes part of the key. Deterministic, therefore fine; but it
does mean the key changes, which is the intended loud failure.

**Guard**: `invoke_or_skip` in `tests/integration/live_model.py` re-raises
`CassetteMissError` **by type, before** its overload-text heuristic runs, precisely so
a drift signal is never downgraded to a capacity skip. Nothing in this feature may
weaken that ordering.

---

## R6 — The generator model bump is clean (correcting the proposal)

**Decision**: set `OPENWIKI_MODEL_ID=claude-sonnet-5` in
`infrastructure-as-code/project.json`. Change nothing else — not the guard, not the
output cap, not the pinned `openwiki` version.

**The proposal warns** the guard test "reads `@langchain/anthropic`'s max-token table
and will flag an id it doesn't know", and suggests relaxing that assertion. **It will
not flag it.** Both layers were read directly:

- `openwiki/dist/agent/index.js:899-907` — `resolveAnthropicMaxOutputTokens` matches
  `/^claude-(?:haiku|sonnet|opus)-(?:4|5)(?:[-.@]|$)/u`, which `claude-sonnet-5`
  satisfies, returning the explicit 16,384 default.
- `@langchain/anthropic/dist/chat_models.js:26` — the fallback table carries an
  explicit `"claude-sonnet-5": 16384` entry.

Both of the guard's conditional assertions therefore pass, and the two unconditional
ones (an explicit cap is set, at or above 16,384; the reason is recorded in the target
description) are untouched by a model-id change. FR-004 forbids relaxing the guard
regardless — it is the only mechanical check on the property that once produced a ~50%
zero-page rate while reporting exit 0.

**Measured, not inferred.** The bump was applied on a scratch copy and the guard run
end to end on 2026-09-20:

```
✔ the target sets an explicit per-turn output cap, at or above what a page-writing turn needs
✔ the target records WHY the cap is pinned, so it is not "tidied" back
✔ openwiki still resolves an explicit per-turn cap for the pinned model
✔ the pinned generator model does NOT fall back to the 4096-token per-turn cap
ℹ tests 20   ℹ pass 20   ℹ fail 0   ℹ skipped 0
```

The skip count is the part that matters: the two conditional assertions `t.skip(...)`
when openwiki is absent from `/usr/local/lib/node_modules`, and a skip reads as a pass.
They ran. The change was then reverted — the branch stays spec-only until `tasks.md`
exists, per the repository's SDD gate.

**One editorial consequence to handle at implementation time.** The target's
`description` recounts the original defect using `claude-sonnet-5` as its example of an
id that was *absent* from the old table ("`claude-sonnet-5` was NOT in that table, so it
silently got 4096"). That history is still true of `openwiki <= 0.4.x`, but once the
target *pins* that id the paragraph reads as though the pin were the known-bad case.
The guard only requires the string `4096` to survive, so the sentence can be reworded
freely — it must be, or the next reader draws the opposite conclusion from the one the
paragraph is there to convey.

---

## R7 — Where the cache assertion lives, and how it fails rather than skips

**Decision**: a new live-model integration test in
`agents/movie-assistant/tests/integration/`, reusing the existing escalation helpers
rather than inventing a second gating mechanism.

**Mechanics**:
- Select the supervisor spec with the cached tier pinned in the test's own env mapping
  (`select_model_config` is pure over a `Mapping`, so this needs no process-env
  mutation), build the real model with `LLM_CASSETTE_MODE` unset, and classify twice.
- Assert `usage_metadata["input_token_details"]["cache_read"] > 0` on the **second**
  call. The first pays the cache write; a five-minute TTL comfortably covers two
  back-to-back calls.
- Gate with `require_live_credential(env, purpose)` from
  `tests/integration/live_model.py`, which **fails** under `MCM_REQUIRE_LIVE_MODEL=1`
  and skips otherwise — satisfying FR-010 with the rule that already exists, measured
  into place by feature 048 after a credential-less gate reported `1 passed, 50 skipped,
  exit 0`.
- Wrap the calls in `invoke_or_skip` so a provider overload is classified as
  infrastructure, not as "caching is broken" — FR-011.

**The distinguishing failure message matters (FR-011, SC-006)**: a zero `cache_read`
has exactly one interesting cause — prefix instability. The assertion message must say
so and name the static block, because the next person to see it will have just edited
the intent taxonomy and will otherwise read it as a flake.

**A second, free, offline assertion**: a unit test that builds the classification
messages twice and asserts the static block is byte-identical. It costs nothing, needs
no credential, cannot skip, and catches the interpolation mistake (FR-006) at merge
time rather than at deploy time. The live test proves caching *engages*; the unit test
proves the *prefix is stable*. Both are cheap; neither substitutes for the other.

---

## R8 — Production stays on the fast tier, and the arithmetic is why

**Decision**: `_FAST_DEFAULTS["anthropic"]` is unchanged.

Verified against the vendor reference on 2026-09-20: fast tier $1.00/M input, minimum
cacheable prefix **4,096** tokens; cached tier $2.00/M input with cache writes at
$2.50/M and cache reads at $0.20/M, minimum prefix **1,024** tokens. The classifier
prefix is ~2,650 tokens — above the cached tier's minimum, below the fast tier's.

Per classification, at a cache hit rate *h*:

| | cost |
|---|---|
| Fast tier, uncached (today, and unavoidable — 2,650 < 4,096) | $0.00265 |
| Cached tier, h = 0 (pays the write every time) | $0.0066 |
| Cached tier, h = 0.5 | $0.0037 |
| Cached tier, h = 0.65 | ≈$0.00265 — **break-even** |
| Cached tier, h = 0.95 (CI burst) | ≈$0.0006 |

Production turns are minutes to days apart — the owner's own key shows days with a
single turn — so the five-minute entry is almost always expired and *h* tends to zero.
Moving production to the cached tier would cost users **≈2.5×** more per turn, and
they pay from their own capped balance. The asymmetry is the feature's central
constraint, and it is why the choice is environment configuration (R4) rather than a
single global default.

---

## R9 — The Ollama prompt shape changes, and that is a real (small) risk

**Finding**: today `classify_intent` calls `model.invoke(prompt)` with a single
string, which LangChain renders as one user message. After R1 it becomes a system
message plus a user message. For the Anthropic path this is the point of the change.
For the Ollama path it is an uncompensated behaviour change: `qwen2.5` will see the
taxonomy in a system role rather than inline in a user turn.

**Assessment**: system-role placement is the better prompt shape and is the
conventional one, so the expected direction is neutral-to-positive. But "expected" is
not "measured", and the repository already documents that `qwen2.5` misclassifies edge
cases the Anthropic models get right (for example "exit search" → `out_of_domain`).

**Decision**: treat the single `qwen2.5` cassette re-record (R5) as the measurement,
and run the local Ollama tier once after the restructure rather than assuming. This is
cheap — one cassette, one local model — and it is the only evidence that the default
provider did not regress. If `qwen2.5` does regress, the fallback is to keep the
single-string shape for the Ollama path only, accepting a provider branch in
`classify_intent` that R1 otherwise avoids.

---

## R10 — What this feature must not disturb

Read and confirmed still-intact, with no change required by this feature:

- **No shared-credential fallback.** `runtime_env` drops any ambient Anthropic key for
  a run carrying no per-user key, and `resolve_anthropic_key` reads only the per-run
  value. FR-015.
- **Per-node pins are dropped on a provider switch.** `runtime_env` pops
  `SUPERVISOR_MODEL` / `SPECIALIST_MODEL` / `ESCALATION_MODEL` when a per-user config
  selects a different provider, so an Anthropic user never inherits an Ollama id (and
  vice versa). This is what makes R4's environment pins safe in the presence of BYOK.
  FR-016.
- **Escalation stays pinned and dormant.** `escalation_or_base` degrades to the
  specialist without an Anthropic key; the flag defaults off. FR-014.
- **The keyless replay gate stays keyless.** `guardrails.yml` runs `nx test:golden` in
  replay with no credential. FR-018.
