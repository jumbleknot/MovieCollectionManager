# PRD — Session-Maintained Wiki Summaries (Retire the CI Generator)

**Status**: Draft for review · **Date**: 2026-11-10 · **Author**: Steven Watson (with Claude Code)
**Supersedes, once ratified**: the scheduled half of feature 044 and features 078 / 082; the
Claims half of ADR-0003. **Input to**: a numbered spec (`specs/NNN-session-maintained-wiki/`).

---

## 1. Problem Statement

The `openwiki/` summaries exist to help the **coding assistant**. A session reads a summary page to
get oriented in an area before it touches code. Polish matters less than accuracy: a wrong summary
sends a session confidently in the wrong direction.

Keeping them fresh in CI with a paid model has not converged in four iterations:

1. Anthropic Sonnet, then
2. Fireworks DeepSeek V4.1 Flash, about 6× cheaper per page, then
3. pages stopped by the deadline rerun alone at `low` effort, then
4. longer job windows plus a 4-page cap, then
5. a daily schedule with refresh cooldowns.

The full history is in §7. Measured from the run records, spend was about **$37/week** over
October and **$62 for 2026-11-01..09**.

The first daily run (2026-11-09, run 5104) showed why the bill does not fall:

- **openwiki 0.7.1 forces pages into every run that nobody asked for.** A page becomes mandatory
  when any file cited by any of its Claims has changed. That is the **30-page forced set** in
  `--claims-audit` today, against the **4 pages requested**.
- **The queue is sorted alphabetically.** Two of the requested pages never received a worker
  before the 51-minute deadline.
- **The run's verdict blamed them anyway:** "escalated to low and still failing — consider
  parking it".
- **Every source edit becomes a paid regeneration later.** Each merge that touches a cited file
  grows the forced set again.

About 20 pages a week have their `resource` change, so even a perfectly behaved generator has a
floor of roughly $8–20 a week.

## 2. Goals / Non-Goals / Anti-Goals

### Goals

- **G1 — Zero marginal API spend for routine freshness.** Summaries are refreshed by the coding
  session that changed their source, on the operator's Max subscription. This is the same session
  and the same PR.
- **G2 — A summary never trails its source on `main`.** CI **blocks** a PR that changes a page's
  `resource` without refreshing that page (operator decision, 2026-11-10).
- **G3 — The generator survives as a manual tool** for a rare full rebuild. It is run by hand,
  never on a schedule.
- **G4 — An ADR (ADR-0004)** records the whole progression and why each step was taken, ending in
  this decision.

### Non-Goals

- **Changing the canonical pages.** These are pages with no `resource`, listed in
  `protected.yaml`, and they are already hand-maintained. Their protected-passage fingerprints
  (G-rules in `check-openwiki-governance.mjs`) are unchanged.
- **Proving that a refreshed summary is correct.** The check proves the page was refreshed
  against the current source. Correctness rests on the session instructions and on PR review.
- **Restructuring the bundle.** Types, directories, index pages and `quickstart.md` are unchanged.

### Anti-Goals (a failure even if it works)

- **A check that fires on changes no session made.** Examples are an automated `[skip ci]`
  commit, or a page whose resource is a whole directory. Either would turn `main` red with no one
  to fix it.
- **A refresh ritual so heavy that sessions route around it,** for example by bumping
  fingerprints blind.
- **Any path where a coding session calls a paid API to write a summary.** The CLAUDE.md
  subscription gate applies unchanged: `MCM_ANTHROPIC_API_KEY` is used by OpenWiki only when the
  operator runs the manual rebuild.

## 3. Proposed Solution

### 3.1 The source fingerprint — one field per derived page

Every derived page (a concept with a `resource`) gains one front-matter field recording the
source it was last refreshed against:

```yaml
resource: docs/runbooks/renovate.md
source-sha256: 8be3186049ddc0e645f0c6990fea80b6f30e71f3ac888469b9a848f69205955a
```

- It is the SHA-256 of the resource file's bytes as committed.
- The field name and encoding are left to the builder, provided the value comes from the file's
  bytes and the line-ending normalisation is stated.
- **Only the `resource` is fingerprinted** (operator decision, 2026-11-10).
  - Today's front matter also carries a `sources:` list, which can run to 12 or more `repo://`
    files that openwiki read.
  - That list is openwiki metadata keyed to the Claims that are being removed. No page body refers
    to its ids (checked: each id appears once, in front matter).
  - **It is stripped.** Fingerprinting it would bring back the "any cited file changed" trigger,
    and would block Renovate PRs.
  - The duty stays single and legible: *you changed X, so refresh the pages whose `resource` is X.*

### 3.2 The blocking check — a new OKF rule, free and offline

`check-openwiki-okf.mjs` gains a rule (V17 or the next free number). For every derived page, it
recomputes the resource's hash and compares it with the stored value.

A mismatch **fails** `guardrails / okf`, which is already a required context. The message names:

- the page,
- its resource,
- the command that refreshes it (§3.4).

Properties:

- **Whole-tree, not diff-based.** It checks every derived page on every run, so `main` itself can
  never drift silently. That needs every page to be fresh at cut-over (§3.6).
- **A page whose resource is a directory is not allowed.** Two pages do this today:
  `process/spec-driven-development.md` → `specs/`, and `architecture/data-model.md` →
  `backend/mc-service/src/domain/`.
  - `spec-driven-development` is about process, which does not change with the contents of
    `specs/`. It becomes an **excluded** page: hand-maintained, no `resource` fingerprint, listed
    as canonical (operator decision, 2026-11-10).
  - `data-model` is the builder's call: re-point it at a file, or treat it the same way.
- **Automated writers.** CD's `[skip ci]` promote commit touches only `.env.deploy` files, which no
  page cites (checked 2026-11-10).
  - A Renovate PR that edits a cited file fails the check like any other PR. A session then
    refreshes the page.
  - This is accepted, because no page currently cites a file Renovate rewrites.
  - The builder should add a governance assertion that keeps it that way: no `resource` may
    match Renovate's managed files or `.env.deploy`.

### 3.3 Claims sidecars, the page manifest and V16 are retired

What they are and do:

- `openwiki/.claims/*.json` is 4.5 MB over 43 pages. It breaks each generated page into factual
  statements and pins each statement's backing files by hash.
- openwiki rechecks every pin at the start of a run. Any moved pin forces the whole page into the
  run, which is the mechanism behind the 30-page forced set.
- V16 uses the sidecars and `.page-manifest.json` to fail any hand edit to a generated page.
- **Nothing else reads them.** Sessions do not open them and no tool serves them.

In the new model:

- The single-source fingerprint (§3.1) replaces claim-level freshness.
- V16 directly contradicts G1, because it fails exactly the edit G1 asks for.
- So the sidecars, `.page-manifest.json`, V16, `wiki-claims-audit.mjs` and the ADR-0003 rule
  G13 ("no page is both") are removed (operator decision, 2026-11-10: "no need to keep sidecars if they don't make the
summaries any more useful to the assistant").

**The page manifest goes the same way.** `.page-manifest.json` (18 KB, 45 entries) is openwiki's
own run bookkeeping. Each entry holds the git head a page was generated at, a fingerprint of its
seed sources, the page's hash and the run that completed it.

- openwiki reads it inside a run to skip pages that are already complete and to resume.
- If it is absent, openwiki starts from an empty manifest, which is what a full rebuild wants.
- Its only other reader is V16. A session never needs it.

So `.claims/`, `.page-manifest.json` and `.last-update.json` are deleted from the repository and
**added to `.gitignore`**. The manual rebuild can let openwiki write them in its working tree, and
they are simply never committed. Nothing needs cleaning up after a rebuild.

**This reverses part of a recorded operator decision.** ADR-0003 cites the 2026-09-27 decision
that Claims are "required and valuable" on derived pages. ADR-0004 supersedes that half
explicitly.

### 3.4 The refresh — a skill and one command

A project skill (`.claude/skills/wiki-refresh/`) and a script make "refresh the summaries I just
made stale" a single, cheap, reviewable act:

- **The script.**
  - `node scripts/wiki-refresh.mjs --stale` lists every derived page whose fingerprint no longer
    matches. That is the same computation as the check, so it never disagrees with CI.
  - `--stamp <page>` rewrites the fingerprint, and the `timestamp`, after the session has updated
    the body.
  - The script never writes prose.
- **The skill tells the session to:**
  1. read the page,
  2. read the source **diff since the stamped version** (the script can show it: `--diff
     <page>`), not the whole source,
  3. update only what the diff invalidates, keeping the page's existing structure and the
     generation brief's rules (`openwiki/INSTRUCTIONS.md`),
  4. stamp it,
  5. commit it in the same PR.
- **A stamp-only change is allowed** when the source diff does not touch anything the page says,
  such as a typo fix in the runbook. The skill says so explicitly, so the honest no-op is cheap.
  A reviewer sees a fingerprint-only diff and can judge it.
- **Session instructions.** A CLAUDE.md gate line points at the skill, so a session that edits a
  `docs/` file learns of the duty before CI tells it.

### 3.5 The CI generator becomes a manual rebuild tool

- **`wiki-maintain.yml` loses its `schedule:` trigger.** Its `workflow_dispatch` stays, and its
  output is a PR for human review, as today.
- **A rebuild regenerates only the pages the operator names** in the dispatch input. This is a
  list of `area/page.md` (operator decision, 2026-11-10).
  - The job fits about 4 pages in about 50 minutes, so a whole-bundle rebuild cannot finish in one
    dispatch.
  - A wholesale overwrite would also discard accuracy fixes that sessions made under G1.
  - **There is no cross-run resume state.** A list that does not finish is dispatched again with
    the pages that remain.
  - The run reports which named pages landed, so the remainder is known without a run record.
- **The rebuild must leave the bundle in the new model.** After openwiki writes pages it stamps
  `source-sha256` on every page it wrote. The sidecars and manifest that openwiki recreates are
  gitignored (§3.3), so they never reach the PR. `.maintenance-state.json` is deleted or frozen.
  The rebuild therefore passes the new check without hand-fixing.
- **Machinery that exists only to make unattended daily runs affordable or safe is deleted or
  frozen, not kept alive:**
  - the run record's backlog, escalation and cooldown maps,
  - `wiki-quiet.mjs` and the commit-based trigger,
  - drift re-planning (082),
  - forced-page handling (#707).
  Which pieces the manual tool still needs is the builder's call. The rule is "a hand-run full
  rebuild works and costs what it costs, and nothing runs unattended."
- **Existing items:**
  - Item #977, which scores US7's weekly target, is closed as superseded and the reason is stated.
  - Item #739's parked page becomes the excluded canonical page of §3.2.

### 3.5a Who may write derived pages — `policy.yaml` (Claude's call)

- **Policy change.** `policy.yaml` gives `openwiki/**` to `actor: generator`. Its header says that
  widening the actor grid is a separate decision. G1 is that decision: derived pages are written
  routinely by a coding session (`agent`), and only on a manual rebuild by the generator.
- **What the builder changes.** The entry becomes `agent`, or both actors if the schema allows.
  The governance rules that tie meaning to `actor` (G1–G4, G12) are updated at the cause, not
  deleted. ADR-0004 records the change as part of this decision, so it is not a silent edit.
- **Retiring V12.** V12, the drift warning, is redundant beside the new blocking rule. The
  builder retires it.

### 3.6 Cut-over

1. **One catch-up pass** in a coding session on the subscription. It refreshes the pages that are
   stale today, about 30 judging by the forced set plus the backlog, and stamps every derived page.
   This can be its own PR or PRs, ahead of the check turning on.
2. **The check turns on** in the same PR that lands the final stamps, so `main` is green the moment
   it becomes blocking.
3. **The schedule is removed no later than the check.** It may be removed first, today, to stop
   spend; that is a one-line change.

## 4. Functional Requirements

- **FR-1** Every derived page carries a source fingerprint computed from its `resource`'s
  committed bytes.
- **FR-2** `guardrails / okf` fails when any derived page's fingerprint differs from its resource,
  naming the page, the resource and the refresh command.
- **FR-3** A derived page's `resource` must be a single file. A directory resource fails the
  governance check.
- **FR-4** `process/spec-driven-development.md` is hand-maintained and canonical, with no
  fingerprint.
- **FR-5** `scripts/wiki-refresh.mjs` provides `--stale`, `--diff <page>` and `--stamp <page>`.
  It shares the check's hash function: one definition, two callers.
- **FR-6** A `wiki-refresh` project skill and a CLAUDE.md gate line make the duty discoverable
  before CI enforces it.
- **FR-7** `wiki-maintain.yml` has no `schedule:`. Manual dispatch takes a list of pages,
  regenerates only those, and produces a reviewed PR that already satisfies FR-1/FR-2.
- **FR-7a** The `sources:` front-matter list is stripped from every derived page. Only `resource`
  is fingerprinted.
- **FR-8** Claims sidecars, `.page-manifest.json`, `.last-update.json` and V16 are removed from
  the repository and the three files are gitignored. ADR-0003 is superseded in part by ADR-0004.
- **FR-9** The docs that describe the old model are updated:
  - `docs/runbooks/wiki-maintenance.md`,
  - `openwiki/INSTRUCTIONS.md` ("where a new learning goes"),
  - the AGENTS.md notes,
  - the "do not hand-edit derived pages" rule, which is inverted.
- **FR-10** ADR-0004 records the progression (§7) with the measured number behind each step, and
  this decision.

### Non-Functional

- The check is offline, model-free and quick, and runs in the existing `okf` context.
- A refresh needs no network and no credential.

## 5. Testing Strategy

- **The check: RED/GREEN self-tests in the gate's `--selftest`.** Scenarios:
  - a fresh page passes,
  - an edited resource fails with the page named,
  - a directory resource fails,
  - a canonical page is ignored,
  - CRLF vs LF follows the stated normalisation.
- **`wiki-refresh.mjs`: unit tests.**
  - `--stale` agrees with the check on the same fixture tree.
  - `--stamp` changes only the fingerprint and timestamp lines.
- **The rebuild path:** a test that the post-rebuild step leaves no sidecar and stamps every
  written page.
- **Cut-over evidence:** `guardrails / okf` green on the PR that turns the check on, with the
  stale count at zero.

## 6. Open Questions for Planning

- **What `architecture/data-model.md` points at:** a file, or the canonical treatment.
- **How much of `wiki-maintain.mjs` the named-page rebuild (§3.5) still needs.** Target: the
  page selection, the generator invocation, the per-page verification and the proposal PR.
  Nothing that exists to schedule, budget, defer, escalate or cool down.

### Settled 2026-11-10

- **Gotcha pages whose resource is a code file stay derived and under the check** (operator
  decision).
  - Affected files: `keycloak.ts`, `server.js`, `session-manager.ts`, `playwright.config.ts`,
    `movie-detail.tsx`, `error_handler.rs`, `observability.py`.
  - A code PR touching one of them refreshes its gotcha page.
  - Gotchas about code are where a stale page misleads a session most, and a refresh from the diff
    is small.
  - Measured load: about 17 commits from 2026-10-10 to 11-10 across all seven. `keycloak.ts` and
    `server.js` had 5 each; for comparison, the busiest doc, `renovate.md`, had 9.

## 7. Background — how we got here (source material for ADR-0004)

Dates and numbers come from the specs and items cited.

| Date | Step | Driver |
|---|---|---|
| 2026-07-26..28 | **043**: bundle generated by hand with Claude (Opus, then Sonnet at about ⅕ the price). Drift is reported, never blocking. | Cost of a model-run step; full-scope runs failed (no-op, empty success, out of memory). |
| 2026-07-30..08-01 | **044**: maintenance on merge to `main` (15-min quiet debounce, 6-h max deferral), Anthropic Sonnet, bounded by pages and wall-clock time, never auto-merged. | Keep the bundle current without an operator; the generator reports no token or cost data (R1). |
| 2026-09-27..28 | **078**: move to Fireworks DeepSeek V4.1 Flash. | $0.08 vs $0.48 per page in a packed run (−77..86%); 2–3× slower. |
| 2026-09-29..10-02 | **#613/#626/#640**: the job gets its own deadline (60 → 120 min on dispatch). | Run 4290 was killed at 60 min with no record. |
| 2026-10-05..08 | **Reasoning effort / US6**: pages stopped by the deadline are retried alone at `low`. | `low` cured a deadline failure at about ¼ the cost (#670). |
| 2026-10-07 | **R14 scoring**: 53% completion on Fireworks vs 98% on Sonnet, accepted. | Sonnet about 6× per page. |
| 2026-10-09..12 | **#707**: openwiki forces pages with stale Claims into every run; keep verified ones, `--claims-audit`, lockfile citations banned. | $1.80–2.39 per run spent and discarded. |
| 2026-10-10 | **082**: drift re-planning (≤ 2 drifted pages per run). | 7 of 70 pages stale and never planned. |
| 2026-11-01..03 | **R19/R20**: about 49-min generation window; cap of 4 pages per invocation. | Deadline stops at 46% (3–4 pages) and 69% (5–8 pages). |
| 2026-11-09 | **US7**: daily schedule, 7-day cooldowns, `low` by default. Target $18.50/week. | $167.80 over 106 runs in 30 days (about $37/week); 265 page attempts for 39 distinct pages. |
| 2026-11-09 | **Run 5104**: 30 forced pages starve the 4 requested ones; about $1.44 for one landed page. | The forced set grows with every merge; about 20 pages/week change source anyway. |
| 2026-11-10 | **This PRD**: sessions refresh summaries on the subscription; CI blocks drift; the generator becomes manual. | The marginal cost of freshness becomes zero, and accuracy is checked where the change is made. |
