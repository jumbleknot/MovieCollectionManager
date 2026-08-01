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

```bash
pnpm nx wiki-maintain infrastructure-as-code        # PAID — needs ANTHROPIC_API_KEY
```

Useful overrides (they go through Nx's `--args`, which is appended to the command line):

| Flag | Use |
|---|---|
| `--args='--since <ref>'` | Ignore the run-record marker and plan over a range you choose. Diagnostics, and one-off sweeps |
| `--args='--max-slices 1'` | Attempt one slice and stop. The cheapest way to sanity-check a change to the machinery |
| `--args=--dry-run` | Print the exact command per slice and invoke **nothing**. Persists nothing either |
| `--args=--json` | Machine-readable output |

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
- `claude-sonnet-5`, which the `wiki-update` target pinned, is **absent from that table**. Every turn
  was capped at 4096 output tokens.
- A turn truncated at the cap *before* it opens a `tool_use` block yields an assistant message with
  **zero tool calls** — precisely LangGraph's ReAct stop condition. The graph exits cleanly, OpenWiki
  exits 0, Nx prints `Successfully ran target`, and no page is written.
- Nothing reports this. OpenWiki never inspects `stop_reason`; Nx sees exit 0; the verifier can say a
  page is missing but never why.

Measured on the wire at turn 25 of a real run: `stop_reason=max_tokens`, `output_tokens=4096`, no tool
call. Full write-up and reproduction steps:
[`HANDOFF-generator-reliability-ANSWER.md`](../../specs/044-openwiki-automation-migration/HANDOFF-generator-reliability-ANSWER.md).

The target now pins **`claude-sonnet-4-6`**, which the table covers at 16384, and
`scripts/__tests__/wiki-maintain.guard.test.mjs` fails any model id that lands back on the 4096
fallback. **If you change `OPENWIKI_MODEL_ID`, run that guard.**

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
| `2` | Bad usage, unreadable run record, or a missing credential | **Yes** |
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

**Neither budget is a monetary bound.** OpenWiki reports no token or cost figure at all, this
repository has no cost measurements, and nothing in this feature claims a spend ceiling. The
wall-clock budget bounds *runner occupancy* — there is one CI runner and `app-e2e` is ~35 minutes on
it.

---

## 3. Reading a failure

A slice fails when **any** of three things is true, and the generator's exit status is not one of them:

1. **No concept page appeared.** An `index.md` refresh counts as zero pages — that is precisely what
   feature 043's false-green run produced: 12 minutes of paid work, one `index.md`, exit 0, reported
   as success.
2. **The bundle stopped being conformant** (`check-openwiki-okf.mjs`, rules V1–V13).
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

## 6. Verifying the machinery itself

```bash
node scripts/wiki-maintain.mjs --selftest             # planner + verifier, offline, keyless
pnpm nx okf-lint infrastructure-as-code               # bundle conformance, V1–V13
pnpm nx okf-governance infrastructure-as-code         # policy, protection, index — G1–G12
node --test scripts/__tests__/wiki-maintain*.test.mjs
```

`--selftest` includes a **deliberately sabotaged generator** that exits 0 having written nothing. If it
ever passes, the zero-page detector is broken — which is the one failure mode that would let this
whole arrangement go quietly back to reporting false green.
