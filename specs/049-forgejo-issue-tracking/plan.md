# Implementation Plan: Forgejo issue tracking — an agent-driven backlog with no human transport layer

**Branch**: `049-forgejo-issue-tracking` | **Date**: 2026-08-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/049-forgejo-issue-tracking/spec.md`

## Summary

Move the backlog off the operator's workstation and into the forge's own issue tracker, and give the
assistant first-class access to it: file, read, update, close, comment, label and dependency-link items
from inside the dev container with no human relay and no commit/PR/CI cycle.

Technical approach: one dependency-free Node script (`scripts/backlog.mjs`) carrying everything that
must be right every time — endpoint/host derivation, pagination, redaction, scope-failure diagnosis —
plus one thin skill (`.claude/skills/forgejo-issues/SKILL.md`) carrying only the decisions an agent
cannot derive from the tool. It mirrors `scripts/ci-status.mjs` deliberately: same transport shape, same
`redactForPublication` output path, same "name the token and the missing scope" failure discipline, same
`node:test` unit-test placement that the guardrails workflow already globs.

Phase 0 replaced the PRD's assumed API behaviour with **measured** behaviour against the live forge
(`15.0.3+gitea-1.22.0`, read-only calls only). Four measurements change the design; two change the
spec's factual premises. The most consequential:

- **The API base cannot come from `FORGE_REGISTRY_HOST`** — that value carries no port, and the forge's
  HTTP API is not on port 80. Derive scheme+host+port from `git remote get-url origin`, exactly as
  `ci-status.mjs` already does.
- **`labels=<unknown-name>` is silently ignored and returns the *unfiltered* set** — a typo'd label
  filter looks like a successful match. The script must resolve label names against the repo's label
  list and fail loudly on an unknown name.
- **The tracker is not empty**: issue **#29 "Dependency Dashboard"** is Renovate-managed. Anything that
  sweeps "all open issues" will hit a bot-owned issue that Renovate rewrites.
- **`MCM_FORGE_ISSUE_TOKEN` already exists in this container and already reads successfully.** Its reach
  is not restricted to this repository — the operator's deliberate decision (2026-08-08), superseding the
  PRD's single-repo bot requirement. Permission scope bounds it server-side; the tooling's
  same-repository guard bounds it client-side, which is why that guard now applies to **every** write
  rather than only to the task fan-out (FR-016).

Full evidence and every measurement in [research.md](research.md).

## Technical Context

**Language/Version**: Node.js 24 (ESM, `.mjs`) — the version already pinned for the container and CI.

**Primary Dependencies**: None at runtime. Built-ins only (`node:fs`, `node:child_process`,
`node:test`, global `fetch`). One internal import: `redactForPublication` from
[scripts/ci-digest-redact.mjs](../../scripts/ci-digest-redact.mjs). Zero new package.json entries — a
new dependency here would have to clear the SCA gate for a tool that makes plain HTTP calls.

**Storage**: None. The forge's own database is the store; items are read and written over HTTP. No
local cache, no state file, no second source of truth (spec Assumptions).

**Testing**: `node:test` + `node:assert/strict` in `scripts/__tests__/backlog.test.mjs`. The guardrails
`naming` job already runs `node --test scripts/__tests__/*.test.mjs` (shell-expanded glob), so a new
file there is enrolled in CI automatically — no workflow edit. Tests must stay deterministic, offline
and token-free: every case drives an exported pure function or an injected fetch double, never the live
forge (the same rule `ci-status.test.mjs` states in its header).

**Target Platform**: The Linux dev container (agent-facing). Not deployed; not part of any image or
stack. Reaches the forge over the tailnet, which the container's start-time firewall already allowlists.

**Project Type**: Repository tooling + agent guidance. No application code under `backend/`,
`frontend/`, `agents/`, `mcp-servers/`, or `infrastructure-as-code/`.

**Performance Goals**: Any single item read or write completes well inside a second on the ~135 KB/s
tailnet link (payloads are KB-scale). The ready-work query is the only multi-call path: 1 list call plus
1 dependency call per candidate, concurrency-capped at 4, and it must stay under ~3 s for a backlog of
50 open items.

**Constraints**: No commit/branch/PR/CI run may result from any backlog operation (FR-002). No forge
host literal in any committed artifact or any line of output (FR-007). No token literal anywhere
(FR-003). Item bodies and comments never pass through argv (FR-009). Skill body stays ≈1–2k tokens
(SC-009) — anything longer belongs in `--help` or the runbook.

**Scale/Scope**: One repository, one tracker, single operator plus one assistant. Backlog expected in
the tens of items, low hundreds at worst — comfortably inside the API's 50-row page cap with paging.
Deliverables: 1 new script, 1 new test file, 1 new skill, 1 issue form, 1 rewritten skill, 1 runbook,
2 documentation edits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies | How this plan satisfies it |
| --- | --- | --- |
| **Test-Driven Development** (NON-NEGOTIABLE) | Yes | Every behaviour lands as an exported pure function first, with a `node:test` case that is verified RED before implementation. `tasks.md` will carry the mandatory Verify-RED/Verify-GREEN checkpoint pairs per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md). |
| **Test Type Integrity** (NON-NEGOTIABLE) | Yes | The unit tier injects a fetch double — permitted, because these are unit tests of a single function. The live-forge verification in [quickstart.md](quickstart.md) is deliberately **not** filed as an integration test: it is a one-time operator-run probe against the real forge with no mocking of any kind, and its findings are recorded in the skill. Nothing under a `tests/integration/` path is created, so the no-mocking rule for that tier is not engaged. |
| **Security — Secrets Management** | Yes | Both tokens are read from the environment only; no literal, no default, no fallback value. `requireWriteToken()` throws with the remedy named rather than degrading silently. Tokens are never echoed, never logged, never placed in argv, and never written to a cache file. |
| **Security — Least Privilege** | Yes, satisfied by scope + a client-side guard | Write access carries repository-read + item-write and nothing else — it cannot push code, read packages, or administer. Its reach across repositories is deliberately unrestricted (operator decision, research D5), so least privilege is enforced where this feature can enforce it: every write is refused unless it targets the repository the working copy points at (FR-016). |
| **Security — Input Validation** | Yes | Item numbers are integer-validated; label and milestone names are resolved against the repo's own lists and rejected when unknown (which is what makes the silently-ignored-filter measurement safe); bodies are read from a file or stdin and length-capped; every output line is control-char-stripped and host-redacted before printing. |
| **Logging & Monitoring — Sensitive Data Prohibition** | Yes | Redaction is on the single `emit()` path, so the host is `<forge>` by construction rather than by remembering. Raw response payloads never reach stdout; `--json` emits a curated subset. |
| **Logging & Monitoring — Structured Format** | Partly (N/A by scope) | The structured-JSON requirement governs *production services*. This is an interactive CLI whose consumer is an agent transcript, so it follows the `ci-status.mjs` convention: compact human/agent-readable lines, with `--json` for machine consumption. |
| **AI Assistant Constraints — Behavior-Descriptive Identifiers** | Yes | Exported names describe behaviour (`buildIssueQuery`, `describeScopeFailure`, `resolveLabelNames`, `selectReadyItems`). No `FR-###` in any identifier; requirement provenance goes in a JSDoc comment on the artifact. |
| **AI Assistant Constraints — Technology Agnosticism** | Yes | Endpoints, verbs, headers and paths appear here and in `contracts/`, never in `spec.md`. |
| **AI Assistant Constraints — Documentation** | Yes | New runbook, devcontainer env-var table row, rewritten `speckit-taskstoissues`, and an openwiki concept after the feature lands (spec Documentation Impact). |
| **Nx as universal task runner** | Deviation — see Complexity Tracking | No Nx target; `node scripts/backlog.mjs` directly, following the `ci-status.mjs` precedent. |
| **Package manager (pnpm only)** | Yes | No package.json change at all. |
| **RTK token compression** | Yes | Test and probe runs go through RTK like every other command in an assisted session. |
| **Backend / Frontend / Agent-layer principles** (Clean Architecture, Rust safety, AG-UI, MCP tool layer, design system…) | No | Nothing under `backend/`, `frontend/`, `agents/`, `mcp-servers/`, `infrastructure-as-code/`. No service, no UI, no agent graph, no MCP server — the "thin skill, not an MCP server" decision is the PRD's, restated with measurements in [research.md](research.md). |

**Gate result (pre-Phase 0)**: PASS with one recorded deviation (no Nx target) and no blocking
prerequisite — the write credential is already provisioned as the operator intends.

**Gate result (post-Phase 1 re-check)**: PASS. The Phase 1 design added no dependency, no new
credential, no new persistent store and no new CI job. Three design consequences were *added* by the
measurements and by the operator's credential decision rather than removed: label-name resolution before
any filter or assignment (Input Validation); an explicit bot-managed-item exclusion so no sweep touches
Renovate's issue; and the same-repository write guard widened from the task fan-out to every write path,
since it is now the only client-side bound on a deliberately cross-repository credential.

## Project Structure

### Documentation (this feature)

```text
specs/049-forgejo-issue-tracking/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — measured forge behaviour + resolved open questions
├── data-model.md         # Phase 1 — entities, fields, state transitions, label taxonomy
├── quickstart.md         # Phase 1 — setup + the one-time live verification sequence
├── contracts/
│   ├── backlog-cli.md    # The command surface (the contract the skill and CI consume)
│   └── forge-endpoints.md # The observed forge contract: endpoints, params, headers, quirks
├── checklists/
│   └── requirements.md   # Spec quality checklist (complete)
└── tasks.md              # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
scripts/
├── backlog.mjs                     # NEW — the backlog tool (commands per contracts/backlog-cli.md)
├── ci-digest-redact.mjs            # REUSED — redactForPublication(), the single redaction seam
├── ci-status.mjs                   # REFERENCE — transport/redaction/auth-failure conventions copied
└── __tests__/
    └── backlog.test.mjs            # NEW — node:test units; auto-globbed by guardrails `naming`

.claude/skills/
├── forgejo-issues/SKILL.md         # NEW — the decision rules + measured quirk list (≈1–2k tokens)
└── speckit-taskstoissues/SKILL.md  # REWRITTEN — forge remote instead of GitHub + GitHub MCP

.forgejo/
└── issue_template/
    └── backlog-item.yaml           # NEW — YAML issue form (structural parity, FR-013)

docs/runbooks/
├── backlog.md                      # NEW — bot/token provisioning, taxonomy, blast-radius warning
└── devcontainer.md                 # CHANGED — env-var table gains MCM_FORGE_ISSUE_TOKEN

.devcontainer/devcontainer.json     # ALREADY LANDED (e4aee95) — consumed, comment kept accurate
CLAUDE.md                           # CHANGED — plan pointer + the Nx index hook (see below)
openwiki/
├── invariants/nx-task-runner.md     # CHANGED IN THIS FEATURE — the interactive-tool exception class
├── protected.yaml                   # CHANGED IN THIS FEATURE — re-fingerprinted in the same change
└── (a backlog-workflow concept)     # CHANGED after the feature lands, per openwiki/INSTRUCTIONS.md
```

**Structure Decision**: Repository-tooling layout, not an application layout — so none of the
plan-template's project options apply. The script lives in `scripts/` beside its closest sibling
(`ci-status.mjs`) and its tests in `scripts/__tests__/` where the guardrails glob already collects
them; agent-facing guidance lives in `.claude/skills/`; the issue form must live at a path the forge
itself reads (`.forgejo/issue_template/`), which is why it is not under `docs/`.

## Implementation Sequencing (for `/speckit-tasks`)

Ordered so that each step is verifiable before the next depends on it, and so the two operator-only
steps are unblocked as early as possible.

1. **No operator prerequisite.** `MCM_FORGE_ISSUE_TOKEN` is already provisioned, delivered, and reading
   successfully; its permissions and its deliberate cross-repository reach are the operator's recorded
   decision (research D5). The one thing still owed is *proof of the scope split*, which is not a setup
   step but the negative half of the write verification in step 5.
2. **Pure core, test-first** — remote→(base, owner, repo) derivation; query assembly with `type=issues`
   and paired `page`+`limit`; `x-total-count` truncation reporting; `describeScopeFailure`; redaction on
   every emit path; body-from-file/stdin; blocked-close error classification; ready-item selection.
   Each lands RED first (US1–US5, FR-006…FR-011).
3. **Read commands** — `list`, `ready`, `show`. Verifiable immediately against the live tracker with the
   read-only token alone, before any write credential exists (this is why reads come first).
4. **Setup of conventions** — labels (taxonomy in [data-model.md](data-model.md)), milestone
   convention, `status/bot-managed` applied to Renovate's issue #29, and the issue form committed and
   then validated via the forge's own `issue_config/validate` endpoint (FR-012, FR-013).
5. **Write commands** — `create`, `update` (incl. close), `comment`, `dep`. Their live verification and
   the 403-under-the-read-token proof are the one-time probe sequence in `quickstart.md` (US1, US3, US5).
6. **Label-filter re-measurement** — with real labels now defined, re-run the `labels=` probe and record
   the *positive* behaviour next to the already-recorded silently-ignored-unknown behaviour (FR-017).
7. **The skill** — written last, so it records measured behaviour rather than predicted behaviour, and
   so its token budget is spent on decisions the tool cannot make (FR-010, FR-015, SC-009).
8. **`speckit-taskstoissues` rewrite** — forge-remote gate, one item per task, milestone + dependency
   ordering, same-repo-only refusal retained in spirit (FR-016, US7).
9. **Documentation** — `docs/runbooks/backlog.md` (with the blast-radius warning at the point where the
   bot would be added to a second repo, FR-018/FR-019), devcontainer env-var row.
10. **Acceptance exercise** — import the workstation backlog conversationally; operator reviews in the
    web UI (US6, SC-006). Calibrate the taxonomy against what actually shows up (OQ-2).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| No Nx target for `backlog.mjs` | **Measured, 2026-08-08:** wrapping a script in an Nx target costs ~**61 s** per invocation in this workspace against ~**0.09 s** direct — same script (`check-resource-naming.mjs` via `pnpm nx check-naming` vs `node scripts/…`), warm daemon, repeated. That fixed ~700× overhead is tolerable for a gate that runs once per push; it is not tolerable for a command an agent runs several times inside one turn (`list`, `show`, `create`, `ready`). A one-minute `ready` would simply not be used, and an unused tool cannot satisfy FR-011. | An Nx target *is* technically fine otherwise — `--args=` forwarding demonstrably handles quoted multi-word flags (`wiki-maintain` uses it), so my earlier "argument forwarding is awkward" objection was overstated and is withdrawn. The disqualifier is latency, plus that the target would have to hang off `infrastructure-as-code`, which is not where a backlog tool belongs. Precedent agrees: `ci-status.mjs`, `gen-dev-secrets.mjs` and `gen-dev-env.mjs` — the other interactive, argv-rich tools — have no targets either. |
| No web E2E regression (`pnpm nx e2e mcm-app`) in the completion checklist | The canonical [feature-validation-checklist](../../openwiki/invariants/feature-validation-checklist.md) states this run is "REQUIRED for EVERY feature — including backend-only changes" and is "not skippable". Its **stated rationale** is that a backend change is exercised by the clients through the BFF → service, and only E2E proves the real user path. That rationale does not reach this feature: it ships no client surface and touches no service the Expo app calls. The changed files are a new `scripts/` tool, a one-word `export` added to a CI diagnostic script, a devcontainer comment, an issue-template YAML, skills, and documentation — none of which enters the app bundle or any runtime path. | Omitting it **silently** was the defect (found by `/speckit-analyze`, finding C1); the alternative was to reason about it in tasks.md prose and leave the plan's deviation table clean, which is exactly how an unrecorded deviation becomes precedent. Recorded here instead. The six live-forge verification tasks (T027, T036, T044, T049, T054, T060) are this feature's end-to-end proof, against the real forge — the system this feature actually integrates with. **If the invariant's letter is preferred over its rationale, run the E2E once (~35 min) and delete this row** — that is a legitimate call and costs only time. A future amendment to the invariant naming "features with no client-reachable surface" would remove the ambiguity for good. |
| The canonical Nx invariant did not describe this class of exception — **fixed in this feature** | [openwiki/invariants/nx-task-runner.md](../../openwiki/invariants/nx-task-runner.md) stated that the only non-Nx invocation permitted anywhere was the Maestro mobile-E2E wrapper. That was already inaccurate for three interactive tools, and `backlog.mjs` would have been a silent fourth — an agent reading the invariant would expect `pnpm nx backlog …` and conclude the tool was missing. | Corrected in place under the concept's `passage-corrected` event (`openwiki/policy.yaml` assigns this path `event-driven`/`actor: agent`, so this edit is the sanctioned actor and event). The Gotchas passage is fingerprinted in `openwiki/protected.yaml`; it was re-fingerprinted in the same change, with the reason recorded as a dated comment, per the gate's own instruction. Governance, OKF, topology-scrub, secret-scan and the gates' own 48 unit tests all pass. |

## Phase Status

- [x] **Phase 0 — research** complete: [research.md](research.md). All five PRD open questions
      resolved; no `NEEDS CLARIFICATION` remains. Behaviour measured, not assumed (read-only calls only
      — nothing was written to the operator's tracker).
- [x] **Phase 1 — design & contracts** complete: [data-model.md](data-model.md),
      [contracts/backlog-cli.md](contracts/backlog-cli.md),
      [contracts/forge-endpoints.md](contracts/forge-endpoints.md), [quickstart.md](quickstart.md),
      agent context pointer updated in `CLAUDE.md`.
- [ ] **Phase 2 — tasks**: run `/speckit-tasks`. The sequencing above is the intended task order; the
      test tasks must carry Verify-RED/Verify-GREEN checkpoints.

## Spec Corrections Arising From Phase 0

Two factual premises inherited from the PRD did not survive measurement. They do not change any
requirement, but the spec's Assumptions should be read with these corrections (recorded here rather
than silently edited into `spec.md`):

1. **"The tracker holds zero items"** — it holds one: Renovate's bot-managed Dependency Dashboard
   (#29). Consequence: the design adds a `status/bot-managed` exclusion rather than assuming a clean
   slate, and item numbers share one sequence with pull requests (PRs occupy #100–#143), so a bare
   `#N` is ambiguous between the two in prose.
2. **"Page size is silently ignored without an explicit page"** — measured false on the issues
   endpoint: page size alone is honoured. The real limits are a default of 30 and a hard cap of 50,
   and the authoritative total lives in `x-total-count`. FR-007's paired `page`+`limit` rule is kept
   as explicitness, but its justification is the 50-row cap, not a silent-ignore bug.
