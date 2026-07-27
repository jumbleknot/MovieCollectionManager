# Acceptance Evidence — Feature 043 (OpenWiki + OKF Knowledge Layer)

**Created**: 2026-07-27 · **Status**: ✅ **COMPLETE** — 45 concepts, full coverage, all gates green

> ## ✅ Delivered
>
> **45 concepts across 8 directories**, conformance gate exit 0, both leak gates green with the bundle
> tracked. Every one of the 17 canonical documents (14 runbooks, 1 ADR, 2 architecture docs) is cited
> by at least one concept — **0 uncited**.
>
> Generation required **8 runs in bounded slices**, not one full-repo request. See the failure modes
> below: the tool cannot complete a ~45-page first pass in a single invocation and reports success
> when it gives up.

## SC-003 — Retrieval validation (T022)

**Criterion**: For each of at least eight repository questions spanning distinct subsystems, an actor
reaches the authoritative source by selecting on concept metadata, opening **no more than two** bundle
files.

**Status**: ⚠️ PARTIAL — measured against the 6 concepts that exist

| # | Question | Metadata selector | Files opened | Source reached | Pass |
|---|---|---|---|---|---|
| 1 | Where is the security boundary for tokens? | `type: Service` + tag `bff` | 2 | `frontend/mcm-app/README.md` | ✅ |
| 2 | How is auth enforced end to end? | `type: Convention` + tag `auth` | 2 | `CLAUDE.md` | ✅ |
| 3 | What is the prod secrets standard? | `type: Decision` | 2 | `docs/decisions/ADR-0001-…md` | ✅ |
| 4 | How do I run E2E tests? | `type: Runbook` + tag `testing` | 2 | `docs/runbooks/e2e-testing.md` | ✅ |
| 5 | How do I recover prod after a reboot? | `type: Runbook` + tag `prod` | 2 | `docs/runbooks/prod-reboot-resilience.md` | ✅ |
| 6 | Why does mc-service need vendored OpenSSL? | `type: Gotcha` | 2 | `CLAUDE.md` | ✅ |
| 7 | How does an idea become shipped work? | `type: Process` | 2 | `specs/` + `docs/proposals/` | ✅ |
| 8 | Why are prod ports in 19000–19099? | `type: Convention` + tag `ports` | 2 | `docs/runbooks/prod-reboot-resilience.md` | ✅ |

**Result**: ✅ **PASS** — 8/8 questions across distinct subsystems resolved by metadata selection
within the 2-file budget. Questions 4, 5 and 8 previously failed for lack of runbook concepts; those
now exist.

---

## SC-004 — Concept accuracy audit (T021)

**Criterion**: A sample of at least ten concepts verified against the sources they cite, with 100% of
identified inconsistencies corrected before the bundle lands.

Two properties are audited per concept, because they fail independently — a concept can be perfectly
accurate and still violate FR-005 by being a verbatim restatement rather than a summary plus link:

- **Accuracy**: does the concept agree with the source it cites?
- **FR-005 compliance**: is it a distilled summary plus gotchas that *links*, rather than a copy?

**Status**: ⚠️ PARTIAL — all 6 concepts audited (SC-004 asks for ≥10; only 6 exist)

Audited by two independent properties — accuracy against the cited source, and FR-005 compliance
measured as concept-size-to-source-size ratio (a verbatim restatement approaches 100%).

| # | Concept | Source | Size ratio | Accurate | Summarizes |
|---|---|---|---|---|---|
| 1 | `projects/mc-service.md` | `docs/MCM-Architecture.md` | 9% | ✅ **omitted** the stale `medi-rs` claim | ✅ |
| 2 | `projects/bff.md` | `frontend/mcm-app/README.md` | — | ✅ | ✅ |
| 3 | `projects/expo-app.md` | `frontend/mcm-app/README.md` | — | ✅ | ✅ |
| 4 | `projects/agent-gateway.md` | `docs/agent-layer.md` | 24% | ✅ | ✅ |
| 5 | `invariants/auth-chain.md` | `CLAUDE.md` | — | ✅ realm/roles confirmed against Keycloak config | ✅ |
| 6 | `invariants/secrets-management.md` | `docs/decisions/ADR-0001-…md` | 55% | ✅ | ✅ |
| 7 | `runbooks/devcontainer.md` | `docs/runbooks/devcontainer.md` | 6% | ✅ | ✅ |
| 8 | `runbooks/server-setup.md` | `docs/runbooks/Server-Setup-Runbook.md` | 4% | ✅ | ✅ |
| 9 | `runbooks/e2e-testing.md` | `docs/runbooks/e2e-testing.md` | 14% | ✅ | ✅ |
| 10 | `runbooks/ci-diagnostics.md` | `docs/runbooks/ci-diagnostics.md` | 16% | ✅ | ✅ |
| 11 | `architecture/system-overview.md` | `docs/MCM-Architecture.md` | 8% | ✅ | ✅ |
| 12 | `architecture/agent-layer.md` | `docs/agent-layer.md` | 35% | ✅ | ✅ |
| 13 | `runbooks/prod-reboot-resilience.md` | `docs/runbooks/prod-reboot-resilience.md` | 21% | ✅ | ✅ |
| 14 | `decisions/adr-0001-…md` | `docs/decisions/ADR-0001-…md` | 41% | ✅ | ✅ |

Every `resource` link resolves — enforced mechanically by gate rule V6 across all 45 concepts, 0
findings. Size ratios span **4–55%**: all genuine distillations.

**Zero corrections were required.**

**Result**: ✅ **PASS** — 14 concepts audited (criterion asks ≥10), 14/14 accurate, 14/14 FR-005 compliant.

---

## SC-013 — Telemetry suppression (T039)

**Criterion**: Zero telemetry events leave either workspace during any generation run, with the egress
allowlist unchanged.

The tool reports usage telemetry to a third-party analytics host **by default**. The container's
egress policy would block it, but the Windows host has no such protection — so this is verified
against the configured opt-out, not against the firewall.

**Status**: ✅ COMPLETE

- **Telemetry verdict file** after a run with `--telemetry-file`: **`{"disabled": true, "sent": false}`** ✅
- **`.devcontainer/init-firewall.sh` unchanged**: ✅ (`git diff --quiet` clean — the analytics host was never allowlisted)
- **`wiki-update` target sets `OPENWIKI_TELEMETRY_DISABLED`**: ✅

**Correction made during implementation**: the original check asserted the payload file was *absent
or empty*. That is wrong — the tool **always writes a verdict file**, so an absence test reports
FAILURE on a correctly-disabled run. The assertion now checks the file's *content*. Caught because
the run produced a file and the naive check would have called a passing configuration a failure.

**Result**: ✅ **PASS** — telemetry disabled by configuration, nothing transmitted, egress allowlist
untouched. Verified across four generation attempts.

---

## SC-007 — Tool-managed block size (T017)

**Criterion**: `CLAUDE.md` gains only the pointer and one environment correction; **hand-authored**
growth stays under 1 KB.

The generator maintains its own `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block in that file.
Its size is set by the generator, not by this feature, so it is **excluded from the budget** — but it
is recorded here so an unexpected future increase is still visible.

**Status**: ✅ COMPLETE

- **Tool-managed block size**: **502 bytes** (excluded from the budget by SC-007)
- **Hand-authored additions**: **854 bytes** — the corrections note plus the checklist line
- **Under the 1 KB budget**: ✅ (854 < 1024)
- **Existing lines deleted**: only the replaced shell line, plus one link line rewritten by the
  operator-doc relocation (FR-024) — no content removed

**Note**: the first measurement came in at **1306 bytes, over budget**. Rather than widen the
criterion, the additions were trimmed to fit.

**Result**: ✅ **PASS**

---

## Generation calibration (T016)

The one unknown Phase 0 research deliberately left open: the cost and page quality of a full
generation over a repository of this size. No useful target could be set before one real run.

**Status**: ✅ COMPLETE (for the slice that was generated)

- **Model used**: `claude-sonnet-5`, set via `OPENWIKI_MODEL_ID` in the `wiki-update` Nx target.
  **Model history, and why it changed twice:** the Anthropic provider defaults to
  `claude-haiku-4-5`. Opus was chosen first because the bundle's value is judgement-heavy
  distillation across a polyglot monorepo. After the aborted runs below burned credit without
  producing a bundle, the choice was revised to **Sonnet on cost grounds** — roughly a fifth of
  Opus's price and well-matched to summarization. Reverting is a one-line change to the target's
  `OPENWIKI_MODEL_ID`. Both `claude-opus-5` and `claude-opus-4-8` were confirmed valid against the
  API (HTTP 200), so the earlier failures were never a bad model id.
- **Node heap**: `NODE_OPTIONS=--max-old-space-size=8192` is **required**, set in the target. Without
  it the run aborts at Node's ~4 GB default with `FATAL ERROR: Reached heap limit` (exit 134) after
  minutes of paid work, having written almost nothing.
- **Wall-clock duration**: ~11 min for the successful 6-page slice (09:53→10:23 including a failed
  full-scope attempt). Failed full-scope attempts: 2.5 min (no-op), 12 min (false green), 3.5 min (OOM).
- **Concepts generated**: **45, across 8 directories** — `projects/`, `invariants/`, `gotchas/`,
  `runbooks/`, `architecture/`, `process/`, `decisions/`, root
- **Runs required**: **8** (1 successful 6-page slice + 6 chained slices, of which 1 no-op'd + 2 re-run
  splits). Successful slice durations ranged 2.5–17 min.
- **Instruction amendments needed**: none — `INSTRUCTIONS.md` was never the problem. **Two GATE fixes
  were needed** instead, both cases of the gate fighting its own generator (see below).
- **Subjective page-quality note**: **good.** Pages are 9–55% of their source's size — genuine
  summaries, not restatements (FR-005 holds). Front matter is well-formed and `type` values are drawn
  from the suggested vocabulary. Notably, the `mc-service` concept **did not propagate** the stale
  `medi-rs` CQRS claim from `CLAUDE.md`, which is independently confirmed absent from `Cargo.toml`
  (`grep -c medi` → 0). The generator preferred source over instruction file, which is the behaviour
  the brief asks for.

### Two gate bugs the real bundle exposed

Both were the gate rejecting output its own generator produces — the exact failure the plan warned
against ("a stricter gate would fail pages its own generator considers valid"). Both are now fixed
with dedicated `--selftest` scenarios so a later refactor cannot silently reintroduce them:

1. **Generated `index.md` carries no `type`.** The tool's root index uses an `okf_version` header
   instead. Requiring `type` failed a file no regeneration could fix. → `index.md` exempt from V2.
2. **Per-directory `index.md` carries no front matter at all.** → absent front matter tolerated on an
   index; **malformed** front matter still fails, because absence is intentional and corruption never is.

This is the fail-closed gate earning its keep: it caught two real defects in itself before any bundle
was committed.

### Operator note — two aborted attempts before the clean run

Recorded because it cost real model spend and would otherwise be invisible:

1. A first run was launched with `nohup … &` from inside a tool call. It survived, but a second run
   was later started in parallel because a `pgrep` liveness check matched only the resolved
   `dist/cli.js` path while the first process's command line read `/usr/local/bin/openwiki`. **Two
   generations then ran concurrently against the same `openwiki/` directory.**
2. Both were killed to recover a single controlled run. At that point the tool had already written
   its planning scratchpad and `quickstart.md`, so the spend was not entirely wasted — the plan is
   what surfaced the four `CLAUDE.md` drift findings below.

**Lesson for the runbook**: this generator writes nothing for many minutes and produces no
incremental stdout, so "no output" is not evidence of a hang. Check for an open socket with zero CPU
(waiting on the API) before concluding anything is wrong, and match liveness on `openwiki` rather
than on a resolved script path.

### Three generator failure modes measured on this repository

All three cost paid model time and **none of them reported failure honestly**:

| # | Failure | Symptom | Mitigation |
|---|---|---|---|
| 1 | **Node heap exhaustion** | `FATAL ERROR: Reached heap limit`, exit 134, after minutes of work; almost nothing written | `NODE_OPTIONS=--max-old-space-size=8192` in the `wiki-update` target |
| 2 | **`--update` no-ops on a partial bundle** | Sees an existing page, records `.last-update.json` at the current `gitHead`, syncs only `index.md`, exits 0 in ~2.5 min | A half-finished bundle does **not** self-heal — clear the generated files (keep `INSTRUCTIONS.md`) to force a full first-pass build |
| 3 | **False green on a large first pass** | Ran 12 min, planned and researched, terminated mid-thought, **exit 0 with only `index.md` written** | Drive generation in **bounded slices** via an explicit page list in the run message, rather than one full-repo request |

**Slice sizing, measured over 8 runs.** Slices of 6–8 pages succeeded repeatedly; the single slice
that produced nothing asked for 7 pages but was the **only one that mixed finishing an existing
directory with creating a new one**. Splitting it along that seam (4 pages into the existing
directory, then 3 into the new one) succeeded immediately. Size alone does not predict failure —
slices of 8 pages succeeded twice.

| Slice | Requested | Delivered |
|---|---|---|
| 1 | 7 pages, existing + new dir | **0** ❌ |
| 1a (re-run) | 4 pages, existing dir | 4 ✅ |
| 1b (re-run) | 3 pages, new dir | 3 ✅ |
| 2 | 8 pages | 8 ✅ |
| 3 | 8 pages | 8 ✅ |
| 4 | 7 pages | 7 ✅ |
| 5 | 7 pages | 7 ✅ |
| 6 | 2 pages | 2 ✅ |

**Always assert the page count after each slice.** Six chained runs each reporting `exit 0` would
otherwise have looked like complete success while silently dropping a seventh of the bundle.

**Mode 3 is the important one for anyone repeating this.** `CLI_EXIT=0` does not mean a bundle was
produced. Always assert the result — `pnpm nx okf-lint infrastructure-as-code` — rather than trusting
the exit code. This is the same false-green class the repository's fail-closed gate convention exists
to catch, and here the gate did catch it.

### SC-014 — Documentation drift: verified and corrected

The generation run cross-checked `CLAUDE.md` against source and flagged four claims. **Each was
independently verified against source before any correction** — none was corrected on the generator's
assertion alone (FR-031). All four were confirmed stale, and one was *worse* than reported.

| # | Claim in `CLAUDE.md` | Verification | Verdict |
|---|---|---|---|
| 1 | CQRS via `medi-rs` | `grep -c medi` on `Cargo.toml` **and** `Cargo.lock` → **0**; `router.rs` wires plain `*Handler` structs onto `AppState` | ❌ stale → corrected |
| 2 | `movie_text_search` index with a `language_override` trick | `indexes.rs:121` calls `drop_index("movie_text_search")`; `movie_repository.rs:305` queries with `$regex` | ❌ stale → corrected, with the historical rationale kept so nobody reintroduces a `$text` index |
| 3 | Agent intents include `context` | Actual intents in `supervisor.py`: `add`, `enrich`, `export`, `import`, `navigate`, `organize`, `query`, `search` | ❌ stale → corrected; **`context` does not exist**, and `enrich`/`search` were undocumented |
| 4 | JWKS fetched on startup; **service fails to start if Keycloak unreachable** | `axum-keycloak-auth-0.8.3` `instance.rs`: `new()` calls `discovery.dispatch(..)` **without awaiting**; nothing in `router.rs` awaits `is_operational()` | ❌ stale → corrected |

**Claim 4 was materially worse than the generator reported.** The generator said "constructed at
startup, fetches lazily" — imprecise in the other direction. The truth is *eager dispatch, never
awaited*: discovery starts at construction and runs in the background. The operational consequence is
what matters and neither wording captured it — **mc-service does not fail to start when Keycloak is
unreachable**; the failure surfaces on the first authenticated request. Someone debugging a boot
failure would have looked in entirely the wrong place. FR-031 exists because of exactly this: the
generator's replacement claim needed correcting too.

**Result**: ✅ **PASS** — 4/4 verified against source, 4/4 confirmed stale, 4/4 corrected in place
across 7 edits. Zero claims corrected on assertion alone; zero left unresolved.

**Scope note**: correcting `CLAUDE.md` was originally out of scope (FR-022 forbade removing content).
Steve extended scope on 2026-07-27; the spec was amended in the same change — FR-022 now carves out
verified corrections, FR-031 mandates verify-before-correct, and SC-014 tracks the outcome.

## SC-011 — Freshness rehearsal (T035)

**Criterion**: the completion checklist carries the bundle-update step, and one rehearsal produces a
reviewable diff or a verified no-op rather than an error.

Run 2026-07-27 19:42:51Z → 19:49:33Z against the **committed, complete** bundle:

- `CLI_EXIT=0`, **6m42s**
- **Zero changed files** — a verified no-op, which is the correct outcome for an unchanged tree
- Conformance gate still green (45 concepts); telemetry `{"disabled": true, "sent": false}`
- The run independently re-confirmed the claim-1 correction ("no `medi-rs`, direct handler structs on
  `AppState`") without being asked — a second verification of that drift finding

**Result**: ✅ **PASS**

### FR-028 cost analysis — CORRECTED

**An earlier revision of this document claimed a no-op update costs ~7 minutes of model time. That
was wrong**, and the recommendation built on it was wrong too. The 6m42s run measured then was *not*
a no-op: the recorded `gitHead` was stale (`a4f13a2`) while `HEAD` had moved, so the tool correctly
re-ran. Corrected by reading `getUpdateNoopStatus` in `dist/agent/utils.js` and measuring each path.

**Measured, 2026-07-27:**

| Scenario | Wall-clock | Model calls |
|---|---|---|
| Clean tree **and** `gitHead` == recorded | **1 second** | **none** — short-circuits with "No repository changes detected" |
| `gitHead` moved, one small commit to react to | 92 s | yes |
| `gitHead` stale across many commits | 6 m 42 s | yes |
| Generation slice (6–8 new pages) | 5–17 min | yes |

**The skip is genuinely free** — `shouldSkip` returns before any agent run.

#### The trap that makes the skip rarely reachable

`persistRunMetadataIfChanged` writes `.last-update.json` **only when wiki content actually changed**.
So a run that correctly concludes "nothing to document" leaves the recorded `gitHead` stale — and the
*next* run therefore sees a moved head and pays full agent cost again. In steady state:

- wiki changed → metadata advances → next run is free
- **wiki unchanged → metadata does not advance → next run pays full cost, indefinitely**

The cheap path is available exactly when the wiki *did* change, and the expensive path runs when it
did not. That is backwards for FR-028's unconditional per-feature step, since most features change no
cited document.

#### Can an unchanged `gitHead` still produce documentation updates?

**Yes — demonstrated, not theorised.** With `gitHead` set equal to `HEAD`, a run still executed and
produced a correct update: it inspected commits, found the MongoDB `nofile` ulimit fix, and added it
to the existing replica-set gotcha page (commit `46ccf70`). Three mechanisms allow this:

1. **Any uncommitted worktree change forces a run** — `getUpdateNoopStatus` returns
   "worktree has changes" for *any* dirty file, related to docs or not.
2. **Stale metadata** (above) means the head comparison often does not match even when nothing
   relevant changed.
3. **The agent is non-deterministic** — given a run, it may legitimately improve or correct a page.

So an unchanged `gitHead` is **not** a guarantee of no output. Only the full precondition — clean
tree *and* matching head — guarantees the free skip, and that state is self-limiting per the trap.

#### Recommendation for the FR-028 revision

Keep the step, but make it **conditional on evidence rather than unconditional**:

- Trigger regeneration when the gate emits a **V12 drift warning** — it names exactly which concepts
  have a source newer than themselves, costs nothing, and runs already on every push.
- Treat a clean-tree/matching-head skip as success, since it is free and instant.
- Do **not** rely on "no changes since last run" alone; the metadata-staleness trap makes that
  unreliable as a cost control.

Not changed in this feature: FR-028 as approved is unconditional, and substituting different
behaviour silently would be a scope change. Raised for an explicit decision.

## Known residual (accepted at planning time)

The baked toolchain entry (T026) is **not proven end-to-end until the next dev-container image
refresh**, because the first bundle was produced from an ad-hoc install per the sequencing
clarification. This is an acceptance follow-up, not a blocker.

**Status**: _pending confirmation after the next image refresh_
