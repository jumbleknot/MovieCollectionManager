# Handoff: Feature 044 — implementation

**From**: the planning session (spec → clarify → plan → tasks → analyze), 2026-07-28 → 2026-07-30
**To**: a fresh session starting implementation
**Status**: **Nothing is implemented.** Spec, plan, and tasks are complete and analyzed; not one task is done.

Read this **before** `spec.md` — it is the short version of what planning established, including two
measured facts that invalidate the obvious approach.

**Artifacts**: [spec.md](spec.md) (72 FR, 31 SC, 14 clarifications) · [plan.md](plan.md) ·
[research.md](research.md) (10 findings) · [data-model.md](data-model.md) ·
[contracts/cli-contracts.md](contracts/cli-contracts.md) · [quickstart.md](quickstart.md) ·
[tasks.md](tasks.md) (65 tasks, 100% requirement coverage) · [checklists/requirements.md](checklists/requirements.md) (16/16).

---

## The two facts that shape everything

Both were measured against the installed toolchain. Do not design around the intuitive alternative.

### 1. The generator has no scoping surface — verification is the ONLY enforcement

`openwiki code [--init|--update] [message]`. That is the whole interface. There is **no** `--pages`,
`--scope`, `--max-pages`, or `--only` flag; the documented way to scope a run is free text
(`openwiki --update "Please document the API routes first"`).

**Consequence**: the 8-page slice cap is an *instruction to a model*, not a constraint on a process.
Nothing stops the generator ignoring it or over-producing. This is why FR-005/FR-006 exist and why the
verifier is the load-bearing component, not a belt-and-braces extra. Judge a slice by **pages that landed
in the working tree** plus bundle conformance — **never** by the generator's exit status, and never by
what it says it did.

### 2. The generator reports no token or cost data — FR-011 was amended because of it

Measured: no usage/cost flag in the option list; zero matches for `inputTokens|input_tokens|totalTokens|usage_metadata|costUsd` across `dist/`; all 21 `tokens` hits in `cli.js` are `marked` markdown-lexer
tokens; `--telemetry-file` is the PostHog payload with no token counts. Feature 043 never measured cost
either — every figure it recorded is wall-clock.

**Consequence**: the original "per-run spend ceiling" clarification was **superseded** mid-planning.
FR-011 is now a **page budget (16) + wall-clock budget (20 min)**, whichever hits first, effective ceiling
≤24 pages / ~37 min once the non-interruptible one-slice overshoot is counted. **No requirement in this
feature asserts a monetary bound** (FR-011d) — do not add one back.

---

## Settled decisions — do not reopen

Each cost a clarification round. Changing one is a spec amendment, not an implementation choice.

| Decision | Note |
|---|---|
| **Per-path regeneration policy** replaces 043's location-based ownership rule | `regenerate` / `event-driven` / `excluded` / `never-written` / `analyzable-not-covered`, each with a governing actor |
| **`regenerate` governs an agent under human review — NOT the generator** | The generator's write scope stays `openwiki/` + its own managed blocks. Widening it is a separate feature. This is the assumption the whole policy grid rests on |
| **`event-driven` includes creation** | A decision reached produces a *new* ADR; a path is not satisfied by being left alone (FR-026f) |
| **Full trim of `CLAUDE.md`**, not a measured tranche | Made safe mechanically — fingerprinted passages in a sidecar manifest — not by limiting scope |
| **Merge-triggered, ~15-min quiet-`main` debounce, no periodic sweep** | Plus a **maximum deferral**, or a busy day starves maintenance exactly when drift is fastest |
| **One proposal, ever, updated in place** | Rebase-and-append. Human commits on the branch must survive. Closed-unmerged → work returns to backlog and the marker rolls back |
| **Canonical-home routing** | Concept cites a `resource` → write upstream (runbooks keep taking learnings directly). No `resource` → authoritative, write into the concept. Only relocated `CLAUDE.md` content changes destination |
| **`specs/**` analyzable but not a coverage target** | `HANDOFF.md` excepted — it carries live measured knowledge |
| **`docs/test-data/**` excluded explicitly**; the fixture file stays put | Its path is baked into a unit test and feature 014's spec/tasks/quickstart |
| **`docs/agent-layer.md` → `docs/runbooks/agent-layer.md`** | No content change. Only its first section is architecture; the other seven are operational |
| **No new credential** | `ANTHROPIC_API_KEY` and `CD_PUSH_TOKEN` already exist. 17 secrets are already in the store |

---

## Constraints inherited (from 043 and the repo)

- **Always invoke generation via `pnpm nx wiki-update infrastructure-as-code`.** A bare CLI call skips the
  telemetry opt-out and the raised heap, and OOMs.
- **Never run `openwiki --init`** — `--update` creates the bundle when absent, avoiding the interactive
  wizard and the `~/.openwiki/.env` it writes.
- **A leak-gate hit is fixed in `openwiki/INSTRUCTIONS.md` and regenerated. Never allowlisted** (FR-015).
- **Always-on gates are offline, keyless, fail-closed. No skip flag. Do not add one.**
- **Every new CI *job* must publish a failure digest** or `check-ci-digest-coverage.mjs` fails the build.
- **New `scripts/__tests__/*.test.mjs` are auto-gated** — the `naming` job's glob is shell-expanded, so no
  workflow edit is needed. They must be deterministic, offline, token-free, `node:` built-ins + `yaml`.
- **A job that needs `yaml` must `pnpm install` first** — 043's `okf` job failed its first CI run on
  exactly this.
- CI is **Forgejo** (`.forgejo/workflows/`). GitHub is a no-Actions push mirror.

---

## Start here

**T001–T003** have no dependencies. Then Phase 2 (T004–T008) blocks everything else.

**MVP = T001–T025** (through US1). That alone ends the false-green failure and makes the existing manual
loop honest — a coherent stopping point that can sit on `main` indefinitely. Next stops: T035 (automated
freshness), T055 (complete).

### Ordering traps

1. **US4 (T036–T038) must land before US3.** The trim runs through the local invocation path (FR-027aa).
   This is why US4 was raised P3 → P2; it looks optional and is not.
2. **Inside US3: the gate (T046–T048) must be green before the trim (T050).** Otherwise load-bearing
   content relocates with no protection against a later paraphrase — the exact risk that justified
   accepting a full trim.
3. **T040 must move the two concepts' `resource` fields in the same change** as the document. The OKF gate
   **fails** on an unresolvable repo-relative `resource`.

---

## Non-obvious things planning discovered

- **Exit `3` is a budget stop, not a failure.** Same reasoning as `ci-status.mjs` distinguishing starvation
  from failure — a run that correctly stops at its budget must not be reported as broken.
- **Add the governance gate as *steps in the existing `okf` job*, not a new job.** A new job incurs its own
  failure-digest obligation for no benefit.
- **The run-record state file must be committed** — CI runners are ephemeral, and FR-012 requires the marker
  to advance even on runs that create no proposal. Advance it with a `[skip ci]` commit (the `cd-deploy`
  digest-promote precedent), which also satisfies FR-009a's no-self-trigger rule.
- **Do not repurpose `openwiki/.last-update.json`** — the tool owns it, and 043 measured it advancing only
  when wiki content changed, which is precisely why the free path was unreachable.
- **Governance YAML at the bundle root is invisible to both the generator and the OKF gate** (both handle
  markdown only). That is what puts the protection manifest outside the generator's write scope — the whole
  point of choosing a sidecar over in-content markers.
- **`CLAUDE.md` carries three machine-managed regions** (`nx configuration`, `SPECKIT`, `OPENWIKI`), written
  by three different tools. The OPENWIKI block is rewritten every run, which is why a hand-authored
  correction note sits beneath it. **That block already claims a scheduled workflow refreshes the wiki —
  this feature makes it true**, so delete the correction's "there is no scheduled workflow" clause (T052).
- **`log.md` is singular.** The vendor blog says `logs.md`; the shipped code does not.
- **There is no PowerShell in this dev container**, but `.specify/scripts/` is PowerShell-only. Resolve the
  feature directory from `.specify/feature.json` instead — it already points at 044. The git extension's
  bash scripts do exist and work.
- **`/speckit-git-commit` silently no-ops.** `auto_commit.default` and every per-event override are `false`
  in `.specify/extensions/git/git-config.yml`, so the hook exits 0 having done nothing. Commit by hand.

---

## Open residual

**FR-023a — the write credential.** The run reuses `CD_PUSH_TOKEN`, which can push directly to protected
`main` when opening a proposal needs far less. FR-023a permits a narrower substitute *provided it reduces
privilege*, but minting one adds a store entry this feature promised not to add. Recorded as a residual in
[plan.md](plan.md)'s Constitution Check and deliberately left untasked — it is an operator decision about
credential scope, not implementation work.

---

## Validation

`quickstart.md` holds 20 runnable scenarios grouped by story; 💰 marks the ones that invoke a paid model.
Everything else is offline and free by design.

Before marking the feature complete, the **full checklist in T064 is mandatory — including the web E2E
regression**, even though this feature touches no application code. In this dev container that runs via the
containerized browser path (chromium cannot be installed here).
