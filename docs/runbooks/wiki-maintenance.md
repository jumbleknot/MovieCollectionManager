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
| unset / `anthropic` (default until the 078 flip) | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, `MCM_ANTHROPIC_API_KEY` |
| `fireworks` | `accounts/fireworks/models/deepseek-v4p1-flash` | `FIREWORKS_API_KEY`, `MCM_FIREWORKS_API_KEY` |

Two more knobs, both validated before any paid call — a malformed value exits 2, it is never read as
a default; an empty value is unset (how an Actions repository variable that was never set arrives):

- `MCM_WIKI_PAGE_CONCURRENCY` (1–8, default 1) — openwiki ≥ 0.6.0 writes that many pages in parallel.
  DeepSeek's wall-clock gap to Sonnet (~3.4×) is **call count**, not latency (078 research R3), so
  concurrency is the lever that closes it.
- `MCM_WIKI_SERVICE_TIER=priority` (Fireworks only) — +25% price. Measured on this workload it bought
  **no** speed (R3), so it is not the default.

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
- **Verifying a generator version bump before the image carries it** (how 0.5.2 → 0.6.0 was done,
  feature 078): side-install it — `npm install -g --prefix <dir> openwiki@<v> mermaid jsdom`, never
  over the container's global copy that other sessions are using — and run the guard with
  `OPENWIKI_ROOT=<dir>/lib/node_modules/openwiki`. The installed-generator assertions then read the
  new version instead of skipping; count them.
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
| `1` | A slice **failed verification** — zero pages written, the bundle became non-conformant, or a write landed where policy forbids it | **Yes** |
| `2` | Bad usage, unreadable run record, a missing credential, a malformed `MCM_WIKI_*` value, or a failed preflight | **Yes** |
| `3` | Stopped at the run budget with work outstanding | **No** — the remainder is in the backlog |

**Exit 3 is not a failure.** Same reasoning as `ci-status.mjs` distinguishing runner starvation from a
red build: a run that correctly stopped at its budget must not be reported as broken. Re-run it and it
continues where it left off.

### The budget

**16 pages** and **20 minutes**, whichever is reached first, checked *between* slices so a slice under
way is never interrupted. The overshoot is therefore bounded at one slice — a declared **effective
ceiling of ≤24 pages / ~37 minutes**. Both are configurable (`--page-budget`, `--time-budget`).

The page count comes from **files that actually appeared in the working tree**. It is not what the
generator says it wrote, and a stub that claims 99 pages while writing one moves the counter by one.

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

A slice fails when **any** of three things is true, and the generator's exit status is not one of them:

1. **No concept page appeared.** An `index.md` refresh counts as zero pages — that is precisely what
   feature 043's false-green run produced: 12 minutes of paid work, one `index.md`, exit 0, reported
   as success.
2. **The bundle stopped being conformant** (`check-openwiki-okf.mjs`, rules V1–V15).
3. **A written path was not permitted** by `openwiki/policy.yaml` — including a write into
   `docs/runbooks/`, which is `regenerate` but governed by an *agent*, not the generator.

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
open **rebases and appends** rather than opening a second — so a commit you push onto that branch
survives every subsequent update. It is **never auto-merged**: a human reviews every wiki diff, and
the proposal is gated by the normal guardrails like any hand-authored change.

Closing it **without merging** returns its work to the backlog and rolls the marker back. Without
that, abandoning a proposal would leave the marker certifying work that never landed.

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
pnpm nx okf-lint infrastructure-as-code               # bundle conformance, V1–V15
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
all. The gate now resolves the stamp through a single helper that prefers `generated.at` and falls
back to `timestamp`, and V5 validates the ISO-8601 shape **inside** the nested `generated.at` and
`verified.at` events rather than only at the top level.

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
- **#587** — a refresh slice that writes nothing for one of its requested pages still verifies,
  because for a refresh the check is that the requested pages *exist*, and an existing page that was
  not rewritten counts toward `noChange`. The marker then advances past the change. Measured on
  `openwiki/runbooks/renovate.md`, 2026-09-26.
- **#525** — the drift-driven sweep that clears the current V12 list, blocked on #587 and on the
  canonical documents being corrected first (#588), so it does not regenerate from wrong sources.

**Read a V12 line with its stamp in mind.** The comparison is the source's last **commit** date
against the page's stamp (`generated.at`, else `timestamp`). Several pages still carry a legacy
date-only stamp — `timestamp: 2026-08-08T00:00:00+00:00` on `openwiki/runbooks/backlog.md`, twelve
such pages at the time of writing — so a source commit made later **the same day** reads as drift
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
- **Gates.** `okf-lint` does not read the sidecars. Its only contact with Claims is V5 validating the
  ISO-8601 shape of a page's `verified.at`.
- **Decision.** The operator decided on 2026-09-27 that Claims are required and valuable (item
  **#513**). The decision's details, and any gates or lifecycle rules that follow from it, are being
  recorded under #513 — none exist yet, so do not treat a sidecar as checked by anything here beyond
  the generator itself.
