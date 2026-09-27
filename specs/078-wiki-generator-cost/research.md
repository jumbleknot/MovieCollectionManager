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

_(The budget decision record for FR-008/FR-016 is §R9, written in T028 after T027 measures 0.6.0 at concurrency; the `vars` probe answer is §R10, from T004.)_
