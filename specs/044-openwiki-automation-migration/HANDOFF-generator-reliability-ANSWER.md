# Answer: the generator stops because a single model turn runs out of output tokens

**From**: the research session, 2026-08-01
**Answers**: [`HANDOFF-generator-reliability.md`](HANDOFF-generator-reliability.md)
**Status**: mechanism identified, reproduced in isolation, and confirmed on the wire during a real run.

---

## The mechanism, in one paragraph

The `wiki-update` target pins `OPENWIKI_MODEL_ID=claude-sonnet-5`. OpenWiki never sets `maxTokens`,
so LangChain picks a per-model default from a hard-coded table in `@langchain/anthropic`. **That table
has no entry for `claude-sonnet-5`**, so the lookup falls through to
`FALLBACK_MAX_OUTPUT_TOKENS = 4096`. Every request the generator makes is therefore capped at **4096
output tokens per model turn**. When a turn needs more than that — narration plus a full page of
markdown emitted as a `write_file` argument — the API returns `stop_reason: "max_tokens"` with the
turn cut off mid-token. If the cut lands *before* the model has opened a `tool_use` block, the
resulting assistant message has **zero tool calls**, and zero tool calls is precisely LangGraph's
ReAct stop condition. The graph exits normally, OpenWiki's stream completes without error, the process
exits **0**, and Nx reports success. Nothing was written, and nothing anywhere in the stack recorded
that the turn was truncated.

That is why the failure looks like "stopped mid-plan": it *is* stopped mid-sentence.

---

## The evidence chain

### 1. No token limit is ever set, so the default applies

`dist/agent/index.js:405` constructs the model with only an API key and retry options — no
`maxTokens`:

```js
return new ChatAnthropic(modelId, {
  apiKey: getProviderApiKey(provider),
  ...(baseURL ? { anthropicApiUrl: baseURL } : {}),
  ...retryOptions,
});
```

`@langchain/anthropic@1.5.2`, `dist/chat_models.js:678`:

```js
this.maxTokens = fields?.maxTokens ?? defaultMaxOutputTokensForModel(this.model);
```

```js
const FALLBACK_MAX_OUTPUT_TOKENS = 4096;
function defaultMaxOutputTokensForModel(model) {
  if (!model) return FALLBACK_MAX_OUTPUT_TOKENS;
  return Object.entries(MODEL_DEFAULT_MAX_OUTPUT_TOKENS)
    .find(([key]) => model.startsWith(key))?.[1] ?? FALLBACK_MAX_OUTPUT_TOKENS;
}
```

The table contains `claude-opus-5`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-4-8`†,
`claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` … and **no `claude-sonnet-5`**.

† via the `claude-opus-4` prefix entry.

**Resolved ceiling for every model OpenWiki offers on this provider:**

| `OPENWIKI_MODEL_ID` | resolved `maxTokens` |
|---|---|
| `claude-haiku-4-5` | 16384 |
| `claude-opus-4-8` | 16384 |
| **`claude-sonnet-5`** (what we pinned) | **4096** |
| `claude-opus-5` | 16384 |
| `claude-sonnet-4-5` | 16384 |

The model we pinned is the *only* one that falls through. It is a gap in LangChain's table, not a
property of Sonnet.

### 2. Nothing checks `stop_reason`

`grep stop_reason` across `@langchain/anthropic/dist/chat_models.js` matches only doc comments. A
truncated turn is returned as an ordinary `AIMessage`.

### 3. Zero tool calls is the loop's stop condition

`langchain/dist/agents/ReactAgent.js:376`, `:414`, `:447`:

```js
if (!AIMessage.isInstance(lastMessage) || !lastMessage.tool_calls
    || lastMessage.tool_calls.length === 0) return exitNode;
```

No `stop_reason` is consulted. A turn truncated before its first `tool_use` block is indistinguishable
from a model that has decided it is finished.

### 4. A clean graph exit is exit 0

`dist/cli.js`, `runPrintCommand`: the stream is consumed to completion, then `process.exitCode = 0`.
Only a *thrown* error reaches the `catch` that sets 1. Nothing throws here.

### 5. Reproduced in isolation — the controlled A/B

Using the exact `ChatAnthropic` OpenWiki constructs, one `write_file` tool, and one prompt that
narrates before writing (`scratchpad/preamble-probe.mjs`):

| model | resolved cap | `stop_reason` | output tokens | tool calls | what the ReAct loop does |
|---|---|---|---|---|---|
| `claude-sonnet-5` | 4096 | `max_tokens` | 4096 | **0** | **EXIT — exit 0, nothing written** |
| `claude-sonnet-4-5` | 16384 | `tool_use` | 10164 | 1 | continue to the tool node |

The truncated turn's text ends mid-word:

```
…so their presence changes what "enforcement" even means in context.\n\n**Step two: read
```

Compare the preserved real failure, `generator-evidence/failed-3-new-pages-2.log`, whose captured
narration ends:

```
…I need to reconsider these as authoritative pages (no `resource
```

Same signature: cut mid-token, no summary, exit 0.

A second probe (`scratchpad/maxtokens-probe.mjs`) establishes the boundary case: when the cut lands
*inside* an already-open `tool_use` block, LangChain still yields one (partial) tool call and the loop
continues — which is why some failures leave a truncated page rather than no page. **The zero-page
outcome requires the cut to land in the text preamble.**

### 6. Confirmed on the wire during a real run

A pass-through proxy on `ANTHROPIC_BASE_URL` recorded every request of a live
`pnpm nx wiki-maintain infrastructure-as-code`. Every turn:

```json
{"model":"claude-sonnet-5","max_tokens":4096,"stream":true, ...}
```

**Turn 25 of 37 is the bug, caught live:**

```json
{"turn":25,"model":"claude-sonnet-5","max_tokens":4096,
 "stop_reason":"max_tokens","output_tokens":4096,"had_tool_use":false}
```

A turn that burned the entire ceiling and emitted **no tool call** — the exact predicted failure, on a
**single-page refresh**, the easiest slice the loop ever runs. That run's first two attempts produced
nothing (`attempt 1 produced nothing — retrying (2/3)`, then the same for 2/3) before the third wrote
the page: the ~50% rate, reproduced in one sitting.

The rest of the distribution shows the ceiling is not comfortably distant but routinely brushed —
**8 of 37 turns exceeded half the budget**, the top eight being:

```
4096, 3065, 3060, 2810, 2620, 2584, 2470, 2095
```

A three-page *creation* slice, where a single turn must emit a whole page of markdown *after*
narrating its findings, crosses 4096 far more often than a refresh does. That is the measured ~50%.

> **Caveat on this particular run, stated because it would otherwise be mistaken for a datapoint.**
> Its *verification* outcome is not usable: this document was created in the working tree while the
> run was in flight, and the verifier — which snapshots the tree once and attributes every change to
> the generator — correctly flagged `specs/*/HANDOFF*.md` as a path the `generator` actor may not
> write. The token evidence above is unaffected, being read off the wire rather than the tree. The
> run's output was reverted.

---

## What this retires from the handoff

| Handoff hypothesis | Verdict |
|---|---|
| A wall-clock timeout inside the tool | **Correctly ruled out.** The bound is per-turn *output tokens*, which is why elapsed time never discriminated: a run's duration is dominated by how many turns it takes, not by how close any one turn came to the cap. |
| A step / turn / recursion cap | **Not the cause.** LangGraph's `recursionLimit` does default to 25 and OpenWiki passes none — but exceeding it throws `GraphRecursionError`, which would exit **1**. Our failures exit 0. Still worth raising as a second-order risk, not as this bug. |
| A swallowed model-side error | **No.** The API call succeeds. There is no error to swallow — the truncation is a legitimate, well-formed response that no layer inspects. |
| The tool stages writes and commits at the end | **No.** Writes go through the backend as they happen; that is why partially-truncated pages appear in the tool-call case. |
| **"Resume rather than restart"** (the handoff's leading alternative harness) | **Structurally impossible in openwiki 0.2.3.** `resolveCheckpointTarget` returns `:memory:` for both `update` and `init` — only `chat` gets the persistent SQLite checkpointer. The thread id also embeds a fresh random component per run. There is no checkpoint to resume from. |
| "Non-determinism is a property of the dependency" | **Wrong, as the handoff suspected.** It is a fixed, deterministic 4096-token ceiling meeting variable-length work. The ~50% is the fraction of slices whose heaviest turn happens to exceed it. |

---

## Harness options, now that the mechanism is known

### A. Remove the cause — raise the per-turn ceiling ✅ **applied**

One line in [`infrastructure-as-code/project.json`](../../infrastructure-as-code/project.json): pin a
model whose prefix LangChain's table actually covers. **4×** the per-turn budget, nothing to
implement, and it eliminates the mechanism rather than compensating for it.

Pinned **`claude-sonnet-4-6`** — the closest peer to the previous pin, so no cost jump, but present in
the table at 16384. (`claude-opus-4-8`, `claude-opus-5`, `claude-haiku-4-5` and `claude-sonnet-4-5`
would also have done; all were verified live on this key.) The target's `metadata.description` now
carries the reason, because the change that reintroduces this bug is indistinguishable from a routine
model bump unless the reason travels with the value.

### B. Stop the same trap recurring — a preflight guard ✅ **applied**

The deeper defect is that **the ceiling is invisible**: nothing in the stack reports it, and the
symptom (exit 0, no pages) is identical to success. A model rename, an OpenWiki upgrade, or a
LangChain upgrade can silently reintroduce it tomorrow.

Two offline, token-free tests now live in
[`wiki-maintain.guard.test.mjs`](../../scripts/__tests__/wiki-maintain.guard.test.mjs): one reads
`OPENWIKI_MODEL_ID` out of the Nx target, resolves it through the **installed** `@langchain/anthropic`
table (not a copy — a copy would drift and then agree with itself), and fails if it lands on the 4096
fallback; the other asserts the target still explains why. Mutation-tested: restoring
`claude-sonnet-5` fails the guard with the diagnosis attached.

### C. Keep the retry, but re-found its justification ✅ **applied**

Retry stays — it covers genuine residual variance, and with (A) applied its attempts become
meaningfully independent instead of re-running into a fixed wall. Against a ceiling, retrying is close
to useless and the independence of attempts is an illusion, which is why the arithmetic in the old
comment ("~50% → 75% → 87%") looked sound while resting on a false premise.

What changed is the **story told about it**. `scripts/wiki-maintain.mjs` and
[`docs/runbooks/wiki-maintenance.md`](../../docs/runbooks/wiki-maintenance.md) both asserted "the
generator is non-deterministic … that is not a bug to be found in this code — it is a property of the
dependency". Both now carry the mechanism instead, and both say explicitly: **if zero-page runs
return, do not add a fourth attempt — measure the wire.**

### D. Rejected, with reasons

- **Resume rather than restart** — impossible; no persistent checkpoint for `update` (see above).
- **Patch the installed `@langchain/anthropic` table** — it lives inside a global npm install and is
  destroyed by the next `npm install -g openwiki`. Only viable as a pinned, scripted postinstall, which
  is more machinery than (A).
- **A `max_tokens`-rewriting proxy on `ANTHROPIC_BASE_URL`** — technically works (this is how the
  evidence above was gathered) and is the only way to keep `claude-sonnet-5` *and* get a large budget
  today. Rejected as a production harness: it puts a bespoke sidecar in the credential path of every CI
  run to work around a one-line config choice.
- **Shrinking slices further / capping page length in the run message** — these are instructions to a
  model, not constraints on a process, and `wiki-maintain.mjs` already says so in its own header. They
  reduce the odds without removing the ceiling.

---

## Validation — the same slice, before and after

Both runs are the identical slice (`process/spec-driven-development.md`), the identical rendered run
message, and the identical harness. Only `OPENWIKI_MODEL_ID` differs.

| | `claude-sonnet-5` (4096) | `claude-sonnet-4-6` (16384) |
|---|---|---|
| requested `max_tokens` on every call | 4096 | 16384 |
| model turns | 37 | 14 |
| turns truncated at the cap | **1** (turn 25, no tool call) | **0** |
| largest turn | **4096** — the ceiling | 1251 |
| turns over 4096 | 1 | 0 |
| attempts needed | 3 (1 and 2 produced nothing) | **1** |
| elapsed | 487s | **84s** |
| outcome | failed¹ | ✅ 1 page written and verified |

¹ that run's pass/fail is not usable as a datapoint — see the caveat above. Its *token* evidence is,
being read off the wire.

**This is one run each, and one run does not measure a rate.** The claim it supports is narrower and
sufficient: the ceiling that produced the zero-page failures is no longer reached, and the failure
mode has a mechanism rather than a probability. The 5.8× drop in elapsed time and the 37→14 turn count
are consistent with that — fewer turns are wasted re-approaching work a truncated turn abandoned.

Reproduction material is preserved in [`generator-evidence/`](generator-evidence/):

| file | what it is |
|---|---|
| `preamble-probe.mjs` | the controlled A/B — same prompt, two models, prints tool-call count and stop reason |
| `maxtokens-probe.mjs` | the boundary case: truncation *inside* an open `tool_use` block still yields a tool call |
| `anthropic-probe-proxy.mjs` | the `ANTHROPIC_BASE_URL` pass-through that records every turn |
| `validation-run-sonnet-4-6.jsonl` | the post-fix run's per-turn record, 14 turns, no truncation |
| `failed-*.log`, `succeeded-*.log` | the original narration captures carried by the handoff |

The **pre-fix** per-turn record was overwritten before the validation run and is not preserved as a
file; its values are quoted above from the session that produced them, and are reproducible by
pointing `ANTHROPIC_BASE_URL` at the proxy with the old pin restored.

### E. Worth reporting upstream

Two genuine upstream bugs, neither of which we need to wait on:

1. `@langchain/anthropic` has no `claude-sonnet-5` entry, so the current Sonnet silently gets a 4096
   cap while every neighbouring model gets 16384.
2. OpenWiki never sets `maxTokens` and never inspects `stop_reason`, so a truncated turn is reported
   to the operator as a successful run.
