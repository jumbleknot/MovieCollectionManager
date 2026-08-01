# Handoff: why does the generator produce nothing ~half the time?

> ## ✅ ANSWERED — 2026-08-01. Do not start this research; read the answer.
>
> **[`HANDOFF-generator-reliability-ANSWER.md`](HANDOFF-generator-reliability-ANSWER.md)**
>
> The cause was a fixed, deterministic, silent per-turn **output-token ceiling**, not
> non-determinism. OpenWiki never sets `maxTokens`, so `@langchain/anthropic` prefix-matches the model
> id against a hard-coded table and falls back to **4096** on a miss — and `claude-sonnet-5`, the id
> this repo pinned, is absent from it. A turn truncated at 4096 *before* it opens a `tool_use` block
> returns zero tool calls, which is exactly LangGraph's ReAct stop condition: the graph exits cleanly,
> OpenWiki exits 0, Nx reports success, nothing is written. Measured on the wire:
> `stop_reason=max_tokens`, `output_tokens=4096`, no tool call. Fixed by pinning a model the table
> covers at 16384, with guards that fail any id landing back on the fallback.
>
> The document below is kept **as it was written**, because two of its conclusions were load-bearing
> in getting to that answer and are worth preserving as method: that elapsed time does not
> discriminate (correct — the bound is tokens per turn, not wall clock), and that the failure
> signature is *stopped mid-plan* rather than *decided to do nothing* (correct — that is truncation).
> Its "what is NOT known" section is now history, not an open list.

**From**: the feature-044 implementation session, 2026-07-31
**To**: a fresh session doing research, not implementation
**Status**: feature 044 is merged and green. The maintenance loop runs, verifies honestly, and has
produced and merged one real proposal. **This handoff is about the one thing it does badly.**

---

## The question, and why the current answer is not good enough

Roughly **half of all generator invocations write nothing**, exit 0, and are reported by Nx as
success. The verifier catches every one — the loop is honest — but the work only lands because
failed slices return to a backlog and get retried across runs.

I closed that out as *"the generator is non-deterministic, so retry it"* and shipped a 3-attempt
in-run retry. **That reasoning is wrong, and it is the reason this handoff exists.**

> Non-determinism is a description of the symptom, not an explanation of the cause. We put harnesses
> around non-deterministic processes precisely to achieve the intended outcome reliably. A ~50%
> per-attempt failure rate is not a property to be accepted and papered over with retries — it is an
> unexplained defect, and the retry is a guess made before anyone understood the mechanism.

The retry is not *wrong* to have (it works, it is bounded, it is reported). It is **premature**: it
was chosen without knowing what terminates the generator, so nobody can say whether 3 attempts is the
right harness, whether a different one would take the rate to ~100%, or whether the real fix is
upstream of retrying entirely.

**The research question**: *what actually causes the generator to stop having written nothing, and
what harness makes the intended outcome reliable?*

---

## What is measured (facts, with numbers)

### The failure shape

The generator runs for minutes, narrates plausible investigative work, exits **0**, and has written
**no files**. Nx reports `Successfully ran target wiki-update`.

### Elapsed time does NOT discriminate — this kills the obvious hypothesis

| | Elapsed seconds |
|---|---|
| **Failed** runs | 156, 393, 521, 552, 643, 660, 900 |
| **Succeeded** runs | 234, 367, 409, 438, 472, 676 |

The ranges overlap heavily. A 234s run succeeded; a 156s run failed; a 676s run succeeded; a 660s run
failed. **A simple wall-clock timeout inside the tool is not the mechanism**, or at least not the
whole of it. Anyone starting from "it must be timing out" should start elsewhere.

### The failure signature is "stopped mid-plan", not "decided to do nothing"

Every failure whose output was captured ends **while narrating its next investigative step**:

- `Now let me check the other existing style pages (keyset-pagination, otel-span, …)` — 643s
- `Found the exact source passage. Let me read more context around line 251 in CLAUDE.md, and confirm section header context.` — 552s
- `Now I have enough material. Let me check the constitution's Token Compression section and the .npmrc/package.json preinstall d…` — 521s

That last one is the sharpest: it says *"Now I have enough material"* and then stops without writing.
Contrast a success, which ends with a full summary of files created and why.

**This does not look like a model deciding the work is unnecessary.** It looks like something
terminating the loop from outside the model's control: a step/turn cap, an aborted stream, a swallowed
error, or an output-token limit hit mid-turn.

Primary evidence is preserved in [`generator-evidence/`](generator-evidence/):
`failed-3-new-pages.log`, `failed-3-new-pages-2.log`, `succeeded-3-new-pages.log`.

### Things already ruled out or established

| Established | How |
|---|---|
| Not caused by slice size alone | 8-page, 3-page **and 1-page** creation slices have all failed; 3-page slices have also succeeded |
| Not caused by a missing subject in the message | Adding a per-page subject raised the rate but did **not** fix it (0 pages in 643s → 3 pages in 367s, then failures returned) |
| Not caused by the message contradicting the gate | That was a real bug (see below) and is fixed; failures continued afterwards |
| Not the credential, not the tool being absent | Both were separately real failures, both fixed; these are distinguishable in the logs |
| Refreshes vs creations differ | Creation is far more failure-prone. A refresh of an already-correct page returns `noChange` cleanly |

### Fixed along the way — do not re-discover these

1. **`nx --args` strips the quoting from its value** before splicing it into the shell, so a run
   message passed that way reaches the generator as bare words and it runs **unscoped**. The message
   now travels in `WIKI_RUN_MESSAGE`, quoted inside the target's own command string.
2. **Nx buffers a successful task's output and discards it.** `--output-style=stream` is why any
   generator narration exists to quote above.
3. **A self-contradictory message produces silent nothing at full price.** "Write ONLY those pages"
   forbids touching the area `index.md`, which OKF rule V9 *requires*. The generator resolved the
   contradiction by writing nothing, for 643 seconds.

---

## What is NOT known

- **What terminates the run.** No step/turn/iteration cap was found in the tool's own `dist` (see
  below), so if one exists it is in its model SDK dependency.
- **Whether a model-side error is being swallowed.** A rate-limit, overload, or max-tokens condition
  that exits 0 would look exactly like this.
- **Whether `--print` mode differs from interactive** in how it terminates.
- **Whether the tool stages writes** and only commits them at the end (which would explain
  all-or-nothing output: stop before the commit step and nothing appears).
- **Whether the model matters.** The target pins `OPENWIKI_MODEL_ID=claude-sonnet-5`. Nobody has
  tried another.

---

## Where to start — free before paid

### 1. Read the tool's source. It is on disk and this costs nothing.

```
/usr/local/lib/node_modules/openwiki/           # installed globally, openwiki@0.2.3
  dist/code-mode.js        (5 KB)   ← the `openwiki code` entry point. START HERE.
  dist/agent/index.js      (46 KB)  ← the agent loop
  dist/agent/utils.js               ← contains writeFile calls
  dist/agent/okf-middleware.js      ← OKF-specific behaviour
  dist/cli.js              (103 KB) ← arg parsing, --print handling
  node_modules/                     ← the model SDK, where a step cap would live
```

Specific things to find:
- The loop that drives tool calls, and **what bounds it** (`maxSteps`, `stopWhen`, `recursionLimit`,
  `maxToolRoundtrips` — none matched in `dist/` itself, so look in `node_modules`).
- **The write path**: does it write files as it goes, or stage and commit at the end?
- **The exit path**: find every route to `exit(0)` and check which of them can be reached having
  written nothing. That is the single most valuable thing in this handoff.
- Whether errors from the model call are caught and swallowed.

### 2. Use the diagnostics the tool already offers

- `--debug` — *"Show full credential and error diagnostics when a run fails"*. Never yet run against
  a **failing** generation (it was used once, on a run that succeeded).
- `--telemetry-file <path>` — writes the anonymous payload locally. May record step counts, stop
  reasons, or errors. Contains no token counts (measured in feature 043 research R1), but the
  *outcome* fields have never been inspected.

### 3. Only then, paid experiments

Each local run costs ~2–10 minutes. Vary **one** thing at a time:

| Experiment | Hypothesis it tests |
|---|---|
| Same slice, 5 consecutive runs, `--telemetry-file` each | Is the stop reason recorded? Is the rate really ~50%? |
| `OPENWIKI_MODEL_ID=claude-opus-5` (or haiku) | Is it model-specific? |
| A message naming **one** page with its full intended content | Does removing all research collapse the failure? |
| Pre-create an empty stub file for the target page | Does "edit this file" succeed where "create a page" fails? |
| A refresh of an existing page vs creating a new one | Confirms the creation/refresh asymmetry mechanically |

---

## Harness options worth considering (the actual deliverable)

Retry is one primitive and the weakest one. Better harnesses become available once the mechanism is
known:

- **Resume rather than restart.** If the generator stops mid-plan, the next attempt currently starts
  from scratch and re-does the same research. Feeding back "you already investigated X; write the file
  now" would be strictly better — and if the cap is on steps, restarting is the *worst* response.
- **Shrink the work per invocation until research is trivial** — one page, with its content sketched
  in the message. The single successful one-shot run in this feature's history had exactly that shape.
- **Split research from writing** into two invocations: one that produces an outline, one that writes
  from it. If the loop budget is the constraint, this halves what each invocation must fit.
- **Pre-create the file** so the task is an edit, not a creation.
- **Detect the stop reason and react to it** rather than treating all zero-page outcomes alike —
  possible only once the mechanism is known, which is the point of the research.

---

## Ground rules for this work

- **Do not change the verifier's contract.** "Every requested page exists after the run" is what makes
  the loop honest, and it has already caught a false green introduced by a well-meant retry.
- **Do not judge by exit status.** The generator's exit code carries no information; this is measured,
  repeatedly.
- **Every paid run is evidence** — capture the full output. `--output-style=stream` is required or Nx
  discards it.
- **A conclusion needs a mechanism.** "It is flaky" is what this handoff exists to replace.

## What done looks like

A written explanation of what terminates a zero-page run, supported by evidence that would let someone
else reproduce it — and a harness recommendation that follows from the mechanism rather than from
guesswork. If the honest answer turns out to be "the tool cannot do reliable multi-page creation and
the harness must decompose to single-page edits", that is a good outcome, provided it is *shown*.

Current behaviour, for reference: `ATTEMPTS_PER_SLICE = 3` in
[`scripts/wiki-maintain.mjs`](../../scripts/wiki-maintain.mjs), failures return to the backlog,
budgets bound the whole run. The operator-facing description is in
[`docs/runbooks/wiki-maintenance.md`](../../docs/runbooks/wiki-maintenance.md).
