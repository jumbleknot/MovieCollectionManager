# Quickstart — Feature 044 validation

**Date**: 2026-07-30 · **Plan**: [plan.md](plan.md) · **Contracts**: [contracts/cli-contracts.md](contracts/cli-contracts.md)

Runnable scenarios that prove the feature works. Grouped by user story so each can be validated
independently. Commands are for the dev container (`echo $MCM_DEVCONTAINER` → `1`); PowerShell equivalents
apply on the Windows host.

> **Cost warning**: scenarios marked 💰 invoke a paid model. Everything else is offline and free — by
> design, the planner and all gates make no model call.

## Prerequisites

| Need | Check |
|---|---|
| Node 24 + pnpm deps | `node --version && pnpm install --frozen-lockfile` |
| OpenWiki 0.2.3 | `openwiki --help \| head -12` (version is in the banner; there is no `--version`) |
| `ANTHROPIC_API_KEY` | 💰 scenarios only. Never on argv — export it |
| RTK active | `rtk gain` — mandatory for AI-assisted sessions |

No stack is required. This feature touches no service, database, or container.

---

## US1 — A run never claims success without producing verified work

**S1.1 — The plan is free and inspectable** (FR-003, FR-004)

```bash
pnpm nx wiki-plan infrastructure-as-code
```

Expect an ordered slice list, each naming one area and ≤8 pages. Expect **no** model call — verify by
running with no `ANTHROPIC_API_KEY` set; it must still succeed.

**S1.2 — No slice mixes a new area with an existing one** (FR-002)

```bash
node --test scripts/__tests__/wiki-maintain.test.mjs
```

The planner must be unable to emit such a slice. This is the shape that produced **zero pages** in the one
043 run that failed outright — the seam is the invariant, not the size.

**S1.3 — A zero-page run is a failure, not a success** (FR-005, FR-006, SC-003)

```bash
node scripts/wiki-maintain.mjs --selftest
```

The selftest injects a generator that exits `0` having written nothing. Expect exit `1`, the slice still in
the backlog, and the marker **not** advanced. A green exit here means the detector is broken — the failure
mode this whole story exists to catch.

**S1.4 — Resume, don't restart** (FR-007, SC-002)

Interrupt an `--execute` run, then re-invoke it. Expect completed slices skipped and only outstanding ones
attempted.

---

## US2 — The bundle stays current without a human remembering

**S2.1 — Nothing to do is free and says so** (FR-012, SC-004)

```bash
node scripts/wiki-maintain.mjs --plan --json | python3 -c "import json,sys; d=json.load(sys.stdin); print('slices:', len(d['slices']))"
```

On a tree with no documentation change since the marker: `slices: 0`. Run twice — **both** must take the
cheap path, which proves the marker advanced. This is the failure 043 measured: the tool's own marker
advances only when wiki content changed, so a run that correctly found nothing paid full price next time.

**S2.2 — Budget stop is not a failure** (FR-011, SC-006)

```bash
node scripts/wiki-maintain.mjs --execute --dry-run --max-slices 1
```

Expect exit `3` with the remainder in `deferred` — distinct from exit `1`. Budgets are **16 pages / 20
minutes**, effective ceiling ≤24 pages / ~37 min once the one-slice overshoot is included
([contracts](contracts/cli-contracts.md) C6). Confirm the page count comes from files in the working tree,
not from the generator's own account — nothing stops it over-producing past its page list (research R2).

**S2.3 — Debounce collapses a burst** (FR-009, SC-008a)

Land three merges inside the window. Expect exactly one maintenance run covering all three, and the
earlier waiting runs cancelled — not queued.

**S2.4 — A busy branch still gets a run** (FR-009b, SC-008b)

Simulate a merge stream that never yields a quiet period. Expect the run to fire at the maximum deferral.
Without this the busiest days — when drift is fastest — would never trigger a run.

**S2.5 — One proposal, updated in place** (FR-016, SC-005b)

With a proposal open, trigger maintenance again. Expect the same PR number, rebased onto `main`, extended.
Place a commit on the branch by hand first and confirm it **survives** (FR-016a).

**S2.6 — Merging a proposal does not re-trigger** (FR-009a, SC-005a)

Merge the proposal. Expect no new maintenance run.

**S2.7 — Abandonment returns work to the backlog** (FR-016b, SC-005c)

Close a proposal unmerged. Expect its work back in the backlog and re-proposed next run — the marker must
not keep certifying work that never landed.

---

## US3 — The instruction file becomes a thin index

**S3.1 — The trim runs through the machinery** 💰 (FR-027aa, SC-002a)

```bash
node scripts/wiki-maintain.mjs --plan --since <pre-trim-ref>   # inspect first — free
pnpm nx wiki-maintain infrastructure-as-code
```

This is the feature's largest generation job and closely resembles what defeated 043 eight times. Its run
record is User Story 1's acceptance evidence — not a synthetic exercise.

**S3.2 — Nothing was lost, and paraphrase is caught mechanically** (FR-028, FR-029, SC-011, SC-012)

```bash
pnpm nx okf-governance infrastructure-as-code
```

Then reword a protected passage and re-run: expect **exit 1** naming the concept, the anchor, and what
changed. Then delete the passage outright: expect a **removal** failure, not a pass for lack of text to
compare (G6).

**S3.3 — Protection is a gate, not a freeze** (FR-029d, SC-018b)

Correct a protected passage *and* update its fingerprint in the same change. Expect **pass**. If this
fails, the gate is a trap and will be worked around rather than respected.

**S3.4 — A derived summary cannot be protected** (FR-041a, SC-018c)

Add a `protected.yaml` entry for a concept that carries a `resource` link. Expect exit `1` (G7) — freezing
a summary against its source would fail every legitimate refresh.

**S3.5 — The file cannot silently re-grow** (FR-040, SC-017)

Append a paragraph of prose to `CLAUDE.md` outside the index and managed regions. Expect exit `1` (G8).

**S3.6 — Managed regions untouched** (FR-032, research R10)

```bash
grep -c "nx configuration start\|SPECKIT START\|OPENWIKI:START" CLAUDE.md   # expect 3
```

**S3.7 — Retrieval still works** (SC-010, SC-016)

For ≥8 subjects the file answered before the trim, confirm each is still reachable from the index plus ≤2
bundle files. Record in the committed evidence document (FR-034).

---

## US4 — Local run and resume

**S4.1 — Same code path as CI** (FR-020, FR-021)

```bash
node scripts/wiki-maintain.mjs --plan          # identical invocation to the workflow's plan step
```

**S4.2 — Generation only via the target** (FR-021)

Confirm the executor invokes `pnpm nx wiki-update infrastructure-as-code`, never the bare CLI. A bare call
skips the telemetry opt-out and the raised heap, and OOMs.

---

## Cross-cutting gates

```bash
pnpm nx okf-lint infrastructure-as-code                    # V1–V13 unchanged; V12 drift stays report-only
pnpm nx okf-governance infrastructure-as-code              # G1–G10
node --test scripts/__tests__/*.test.mjs                   # all script units (auto-globbed in CI)
node scripts/secret-scan.mjs && node scripts/check-topology-scrub.mjs
node scripts/check-ci-digest-coverage.mjs                  # the new workflow must publish a digest
```

**Full validation checklist** (mandatory before marking the feature complete) — note the web E2E
regression is required for **every** feature, including one that touches no application code:

```bash
pnpm nx lint mcm-app && pnpm nx typecheck mcm-app
pnpm nx test mcm-app && pnpm nx test mc-service
pnpm nx e2e mcm-app          # containerized browser path in the dev container
rtk gain                     # >80% compression, run last
```

---

## Known-good reference points

| Fact | Value | Why it matters |
|---|---|---|
| Reliable slice size | ≤8 pages | Delivered twice in 043; size alone did not predict failure |
| The shape that failed | New area + existing area in one slice | The only 043 slice that produced nothing |
| Generator scoping surface | Free-text run message only | No `--pages` flag exists (research R2) |
| Generator cost reporting | **None** | Why FR-011 is a page/time budget, not a spend ceiling (research R1) |
| Run budget | 16 pages / 20 min; ≤24 pages / ~37 min effective | One-slice overshoot is not interruptible |
| Bundle today | 45 concepts, 8 directories, 17 documents cited | Pre-trim baseline |
| `CLAUDE.md` today | 592 lines, ~70 KB, 38 sections | The before-measurement for SC-009 |
