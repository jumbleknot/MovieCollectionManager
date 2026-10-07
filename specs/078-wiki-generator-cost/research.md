# Research: 078 — cheaper wiki maintenance

Every finding below was obtained by **executing** something on 2026-09-27, not by reading. Raw per-call
usage logs, run logs, diffs and Claims sidecars for every probe are kept with the session scratchpad; the
figures here are copied from them.

## The instrument (R0)

A Node `--import` preload wraps `globalThis.fetch`, tees every Anthropic `/v1/messages` and OpenAI-shaped
`/chat/completions` response, and appends one JSON line per model call: agent kind (planner / page worker,
from the tool list in the request), status, usage, duration, and output characters per content block
(including the Claims payload inside `submit_page`). It never records prompt or file content.

**Validated against the bill**: the two first Fireworks probes, priced from the tap's counts at the operator's
standard rates, total **$0.178**; the operator's Fireworks bill for them is **$0.178025**. The instrument is
trusted to the cent.

Probe harness: the pinned `openwiki@0.5.2`, the exact env of the `wiki-update` Nx target (explicit 16,384 output
cap, telemetry off), and the run message `renderRunMessage` produces for a one-page slice. Only the provider
changes between probes.

## R1 — Cost per page, by provider (measured)

| Page | Sonnet 5 | DeepSeek V4.1 Flash @ Fireworks, standard | priority |
|---|---|---|---|
| `gotchas/keycloak-service-account.md` (no prose change needed) | $0.39 | $0.090 | — |
| `runbooks/android-emulator.md` (69 changed source lines, first Claims) | $0.62, $0.69 | $0.088, $0.124 | see R3 |

Fireworks prices (operator, 2026-09-27): standard $0.22 / $0.007 / $0.66 per M uncached / cached / output;
priority $0.275 / $0.00875 / $0.825. DeepSeek is **77–86% cheaper per page** at standard.

The cost shape differs: DeepSeek makes 47–73 calls per page against Sonnet's 12–20, re-reading a growing
context each time, so ~95% of its input is cache reads — cheap only because Fireworks bills cached input at
$0.007/M. **If that price rises, re-measure before trusting R1**: at an undiscounted cached rate DeepSeek would
cost more than Sonnet.

## R2 — Quality and reliability (measured)

- 5 DeepSeek probes, 5 × exit 0, every assigned page and its `index.md` written, Claims submitted,
  `okf-lint` green. Zero tool-call failures across all calls.
- Four factual statements in a DeepSeek-written page spot-checked against source, all correct:
  `deleteUser` URL-encodes the id and treats 404 as success; `countUsersInClientRole` throws 502 rather than
  returning 0; the service account's realm roles are exactly `view-users`, `manage-clients`, `manage-users`.
- DeepSeek's rewrite picked up feature 076's account-deletion paths; the Sonnet run of the same page judged no
  change was needed and missed them.
- DeepSeek drops the page's `timestamp:` and adds `generated: {by, at}` — **not a DeepSeek behaviour**: OpenWiki
  itself removes `timestamp` on any page whose body changed. `check-openwiki-okf.mjs` already reads
  `generated.at` first (V12 drift keeps working).

## R3 — Speed, and what the priority tier buys (measured)

Timed runs of the same page, same harness:

| Run | Wall clock | Model calls | Avg call latency | Model time share |
|---|---|---|---|---|
| Sonnet 5 | **214 s** | 20 | 8–12 s | 99% |
| DeepSeek, standard | **637 s, 727 s** | 47, 65 | 9.6–13.9 s | 99% |
| DeepSeek, priority | **872 s** | 56 | 14.0–16.1 s | 99% |

Wall clock is ~99% model time; tool execution is negligible. DeepSeek's per-call latency is only ~15–20% above
Sonnet's — **the 3.4× wall-clock gap is call count**, which is model behaviour, not queueing. Priority admission
can shorten each call's wait; it cannot reduce the number of calls — and on the measured run it did not even do
that: priority calls averaged 14.0 s (planner) and 16.1 s (page worker) against 13.9 s and 9.6 s on standard,
at $0.129 against $0.125 for the same page priced at standard rates. One run per tier, on a Sunday, so admission
queueing was probably minimal; the result says priority buys nothing measurable here, not that it never could.

**Tier decision (FR-009): standard.** Priority is not adopted. Whether the `service_tier` field was actually
applied was not confirmed by billing; that verification becomes necessary only if priority is reconsidered. `service_tier: "priority"` is a request-body
field (operator-confirmed); `openwiki@0.5.2` exposes no way to send it, so R6 applies.

## R4 — A CI variable cannot override the Nx target's provider today (measured in source)

`nx@22.7.8` `run-commands` builds the child env as `{ ...process.env, ...envOptionFromExecutor }`
(`dist/src/executors/run-commands/running-tasks.js`, `processEnv`). The `wiki-update` target's `env` block sets
`OPENWIKI_PROVIDER=anthropic` and `OPENWIKI_MODEL_ID=claude-sonnet-5`, so **anything the workflow exports is
silently overwritten**. A provider switch must therefore be resolved inside the command (or by
`wiki-maintain.mjs` before spawning it), not by exporting `OPENWIKI_*` from the job.

## R5 — Where the money goes inside a run (measured)

On Sonnet, a one-page invocation spends **$0.33 on planning** (83% of a no-change page's run): OpenWiki's planner
prompt instructs it to "explore before submitting the plan … map manifests, major directories, entrypoints"
regardless of how narrowly the run message scopes the work. `wiki-maintain` invokes the generator once per slice
and builds slices per wiki area (`renderRunMessage`: "Work on exactly one area"), so a run touching N areas
plans N times. On DeepSeek the planner is ~45% of a run's calls and time — consolidation saves time there as
well as money.

`MAX_PAGES_PER_SLICE = 8` and per-area slicing were sized for 0.2.3, where one agent loop wrote every page and a
long run risked the zero-page failure. In 0.5.x each page is a fresh worker with its own context and a durable
queue (`openwiki/.run.json`), so a multi-page invocation no longer compounds per-page risk the same way.

## R6 — Sending `service_tier` without forking the generator (design, to verify in implementation)

Options considered:

| Option | Verdict |
|---|---|
| Ask OpenWiki upstream for a provider-options passthrough | Right long-term; does not unblock this feature. File it. |
| Patch `openwiki` in `node_modules` | Rejected — invisible, lost on every install, and the CI job installs globally. |
| A repo-owned `--import` preload loaded by the `wiki-update` target, doing exactly two things: add `service_tier` to Fireworks chat-completions bodies when configured, and record per-call usage (Story 4) | **Chosen.** It is the R0 instrument promoted into the repo. It must be provably inert when unconfigured and must never alter any other byte of a request — a guard test asserts both. |

## R7 — Grounded Claims are not the cost problem (measured; out of scope)

First-time Claims on a page cost ~$0.07 on Sonnet (about a quarter of the page worker, ~11% of the run);
later refreshes submit only stale/revised/new Claims. Claims cannot be disabled in 0.4.0–0.6.0. Tracked
separately as backlog #513 (adopt).

## R8 — What `openwiki@0.6.0` changes for this repository (read from the published package)

- **Prompts**: `dist/agent/repository-prompts.js` is byte-identical to 0.5.2 — planner (explore-before-plan) and
  page-worker instructions, and the Claims guidance, are unchanged. Output shape should therefore match 0.5.2;
  T0xx verifies on a real run rather than assuming it.
- **Dependencies**: none added, removed or bumped (`package.json` differs only in `version`). Node engine
  `>=22.22.0`; the container runs v24.20.0.
- **New**: `OPENWIKI_PAGE_CONCURRENCY` (default 1, max 8) runs repository page workers in parallel, staggering
  worker starts by 1 s and holding `/openwiki/quickstart.md` back to run last and alone. Planning is still a single
  serial pass. With concurrency > 1 the default provider retry count rises to 5.
- Also new, not used here: wiki workspace linking (`openwiki link`) and retrieval tools for the MCP integration.
- The Anthropic cap resolver still lives in `dist/agent/index.js`, where the guard reads it.

_(The budget decision record for FR-008/FR-016 is §R9; the `vars` probe answer is §R10, from T004.)_

## R10 — `${{ vars.* }}` resolves on this forge (T004)

Answered from the repository rather than a scratch workflow: `cd-deploy.yml` and `devcontainer-image.yml`
already depend on `${{ vars.REGISTRY }}` / `${{ vars.NS }}` and run green, so repository variables resolve.
An unset variable renders as `''`, which is why `wiki-provider.mjs` treats an empty value as unset (a test
pins it) instead of rejecting it as malformed.

## R11 — Design corrections found while implementing Merge A

- **`main()` drives `executeSlices` itself**, not through `runMaintenance`. A preflight added only to
  `runMaintenance` would never have run in CI; the gate is one shared `preflightGate`, and a structural test
  pins that the CLI path calls it before the proposal branch and before any slice.
- **Packing re-merged a deliberately split area.** The planner only emits two same-kind slices for one area
  when the area exceeds the slice cap; packing now never groups two slices of the same area. This also kept
  every pre-existing budget/resume/failure test valid without modification.
- **The slice stays the backlog unit** (plan D4 proposed a new `parts` shape plus a back-compat reader). Packing
  happens at execution instead, so the committed backlog's shape is unchanged and T019 holds by construction.
- **The usage tap's `tapError` must record the error NAME only**: V8's `JSON.parse` message quotes the text it
  failed on, i.e. response content (proven RED on the first draft).

## R12 — openwiki 0.6.0 rewrites a file the generator may not write (found by T015e)

The 0.6.0 regression run (T015e — Fireworks, concurrency 1, through the new launcher) was cut short at 48 calls
by a dev-container failure, but not before it had modified **`AGENTS.md`**. openwiki rewrites its managed
`<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block in `AGENTS.md` and `CLAUDE.md` on every run
(`dist/ingestion/code-mode.js`, `writeCodeModeAgentSnippets`), and 0.6.0 changed the `AGENTS.md` text (four
lines about its retrieval tools). `openwiki/policy.yaml` lets only `actor: agent` write `AGENTS.md` —
checked: `mayWrite(policy, 'AGENTS.md', 'generator')` → not allowed. So on 0.6.0 **every slice would have failed
verification**, been retried, and returned to the backlog, with the marker never advancing. None of the four
0.5.2 probes touched `AGENTS.md`, because the committed block already matched 0.5.2's text.

Fix: the committed block now carries 0.6.0's text (an agent-authored edit, which the policy allows), so the
generator's rewrite is byte-identical and is not a write. A new guard rebuilds both blocks from the installed
generator's own source and compares byte-for-byte — validated in both directions: it passes against 0.5.2 with
the old text and fails against 0.6.0 until the block is updated. The next version bump that changes the text
fails offline, not in every paid run. The `CLAUDE.md` block (`@AGENTS.md`) is unchanged in 0.6.0.

The adopted text tells assistants not to preload the wiki at task start and to prefer openwiki's retrieval
tools where installed (they are not, here), falling back to `openwiki/quickstart.md`. It sits alongside —
not in conflict with — this repository's own note outside the markers ("query `openwiki/` before a broad text
search"): both say consult the wiki when the task needs it.

## R13 — T015e on openwiki 0.6.0, end to end (2026-09-27)

Fireworks / DeepSeek V4.1 Flash, standard tier, concurrency 1, through `wiki-generate.mjs` and the repo's usage
tap, on the commit carrying the R12 fix. One page asked for; **two written** — the second
(`runbooks/wiki-maintenance.md`) forced into the plan by its stale Claims, because this branch edited its source
runbook (openwiki's `addRequiredClaimIssueJobs`; the spec's edge case). Every path written is allowed to the
generator by the policy; **`AGENTS.md` and `CLAUDE.md` untouched** (R12 confirmed on a real run); `okf-lint`
green.

| Wall clock | Pages | Calls | Failed calls | Uncached / cached / output tokens | Est. cost |
|---|---|---|---|---|---|
| **1,504 s** | 2 | 86 | 0 | 346k / 7.38M / 119k (80k reasoning) | **$0.21** |

About **12 minutes per page at concurrency 1**, planning included — the number Merge B's concurrency
measurement (T027) has to bring down before the CI budget can be set.

## R9 — Budget decision record (T027/T028; operator sign-off 2026-09-28)

**Measured** on openwiki 0.6.0, one packed invocation of 4 requested pages across 2 areas (`runbooks/local-dev`,
`runbooks/server-setup`, `gotchas/session-lifecycle-and-eviction`, `gotchas/playwright-testid-mapping`), plus
`runbooks/wiki-maintenance` forced in by its stale Claims in every run — so 5 pages written each time. Every run:
exit 0, 0 failed calls, `okf-lint` green, `AGENTS.md`/`CLAUDE.md` untouched, every write allowed by the policy.

| Provider | Concurrency | Wall clock | Planning | Cost | Per page |
|---|---|---|---|---|---|
| Fireworks / DeepSeek V4.1 Flash | 1 | 2,187 s | 205 s | $0.31 | $0.06 |
| Fireworks / DeepSeek V4.1 Flash | 2 | 2,337 s | 320 s | $0.45 | $0.09 |
| **Fireworks / DeepSeek V4.1 Flash** | **4** | **895 s, 1,391 s** | 116–344 s | **$0.36, $0.40** | **~$0.08** |
| Anthropic / Sonnet 5 | 4 | 450 s | 187 s | $2.39 | $0.48 |
| *CI on `main`, Sonnet 5, concurrency 1 (other pages)* | *1* | *1,397 s (budget stop)* | — | *$4.50* | *$0.90* |

- Concurrency 4 overlaps the page workers ~3.2× (1,759 s of model time in ~550 s) at **no extra cost** and **no rate
  limiting**. The concurrency-2 run was not a trend but a noisier run: 35% more output and slower calls.
- Same-page, same-concurrency: DeepSeek is **83–85% cheaper** than Sonnet 5, and **~91% cheaper per page than CI pays
  today** (SC-001's target is 70%). It is 2–3× slower; its time varies ±50% run to run with the amount of work it chooses.
- The CI step durations (forge `durations`, run 3770): the debounce `sleep 900` **runs inside the job** and counts
  against `timeout-minutes`; installs ~35 s; the execute step carries ~3.5 min around the generator.

**Decision** (operator: "~8 pages per run, timeout 60"):

| Constant | Value | Derivation |
|---|---|---|
| `MCM_WIKI_PROVIDER` (CI default) | `fireworks` | R1/R9; `vars.MCM_WIKI_PROVIDER=anthropic` switches back without a commit |
| `MCM_WIKI_PAGE_CONCURRENCY` (CI default) | `4` | fastest measured, no rate limiting, no cost penalty |
| `MAX_PAGES_PER_INVOCATION` | 8 | two waves of four workers — the 5-page runs were already two waves |
| `WORST_INVOCATION_SECONDS` | 30 min | measured ≤ 23 min for two waves, +30% |
| `TIME_BUDGET_SECONDS` | **4 min** | a START deadline: 60 − (15 debounce + 2 setup + 30 worst + 4 publishing) − 5 margin |
| `PAGE_BUDGET` | 8 | = one invocation |
| `timeout-minutes` | **60** | operator-approved runner hold; the guard recomputes the 55-min ceiling from the constants |

Effective ceiling: **≤16 pages / ~34 min of generation, ~55 min of runner time**. In practice a run is one 8-page
invocation (~$0.60), a retry happens only after a fast failure, and the rest carries to the next run. A first draft set
the start deadline at 5 min; the new guard's own arithmetic caught that it left 4 min of margin, not 5.

**Enforcement.** The wiki job now runs `wiki-maintain.guard.test.mjs` right after installing the pinned generator and
fails on any skip — the one place those pinned-version checks can run. Simulating the step caught that node's TAP
summary reads `# skipped N`, not `# skip N`: the first draft would have failed every run, correct generator or not.

## R14 — Scoring 45 real CI runs against SC-001…SC-005 (T034, 2026-10-07)

**Window.** Every `maintain` job that ran the generator on Fireworks, from the flip (run 4200, 2026-09-28) to run 4801
(2026-10-07): **45 runs, 24 completed, 21 failed.** Sources: the run records in
`git log -p origin/main -- openwiki/.maintenance-state.json` (42; three later commits that only carry a record forward
are excluded), the forge's `/actions/tasks` rows (which also show the 3 runs that left no record), and the 18 failure
bundles `<run id>--maintain`, which name each failure's cause. Most of the window was the item #525 drift sweep, a
deliberate pass over the hardest stale pages, so it is a harder workload than the Sonnet baseline's.

**Every failure, by type.** The type matters because the fix differs for each (item #682; #525's closing comment):

| Type | Runs (UI run number) | n | What the record shows |
|---|---|---|---|
| Deadline stop: too slow for the window | 4392, 4398, 4412, 4605, 4675, 4686, 4716 | 7 | outcome `failed`, 93–376 calls, stopped at 2,178–6,677 s, remainder carried |
| Killed by `timeout-minutes` (before #626) | 4290, 4385, 4386 | 3 | **no record, no bundle, no cost line**; task row lasted exactly 60 min |
| Worker exited without submitting | 4326, 4377, 4424, 4679, 4766, 4774, 4801 | 7 | page restored, slice stale; at default effort **and** at `low` |
| Provider 429 (rate limit) | 4798, 4800 | 2 | 7 calls, 3 failed, 19–29 s |
| openwiki state (not the model) | 4283 (Claims "not durable"), 4348 ("a different persisted plan") | 2 | 0 or 35 calls |

The killed runs were the deadline type before the job could stop itself. #613's correction shows they were slow,
not hung. So **10 of 21 failures are speed failures.** DeepSeek is 2–3× slower than Sonnet (R3, R9), so these are the
cost of the cheaper provider under a fixed window, not chance.

Two findings change what #525's closing comment implies:
- **Worker exits are not only a large-source problem.** Of the 7, three are on `runbooks/sast-scanning` or `projects/sast`.
  Both cite `docs/runbooks/sast-scanning.md`, which is **26 KB**. Meanwhile `runbooks/wiki-maintenance` (source 47 KB)
  landed. #682 frames the cause as the 110 KB and 78 KB sources; the size explanation does not cover these three.
- **The evidence that `low` cures deadline failures is one page, once.** `sast-scanning`'s two default-effort
  failures were one deadline stop (4686) and one **worker exit** (4679). After `low` landed it (run 4729), a later
  `low` run on the same page exited its worker (4801). Any auto-escalation design should start from this.

### Verdicts

| SC | Target | Measured | Verdict |
|---|---|---|---|
| **SC-001** | median cost/page ≥ 70% below $0.90 | median **$0.150** over the 24 completed runs (range $0.065–$0.587) = **−83%**. All-in, counting the $6.24 spent by failed runs: $14.35 / 54 pages landed = **$0.266, −70.4%**. The 3 killed runs' spend is unrecorded, so the true all-in figure is a little worse. | **Met** on the criterion as written (median). The all-in figure is at the threshold. |
| **SC-002** | landed share ≥ Sonnet's | Fireworks: **24/45 runs completed (53%)**, 54 pages landed. Sonnet 5, 1–27 Sep: **61/62 (98%)**, 116 pages, 0 kills (the one failure, 2026-09-20, recorded itself). | **Not met.** The workloads differ: Sonnet never ran the sweep's pages in CI. That limits how far the comparison goes, but it does not reverse it. The 10 speed failures are a property of the provider. |
| **SC-003** | invocations < areas on a multi-area run | 1 invocation each covering 3 areas (run of 2026-09-29 02:31, 8 pages), 3 areas (03:47, 5 pages), **4 areas** (11:00, 8 pages), 2 areas (2026-10-04 15:00; 2026-10-06 02:44) | **Met** — five completed runs |
| **SC-004** | no platform-timeout kill | **3 kills** (4290, 4385, 4386; 29–30 Sep). **0** kills in the **25 runs since #626** (merged 2026-09-30 21:04) gave the job its own deadline. The longest run since then was 6,683 s, inside the 120-min dispatch window (#640). `ci-status durations --job maintain` reports `cens 0`, but it only sees runs that published a bundle, and a killed run publishes none. That is exactly how the kills would be missed. | **Not met** over the window; **held** since #626. Also, an over-budget *invocation* ends as `failed` with its remainder carried forward. Only the start deadline produces "stopped at budget". |
| **SC-005** | estimate within 5% of the bill | Estimate for 2026-10-01 00:00 → 2026-10-07 23:59 UTC: **$7.0291 over 24 CI runs**. No CI run straddles either edge, and the window excludes the three unrecorded kills. | **Pending** the operator's Fireworks console figure (T023). |

**SC-002 decision (operator, 2026-10-07): keep Fireworks; do not flip back to Anthropic.** The reason is cost: Sonnet
is about 6× more per page. SC-002 is recorded as an accepted deviation, not as met. The speed failures are handled
with an automatic escalation to `reasoning_effort: low` after a deadline failure (US6). Worker exits stay with
item #682.
