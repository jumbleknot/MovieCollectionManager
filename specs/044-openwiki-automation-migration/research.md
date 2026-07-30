# Phase 0 Research — Feature 044

**Date**: 2026-07-30 · **Spec**: [spec.md](spec.md)

All findings below were measured against this repository and the installed toolchain, not inferred.
Where a finding contradicts the specification, it is called out explicitly rather than absorbed.

---

## R1 — The generator exposes NO token or cost accounting → FR-011 amended to page/time

**Decision**: **RESOLVED 2026-07-30 by spec amendment.** The spend ceiling is replaced by a **per-run page
budget and wall-clock budget**, whichever is reached first — the two quantities this repository can
actually observe. No monetary bound is asserted anywhere in the feature.

**Evidence** (openwiki 0.2.3, `/usr/local/lib/node_modules/openwiki`):

| Probe | Result |
|---|---|
| `openwiki --help` complete option list | `--init` `--update` `--mode` `-p/--print` `--debug` `--modelId` `--scheduled` `--telemetry-file`. **No usage, cost, or budget flag.** |
| `grep -ri "inputTokens\|input_tokens\|totalTokens\|usage_metadata\|costUsd" dist/` | **zero matches** |
| All 21 `tokens` hits in `dist/cli.js` | `marked` markdown-lexer tokens (`marked.lexer`, `token.tokens`, `InlineMarkdown`) — not LLM accounting |
| `tokens` in `dist/agent/openai-chatgpt-oauth.js` | OAuth access/refresh tokens |
| `--telemetry-file <path>` payload | Carries no token counts; it is the PostHog anonymous payload (`posthog-node`). Not a usage report |
| `--debug` | "full credential and error diagnostics" — not usage |

The tool depends on `@langchain/anthropic` and `langchain`, which populate `usage_metadata` internally,
but **openwiki does not surface it**. There is no wrapper point either: the CLI is a bundled binary
invoked as a subprocess.

**Why this matters**: the 2026-07-30 clarification chose a spend ceiling over a page or wall-clock
budget on the understanding that cost could be bounded directly. It cannot. Worse, **feature 043 never
measured cost either** — every figure in its handoff is wall-clock (a slice is 5–17 min, an incremental
run ~92 s, a no-op ~1 s). The repository has no dollar-denominated data to calibrate against, only time.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| Anthropic Admin/Usage API | **Rejected** — requires a new admin-scoped credential, violating FR-023's "no new credential"; also reports with lag, so it cannot gate a slice about to start |
| Wrap or proxy the API calls to capture response usage headers | **Rejected** — requires intercepting a bundled third-party CLI's HTTP; brittle across upgrades and a poor fit for a governance feature |
| `--telemetry-file` as the usage source | **Rejected on evidence** — the payload has no token counts |
| Pages-written × calibrated cost-per-page | **Rejected by the maintainer** — a fabricated estimate that *reads* as a monetary guarantee is worse than no monetary claim. There is no cost data anywhere in the repository to calibrate against |
| **Page budget + wall-clock budget, whichever first** | **SELECTED** — both directly observable, no new credential, and the page count reuses what the verifier already computes for FR-005 |

**Resolution**: FR-011 is amended to the two measurable budgets (FR-011/FR-011a–d). Notably FR-011b now
requires both counters to come from **verified observation** — pages counted from the working tree, never
from the generator's self-report — which extends the anti-false-green reasoning of FR-005 to the budget
itself. This matters because of R2: nothing stops the generator over-producing past its page list.

FR-011c also **improves** under the amendment. A spend ceiling would have bounded money only, leaving
runner occupancy to a separate mechanism; a wall-clock budget bounds occupancy directly and so contributes
to FR-019 rather than sitting orthogonal to it.

FR-011d records the honest negative: **no requirement in this feature asserts a monetary bound**, because
nothing here can measure one.

---

## R2 — A slice can only be expressed as free-text; the bound is advisory, verification is authoritative

**Decision**: The planner emits a **run message** containing an explicit page list; bounding is
prompt-side, and only the verifier is authoritative.

**Evidence**: the full usage is `openwiki code [--init|--update] [message]`. There is no `--pages`,
`--scope`, `--max-pages`, or `--only` flag; the documented example of scoping is exactly
`openwiki --update --modelId gpt-5.5 "Please document the API routes first"`. This confirms 043's
finding that what worked was "an explicit page list of 6–8 pages in the run message."

**Why this matters**: nothing mechanically prevents the generator from exceeding or ignoring the slice.
The eight-page cap in FR-002 is an instruction to a model, not a constraint on a process. This is the
strongest possible justification for FR-005/FR-006 — result verification is not belt-and-braces here,
it is the only real enforcement.

**Alternatives considered**: none available. There is no programmatic scoping surface.

---

## R3 — Debounce on a quiet main branch is achievable natively

**Decision**: Implement the ~15-minute quiet-branch debounce with a **`concurrency` group plus
`cancel-in-progress: true` and an initial wait**. Each new push cancels the waiting run and starts a
fresh wait, so the run only proceeds once the branch has been still for the wait duration.

**Evidence**: `.forgejo/workflows/infra-image-scan.yml:43-45` already uses
`concurrency: { group: …-${{ github.ref }}, cancel-in-progress: true }`, so the primitive is available
in this Forgejo. `[skip ci]` is also honored — `cd-deploy`'s digest promote relies on it.

**Maximum deferral (FR-009b)**: the cancel-restart loop is unbounded on a busy day. The cap is
computed, not timed: before waiting, the job compares the **age of the oldest commit not yet covered by
the run record** against a maximum-deferral threshold, and skips the wait when it is exceeded. This
survives cancellation because it is derived from git history rather than held in the cancelled run's
memory.

**Alternatives considered**: a fixed cron poll (rejected — reintroduces the periodic sweep the spec
excludes); an external queue (rejected — new infrastructure for a timing problem).

---

## R4 — Runner state is ephemeral, so the run record must be committed

**Decision**: The run record and backlog live in a **version-controlled state file**, advanced by a
`[skip ci]` commit pushed with the existing write-scoped token — the same mechanism `cd-deploy` uses for
its digest promote.

**Evidence**: CI jobs check out fresh; nothing on the runner survives. FR-012 requires the marker to
advance even on a run that documents nothing, so the marker cannot live only inside a proposal branch
that such a run never creates. `openwiki/.last-update.json` is written by the **tool** (`updatedAt`,
`command`, `gitHead`, `model`) and must not be repurposed — a tool-owned file cannot carry our
semantics safely across an upgrade.

`[skip ci]` also satisfies FR-009a: a marker commit cannot re-trigger maintenance.

**Alternatives considered**: deriving the marker purely from git history (rejected — cannot distinguish
"covered and found nothing" from "never covered", which FR-017 requires); runner-local cache (rejected —
does not survive, and a lost cache silently re-does paid work).

---

## R5 — Governance artifacts go beside the generation brief, and the gate reuses the existing job

**Decision**: Two hand-authored YAML files at the bundle root — `openwiki/policy.yaml` (per-path
regeneration policy) and `openwiki/protected.yaml` (protection manifest) — enforced by a new
`scripts/check-openwiki-governance.mjs` added as **steps in the existing `okf` job**, not as a new job.

**Rationale**:

- The generator writes `*.md` concepts, `index.md`, `log.md`, and `.last-update.json`. The existing gate
  collects markdown only (`collectMarkdown`), so `.yaml` siblings are invisible to both — they sit
  outside the generator's write scope, which is exactly FR-029b's requirement.
- `INSTRUCTIONS.md` already establishes the precedent of a hand-authored, never-rewritten file at the
  bundle root.
- **Reusing the `okf` job avoids a new CI digest obligation.** `check-ci-digest-coverage.mjs` fails the
  build when a *job* lacks a failure digest; adding steps to a job that already publishes one keeps the
  gate satisfied with no new workflow surface.
- Keeping this as a **separate script** from `check-openwiki-okf.mjs` (424 lines, rules V1–V13) preserves
  that gate's single responsibility and gives the new rules their own `--selftest` and test file.

**Alternatives considered**: extending `check-openwiki-okf.mjs` in place (rejected — conflates bundle
conformance with governance, and doubles the blast radius of a change to either); a dedicated workflow
(rejected — new job, new digest obligation, no benefit for an offline keyless check).

---

## R6 — Two new checks must be keyless and offline, like every always-on gate

**Decision**: `check-openwiki-governance.mjs` follows the established gate idiom exactly — `--selftest`
first, exit `0` clean / `1` violation / `2` bad usage, `node:` built-ins plus `yaml`, rule IDs continuing
the existing series, and a unit test at `scripts/__tests__/check-openwiki-governance.test.mjs`.

**Evidence**: nine sibling gates in `guardrails.yml` follow this shape; the `naming` job runs
`node --test scripts/__tests__/*.test.mjs` via a shell glob, so a new test file is picked up with **no
workflow edit**. The `okf` job already runs `pnpm install` because the gate imports `yaml` — the
dependency is available.

---

## R7 — Relocating the agent-layer document is a solved, tested operation

**Decision**: Move `docs/agent-layer.md` → `docs/runbooks/agent-layer.md` with no content change, update
inbound references in lockstep, and extend the existing relocation guard.

**Evidence**: feature 043 performed the same operation on two operator documents and left
`scripts/__tests__/relocated-docs-links.test.mjs` behind to guard it. Inbound references to update:
`CLAUDE.md:93`, five feature specs (018/019/020/040/043 — historical, but their links must still
resolve), and two bundle concepts whose `resource` field points at the old path
(`projects/agent-gateway.md`, `architecture/agent-layer.md`). The OKF gate **fails** on an unresolvable
repo-relative `resource`, so the concepts must move in the same change.

The known cost — a pure rename produced permanent false drift warnings in 043 — is not incurred here,
because V12 drift stays report-only (FR-036) and staleness is now handled by change-triggered
regeneration.

---

## R8 — Proposal create-and-update on the forge

**Decision**: Maintain a single long-lived branch and a single open pull request, created and updated
through the Forgejo API with the existing write-scoped token. Updates **rebase onto `main` and append**,
preserving human commits (FR-016a).

**Evidence**: `CLAUDE.md` documents the working `POST /api/v1/repos/{owner}/{repo}/pulls` pattern, and
`cd-deploy` demonstrates a whitelisted-user write token pushing to protected `main`. The read-only
CI-monitor token is insufficient (no `write:repository`).

**Preserving human commits**: the update must never force-overwrite the branch wholesale. It rebases the
branch onto current `main` and adds new work as new commits, so a human's remediation commit — the
sanctioned fix path under FR-015 — survives as part of the rebased series.

**Closed-unmerged detection (FR-016b)**: the run queries the proposal's state; a `closed` and unmerged
proposal means its covered work returns to the backlog and the run record must not claim it.

---

## R9 — Confirmed: no new credential is required

**Decision**: Consume `ANTHROPIC_API_KEY` and the existing write-scoped token. Add nothing to the store.

**Evidence**: `ANTHROPIC_API_KEY` is referenced at `app-ci.yml:255` (`app-e2e`) and `app-ci.yml:736`
(`dast`); `CD_PUSH_TOKEN` at `cd-deploy.yml:110`. Seventeen distinct secrets are already in use across
six workflow files. This closes the FR-023 correction with direct evidence.

---

## R10 — An index-only instruction file must coexist with three managed regions

**Decision**: The trim rewrites only the hand-authored prose. The three machine-managed regions are left
byte-identical, and the index is placed outside them.

**Evidence**: `CLAUDE.md` carries `<!-- nx configuration start/end -->` (Nx), `<!-- SPECKIT START/END -->`
(Spec Kit, rewritten by `/speckit-plan` itself), and `<!-- OPENWIKI:START/END -->` (rewritten by every
generator run). A hand-authored correction note already sits *below* the OpenWiki block precisely because
that block is overwritten each run.

**Bonus**: the OpenWiki block asserts "The scheduled OpenWiki GitHub Actions workflow refreshes the
repository wiki." This feature makes that sentence true, so the correction note's first clause
("there is **no scheduled workflow**") is deleted as part of the trim.

---

## Resolved unknowns summary

| # | Unknown | Status |
|---|---|---|
| R1 | Can per-run spend be measured? | **No** — FR-011 amended to page + wall-clock budgets. Resolved |
| R2 | How is a slice scoped? | Free-text run message only; verification is the sole enforcement |
| R3 | Is a quiet-branch debounce achievable? | Yes — `concurrency` + `cancel-in-progress` + git-derived deferral cap |
| R4 | Where does run state live? | Committed state file, advanced by a `[skip ci]` commit |
| R5 | Where do governance artifacts live, and which job gates them? | Bundle-root YAML; steps added to the existing `okf` job |
| R6 | What shape does the new gate take? | The established keyless `check-*.mjs` idiom; test auto-globbed |
| R7 | How risky is the document relocation? | Low — precedented and already guarded by a test |
| R8 | How are proposals created and updated? | Forgejo API, single branch, rebase-and-append |
| R9 | Is a new credential needed? | No — confirmed by direct evidence |
| R10 | Can the instruction file be index-only? | Yes — three managed regions preserved untouched |
