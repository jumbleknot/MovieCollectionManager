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
