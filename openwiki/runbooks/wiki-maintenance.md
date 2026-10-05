---
type: Runbook
title: "OpenWiki knowledge-bundle maintenance"
description: The derived summary of how the openwiki/ bundle is planned, generated, verified and published — the free wiki-plan before the paid wiki-maintain, the provider/credential table with its per-provider knobs (page concurrency, service tier, and the Fireworks-only reasoning effort of item #525) and the env-scoping rule that keeps the Nx target from overwriting the job's choice, the run budget with its per-event job deadline and exit-code semantics, the four independent slice-verification causes (missing page, non-conformance including V16, a policy-forbidden write, a page left stale after the run), the single long-lived openwiki-maintenance proposal that proposes per part and reverts unrequested writes after a deadline stop, and the Claims-sidecar durability contract that makes a hand edit of a covered page brick every later run.
resource: docs/runbooks/wiki-maintenance.md
tags: [openwiki, okf, documentation, ci, maintenance, runbook]
sources:
  - id: openwiki-source-7e1c4d46c53be9bf32311e06
    resource: repo://.devcontainer/toolchain.Dockerfile
  - id: openwiki-source-36295b95c290f53e6f6e79a7
    resource: repo://.forgejo/workflows/wiki-maintain.yml
  - id: openwiki-source-c231cd090281b3129aaf6167
    resource: repo://docs/runbooks/wiki-maintenance.md
  - id: openwiki-source-5731c4a4c76f88db8cc6fb40
    resource: repo://infrastructure-as-code/project.json
  - id: openwiki-source-d0e241f24a4e0d3e79f47c5f
    resource: repo://scripts/__tests__/openwiki-claims.test.mjs
  - id: openwiki-source-cccdf9eddce7e76440d4cd28
    resource: repo://scripts/__tests__/openwiki-stamp.test.mjs
  - id: openwiki-source-ef3e1dc36da7e40bc6a337f5
    resource: repo://scripts/__tests__/wiki-maintain.guard.test.mjs
  - id: openwiki-source-3cfcbfbe6daeeadc1b4b8cf8
    resource: repo://scripts/__tests__/wiki-maintain.test.mjs
  - id: openwiki-source-73ea24dd4413f81583ff9282
    resource: repo://scripts/__tests__/wiki-provider.test.mjs
  - id: openwiki-source-98792bbc9621de1ad3e22856
    resource: repo://scripts/check-openwiki-governance.mjs
  - id: openwiki-source-ccaf212e2940e782eb0de272
    resource: repo://scripts/check-openwiki-okf.mjs
  - id: openwiki-source-efa55c3a8c70016f55bf6266
    resource: repo://scripts/openwiki-claims.mjs
  - id: openwiki-source-d6ba69382020a933bb1c9de0
    resource: repo://scripts/openwiki-stamp.mjs
  - id: openwiki-source-f7de3a4f5f1323dd23a0c681
    resource: repo://scripts/wiki-generate.mjs
  - id: openwiki-source-e3418ba4f663de6f0edbcde6
    resource: repo://scripts/wiki-maintain.mjs
  - id: openwiki-source-238c6bb3246fc134ab159b1e
    resource: repo://scripts/wiki-provider.mjs
  - id: openwiki-source-b06e5457680691b00528f189
    resource: repo://scripts/wiki-usage-tap.mjs
  - id: openwiki-source-cc0e84ce24c43bdaff14a3c1
    resource: repo://scripts/wiki-usage.mjs
generated: { by: "openwiki/0.6.0", at: "2026-10-05T15:09:13.400Z" }
verified:
  - by: openwiki/0.6.0
    at: 2026-10-05T15:09:13.400Z
---


# OpenWiki knowledge-bundle maintenance

**Feature 044** (with the cost/provider work of feature 078 and the deadline work of item #613).
`pnpm nx wiki-plan infrastructure-as-code`
decomposes the documentation changes since the last recorded run into **slices** — at most 8 pages,
exactly one bundle area each — offline and free, so there is never a reason to skip it before spending
on `pnpm nx wiki-maintain infrastructure-as-code` (paid, needs the selected provider's key). The paid
run is bounded three ways: a page budget, a start deadline, and a per-event **job deadline** that a
merge-triggered run and a dispatched run are each given differently. The run
record lives at `openwiki/.maintenance-state.json`, committed because runners are ephemeral; it is
distinct from the tool's own `openwiki/.last-update.json`. See
[OpenWiki bundle generation and maintenance](../process/wiki-maintenance.md) for the underlying
`wiki-update`/`okf-lint` Nx targets this machinery drives, and
[Nx as the task runner](../invariants/nx-task-runner.md) for why the bare `openwiki` CLI must never be
invoked directly. The governing rules live in `openwiki/INSTRUCTIONS.md` (the generation brief) and
`openwiki/policy.yaml` (the regeneration policy); the how — CLI flags, the debounce arithmetic, the
step-by-step procedure — is `../../docs/runbooks/wiki-maintenance.md`.

Useful overrides go through Nx's `--args` (appended to the command line): `--args='--since <ref>'`
ignores the marker and plans over a range you choose (diagnostics and one-off sweeps);
`--args='--max-slices 1'` attempts one slice and stops; `--args=--dry-run` prints the exact command per
slice and invokes nothing, persisting nothing; `--args=--json` is machine-readable.

## The shape of a run

```mermaid
stateDiagram-v2
    [*] --> Plan
    Plan --> NothingToDo: nothing changed since the marker
    Plan --> Preflight: slices planned, paid start
    Preflight --> BadUsage: provider error, exit 2
    Preflight --> Invocation: minimal call answered
    Invocation --> DeadlineStop: GNU timeout fires, status 124 or 137
    DeadlineStop --> RevertUnrequested: restore what the slice did not ask for
    RevertUnrequested --> Verify: requested pages, their sidecars and their index kept
    Invocation --> Verify: pages counted from the working tree
    Verify --> Partial: failure only on other parts, conformance and policy clean
    Partial --> Proposal: the landed parts are proposed
    Partial --> Backlog: only the failed parts return
    Verify --> Proposal: any page landed, whatever the outcome
    Verify --> StoppedAtBudget: page or time budget spent, or under 5 min left before the reserve
    StoppedAtBudget --> Proposal: pages that landed are still proposed (exit 3, not a failure)
    Verify --> Retry: slice failed, attempts remain
    Retry --> Verify
    Retry --> Backlog: 3 attempts used
    Verify --> Backlog: slice failed
    Verify --> StoppedAtFailureLimit: two consecutive slices failed
    StoppedAtFailureLimit --> Proposal: pages that landed are still proposed (exit 1)
    StoppedAtFailureLimit --> [*]: exit 1, nothing landed
    Backlog --> Invocation: the run continues with the next slice
    Backlog --> [*]: no slice left — the failed work waits for a later run
    Proposal --> PublishFailed: push or forge call refused
    PublishFailed --> [*]: exit 1, marker held and the slices are back in the backlog
    Proposal --> [*]: one proposal created or updated
    NothingToDo --> [*]
    BadUsage --> [*]
```

The states a maintenance run moves through: planning is free, the preflight is the first act that costs
anything, a failing slice is retried and then returned to the committed backlog, and a budget stop — pages
or wall clock, or a job deadline that leaves too little time to *start* a generator — ends the run with
the remainder carried forward (exit 3),
while two consecutive slice failures end it as a failure (exit 1). A run that
generated pages but could not get them onto a proposal undoes the marker advance rather than certifying
work that only exists on a runner about to be thrown away. Two of those edges are the newer machinery: a
generator the job deadline stops is first cleaned of everything the slice never asked for, and an
invocation that fails only on *some* of its parts proposes the parts that verified instead of discarding
them with the failed ones.

## The provider is configuration (feature 078)

Which model writes the bundle is not code: `scripts/wiki-provider.mjs` is the single table, resolved in
**one pure place** from `MCM_WIKI_PROVIDER`.

| `MCM_WIKI_PROVIDER` | Model | Key (first non-empty; mapped at the point of use) |
|---|---|---|
| `anthropic` — the **local** default (unset) | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, `MCM_ANTHROPIC_API_KEY` |
| `fireworks` — the **CI** default (the workflow sets it, at page concurrency 4) | `accounts/fireworks/models/deepseek-v4p1-flash` | `FIREWORKS_API_KEY`, `MCM_FIREWORKS_API_KEY` |

The chosen credential is mapped to the name the generator reads **only** in the generator's own
environment, and every other provider's key is removed from it. Three more knobs are validated before any
paid call, and each is per-provider: setting one on a provider that does not take it is an error, never
something quietly ignored.

- `MCM_WIKI_PAGE_CONCURRENCY` (1–8, default 1) — openwiki ≥ 0.6.0 writes that many pages in parallel.
- `MCM_WIKI_SERVICE_TIER=priority` (Fireworks only) — +25% price; measured on this workload it bought
  **no** speed, so it is not the default.
- `MCM_WIKI_REASONING_EFFORT` (Fireworks only: `none`, `low`, `high`, `max`; unset = the model's own
  default) — the item-#525 trial knob described next.

**The reasoning-effort knob (item #525).** `scripts/wiki-provider.mjs` rejects any value Fireworks does
not document for this model, so a bad value fails before any paid work. It cannot travel as openwiki's own
`OPENWIKI_REASONING_EFFORT`, because openwiki 0.6.0 refuses an effort for its `fireworks` provider: the
**usage tap** (`scripts/wiki-usage-tap.mjs`), loaded into the generator process, sets `reasoning_effort`
on the Fireworks chat-completions request bodies instead — exactly the route `MCM_WIKI_SERVICE_TIER`
already uses. The preflight sends it too, so a value the provider rejects fails before paid work. The
run's usage line and its record carry `effort=<value>` when it is set, and the effort changes no price
row, because Fireworks bills reasoning as output tokens. **It is under trial:** latency is roughly output
tokens ÷ generation speed, and a lower effort means fewer reasoning tokens per call — but possibly a
weaker page. In CI it is the `reasoning-effort` **input of a dispatched run**, and a push run has no
inputs, so it falls through to the repository variable — which stays unset, the model default. That is
what keeps a trial from changing what a merge-triggered run sends; do not set the repository variable
until a trial's page has been reviewed.

The launcher also *imposes* one variable the operator never sets: it puts
`OPENWIKI_PROVIDER_RETRY_ATTEMPTS=2` into the generator's environment unless an explicit operator value
is already there (see the hang below).

**A malformed value exits 2 — it is never read as a default**, because a mis-typed selector that fell
back would bill the wrong vendor with no signal. An empty value is unset (how an Actions repository
variable that was never set arrives). In CI these are repository **variables**, so switching provider is
a settings change, not a commit; the keys are the secrets `ANTHROPIC_API_WIKI_MAINTAIN` and
`FIREWORKS_API_WIKI_MAINTAIN`.

**Why the Nx target names no provider.** Nx builds a target's child env as
`{ ...process.env, ...targetEnv }`, so a provider in the target's `env` would silently overwrite the
job's choice — the job could set a provider and the generator would never see it. The target therefore
runs `scripts/wiki-generate.mjs`, which resolves the table, hands the generator only the selected
provider's key, and passes `WIKI_RUN_MESSAGE` as one argv element with no shell. See
[Model-provider environment scoping](../invariants/model-provider-scoping.md) for the analogous
env-scoping rule on the agent side.

**Preflight.** Before the first paid slice, `wiki-maintain --execute` makes one minimal call to the
selected model (`node scripts/wiki-generate.mjs --preflight` by hand). A failure exits **2** with the
record untouched and names the provider's error type — a withdrawn model id, a revoked key or a blocked
egress host costs one token, not a slice.

## What the exit codes mean

| Code | Meaning | Is something wrong? |
|---|---|---|
| `0` | Plan produced, or every attempted slice verified, or nothing to do | No |
| `1` | A slice **failed verification** — a requested page missing or left stale, the bundle became non-conformant, or a write landed where policy forbids it (a stopped generator usually leaves a requested page stale, which fails it the same way) — or the generated work could not be published (the marker is then held and the slices returned to the backlog) | **Yes** |
| `2` | Bad usage, unreadable run record, a missing credential, a malformed `MCM_WIKI_*` value or `WIKI_JOB_DEADLINE`, a failed preflight, or a policy file that will not load | **Yes** |
| `3` | Stopped with work outstanding — the run budget was reached, the job deadline left too little time to start a generator, or slices were carried forward in the backlog | **No** — the remainder is in the backlog |

**Exit 3 is not a failure.** A run that correctly stopped at its budget must not be reported as broken:
re-run it and it continues where it left off.

### How a slice is verified

```mermaid
flowchart TD
    A["Slice finished"] --> B{"Every requested page present?"}
    B -->|"no - a requested page is missing"| P["The failed part is named, per area and page"]
    B -->|yes| C{"Bundle still conformant, V1 to V16?"}
    C -->|no| F["Whole invocation failed, exit 1 - every part returns"]
    C -->|yes| D{"Every written path permitted by policy.yaml?"}
    D -->|no| F
    D -->|yes| E{"A requested page left stale?"}
    E -->|"yes - its source commit is newer than its stamp"| P
    E -->|no| G["Slice verified"]
    P --> K["The parts that verified are still proposed"]
    P --> H["Retried within the run, then only the failed parts return to the backlog"]
    F --> H
    G --> I["Marker may advance — only if no slice in the run failed"]
```

The four independent checks a finished slice must clear before its marker may advance, and how it
resolves. Only the first and the last are attributable to a *part* of a multi-area invocation: a
conformance or policy failure is the whole invocation's, so it proposes nothing and returns every part.

Verification never consults the generator's own exit status; it looks only at what landed in the working
tree and at the bundle's gates. The contract is the pages the slice *requested*, not "some page
appeared": a run that wrote unrelated pages while ignoring the request fails, and an `index.md` alone
counts as zero pages. Writing **nothing** is not by itself a failure — a refresh whose requested pages
all exist and none is stale (cause 4) passes as `✅ … nothing needed changing (0 written)`. Cause 4 is
judged **after** the run whether or not the page was written (item #616), because "written" only means
its bytes changed: on proposal #615 a run deleted a `verified:` block from
`runbooks/ci-diagnostics.md`, left the body and its `generated` stamp alone, and the page counted as
written — so a check that skipped written pages never looked, and the marker moved past the source
change exactly as in #587. Cause 2's conformance includes **V16**, the Markdown/Claims durability rule,
because a bundle that breaks it stops every *later* run. The four ways a slice can fail, and what each
one means, are enumerated in the gotchas below. The two stamp-reading checks this flow shares with
`okf-lint` — the stale-page cause here and the gate's V12 drift warning — both go through
`scripts/openwiki-stamp.mjs`, so they resolve the same page to the same date.

Two refinements the diagram shows that the four causes alone do not. A failure that is attributable
*only* to other parts — a requested page missing or still stale, with conformance and policy clean — is
recorded per part (`landedParts`), so the parts that verified are proposed and only the failed parts
return to the backlog. And a generator the job deadline stopped is first cleaned up: everything the run
changed is restored, or deleted if new, except what the slice actually requested.

## The budget — one invocation per run

**One 8-page generator invocation per run.** At execution, consecutive same-kind slices of *different*
areas are packed into one generator invocation of up to `MAX_PAGES_PER_INVOCATION` pages, because every
invocation pays a fixed planning pass — ~$0.33 on Sonnet, 83% of a one-page run — and a run touching
three areas used to plan three times. The **slice** stays the unit of the backlog: a failure carries
forward only the areas whose pages did not land. The constants live in `scripts/wiki-maintain.mjs` and
the guard test *derives* the workflow's `timeout-minutes` from them (asserting the value and that it
leaves at least 5 minutes of margin), so changing one without the other fails offline:

| | Value | Why |
|---|---|---|
| Page budget | 8 | one invocation's worth (`MAX_PAGES_PER_INVOCATION`) |
| Time budget | **4 min** | a deadline for **starting** work — an invocation or retry under way is never interrupted |
| Job deadline | window − 8 min | each invocation is wrapped in GNU `timeout` with the time left minus an 8-minute reserve (item #613) |
| Worst-case invocation | 30 min | 8 pages at page concurrency 4 is two waves of workers, measured ≤ 23 min |
| Window (push) | 60 min | 15-min debounce (it sleeps **inside** the job) + setup + 4 + 30 + publishing ≈ 55, plus margin |
| Window (dispatch) | 120 min | the whole job — a dispatched run has no debounce and may need it |
| Job timeout | 120 min | the hard ceiling; a merge-triggered run is still held to 60 by the deadline, not by this |

So a run does one invocation and stops — a second starts only if the first finished inside 4 minutes,
and a retry only after a fast failure; everything else carries forward in the backlog. Declared
effective ceiling: **≤16 pages / ~34 min of generation**. The page count comes from **files that
actually appeared in the working tree**, not from what the generator says it wrote. **Neither budget is
a monetary bound** — the wall-clock budget bounds runner occupancy.

**The job deadline (item #613).** The workflow's first step records `WIKI_JOB_DEADLINE` from a window
chosen **per event**: `workflow_dispatch` gets `DISPATCH_MINUTES=120` (the whole job), `push` gets
`PUSH_MINUTES=60` — so the runs every merge starts keep the shared-runner hold, and raising the ceiling
cannot lengthen them. The guard test pins both (`DISPATCH_MINUTES` equals `timeout-minutes`,
`PUSH_MINUTES` is 60). Each invocation then runs under GNU `timeout` with the time left minus an
8-minute reserve for verification, publishing and the run-record commit; a slice with under 5 minutes
left is not started and carries forward (exit 3). A deadline stop does **not** by itself fail the slice:
after the revert below, the slice is judged like any other, by what landed — in practice a stopped
generator leaves a requested page unwritten or stale, which fails it (exit 1), while a slice whose
requested pages all landed fresh before the stop verifies. Either way the run **still commits its record,
usage and digest** — before this a hang ran until the platform
killed the job with nothing recorded. `timeout` signals the whole process group, which matters because
nx starts openwiki as a grandchild; that holds while nx uses no pseudo-terminal, which it does only when
stdout is a TTY — never in CI. Only the workflow sets `WIKI_JOB_DEADLINE`, so an interactive local run
is never wrapped; a malformed value is an error (exit 2), never ignored.

**Why a run hung for an hour (2026-09-30).** For an OpenAI-compatible provider (Fireworks) openwiki sets
no request timeout, so the OpenAI SDK's **10-minute** default applies, and at page concurrency above 1
openwiki retries **5** times: one model request accepted and never answered was about 60 silent minutes.
The generator's environment now sets `OPENWIKI_PROVIDER_RETRY_ATTEMPTS=2` (an explicit operator value
wins), bounding that at about 30 minutes; the deadline above bounds the rest. A merge-triggered run also
spends its first 15 minutes in the debounce, so it has about 45 minutes, not 60 — size the work for that
window.

**Why dispatched runs get 120 minutes (operator decision, 2026-10-02).** An *uncovered* page — one with
no `.page-manifest.json` entry, left by openwiki "for full review" — needs about 1.65× the output per
call and over 1.6× the calls of a covered one. Generation speed on Fireworks also varies by the hour:
measured 45–145 tok/s across a few days, and latency per call is roughly output tokens ÷ that speed. At
70–80 tok/s, `projects/sast` stopped at the old 51-minute deadline after 93 calls of ~29.5 s each, while
a covered page finished in 58 calls. Process uncovered pages **one per dispatched run**: seed the page
through a pull request that edits `backlog` in `openwiki/.maintenance-state.json`, merge it (the merge
run then has nothing to do), and dispatch.

## What a run cost (feature 078)

OpenWiki reports no usage itself, so `scripts/wiki-usage-tap.mjs` is loaded into the generator process
and records per-call **counts** (never content). Each invocation's counts are priced from
`scripts/wiki-provider-prices.json` — a dated table; update `asOf` with every change — and the run total
lands in the job log and in `lastRunUsage` in `openwiki/.maintenance-state.json`:

```text
[wiki-maintain] usage runbooks/: 47 call(s), 183838 uncached / 2801438 cached / 43117 output tokens, ~$0.0883 (fireworks, prices 2026-09-27)
[wiki-maintain] run usage: ~$0.0883 over 47 call(s) in 1 invocation(s), fireworks, prices 2026-09-27
```

It is an **estimate** (it reconciled with the Fireworks bill to the cent on the 078 research probes).
`not captured` means the tap produced nothing — it is never written as $0. A line saying `PARTIAL total`
means some invocations were not captured. `failedCalls` counts non-200 responses: rate limiting under
page concurrency shows up there first. When the reasoning-effort knob is set, both the per-invocation and
the run line carry `effort=<value>` after the provider (and tier, if any), and the value is recorded in
`lastRunUsage.reasoningEffort` — it changes no price row, because Fireworks bills reasoning tokens as
output tokens.

## Gotchas

- **A filename is not a specification.** The run message carries a one-line subject per page — without
  one, the generator spends its whole budget working out what a page should say; measured across the
  feature-044 relocation, that single change was the difference between 0 pages in 643s and 3 pages in
  367s. The planner asks for at most 8 pages when *refreshing* existing concepts but only 3 when
  *creating* new ones, and never mixes the two kinds in one slice. **The creation cap of 3 is
  unverified**: it was calibrated while every turn was silently capped at 4096 output tokens (the
  `claude-sonnet-5` bug); that cap is now fixed, and the limit may be needlessly conservative — treat
  it as a starting point, not a measured finding, and raise it against measurement if you need to.
- **The backlog is committed, so it outlives the policy that produced it — and is re-validated against
  the current policy on every plan.** A slice that can never succeed (e.g. one targeting a page
  `policy.yaml` no longer covers) is dropped and reported as `carried-forward page(s) dropped` rather
  than silently starving the queue behind it. A failed slice no longer blocks the next one either; the
  run stops only after **two consecutive** failures.
- **A slice is retried up to 3 times within one run before returning to the backlog**, and the attempt
  count is always reported. A retry can never forgive what an earlier attempt did: the working tree is
  snapshotted once, before the first attempt, so a forbidden write on attempt 1 still fails the slice
  even if attempt 2 behaves. Note: the ~50% "miss" rate measured during feature-044 was not genuine
  non-determinism — it was a fixed bug (the model id then pinned was absent from
  `@langchain/anthropic`'s table, so every turn was silently capped at 4096 output tokens and truncated
  before it could open a tool call). OpenWiki 0.5.2 fixed the cause upstream — an explicit `maxTokens`
  now beats the vendor table — and `wiki-update` additionally sets `OPENWIKI_MAX_OUTPUT_TOKENS=16384`
  itself rather than trusting either layer to keep holding. The pinned model is now **`claude-sonnet-5`**
  (moved from `claude-sonnet-4-6` in feature 075, a cost-only swap — see the model-pin gotcha below).
  **If zero-page runs return, measure the wire — check `stop_reason` and `output_tokens` on a
  pass-through proxy — not the retry count.** The retry is also bounded by the job deadline: a retry is
  never started when the time left before the reserve has fallen under 5 minutes, and the allowance is
  recomputed for every attempt rather than fixed at the start of the slice.
- **The model pin has made a round trip, and both moves were deliberate.** Feature 043 pinned
  `claude-sonnet-5`; the 2026-08-01 fix moved it to `claude-sonnet-4-6` (an id the vendor table *did*
  match, the only way to escape the 4096 fallback before an explicit cap existed); feature 075
  (2026-09-21) moved it back. A reference to `claude-sonnet-4-6` in an older document or commit is that
  middle period, not a conflicting pin. The move back was **cost-only**: same vendor, same credential,
  same workflow, same Deep Agents caching middleware, only the id changed. Sonnet 5 lists at $2/$10 per
  MTok against Sonnet 4.6's $3/$15, with cache reads at $0.20/MTok against $0.30. Generation is the
  largest line on the model bill (~53% of a measured $74.89 over the 30 days to 2026-09-20) and already
  ~92% cache reads, so the *cached-read* rate — not the list input price — was the number that decided
  it: roughly −33%, from ≈$1.72 to ≈$1.15 per run-day. **OpenWiki sends no `temperature` parameter,
  which is why this bump was safe where the agent gateway's equivalent bump was not** — Sonnet 5 and
  Opus 5 reject `temperature` with a 400, and the gateway sent it unconditionally. A model id is only a
  drop-in for the parameters the caller actually sends; if OpenWiki ever starts sending sampling
  parameters, re-check this before bumping the pin again.
- **Read the guard's SKIP COUNT, not just the exit code.**
  `scripts/__tests__/wiki-maintain.guard.test.mjs` asserts, for the pinned generation model, that the
  explicit cap is set and at or above the 16384-token minimum a page-writing turn needs, that
  OpenWiki's own `resolveAnthropicMaxOutputTokens` still matches the pinned id, and that the id would
  not resolve to `@langchain/anthropic`'s 4096-token fallback if the explicit cap were removed. Two of
  its four cap-related tests **skip** when OpenWiki is absent from `/usr/local/lib/node_modules` — and
  now also when the installed version is not the pinned one — so a skip can misleadingly read as a
  pass. Point `OPENWIKI_ROOT` at a side install of the pinned version (`npm install -g --prefix <dir>
  openwiki@<v> mermaid jsdom`) to make them run; the `claude-sonnet-5` bump was verified at 20 passed /
  0 failed / 0 skipped. The wiki-maintain CI job runs this guard after installing the generator and
  before any paid work, and **fails the step on a skip**, reading node's `# skipped 0` summary line.
- **The managed `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block is rewritten on every run, so the
  committed block must already be what the pinned generator writes.** OpenWiki rewrites that block in
  `AGENTS.md` and `CLAUDE.md` on every run, and 0.6.0 changed the `AGENTS.md` text (four lines about its
  retrieval tools). `openwiki/policy.yaml` permits only `actor: agent` to write `AGENTS.md`, so on 0.6.0
  **every slice** would have failed verification (`AGENTS.md — the run may not write here`), been
  retried, and returned to the backlog with the marker never advancing — run after run, at full cost.
  The fix is that the committed block *is* the pinned generator's text (an agent-authored edit, which
  the policy allows), which makes the rewrite byte-identical and therefore not a write at all.
  `scripts/__tests__/wiki-maintain.guard.test.mjs` now rebuilds both blocks from the installed
  generator's own source and compares them byte-for-byte, so the next version bump that changes the text
  fails **offline** instead of failing every paid run in CI: update the block in the same change as the
  pin. The pinned-version checks skip wherever the pinned generator is not installed, which is why the
  wiki-maintain job — the one place it *is* installed — runs this guard before any paid call and fails
  the step on a skip.
- **A slice fails when any of four things is true, and the generator's own exit status is not one of
  them:** a **requested page does not exist after the run** (an `index.md`-only refresh counts as
  nothing — this is exactly what produced feature 043's false-green run: 12 minutes of paid work, one
  `index.md`, exit 0, reported as success), the bundle stopped being conformant
  (`check-openwiki-okf.mjs`, rules V1–V16 — including **V16**, the Markdown/Claims durability rule
  described under Claims sidecars below, because a bundle that breaks it stops every later run rather
  than failing one page), a written path was not permitted by
  `openwiki/policy.yaml` — which includes a write into `docs/runbooks/`, a path that *is* `regenerate`
  but is governed by an **agent**, not the generator — or a **requested page was left stale** (items
  #587, #616):
  a requested page that cites a `resource` whose last **commit**
  is newer than the page's stamp is named in the failure one page at a time, so a multi-page slice no
  longer passes because *some* of its pages were written. **Whether or not the run changed the file**,
  the page is judged after the run (#616): on proposal #615 a run deleted a `verified:` block from
  `runbooks/ci-diagnostics.md`, left the body and its `generated` stamp alone, and the page counted as
  *written* — so the earlier check, which only looked at unwritten pages, never examined it and the
  marker moved past the source change exactly as in #587. A real rewrite moves `generated.at` past the
  source's commit, so it is never flagged. That stamp is the **newest** of
  `generated.at`, `verified.at` and `timestamp` — an older verification never drags a newer generation
  backwards — and the rule lives in exactly one place, `scripts/openwiki-stamp.mjs`, imported by both
  the OKF gate's V12 drift check and the `sourceNewerThanStamp` check here, so the two cannot disagree
  about which date a page carries. A page whose source has not moved since its stamp may still honestly
  write nothing — that is the
  `✅ … nothing needed changing` line, not a failure. A page with no usable stamp, an external
  `resource`, or an untracked source is unknowable and keeps that honest no-change outcome too. A legacy
  date-only stamp reads a same-day source commit as newer, so such a page is retried until the generator
  restamps it — that errs toward retrying, never toward a silent skip. The
  comparison is against the cited source's last git **commit** date, never its mtime, because a fresh
  checkout stamps every file's mtime with the checkout time and an mtime read would mark every concept
  stale. The failed work returns to the backlog and **the marker does not advance** — for causes 1 and 4
  only the failed parts of a packed invocation do, while causes 2 and 3 carry the whole invocation back.
  A generator the job deadline stopped is judged on what landed, like any other: the stop is recorded,
  the run **still commits its record, usage and digest**, and nothing about the generator's own exit
  status changes the verdict — a stopped generator usually leaves a requested page stale, which fails
  the slice.
- **Remediation is always the brief, never an allowlist.** If a page trips the conformance gate, a leak
  scan, or the governance gate, fix `openwiki/INSTRUCTIONS.md` and re-run — the gates have no skip flag
  by design, because an allowlisted leak stays leaked.
- **CI waits ~15 minutes (concurrency + `cancel-in-progress` + an initial sleep) so one run covers a
  burst of merges, but never defers past 6 hours** — that ceiling is derived from git commit dates
  because the waiting run gets cancelled and any in-memory timer dies with it; git state survives
  cancellation, run state does not. `workflow_dispatch` bypasses the wait entirely, and the run does not
  trigger itself (`[skip ci]` marker commit, or a bundle-only change). A failure publishes a feature-042
  failure digest like every other job and never gates a merge — see
  [CI self-serve diagnostics](ci-diagnostics.md).
- **The proposal is one long-lived branch (`openwiki-maintenance`), at most one open pull request, ever,
  and never auto-merged.** The runner is a fresh checkout, so the branch exists there only on the
  **remote**: the run checks it out from there, and only while its proposal is **open** (a closed one's
  commits are not revived — see the #619 gap below). Until 2026-09-28 it looked only for a *local*
  branch, found none on every CI run, started from `main`, and the `--force-with-lease` push replaced
  the open proposal — measured on proposal #594, where a 4-page and then an 8-page slice were discarded
  while the run record still listed both. A run that finds it open now continues the *remote* branch,
  rebases it onto the base and appends — so a review comment's remediation commit survives every later
  update — and the push refuses outright (`pushing would discard N commit(s) from open proposal`) when
  `git cherry` shows a commit the open proposal holds that the new head lacks: a red run, never a silent
  overwrite. Closing it without merging is *meant* to return its work to the backlog and roll the marker
  back — without that, abandoning a proposal leaves the marker certifying work that never landed. **It
  does not do so today (item #619):** the run computes its plan before it reconciles the proposal, so
  the returned slices are overwritten by the run's own backlog and `markerBefore` records the
  already-advanced marker. Until #619 is fixed, re-seed a closed proposal's pages by hand — a seed
  change that edits `backlog` in `openwiki/.maintenance-state.json`. If the *publishing* step itself
  fails instead (the push or the forge call), the marker is held and this run's slices go back to the
  backlog, so nothing is certified that never reached a proposal; the recorded usage stays, because that
  money was already spent.
- **One invocation can carry several slices, and a failure in one part no longer discards the others.**
  When an invocation's failure is attributable only to *other* parts — a requested page missing or still
  stale — while conformance (V16 included) and policy are clean, `verifySlice` reports the parts that
  verified as `landedParts`, and they are proposed (`proposableSlices`: verified invocations plus landed
  parts); only the failed parts return to the backlog. Before this, run 4399 (2026-10-01) verified
  `runbooks/backlog.md` but proposed nothing because `projects/sast.md` in the same invocation was still
  stale at the deadline — and since the backlog page's source change was already behind the marker,
  nothing would have planned it again. A **whole-invocation** failure (conformance or policy) still
  proposes nothing and returns every part. A proposal is created or updated whenever **any** page
  landed — including a run that stopped at its budget (exit 3) or had a failed slice (exit 1) — and a
  failed slice's written files are **not** reverted, so when another slice in the run verified, whatever
  the failed slice wrote rides along on the proposal: review it as such. The run stops early only after
  two consecutive slice failures.
- **After a deadline stop, the slice keeps only what it requested.** openwiki forces every page with a
  Claims issue into a run, so a generator stopped part-way (GNU `timeout` exit 124, or 137 after
  `--kill-after`) can leave a page it was never asked for half-written — on run 4606 (2026-10-04) that
  broke V16 on `projects/keycloak.md`, a whole-invocation failure, and the requested page's $0.96
  regeneration was lost. `revertUnrequested` now restores every path the run changed to its committed
  state (or deletes it if new) **except** the requested pages, their `.claims` sidecars and the requested
  areas' `index.md`; paths that were dirty before the run are left alone. It applies **only** to a
  deadline stop: a generator that exits on its own is judged on everything it wrote, so a broken forced
  page on a normal exit still fails the slice rather than being quietly reverted.
- **A reviewer must not hand-edit a page openwiki has covered — that bricks every later run.** A page
  with an entry in `openwiki/.page-manifest.json` is certified byte-for-byte by its `.claims` sidecar,
  so editing it breaks the certification and openwiki then refuses **every** later run, not just that
  page: measured on 2026-09-29, when four hand-corrected pages on #606 stopped maintenance until #610
  recovered it, and again on #615 where a run's own output did it. To correct a covered page by hand,
  **uncover it in the same commit** — remove its manifest entry, delete its sidecar, and delete its
  front-matter `verified:` event. openwiki then leaves it for full review, and the correction stands
  until the page is next regenerated. The OKF gate's **V16** fails such a pull request, so this is now
  caught at review time rather than by the next paid run — the rule itself is the durability contract
  described under Claims sidecars below.
- **If the run record and the forge disagree about an open proposal, the forge wins.** The record's
  `proposal` pointer is a cache, not the source of truth — a run created a proposal, its marker commit
  lost a push race against `main`, and the pointer never landed. The next run then tried to open a
  second proposal and died on `forge POST /pulls → 409`. A run now asks the forge which proposal is
  open for the branch before creating one, adopts it if found, and treats a 409 as "someone beat me to
  it — adopt and update" rather than a fatal error, so a run that lost its record self-heals instead of
  staying permanently stuck (the one-proposal invariant survived only because the forge refused).
- **A protected passage may only live on a concept with no `resource`.** Freezing a derived summary
  against the document it summarizes would fail every legitimate refresh. To change such a passage,
  update its text and its fingerprint in the same change:
  `node scripts/check-openwiki-governance.mjs --fingerprint openwiki/<area>/<page>.md "<heading text>"`.
  See `openwiki/protected.yaml` and the routing rule in
  [where a new learning goes](../process/wiki-maintenance.md).
- **The generator writes site-root-absolute body links (`](/openwiki/…)`) — those are dead on this
  forge.** A leading `/` resolves against the site root, so the forge reads `openwiki` as a username
  and 404s. Measured via `POST /api/v1/markup` (the one endpoint that takes `Context`, `BranchPath`,
  and `FilePath`, rendering a link exactly as the file view does). 204 links across 61 of the
  bundle's 77 files were broken this way while `okf-lint` passed, because V6 verified only the
  `resource` front-matter field, not body links. Three layers now hold the line: `INSTRUCTIONS.md`
  §6 states the convention; `verifySlice` normalises whatever the slice wrote before the gate reads
  it; and `okf-lint` rules **V14** (site-root-absolute) and **V15** (does not resolve from its own
  file's directory) fail the build for anything else. For a bundle-wide sweep (e.g. after restoring
  from elsewhere): `node scripts/wiki-maintain.mjs --normalize-links` (offline, no credential; add
  `--dry-run` to preview). Code fences and code spans are exempt.
- **The OKF v0.2 provenance migration flips the bundle gradually — both stamp shapes coexist until
  every page has been regenerated.** OpenWiki 0.5.x replaces the flat `timestamp:` scalar with a
  structured `generated: {by, at}` event. `finalizeGeneratedProvenance` stamps `generated` on every
  page whose body changed in the run and removes that page's `timestamp` field in the same pass; a
  page whose body did not change keeps its prior stamp untouched. Reading only `timestamp` therefore
  would not have failed loudly: it would have made V12 cover one fewer page each time a page was
  rewritten, until drift detection checked nothing while the gate still printed `✅ conformant`. The
  gate now resolves the stamp through one shared helper, `scripts/openwiki-stamp.mjs`, which takes the
  **newest** of `generated.at`, `verified.at` and `timestamp` (operator decision 2026-09-28) — newest,
  because each field is an event and OpenWiki can add one without touching the others. It re-verifies
  a page's Grounded Claims against its sources and writes `verified` while leaving the body, and so
  `generated` and `timestamp`, untouched; measured on
  `openwiki/decisions/adr-0001-prod-secrets-management.md`, verified at 17:17Z against a source that
  changed at 16:17Z, which V12 went on reporting as stale while it read only the other two. An older
  verification never drags a newer generation backwards. The helper is imported by **both** readers —
  V12 in `check-openwiki-okf.mjs` and the #587/#616 stale check in `scripts/wiki-maintain.mjs` —
  precisely
  so they cannot drift apart, and the provenance comment in `check-openwiki-okf.mjs` now delegates to it
  rather than restating the rule. `verified` is written as a **list** of `{by, at}` events, and **V5
  now validates every entry of that list** (until 2026-09-28 a path reader that did not descend arrays
  meant no real `verified.at` had ever been validated). However, a concept that cites a `resource` but
  carries no usable stamp at all is silently excluded from drift coverage — the gate counts and prints
  those pages as a warning, never a failure. **If that count climbs, drift coverage is falling;
  investigate the generator's provenance pass, not the pages** — a silent fall in V12 coverage is
  exactly how the gate could go on printing green while checking less.
- **V12 drift is reported, never planned.** It is warn-only — it never touches the exit code — and it
  is deliberately not an input to `planSlices` in `scripts/wiki-maintain.mjs`, which decomposes only
  the paths changed since the run-record marker plus the carried-forward backlog. The reason: one edit
  to a widely cited file would otherwise fan drift out across every concept citing it and never clear.
  The consequence is that a concept whose source changed after the marker passed it is **not
  re-planned automatically** — clearing it takes a hand-seeded sweep (`--since <ref>`, or pages placed
  in the run record's `backlog`). Known ways a concept falls behind, each tracked: **#526** (the general
  gap — nothing re-plans a concept once the marker has passed its source change); **#587 (fixed)** — a
  refresh slice that wrote nothing for one of its requested pages used to verify as `noChange` and
  advance the marker past the change (measured on `openwiki/runbooks/renovate.md`, 2026-09-26), and
  `verifySlice` now fails the slice for such a page when its source is newer than its stamp (cause 4
  above), so the page returns to the backlog and the marker holds — which closes the route by which a
  *planned* page fell behind, while #526 remains for pages that were never planned at all; **#616
  (open — its guards are in place)** — the same gap through a different door, where a page counted as
  *written* because a front-matter-only edit changed its bytes, so #587's unwritten-only check never
  examined it, and Markdown and Claims were left inconsistent (proposal #615); the cause is openwiki's own
  restore path when a worker exits without submitting. **Both guards shipped in #617** — a requested page
  changed only in front matter is judged stale (cause 4 above), and V16 fails a non-durable bundle — but
  the item stays **open** for its last criterion, a real refresh of `runbooks/ci-diagnostics.md`, which the
  current Fireworks model cannot generate (see #589). Do not describe #616 as fixed. And
  **#525** — the drift-driven
  sweep that would clear the current V12 list, blocked on #587 and on canonical sources being corrected
  first (#588, done). Read a V12 line with its stamp in mind: several pages still carry a legacy date-only
  stamp, so a source commit made later **the same day** reads as drift even when the page was generated
  from it.
- **Mermaid and jsdom are optional peer dependencies — missing them causes diagram fences to be
  silently rewritten to plain text fences while the run exits 0.** From OpenWiki 0.5.0, Mermaid
  diagrams are embedded by default and every fence is validated after a run. Without `mermaid` and
  `jsdom` installed alongside the generator, OpenWiki falls back to a weaker built-in check; any
  diagram that fails that check is rewritten in place as a plain `text` fence with a comment — the run
  still exits 0, every gate still passes, and the diagram is silently downgraded. Both packages are
  therefore installed in `.devcontainer/toolchain.Dockerfile` **and** in
  `.forgejo/workflows/wiki-maintain.yml`. A guard in
  `scripts/__tests__/wiki-maintain.guard.test.mjs` asserts that the two lists match: if only one
  environment has the parser, they disagree about what a valid diagram is, and the environment that
  writes the bundle decides.
- **Claims sidecars (`openwiki/.claims/`) hold the evidence behind a page, one JSON file per page,
  mirroring the page's path** (e.g. `openwiki/.claims/runbooks/backups.json` for
  `openwiki/runbooks/backups.md`). A sidecar carries `schemaVersion`, a `pageVersion` hash, a
  `verification: {by, at}` event, and a `claims` array; each claim has a stable `id`, a `statement`,
  and one or more `evidence` entries (`repo://<path>`, optionally `#Lx-Ly`, plus a resolver-computed
  version hash of that source). On a later refresh a claim is marked `stale` when its evidence's
  version no longer matches, or `unresolved` when the evidence cannot be resolved, and the generator
  must confirm, revise, or retract it — the rules a page like this one is itself following.
  `openwiki/policy.yaml` has no dedicated rule for `.claims/`; the sidecars are permitted only by the
  `openwiki/**` catch-all (`regenerate`, `actor: generator`). `okf-lint` touches Claims in three
  places: V5 validates the ISO-8601 shape of the page's `verified.at` events, which OpenWiki writes as
  a **list** (via `stampValues` in `scripts/openwiki-stamp.mjs`); V12 counts the newest `verified.at`
  as a candidate stamp; and **V16 reads the sidecars themselves** — see the durability contract below.
  The operator decided on 2026-09-27 that
  Claims are required and valuable (item #513), and the decision's details, plus any gates or lifecycle
  rules that follow from it, are recorded under that item. **Nothing yet checks that a sidecar's claims
  are *true*:** the only gate on sidecars is V16's durability check, so a sidecar records what the
  generator asserted about a page, not reviewed content.
- **A sidecar is a durability contract, not a note: V16 is what enforces it.** `openwiki/.page-manifest.json`
  lists every page openwiki has **covered** (`/openwiki/<page>.md` keys, each with its own `pageVersion`
  and a `completedBy` generator version). openwiki 0.6.0 re-proves each covered page before a run can
  advance — the sidecar must exist, carry a `verification`, and record a `pageVersion` equal to the
  sha256 of the page's **current** bytes — and otherwise throws *"Cannot advance page coverage for
  /openwiki/<page>; Markdown and verified Claims are not durable"* and fails the **whole** run, every
  slice, before any generation. That is why a hand edit of a covered page stops maintenance entirely
  (#611). The rule is defined once in `scripts/openwiki-claims.mjs` (`claimsDurabilityFindings`, the same
  check openwiki performs in `buildManifestEntry`) and exposed as gate rule **V16**, so a pull request
  that hand-edits a verified page goes red at review time instead of bricking the next paid run. A page
  with **no** manifest entry is not checked — openwiki leaves it "uncovered for full review" — and that
  is the escape hatch: to correct a covered page by hand, uncover it in the same commit (drop its
  manifest entry, delete its sidecar, delete its front-matter `verified:` event). The same module lets
  wiki-maintain's link normalization carry a covered page's certified hash across a pure link rewrite,
  so the harness cannot break the invariant it enforces — and only for a page that was durable *before*
  the rewrite, never laundering one that was already broken.

Full plan/execute CLI flags, the CI workflow's proposal-adoption logic, the debounce arithmetic, and
the self-test/lint/governance verification commands (`node scripts/wiki-maintain.mjs --selftest`,
`pnpm nx okf-lint infrastructure-as-code`, `pnpm nx okf-governance infrastructure-as-code`):
`../../docs/runbooks/wiki-maintenance.md`. The pull-request and CI surface around a proposal is covered
by the [CI/CD pipeline](../projects/ci-cd-pipeline.md), the
[feature-validation checklist](../invariants/feature-validation-checklist.md), and the
[devcontainer sandbox](devcontainer-sandbox.md) /
[host toolchain setup](dev-environment-setup.md) pages.
