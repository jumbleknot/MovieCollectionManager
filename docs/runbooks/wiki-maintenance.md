# Runbook — OpenWiki knowledge-bundle maintenance

**Feature 044.** How to run, read and diagnose maintenance of the OKF bundle at `openwiki/` — locally
and in CI — and where a new learning goes now that `CLAUDE.md` is an index.

Related: [ci-diagnostics.md](ci-diagnostics.md) · [devcontainer.md](devcontainer.md) ·
`openwiki/INSTRUCTIONS.md` (the generation brief) · `openwiki/policy.yaml` (the regeneration policy).

---

## 1. Plan before you pay

```bash
pnpm nx wiki-plan infrastructure-as-code            # offline, keyless, free — always safe
pnpm nx wiki-plan infrastructure-as-code --args=--json
```

The planner decomposes the documentation changes since the last recorded run into **slices**: at most
**8 pages**, exactly **one bundle area** each. It makes no model call and needs no credential, so
there is never a reason to skip it before spending. Read the plan; then run it.

At execution, consecutive same-kind slices of **different** areas are packed into one generator
invocation of up to `MAX_PAGES_PER_INVOCATION` pages (feature 078). Every invocation pays a fixed
planning pass — ~$0.33 on Sonnet, 83% of a one-page run — so a run touching three areas used to plan
three times. The slice is still the unit of the backlog: a failure carries forward only the areas whose
pages did not land.

```bash
pnpm nx wiki-maintain infrastructure-as-code        # PAID — needs the selected provider's key (§1a)
```

Useful overrides (they go through Nx's `--args`, which is appended to the command line):

| Flag | Use |
|---|---|
| `--args='--since <ref>'` | Ignore the run-record marker and plan over a range you choose. Diagnostics, and one-off sweeps |
| `--args='--max-slices 1'` | Attempt one slice and stop. The cheapest way to sanity-check a change to the machinery |
| `--args=--dry-run` | Print the exact command per slice and invoke **nothing**. Persists nothing either |
| `--args=--json` | Machine-readable output |

### 1a. Which model writes the bundle (feature 078)

The provider is **configuration**, not code. `scripts/wiki-provider.mjs` is the single table:

| `MCM_WIKI_PROVIDER` | Model | Key (first non-empty; mapped at the point of use) |
|---|---|---|
| `anthropic` — the **local** default (unset) | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, `MCM_ANTHROPIC_API_KEY` |
| `fireworks` — the **CI** default (the workflow sets it, at page concurrency 4) | `accounts/fireworks/models/deepseek-v4p1-flash` | `FIREWORKS_API_KEY`, `MCM_FIREWORKS_API_KEY` |

Three more knobs, all validated before any paid call — a malformed value exits 2, it is never read as
a default; an empty value is unset (how an Actions repository variable that was never set arrives):

- `MCM_WIKI_PAGE_CONCURRENCY` (1–8, default 1) — openwiki ≥ 0.6.0 writes that many pages in parallel.
  DeepSeek's wall-clock gap to Sonnet (~3.4×) is **call count**, not latency (078 research R3), so
  concurrency is the lever that closes it.
- `MCM_WIKI_SERVICE_TIER=priority` (Fireworks only) — +25% price. Measured on this workload it bought
  **no** speed (R3), so it is not the default.
- `MCM_WIKI_REASONING_EFFORT` (Fireworks only: `none`, `low`, `high`, `max`; unset = the model's own
  default, `high`) — sent as `reasoning_effort` by the usage tap, because openwiki 0.6.0 refuses an effort
  for its `fireworks` provider. The preflight sends it too, so a value Fireworks rejects fails before paid
  work. A run's usage line and record carry `effort=<value>` when it is set. **Under trial** (item #525):
  latency is roughly output tokens ÷ generation speed, and a lower effort means fewer reasoning tokens
  per call — but possibly a weaker page. In CI it is the `reasoning-effort` input of a **dispatched** run,
  so a trial never changes what a merge-triggered run sends; do not set the repository variable until a
  trial's page has been reviewed.

**In CI** these are repository **variables** (Settings → Actions → Variables), so switching back to
Anthropic is a settings change, not a commit; the keys are the secrets `ANTHROPIC_API_WIKI_MAINTAIN`
and `FIREWORKS_API_WIKI_MAINTAIN`. **Locally**, export the variables and run the Nx target as usual; the
dev container carries `MCM_FIREWORKS_API_KEY` from `~/.mcm-sandbox-env`.

**Why the Nx target names no provider.** nx builds a target's child env as
`{ ...process.env, ...targetEnv }` — a provider in the target's `env` would silently overwrite the
job's choice (078 research R4). The target runs `scripts/wiki-generate.mjs`, which resolves the table,
gives the generator **only** the selected provider's key, and passes `WIKI_RUN_MESSAGE` as one argv
element with no shell.

**Preflight.** Before the first paid slice, `wiki-maintain --execute` makes one minimal call to the
selected model (`node scripts/wiki-generate.mjs --preflight` does the same by hand). A failure exits
**2** with the record untouched and names the provider's error type — a withdrawn model id, a revoked
key or a blocked egress host costs one token, not a slice.

### Sizing a slice, and why the message must carry the SUBJECT

The planner asks for at most **8 pages** when *refreshing* existing concepts, but at most **3** when
*creating* new ones, and it never mixes the two kinds in one slice.

> **These two numbers were calibrated against a broken configuration, and nobody has re-measured them
> since it was fixed.** The evidence for the creation cap — 8-page creation slices "defeating three
> consecutive runs" — was collected while every turn was being silently truncated at 4096 output
> tokens (see below). A larger slice means a longer plan, and a longer plan is exactly what used to
> hit that ceiling, so the observed failure may have been the truncation rather than the page count.
> With the cap now at 16384 the creation limit of 3 may be needlessly conservative. Treat it as
> unverified rather than as a finding, and if you raise it, raise it against measurement.

What is *not* in doubt is that creation is dearer than refreshing: a refresh of an accurate page
needs no per-page source investigation and returns `noChange` in seconds.

More important than the count: **a filename is not a specification.** Given only
`gotchas/session-lifecycle-and-eviction.md`, the generator spends its whole budget working out what
that page should say — three runs died mid-research, one of them after printing *"Now I have enough
evidence for all 8 pages"*, having written nothing in 643 seconds. The run message therefore carries a
one-line **subject** per page. That single change was the difference between **0 pages in 643s** and
**3 pages in 367s**.

When seeding a one-off sweep by hand, put the subjects in the run record's `backlog` alongside the
page names:

```json
{ "area": "gotchas",
  "pages": ["docker-internal-dns.md"],
  "subjects": { "docker-internal-dns.md": "the BFF reaches Keycloak at keycloak-service:8080 inside Docker networks, never localhost" } }
```

### A slice that can never succeed, and how the backlog sheds it

**The backlog is committed, so it outlives the policy that produced it.** Twice on `main`, a slice
planned under an older policy — concepts summarizing `CLAUDE.md` and `AGENTS.md`, which are indexes
*into* the bundle — sat at the head of the backlog and could never succeed, because nothing would ever
legitimately write those pages. Worse, execution stopped at the first failed slice, so it also starved
the legitimate work queued behind it.

Both are fixed, and the fixes are worth knowing because they change what a red run means:

- **Carried-forward work is re-validated against the current policy on every plan.** A page whose
  source is no longer a coverage target is dropped and *reported* — look for
  `carried-forward page(s) dropped` in the plan output. Changing `policy.yaml` therefore reaches work
  already in the backlog, not just new work.
- **A failed slice no longer blocks the next one.** The run continues, and stops only after
  **two consecutive** failures — which is the line between "this slice cannot be done" and "nothing
  can". A run that stops there says so explicitly.

### Why the generator used to write nothing half the time — and what to check if it starts again

Through feature 044 roughly **half** of single invocations produced nothing, exited 0, and were
reported by Nx as success. That was recorded here as the generator being *non-deterministic*. **It was
not.** The cause, found on 2026-08-01, was a fixed and silent per-turn output-token ceiling:

- OpenWiki never sets `maxTokens`, so `@langchain/anthropic` picks a default by prefix-matching the
  model id against a hard-coded table, **falling back to 4096** on a miss.
- `claude-sonnet-5`, which the `wiki-update` target pinned at the time (feature 043), was **absent
  from that table**. Every turn was capped at 4096 output tokens.
- A turn truncated at the cap *before* it opens a `tool_use` block yields an assistant message with
  **zero tool calls** — precisely LangGraph's ReAct stop condition. The graph exits cleanly, OpenWiki
  exits 0, Nx prints `Successfully ran target`, and no page is written.
- Nothing reports this. OpenWiki never inspects `stop_reason`; Nx sees exit 0; the verifier can say a
  page is missing but never why.

Measured on the wire at turn 25 of a real run: `stop_reason=max_tokens`, `output_tokens=4096`, no tool
call. Full write-up and reproduction steps:
[`HANDOFF-generator-reliability-ANSWER.md`](../../specs/044-openwiki-automation-migration/HANDOFF-generator-reliability-ANSWER.md).

**Fixed upstream at 0.5.2, and still pinned here anyway.** OpenWiki now supplies an explicit
`maxTokens` of its own — `resolveAnthropicMaxOutputTokens` returns 16384 for any
`claude-(haiku|sonnet|opus)-(4|5)` id — and `@langchain/anthropic`'s table has since grown a
`claude-sonnet-5` entry, so both layers that failed now hold. That is exactly why the target does
**not** rely on either: the fix is invisible at runtime, a model rename or a vendor change would undo
it in one line, and the symptom is a green build with an empty diff. `wiki-update` therefore sets
**`OPENWIKI_MAX_OUTPUT_TOKENS=16384`** explicitly, which OpenWiki reads ahead of everything else — so
that value, not any vendor table, is the one that reaches the model. The model is pinned at
**`claude-sonnet-5`** (`OPENWIKI_MODEL_ID` in `infrastructure-as-code/project.json`).

**The pin has made a round trip, and both moves were deliberate.** Feature 043 (2026-07-27) pinned
`claude-sonnet-5`. The 2026-08-01 fix above moved it to `claude-sonnet-4-6` — an id the vendor table
*did* match, which was the only way to escape the 4096 fallback before an explicit cap existed.
Feature 075 (2026-09-21) moved it back to `claude-sonnet-5`, which is safe now because the explicit
`OPENWIKI_MAX_OUTPUT_TOKENS` no longer depends on any table. A reference to `claude-sonnet-4-6` in an
older document or commit is that middle period, not a conflicting pin.

**Why that model** (feature 075, 2026-09-21). The move back is purely a cost one: same vendor, same credential, same workflow, same Deep Agents caching middleware
— only the id changes. Sonnet 5 lists at $2/$10 per MTok against Sonnet 4.6's $3/$15, with cache
reads at $0.20/MTok against $0.30. Generation is the single largest line on the model bill (53% of
$74.89 over the 30 days to 2026-09-20) and is already ~92% cache reads, so list *input* price is the
wrong number to compare and the cached-read rate is the one that decides: a straight ≈−33%, from
≈$1.72 to ≈$1.15 per run-day, at no quality risk.

Two things to know before changing it again:

- **Run the guard first, and read the SKIP COUNT, not just the exit code.** Two of its four cap
  assertions skip when OpenWiki is absent from `/usr/local/lib/node_modules`, and a skip reads as a
  pass. The `claude-sonnet-5` bump was verified at 20 passed / 0 failed / **0 skipped**.
- **Verifying a generator version bump before the image carries it** (how 0.5.2 → 0.6.0 and
  0.6.0 → 0.7.1 were done, feature 078): side-install it — `npm install -g --prefix <dir> openwiki@<v> mermaid jsdom`, never
  over the container's global copy that other sessions are using — and run the guard with
  `OPENWIKI_ROOT=<dir>/lib/node_modules/openwiki`. The installed-generator assertions then read the
  new version instead of skipping; count them.
- **On every generator bump, re-check the gaps we work around.** The table is in
  [`specs/078-wiki-generator-cost/research.md`](../../specs/078-wiki-generator-cost/research.md) R15: request-body
  options (`service_tier`), reasoning effort for `fireworks`, local token usage, and the managed `AGENTS.md`
  block. For each, the table says which file to grep and which upstream issue or PR to watch. If a gap has
  closed, retire that part of `scripts/wiki-usage-tap.mjs` or the R12 guard in the same change, and update R15.
- **OpenWiki sends no `temperature`**, which is why this bump was safe where the agent gateway's was
  not. Sonnet 5 and Opus 5 reject that parameter with a 400 and the gateway was sending it
  unconditionally — see [`specs/075-llm-cost-phase-1/research.md`](../../specs/075-llm-cost-phase-1/research.md)
  R13. A model id is only a drop-in for the parameters the caller actually sends; if a future
  OpenWiki release starts sending sampling parameters, re-check that before bumping again.

`scripts/__tests__/wiki-maintain.guard.test.mjs` now asserts all three: that the explicit cap is set
and large enough, that OpenWiki's own resolver still matches the pinned id, and that the id would not
land on the 4096 fallback if the explicit cap were removed. **If you change `OPENWIKI_MODEL_ID` or
`OPENWIKI_MAX_OUTPUT_TOKENS`, run that guard.**

**If zero-page runs return, do not add a fourth retry attempt — measure the wire.** Point
`ANTHROPIC_BASE_URL` at a pass-through proxy that logs each response's `stop_reason` and
`output_tokens`; that is how this was found, and it is the only place the truth is visible.

#### The retry that remains

A slice is attempted up to **3 times within one run** before it goes back to the backlog. This covers
the ordinary residual variance of a model doing open-ended work. Note that retrying is close to
*useless* against a ceiling like the one above — every attempt runs into the same wall, and the
apparent independence of attempts is an illusion — so a persistent failure rate is evidence to
investigate, not a number to raise the attempt count against. Retries are bounded by the same page and
wall-clock budgets as everything else, and the attempt count is always reported:

```
[wiki-maintain] ✅ runbooks/ — 1 page(s) written and verified after 2 attempts
```

A `✗` line likewise says `after 3 attempt(s)`, so a slice that is genuinely unsatisfiable still looks
different from one that was merely unlucky.

**A rate-limited attempt waits instead of retrying at once (item #683).** A failed attempt where at least **half** of
its calls answered HTTP **429** is recognised from the usage tap's per-call `status` (never from the generator's text);
a stray 429 that the SDK's own retry absorbed inside a working attempt does not count. The retry then waits
**60 s** (120 s before a third attempt), but only while it would still *start* inside the 4-minute time budget and leave
the generator its 5 minutes before the job deadline; otherwise the attempt is **not** retried. Run 4798 (2026-10-06)
had retried straight into an active 429 three times in 29 seconds and reported it as an ordinary "produced nothing".
Either way it is named: a `RATE-LIMITED (N call(s) answered HTTP 429)` line at the attempt, a `RATE-LIMITED` line under
the `✗`, and `rateLimited: {attempts, calls}` on the invocation in `lastRunInvocations`. An attempt that produced
nothing **without** a 429 still retries immediately.

**A retry can never forgive what an earlier attempt did.** The working tree is snapshotted once,
before the first attempt, so a forbidden write on attempt 1 still fails the slice even if attempt 2
behaves. Re-snapshotting per attempt was tried and it laundered a policy violation into a success —
the existing policy-guard tests caught it immediately.

Beyond the retries, a failed slice still returns to the committed backlog and the marker still holds,
so successive runs continue to drain it. Investigate when the *same* slice fails across several runs,
or when a failure names something other than missing pages — a conformance regression or a policy
violation is a real defect, not a flaky generator.

### Why never the bare CLI

Always go through the Nx target. `openwiki` invoked directly skips `OPENWIKI_TELEMETRY_DISABLED=1`
and the raised Node heap, **and OOMs**. `wiki-maintain` shells out to `pnpm nx wiki-update
infrastructure-as-code` for exactly this reason, and a unit test asserts no code path calls the CLI
directly.

> **Nx `--args` is appended to a shell command line unquoted.** Measured: `--args="--since=one two"`
> arrives as two separate arguments. That is why the generated run message is a single line with no
> backticks, `$`, or quotes — a markdown-formatted message would be command-substituted, and the
> generator would scope itself to the first word.

---

## 2. What the exit codes mean

| Code | Meaning | Is something wrong? |
|---|---|---|
| `0` | Plan produced, or every attempted slice verified, or nothing to do | No |
| `1` | A slice **failed verification** — a requested page missing or left stale, the bundle became non-conformant, or a write landed where policy forbids it (§3) | **Yes** |
| `2` | Bad usage, unreadable run record, a missing credential, a malformed `MCM_WIKI_*` value, or a failed preflight | **Yes** |
| `3` | Stopped at the run budget with work outstanding | **No** — the remainder is in the backlog |

**Exit 3 is not a failure.** Same reasoning as `ci-status.mjs` distinguishing runner starvation from a
red build: a run that correctly stopped at its budget must not be reported as broken. Re-run it and it
continues where it left off.

### The budget

**One 8-page generator invocation per run, in a 60-minute window (120 when dispatched)** (feature 078, research R9 — operator decision,
2026-09-28). The constants live in `scripts/wiki-maintain.mjs` (C6) and the guard test *derives* the workflow's
`timeout-minutes` from them, so changing one without the other fails offline:

| | Value | Why |
|---|---|---|
| Page budget | 8 | one invocation's worth (`MAX_PAGES_PER_INVOCATION`) |
| Time budget | **4 min** | a deadline for **starting** work — checked between invocations and retries; it never stops an invocation, the job deadline does |
| Job deadline | window − 8 | an invocation in CI is **stopped** when it would run into the last 8 minutes of its window (see below) |
| Worst-case invocation | 30 min | 8 pages at page concurrency 4 is two waves of workers, measured ≤ 23 min |
| Window (push) | 60 min | 15-min debounce (it sleeps **inside** the job) + setup + 4 + 30 + publishing ≈ 55, plus margin |
| Window (dispatch) | 120 min | the whole job — a dispatched run has no debounce and may need it (see below) |
| Job timeout | 120 min | the hard ceiling (operator decision, 2026-10-02); a push run is held to its 60-minute window by the deadline, not by this |

So a run does one invocation and stops — a second starts only if the first finished inside 4 minutes, and a retry only
after a fast failure; everything else carries forward in the backlog. That includes slices the **plan** defers past the
page budget, before any generation: until 2026-10-09 those were printed as "carried forward" but never written to the
backlog, so the marker advanced past their range and they were lost. Declared effective ceiling: **≤16 pages / ~34 min
of generation**. The page count comes from **files that actually appeared in the working tree**, not from what the
generator says it wrote.

**The job deadline (item #613).** The workflow's first step records `WIKI_JOB_DEADLINE` from a window chosen **per
event**: `workflow_dispatch` gets `DISPATCH_MINUTES=120` (the whole job), `push` gets `PUSH_MINUTES=60` — so the runs
every merge starts keep the shared-runner hold, and raising the ceiling cannot lengthen them. The guard test pins both
(`DISPATCH_MINUTES` equals `timeout-minutes`, `PUSH_MINUTES` is 60). Each invocation then runs under GNU `timeout` with the time left minus an 8-minute
reserve for verification, publishing and the run-record commit; a slice with under 5 minutes left is not started and
carries forward (exit 3). A deadline stop does **not** by itself fail the slice: after the revert below, the slice is
judged like any other, by what landed. In practice a stopped generator leaves a requested page unwritten or stale, so
the slice fails (exit 1); a slice whose requested pages all landed fresh before the stop verifies. Either way the run
**still commits its record, usage and digest**. Before this, a hang ran until the platform killed the job with nothing recorded — measured on runs
4290, 4385 and 4386. `timeout` signals the whole process group, which matters because nx starts openwiki as a
grandchild; that holds while nx uses no pseudo-terminal, which it does only when stdout is a TTY — never in CI.

**Why a run hung for an hour (2026-09-30).** For an OpenAI-compatible provider (Fireworks) openwiki sets no request
timeout, so the OpenAI SDK's **10-minute** default applies, and at page concurrency above 1 openwiki retries **5** times:
one model request accepted and never answered was about 60 silent minutes. The generator's environment now sets
`OPENWIKI_PROVIDER_RETRY_ATTEMPTS=2` (an explicit operator value wins), bounding that at about 30 minutes; the deadline
above bounds the rest. A merge-triggered run also spends its first 15 minutes in the debounce, so it has about 45
minutes, not 60 — size the work for that window.

**Why dispatched runs get 120 minutes (operator decision, 2026-10-02).** An *uncovered* page — one with no
`.page-manifest.json` entry, left by openwiki "for full review" — needs about 1.65× the output per call and over 1.6× the
calls of a covered one. Generation speed on Fireworks also varies by the hour: measured 45–145 tok/s across a few days,
and latency per call is roughly output tokens ÷ that speed. At 70–80 tok/s, `projects/sast` stopped at the old 51-minute
deadline after 93 calls of ~29.5 s each, while a covered page finished in 58 calls. Process uncovered pages **one per
dispatched run**: seed the page through a pull request that edits `backlog` in `.maintenance-state.json`, merge it (the
merge run then has nothing to do), and dispatch.

If a run is ever killed at `timeout-minutes` anyway, the deadline arithmetic is wrong: re-measure (research R9's
method) before raising the timeout, which is a decision about the shared runner.

**Neither budget is a monetary bound.** Nothing in this feature enforces a spend ceiling. Until
feature 078 a run could not tell you what it cost — the only figure was the provider's bill, such as
the 30-day figure quoted under *Why that model* in §1. It now records an estimate (below), but that is
a measurement, not a limit. The wall-clock budget bounds *runner occupancy* — there is one CI runner
and `app-e2e` is ~35 minutes on it.

### What a run cost (feature 078)

OpenWiki reports no usage itself, so `scripts/wiki-usage-tap.mjs` is loaded into the generator process
and records per-call **counts** (never content). Each invocation's counts are priced from
`scripts/wiki-provider-prices.json` — a dated table; update `asOf` with every change — and the run total
lands in the job log and in `lastRunUsage` in `openwiki/.maintenance-state.json`:

```text
[wiki-maintain] usage runbooks/: 47 call(s), 183838 uncached / 2801438 cached / 43117 output tokens, ~$0.0883 (fireworks, prices 2026-09-27)
[wiki-maintain] run usage: ~$0.0883 over 47 call(s) in 1 invocation(s), fireworks, prices 2026-09-27
```

It is an **estimate** (it reconciled with the Fireworks bill to the cent on the 078 research probes).
`not captured` means the tap produced nothing — it is never written as $0. A line saying
`PARTIAL total` means some invocations were not captured. `failedCalls` counts non-200 responses:
rate limiting under page concurrency shows up there first.

---

## 3. Reading a failure

A slice fails when **any** of four things is true, and the generator's exit status is not one of them:

1. **A requested page does not exist after the run.** The contract is the pages the slice
   *requested*, not "some page appeared": a run that wrote unrelated pages while ignoring the request
   fails, and an `index.md` alone counts as zero pages — feature 043's false-green run was 12 minutes
   of paid work, one `index.md`, exit 0, reported as success. Writing **nothing** is not by itself a
   failure: a refresh whose requested pages all exist and none is stale (cause 4) passes as
   `✅ … nothing needed changing (0 written)`.
2. **The bundle stopped being conformant** (`check-openwiki-okf.mjs`, rules V1–V16). V16 is the one
   that protects every *later* run: each page openwiki has covered (an entry in
   `openwiki/.page-manifest.json`) must still hash to the `pageVersion` its verified Claims sidecar
   certifies. openwiki refuses the whole run otherwise (`Markdown and verified Claims are not durable`)
   — see *Claims sidecars* below.
3. **A written path was not permitted** by `openwiki/policy.yaml` — including a write into
   `docs/runbooks/`, which is `regenerate` but governed by an *agent*, not the generator.
4. **A requested page is still stale after the run** (items #587, #616). A requested page that cites
   a `resource` whose last **commit** is newer than the page's stamp (the **newest** of
   `generated.at`, `verified.at` and `timestamp`) is named in the failure one page at a time —
   **whether or not the run changed the file**. A real refresh moves `generated.at` past the source's
   commit, so it is never flagged; a page left unwritten, or changed only in front matter, is. (Until
   2026-09-29 only *unwritten* pages were judged, and on proposal #615 a run that merely deleted a
   `verified:` block counted as a refresh while the page stayed stale.) A multi-page slice no longer
   passes because *some* of its pages were written. A page whose source has **not** moved
   since its stamp may still honestly write nothing: that is the `✅ … nothing needed changing` line,
   not a failure. A page with no stamp, an external resource, or an untracked source cannot be
   checked and keeps that outcome too. A legacy date-only stamp (see *Drift is reported, never
   planned* below) reads a same-day source commit as newer, so such a page is retried until the
   generator restamps it. That errs toward retrying, never toward a silent skip.
   The stamp rule is `scripts/openwiki-stamp.mjs`, imported by both this check and V12 so the two
   cannot disagree.

The failed slice returns to the backlog and **the marker does not advance**, so the work stays
outstanding and the next run retries it.

### In CI

```bash
node scripts/ci-status.mjs status --branch main       # is anything red?
node scripts/ci-status.mjs failure --pr <n> --full    # the published digest + evidence bundle
```

`wiki-maintain` publishes a feature-042 failure digest like every other job, so a failure is
diagnosable without touching the runner host. It is **not** a required context and never gates a
merge.

### Remediation — the one rule

**Fix `openwiki/INSTRUCTIONS.md` and re-run. Never allowlist rejected content.** If a page trips the
conformance gate, a leak scan, or the governance gate, the brief is the surface that changes; the
gates have no skip flag and no allowlist by design, because an allowlisted leak stays leaked.

---

### Escalation after a deadline failure (078 US6)

When the job deadline stops the generator (it exits 124 or 137 from `timeout`), every requested page that did not
land is **tagged**. The next run, whether merge-triggered or dispatched, gives the tagged pages invocations of their
own at `reasoning_effort: low`, before any other work. Everything else runs at the default effort.

- **Only a deadline stop tags.** A worker that "exited without submitting", a provider 429, an openwiki state error
  and a policy or conformance violation never tag: those are normal exits, and `low` does not cure them (item
  #682). A start-deadline carry-forward is not a failure either.
- **Where the tags live:** `escalations` in `openwiki/.maintenance-state.json`, keyed `area/page`, beside the
  backlog:
  ```json
  "escalations": { "runbooks/sast-scanning.md": { "effort": "low", "reason": "deadline", "since": "…", "failuresAtLow": 0 } }
  ```
- **Precedence:** an explicit effort, from the `reasoning-effort` dispatch input or the `MCM_WIKI_REASONING_EFFORT`
  repository variable, applies to the whole run. The tags are kept for later. A provider without reasoning effort
  (`anthropic`) ignores them.
- **Clearing:** a tag goes when its page lands. Tags are per page, so a page that landed inside a part that failed
  is cleared, not tagged.
- **Which effort each invocation used:** `lastRunInvocations` in the run record (pages, `effort`, `deadlineStop`,
  `estCostUsd`). `lastRunUsage.reasoningEffort` reads `mixed` when invocations differ.
- **When `low` also fails:** the tag stays and `failuresAtLow` counts up. The run logs, and the failure bundle
  carries:
  `[wiki-maintain] ⚠ escalated to low and still failing (N): area/page — consider parking it (078 US6)`.
  Nothing is parked automatically.
- **Parking a tagged page:** remove its backlog slice **and** its `escalations` entry in the same commit. A tag left
  behind for a page that is neither queued nor present is dropped by the next run. One for a page that exists is
  kept, and does nothing until the page is planned again.
- **Caveat:** the evidence that `low` lands a slow page is one success on one page (spec 078 research R14). Escalation
  guarantees the retry happens, and that a repeat failure is visible. It does not guarantee the page lands.

## 4. What CI does, and why it waits

Merge-triggered on `main`, with a **~15-minute quiet period**: `concurrency` +
`cancel-in-progress: true` + an initial `sleep`. A new push cancels the sleeping run and a fresh one
starts, so a burst of merges produces exactly one run covering all of them.

A merge stream that never goes quiet would starve maintenance exactly when drift is fastest, so beyond
a **6-hour maximum deferral** the wait is skipped. That age is derived from **git** — the commit date
of the oldest commit the run record has not covered — because the waiting run gets *cancelled*, and
any timer it was holding dies with it. Git state survives cancellation; run state does not.

`workflow_dispatch` bypasses the wait entirely.

The run **does not trigger itself**: the `[skip ci]` marker commit and a bundle-only change (its own
proposal landing) are both recognised and skipped.

### The proposal

One long-lived branch (`openwiki-maintenance`), one open pull request, **ever**. A run that finds it
open **continues the remote branch, rebases and appends** rather than opening a second — so a commit
you push onto that branch survives every subsequent update. It is **never auto-merged**: a human
reviews every wiki diff, and the proposal is gated by the normal guardrails like any hand-authored
change.

**A reviewer commit must not edit a Claims-verified page in place.** A page with an entry in
`openwiki/.page-manifest.json` is certified byte-for-byte by its `.claims` sidecar; editing it breaks
that, and openwiki then refuses **every** later run — measured on 2026-09-29, when four hand-corrected
pages on #606 stopped maintenance until #610 recovered it. The OKF gate's V16 now fails such a PR.
To correct a covered page by hand, **uncover** it in the same commit: remove its manifest entry,
delete its sidecar, and delete its front-matter `verified:` event. openwiki then leaves it for full
review, and the correction stands until the page is next regenerated.

The runner is a fresh checkout, so the branch exists there only on the remote; the run checks it out
from there, and only while its proposal is **open** (a closed one's commits are not revived). Until 2026-09-28 it looked only for a *local* branch, found none on every CI run,
started from `main`, and the `--force-with-lease` push replaced the open proposal — measured on
proposal #594, where a 4-page and then an 8-page slice were discarded while the run record still
listed both. The push now also refuses outright (`pushing would discard N commit(s) from open
proposal`) if the open proposal holds a commit the new head does not: a red run, never a silent
overwrite.

Closing it **without merging** returns its work to the backlog and rolls the marker back to the proposal's
`markerBefore` — without that, abandoning a proposal leaves the marker certifying work that never landed. The next
run **reconciles before it plans**, so it plans the returned slices and the whole range from the rolled-back marker;
`markerBefore` is the marker the opening run *found*, captured before generation. Both were broken until item #619
(2026-10-09): the run planned before reconciling, so its own backlog and marker overwrote the reconciled ones, and
`markerBefore` recorded the run's own base commit — proposal #615's slice vanished on the very next run, and was
re-seeded by hand. `executeRun` in `scripts/wiki-maintain.mjs` is the whole sequence, and a test drives a
closed-unmerged proposal through it.

**When a proposal is created or updated.** Whenever any page landed — including a run that stopped
at its budget (exit 3) or had a failed slice (exit 1). A failed slice is returned to the backlog and the run
carries on to the next slice; it stops early only after two consecutive slice failures.

**A failed part's requested pages are put back before anything is proposed (item #685).** The proposal stages the
whole working tree, so a failed part's bytes used to ride along with whatever landed. On #684 (run 4801) that was
`runbooks/sast-scanning.md` after openwiki's restore path had rewritten it without its `verified:` block and re-hashed
its sidecar to match: V16 sound, no gate noticed, and merging would have erased a verification event for a page that
was never regenerated. Now, after a failed invocation, each failed part's page and `.claims` sidecar return to their
committed bytes and its `.page-manifest.json` entry to its pre-invocation value — all three or none, so V16 still
compares a page with its own sidecar — and the run says so (`[wiki-maintain] restored N path(s) of the part(s) that did
not land`). Left alone, and so still possible on a proposal: a page whose page or sidecar was dirty **before** the
invocation (its prior bytes are not in git), an **untracked** new page (it has no committed state, and deleting it would
orphan its index link), and anything the generator wrote **outside** the requested pages. Review those as such.

**One invocation can carry several slices, and a failure in one part no longer discards the others.** When an
invocation's failure is attributable only to *other* parts — a requested page missing or still stale — while
conformance (V16 included) and policy are clean, `verifySlice` reports the parts that verified as `landedParts`, and
they are proposed (`proposableSlices`: verified invocations plus landed parts); only the failed parts return to the
backlog. Before this, run 4399 (2026-10-01) verified `runbooks/backlog.md` but proposed nothing because `projects/sast.md`
in the same invocation was still stale at the deadline — and since the backlog page's source change was already behind
the marker, nothing would have planned it again. A **whole-invocation** failure (conformance or policy) still proposes
nothing and returns every part.

**After a deadline stop, the slice keeps only what it requested.** openwiki forces every page with a Claims issue into
a run, so a generator stopped part-way (GNU `timeout` exit 124, or 137 after `--kill-after`) can leave a page it was
never asked for half-written — on run 4606 (2026-10-04) that broke V16 on `projects/keycloak.md`, a whole-invocation
failure, and the requested page's $0.96 regeneration was lost. `revertUnrequested` now restores every path the run
changed to its committed state (or deletes it if new) **except** the requested pages, their `.claims` sidecars and the
requested areas' `index.md`; paths that were dirty before the run are left alone. It applies **only** to a deadline stop:
a generator that exits on its own is judged on everything it wrote.

### If the run record and the forge disagree, the forge wins

The record's `proposal` pointer is a **cache** of something the forge owns. It can be lost: the record
is committed by a step that can fail, and it did — a run created the proposal, its marker commit lost
a push race against `main`, and the pointer never landed. The next run then tried to open a *second*
proposal and died on `forge POST /pulls → 409`. The one-proposal invariant survived only because the
forge refused.

So a run now asks the forge which proposal is open for the branch, adopts it, and updates it. A run
that has lost its record is self-healing rather than permanently stuck, and a 409 is handled by
adopting the existing proposal rather than failing.

### The run record

`openwiki/.maintenance-state.json`, committed, because runners are ephemeral and the marker has to
advance even on a run that produced no proposal. It is **not** `openwiki/.last-update.json` — that
file belongs to the tool, and 043 measured it advancing only when wiki content changed, which is
exactly why the free "nothing to document" path was unreachable.

To seed work by hand (the one-off relocation used this), put slices in its `backlog` array and run
`wiki-plan`: carried-forward slices are planned first, so a backlog never starves behind fresh
changes.

---

## 5. Where a new learning goes

**The canonical home of its subject**, determined mechanically from the bundle:

1. Find the concept covering the subject (query by `type`/`tags`, or read the area's `index.md`).
2. **Does it carry a `resource`?**
   - **Yes** → it is a *derived summary*. Write the learning into the **cited source** — the runbook,
     the decision record, the architecture document — and let the summary refresh from it.
   - **No** → it is *authoritative*. Write the learning **into the concept**; there is no upstream
     document to write into.
3. **No concept covers it?** Add one, and where the subject has a canonical document, write the detail
   there and cite it.

So an operational learning belongs in the runbook, **not** in the page summarizing the runbook. A
concept that becomes a copy of its source has failed the generation brief, and hand-writing into
derived summaries is how that starts.

**Do not write prose into `CLAUDE.md`** expecting a later run to relocate it. That file is an index and
a gate fails on content beyond its index and its three machine-managed regions. The rejected
alternative — grow the instruction file and clean up later — is recorded in `INSTRUCTIONS.md` §6: it
needs an automated run to rewrite instruction-file content, which the generator's write scope
excludes, and it reinstates the grow-then-trim cycle this arrangement exists to end.

### Protected passages

`openwiki/protected.yaml` lists the **authoritative** concepts and fingerprints the load-bearing
passages inside them. A refresh that reworded one **fails the governance gate** rather than depending
on a reviewer noticing. To change such a passage legitimately, update its text **and** its fingerprint
in the same change:

```bash
node scripts/check-openwiki-governance.mjs --fingerprint openwiki/<area>/<page>.md "<heading text>"
pnpm nx okf-governance infrastructure-as-code
```

A passage may only be protected on a concept with **no** `resource` — freezing a derived summary
against the document it summarizes would fail every legitimate refresh.

---

## 6. Link form — the one thing the generator gets wrong on its own

The generator writes `](/openwiki/…)`. **That is a dead link on this forge**, and it is not a
cosmetic preference: a leading `/` resolves against the **site** root, so the forge reads `openwiki`
as a *username* and 404s. Measured with `POST /api/v1/markup` (the endpoint that takes `Context`,
`BranchPath` and `FilePath`, so it renders exactly as the file view does — `/api/v1/markdown` takes
no file path and cannot answer this). 204 links across 61 of the bundle's 77 files were broken this
way before anyone checked, and `okf-lint` passed the whole time because it only verified the
`resource` front matter (item #491).

Three things now hold the line, and you should not need any of them by hand:

1. `openwiki/INSTRUCTIONS.md` §6 states the convention, so the generator is asked for the right form.
2. `verifySlice` normalizes whatever the slice wrote, deterministically, before the gate reads it —
   because the brief is an instruction to a model, not a guarantee.
3. `okf-lint` rules **V14** (site-root-absolute) and **V15** (does not resolve from its own file's
   directory) fail the build for anything that arrives by another route.

If you ever need the bundle-wide sweep — a bundle restored from elsewhere, say:

```bash
node scripts/wiki-maintain.mjs --normalize-links --dry-run   # what would change, writes nothing
node scripts/wiki-maintain.mjs --normalize-links             # do it
```

Offline and free; it needs no credential. It moves **only** the target inside `](…)`, never prose,
and it skips code fences and code spans. If it touches a page carrying a protected passage, the
governance gate will demand the fingerprint be re-cut in the same change — that is working as
intended, and `--fingerprint <concept> "<anchor>"` prints the new value.

---

## 7. Verifying the machinery itself

```bash
node scripts/wiki-maintain.mjs --selftest             # planner + verifier, offline, keyless
pnpm nx okf-lint infrastructure-as-code               # bundle conformance, V1–V16
pnpm nx okf-governance infrastructure-as-code         # policy, protection, index — G1–G12
node --test scripts/__tests__/wiki-maintain*.test.mjs
node --test scripts/__tests__/openwiki-links.test.mjs # body-link scanner and normalizer
```

`--selftest` includes a **deliberately sabotaged generator** that exits 0 having written nothing. If it
ever passes, the zero-page detector is broken — which is the one failure mode that would let this
whole arrangement go quietly back to reporting false green.

---

## 8. The OKF v0.1 → v0.2 provenance migration (OpenWiki 0.5.x)

OpenWiki 0.5.x emits **OKF v0.2**, which replaces the flat `timestamp:` scalar with a structured
`generated: {by, at}` event. The bundle does not convert in one step, and the way it converts is the
part worth knowing:

- `finalizeGeneratedProvenance` stamps `generated` on every page whose **body changed** in the run,
  and in the same pass **removes that page's `timestamp` field**. It is a replacement, not an
  addition.
- A page whose body did not change keeps its prior stamp untouched. So the bundle carries **both
  shapes at once**, one per page, and flips over gradually as pages are regenerated.
- The root `index.md` declares `okf_version: "0.2"`. The legacy `timestamp` stays valid on pages that
  have not been rewritten, so there is nothing to migrate by hand and no cutover to schedule.

**Why this needed a gate change rather than nothing.** `check-openwiki-okf.mjs` reads the stamp for
V12, the drift warning that reports a concept whose cited source has moved on. Had it kept reading
only `timestamp`, it would not have failed — it would have gone on printing `✅ conformant` while
silently covering one fewer page every time a page was regenerated, until drift checked nothing at
all. The gate now resolves the stamp through one shared helper, `scripts/openwiki-stamp.mjs`, which
takes the **newest** of `generated.at`, `verified.at` and `timestamp` (operator decision 2026-09-28).
Newest, because each is an event and OpenWiki can add one without the others: it re-verifies a page's
Claims and adds `verified` while leaving the body — and so `generated` and `timestamp` — untouched.
Measured on `decisions/adr-0001-prod-secrets-management.md`, verified at 17:17Z against a source that
changed at 16:17Z, which V12 went on reporting as stale while it read only the other two. An older
verification never drags a newer generation backwards.

V5 validates the ISO-8601 shape of every one of those values, including each entry of `verified`,
which OpenWiki writes as a **list** of `{by, at}` events. Until 2026-09-28 V5 read it with a path
reader that did not descend lists, so no real `verified.at` had ever been validated.

**The number to watch.** A concept that cites a `resource` but carries no usable stamp is one drift
cannot check. That is not a conformance violation and never fails the build, but the gate now counts
and prints those pages:

```
[openwiki-okf] ⚠️  N concept(s) cite a source but carry no usable `generated.at` or `timestamp` —
drift is NOT checked for these:
```

If that count climbs, drift coverage is falling — investigate the generator's provenance pass rather
than the pages. A silent loss of coverage is precisely the failure this counter exists to make loud.

### Drift is reported, never planned

V12 is **warn-only** — it never touches the exit code — and it is **not an input to the planner**.
`planSlices` in `scripts/wiki-maintain.mjs` takes only the paths changed since the run-record marker
and the carried-forward backlog; its header says so deliberately, because one edit to a widely cited
file would fan out across every concept citing it and never clear. The consequence is that a concept
which falls behind the marker — its source changed, but the slice that should have refreshed it did
not — is **not re-planned automatically**. The V12 list is the only place it shows up, and clearing
it takes a hand-seeded sweep (`--since <ref>`, or pages put in the run record's `backlog`).

Known ways a concept falls behind, each tracked:

- **#526** — the general gap: nothing re-plans a concept once the marker has passed its source change.
- **#587 (fixed)** — a refresh slice that wrote nothing for one of its requested pages used to
  verify, because the only check was that the requested pages *exist*. An existing page that had not
  been rewritten counted toward `noChange`, and the marker advanced past the change. Measured on
  `openwiki/runbooks/renovate.md`, 2026-09-26. `verifySlice` now fails the slice for such a page when
  its source is newer than its stamp (§3, cause 4), so the page returns to the backlog and the marker
  holds. This closes the route by which a *planned* page fell behind; #526 remains for pages that were
  never planned.
- **#616 (open; its guards are in place)** — a run that only stripped a page's `verified:` block counted as a
  refresh, and left Markdown and Claims inconsistent (proposal #615). The cause is openwiki's own restore path when a
  worker exits without submitting. Both guards shipped in #617: a requested page changed only in front matter is
  judged stale (§3, cause 4), and V16 fails a non-durable bundle. The item stays **open** for its last criterion, a
  real refresh of `runbooks/ci-diagnostics.md`, which the current Fireworks model cannot generate (see #589). Do not
  describe #616 as fixed.
- **#525** — the drift-driven sweep that clears the current V12 list. It was blocked on #587 and on
  the canonical documents being corrected first (#588, done), so that it does not regenerate from
  wrong sources.

**Read a V12 line with its stamp in mind.** The comparison is the source's last **commit** date
against the page's stamp (the newest of `generated.at`, `verified.at` and `timestamp`). Several pages
still carry a legacy date-only stamp — `timestamp: 2026-08-08T00:00:00+00:00` on
`openwiki/runbooks/backlog.md`, eleven such pages on 2026-09-28 — so a source commit made later **the same day** reads as drift
even when the page was generated from it. `backlog.md` is exactly that case: its source's last
commit is `2026-08-08T19:38:20+00:00`. Compare the dates before queuing such a page; the warning
clears for good once the page is regenerated and gains a full `generated.at`.

### Diagrams need their parser installed, or they degrade silently

From 0.5.0 OpenWiki embeds Mermaid diagrams by default and validates every fence after a run. The
authoritative validator is the real `mermaid` parser, which is an **optional peer dependency**
alongside `jsdom`. Without them OpenWiki falls back to a lightweight built-in check, and any diagram
that fails validation is rewritten in place into a plain `text` fence with a short comment — the run
still exits 0 and every gate still passes.

Both are therefore installed beside the generator in `.devcontainer/toolchain.Dockerfile` **and** in
`.forgejo/workflows/wiki-maintain.yml`, and a guard in `scripts/__tests__/wiki-maintain.guard.test.mjs`
asserts the two lists match — if only one environment has the parser, the two disagree about what a
valid diagram is, and the one that writes the bundle wins.

---

## 9. Claims sidecars (`openwiki/.claims/`)

OpenWiki 0.5.2 records **Claims** for the pages it writes: atomic, evidence-backed propositions that
the page body relies on. They live beside the bundle, one JSON sidecar per page, mirroring the page's
path — `openwiki/.claims/runbooks/backups.json` belongs to `openwiki/runbooks/backups.md`. Twelve
exist at the time of writing, all written by the generator since 2026-09-20, and each of the twelve
pages carries a matching `verified:` entry (`by: openwiki/0.5.2`, `at: <ISO time>`) in its front
matter.

A sidecar holds `schemaVersion`, a `pageVersion` hash of the page, a `verification: {by, at}` event,
and a `claims` array. Each claim has a stable `id`, a `statement`, and one or more `evidence` entries,
each a `repo://<path>` resource (optionally with a `#Lx-Ly` line range) plus a resolver-computed
`version` hash of that source as it stood when the claim was made. On a later refresh OpenWiki marks
a claim `stale` when its evidence's version no longer matches (or `unresolved` when the evidence
cannot be resolved), and the generator must then confirm, revise or retract it — the installed
package's `dist/claims/guidance.js` states those rules.

What this repository does with them today:

- **Policy.** `openwiki/policy.yaml` has no rule of its own for `.claims/`; the sidecars are permitted
  only by the `openwiki/**` catch-all (`regenerate`, `actor: generator`).
- **Gates.** `okf-lint` touches Claims in three places. V5 validates the ISO-8601 shape of every
  `verified.at`, and V12 counts it as a stamp (the newest of `generated.at`, `verified.at` and
  `timestamp`). **V16 reads the sidecars:** every page with a `.page-manifest.json` entry must have a
  sidecar with a `verification` whose `pageVersion` equals the sha256 of the page's current bytes —
  the exact invariant openwiki 0.6.0 enforces before it will run (`buildManifestEntry` in
  `generation/page-manifest.js`), defined once in `scripts/openwiki-claims.mjs`. A page with no
  manifest entry is not checked; openwiki leaves it for full review. The same module lets
  wiki-maintain's link normalization carry a covered page's certified hash across a pure link
  rewrite, so the harness cannot break the invariant it enforces.
- **Decision.** The operator decided on 2026-09-27 that Claims are required and valuable (item
  **#513**). The decision's details, and any gates or lifecycle rules that follow from it, are being
  recorded under #513. The only gate on sidecars today is V16's durability check (above); nothing
  checks that a sidecar's claims are *true*, so do not treat one as reviewed content.
