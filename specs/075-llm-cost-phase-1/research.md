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

**Executed, not just read** (2026-09-20). `ChatOllama` constructs without connecting, so
the converter can be driven offline with no server:

```python
m = ChatOllama(model="qwen2.5", base_url="http://127.0.0.1:1")   # never connects
m._convert_messages_to_ollama_messages([SystemMessage(...cache_control...), HumanMessage(...)])
# → system | '\nYou route a user message. Labels: add, enrich, ...'
#   user   | 'find the movie Dune'
```

Two things this establishes:

1. `cache_control` is dropped and the text survives — R1 confirmed by execution.
2. **It runs offline with no Ollama server**, which means this is CI-gateable. See
   R11 — it is not currently gated anywhere, and that is the real hole.

**A detail the reading missed**: the converter accumulates with
`content += f"\n{content_part['text']}"` starting from `""`, so the Ollama-rendered
system content carries a **leading newline** the current single-string prompt does not.
Harmless semantically, but it is real bytes the model sees and it is part of the
re-recorded cassette key. Worth knowing before someone treats it as corruption.

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

**Decision**: treat the `qwen2.5` cassette re-record (R5) as the measurement, and run
the local Ollama tier after the restructure rather than assuming. If `qwen2.5` does
regress, the fallback is to keep the single-string shape for the Ollama path only,
accepting a provider branch in `classify_intent` that R1 otherwise avoids.

**The repository already enforces this, and more strongly than first assessed.**
`tests/integration/test_out_of_domain.py` resolves its cassette **from the resolved
model id** (`_cassette_path(spec.model_id)`), and the two tiers are recorded as separate
files on purpose. So the same 9 in-domain / out-of-domain assertions replay under
**both** providers:

| Gate | `MODEL_PROVIDER` | Resolves to | Cassette replayed |
|---|---|---|---|
| `guardrails` (keyless merge gate, every PR) | **unset** | Ollama tier | `topic-confinement.qwen2-5.json` |
| `test:golden-live` (pre-deploy) | `anthropic` | fast tier | live, no cassette |

Consequences that matter for this feature:

1. **The Ollama classification path is covered by a merge-blocking gate on every PR** —
   not by a single loose fixture. `guardrails` leaves `MODEL_PROVIDER` unset, which is
   precisely why the Ollama tier is what it replays.
2. **The prompt restructure will fail that gate until the `qwen2.5` cassette is
   re-recorded**, with `pytest.fail("no cassette for supervisor model 'qwen2.5' … A
   missing cassette is drift, not a reason to skip")`. This is a hard blocker by
   construction — the Ollama path cannot silently break, and the re-record cannot be
   quietly skipped.

**What that gate does and does not prove.** It proves the restructured prompt still
flows through the Ollama code path and still yields the right label on those 9 inputs —
because re-recording is itself a live `qwen2.5` invocation, and replay then pins its
answers. It does **not** prove `qwen2.5`'s accuracy is unchanged on inputs outside those
9. `test_models_build.py` invokes a real Ollama but skips in CI (allowlisted — CI runs
no Ollama), so the broader local check is a developer action, covered in the quickstart.

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

---

## R11 — CORRECTION: replay does not exercise the Ollama adapter, so R1 is ungated

**Raised by the operator, 2026-09-20**: *"Ollama is the default for this dev container
only. Ollama doesn't exist in CI."* Correct, and chasing it down overturned part of R9.

**What R9 got right** (each verified by running it, not by reading):

- `guardrails` sets only `LLM_CASSETTE_MODE: replay` on the golden step — no
  `MODEL_PROVIDER` anywhere in the workflow — so `select_model_config("supervisor", {})`
  returns `ModelSpec(provider='ollama', model_id='qwen2.5')`.
- `test_out_of_domain.py` carries a module-level `pytestmark = pytest.mark.golden`, so
  it *is* collected by `pytest tests/integration -m golden`.
- The `qwen2.5` cassette is genuinely load-bearing on every PR. Removing it takes the
  gate from **51 passed** to **42 passed, 9 errors**.
- None of this needs an Ollama server — it is pure replay.

**What R9 got wrong.** Under replay, `build_chat_model` returns a `ReplayChatModel`
**and never constructs `ChatOllama` at all**. So the guardrails gate exercises
`classify_intent`'s message construction and the cassette layer — but **not one line of
`langchain_ollama`'s message conversion**. The R1 finding that makes the whole
single-shape design safe is therefore verified by source reading plus a local
execution, and by **nothing in continuous integration**.

Accurate coverage table:

| Property | Exercised by | Runs in CI? |
|---|---|---|
| `classify_intent` builds the right messages; labels still correct on the Ollama tier | `guardrails` golden replay | **Yes, blocking, every PR** |
| `langchain_ollama` drops `cache_control` without raising (**the R1 claim**) | nothing today | **No** |
| A live `qwen2.5` still classifies correctly on the new shape | the re-record; `test_models_build.py` | **No** — the latter skips in CI (allowlisted; CI runs no Ollama) |

**Decision**: close the middle row with an offline unit test that drives
`ChatOllama._convert_messages_to_ollama_messages` directly — proven feasible above,
needs no server, cannot skip, and asserts exactly the property the design rests on
(`cache_control` absent from the converted message, static text intact). This is FR-025.

**Why this matters more than it looks.** The failure it guards is a *dependency-bump*
failure, not an authoring failure. If a future `langchain-ollama` tightens that
`else: raise ValueError` arm to reject unknown keys on a text part, the single-shape
design breaks for the default provider — and today nothing would catch it until someone
ran the assistant locally against Ollama. A Renovate bump could land it silently.

**Correction to the earlier claim** that "each provider has its own blocking gate": CI
blocks on the Ollama *cassette*, not on the Ollama *adapter*. With FR-025 the statement
becomes true for the part that matters; the live-model dimension stays a local check by
design, which is the same position every other provider-live behaviour occupies here.

---

## R12 — CORRECTION: R4's job-scope pin would break the `provider: ollama` path

**Raised by the operator, 2026-09-21**, checking this feature against
`openwiki/invariants/model-provider-scoping.md` bullet 1 — *"Dev and test default to
self-hosted Ollama"*. The check found a defect in R4, not a wording problem.

**The invariant's three rules, and what this feature does to each**:

| Invariant rule | Effect of this feature |
|---|---|
| Dev and test default to self-hosted Ollama (`qwen2.5` / `qwen2.5:32b`) | **Unchanged.** No default moves; `MODEL_PROVIDER` still defaults to `ollama`. |
| The golden surface and prod use Claude (`claude-haiku-4-5` fast, `claude-sonnet-4-6` balanced) | **The balanced id changes** to `claude-haiku-4-5`. The page must be corrected (FR-019) — it is canonical, so the learning goes *into* it. |
| Escalation is always `claude-opus-4-8`, unconditionally | **Unchanged.** |

Plus one category the page does not yet describe: the **burst CI surfaces** take a
cached-tier supervisor. That is new text, not a correction.

**The defect.** R4 said to set, at `app-e2e` job scope, both
`ANTHROPIC_SUPERVISOR_MODEL` (for the container) and a bare `SUPERVISOR_MODEL` (for the
in-job pytest process). But `app-ci.yml` declares a `workflow_dispatch` input
`provider: choice [anthropic, ollama]`, and the job reads
`MODEL_PROVIDER: ${{ github.event.inputs.provider || vars.MODEL_PROVIDER || 'anthropic' }}`.
So that job **can** run on Ollama — and a bare, unconditional job-scope pin follows it
there. Measured:

```
MODEL_PROVIDER=ollama + SUPERVISOR_MODEL=claude-sonnet-5
  → ModelSpec(provider='ollama', model_id='claude-sonnet-5')   # an Anthropic id sent to Ollama
MODEL_PROVIDER=ollama + ANTHROPIC_SUPERVISOR_MODEL=claude-sonnet-5
  → ModelSpec(provider='ollama', model_id='qwen2.5')           # correctly inert
```

`agent-stack.mjs`'s Ollama branch pushes `-e SUPERVISOR_MODEL=${SUPERVISOR_MODEL}`
(`process.env.SUPERVISOR_MODEL || 'qwen2.5'`), so the container breaks the same way.
R4's own contract file even warned that a bare pin "would be wrong on any job that can
run with `provider: ollama`" — and then specified it on exactly such a job. The caveat
contradicted the instruction.

**The dev container is fine**, and for the reason the invariant implies: the
`ANTHROPIC_*` names are read only on the Anthropic path, so a pin in
`devcontainer.json` is inert while a developer stays on the Ollama default. Bullet 1
holds there without any change.

**Decision — fix it at the cause, not with a conditional.** Teach
`select_model_config` to honour a **provider-scoped** override ahead of the bare one:

```
SUPERVISOR_MODEL  resolution: env[f"{PROVIDER}_SUPERVISOR_MODEL"] → env["SUPERVISOR_MODEL"] → tier default
```

Rationale:

- It makes the rule *unbreakable by configuration* rather than documented-around. A
  provider-scoped pin can never reach the wrong provider, on any surface, ever.
- One variable name then works for both the container and the in-job process, which
  deletes the "two names on one job" awkwardness R4 introduced.
- It moves a convention currently implemented in one Node script into the pure function
  the invariant already names as the single place model selection happens — so
  `agent-stack.mjs`'s translation becomes redundant rather than load-bearing.
- It is offline-testable, because `select_model_config` is pure over a `Mapping`.

**Alternative rejected**: a conditional YAML expression pinning the bare name only when
the provider input is `anthropic`. It works, but it re-encodes the invariant in a
template expression in one workflow, where the next job to copy the pattern gets it
wrong silently — which is how this defect arose in the first place.

**Scope note**: this widens the feature by one small change to a canonical pure function
plus its unit tests. That is a real increase and is called out rather than absorbed
quietly; the cheaper alternative above is available if the smaller diff is preferred.

---

## R13 — BLOCKER: `claude-sonnet-5` rejects `temperature`, so US2 as planned could never have worked

**Raised by the operator, 2026-09-21**, noticing that `claude-sonnet-4-6` and
`claude-opus-4-8` look superseded. They are — and chasing it found a defect that would
have failed the feature on its very first model call.

**First, the model inventory, live from the vendor today** (`GET /v1/models`, free) —
not from a cached table:

```
claude-fable-5-1, claude-opus-5, claude-sonnet-5, claude-fable-5,
claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-opus-4-6,
claude-opus-4-5-20251101, claude-haiku-4-5-20251001, claude-sonnet-4-5-20250929
```

So `claude-sonnet-5` and `claude-opus-5` are current; `claude-sonnet-4-6` and
`claude-opus-4-8` are prior generations, still served. **`claude-haiku-4-5` is still the
current Haiku** — there is no Haiku 5 — so every fast-tier target in this feature is
already current.

**The blocker.** `_build_real_chat_model` passes `temperature=spec.temperature`
unconditionally, and `ModelSpec` always carries `0.0`. Measured, one tiny live call per
model:

| Model | `temperature=0.0` | Without `temperature` |
|---|---|---|
| `claude-haiku-4-5` | accepted | — |
| `claude-sonnet-4-6` | accepted | — |
| `claude-opus-4-6` | accepted | — |
| **`claude-sonnet-5`** | **400 — `` `temperature` is deprecated for this model``** | **works** |
| **`claude-opus-5`** | **400 — same** | **works** |
| **`claude-opus-4-8`** | **400 — same** | — |

Consequences, in order of severity:

1. **US2 was unshippable as written.** Every `SUPERVISOR_MODEL=claude-sonnet-5` call
   would have returned 400. The cache assertion (R7) would have failed — correctly, but
   for a reason nobody would have predicted from the plan — and `app-e2e` would have
   gone red on the first run.
2. **There is a latent defect on `main` today, independent of this feature.** The
   escalation tier is pinned to `claude-opus-4-8`, which also 400s on the `temperature`
   this code always sends. The tier is dormant (flag defaults off, nothing routes there)
   so nobody has hit it — but the frontier escape hatch is **non-functional**, and would
   fail on first use the moment `mcm.agent.frontier-escalation` was enabled.
3. **US1 is unaffected.** `openwiki`'s agent constructs
   `new ChatAnthropic(modelId, { apiKey, maxTokens, ...retryOptions })` and sets
   `temperature` nowhere in its entire dist. Grepped: no match. The generator bump to
   `claude-sonnet-5` remains the risk-free, merge-first story.

**Why the existing guards missed it.** The generator guard (R6) only ever checked the
output cap, and passed. `select_model_config` is pure and never calls a provider, so its
unit tests pass. The golden suite replays cassettes and never constructs a real model.
Nothing in the repository asserts that *a model this repo can resolve is actually
invocable with the parameters this repo sends* — which is precisely the "check the
instrument" failure mode: every green tick was truthful about a narrower claim than the
one being relied on.

**Decision — fix the cause, and add the missing instrument**:

- Stop sending `temperature` to models that reject it. Direction of the default matters:
  **omitting it never errors, sending it can**, so an unrecognised model id must default
  to *omitting*, with the models known to accept it named explicitly. The reverse
  default reintroduces this bug on the next model generation.
- Move escalation to `claude-opus-5`. Same list price as `claude-opus-4-8`
  ($5/$25), current generation, and — unlike the id pinned today — it actually works
  once `temperature` is dropped. Fixing the parameter bug without fixing the id would
  leave the escape hatch on a superseded model for no reason, since this feature is
  editing that line anyway. Note for whoever enables the tier: Opus 5 runs adaptive
  thinking *by default* where Opus 4.8 did not, so output tokens per escalation will be
  higher than the dormant tier's historical zero suggests.
- **Add a live "every resolvable model is invocable" test.** One minimal call per model
  id this repo can select, asserting no 4xx. It is the instrument that was missing: it
  would have caught both this blocker and the dormant escalation defect, and it is the
  only thing that will catch the next parameter deprecation. Cheap — a handful of tokens
  per model — and it belongs in the live tier with the existing fail-not-skip gating.

**Scope**: this is a blocker, not an enhancement, so the parameter fix is in scope for
merge 2 by necessity. The escalation id bump and the new invocability test are
judgement calls made here rather than deferred, because the feature is already editing
`models.py`'s defaults and the alternative is knowingly leaving a broken escape hatch.
