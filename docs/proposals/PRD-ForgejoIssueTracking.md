# PRD — Forgejo Issue Tracking (Agent-Driven Backlog via a Thin Skill over the REST API)

**Status:** Proposed

**Created:** 2026-08-08

**Context:** The MCM backlog currently lives in Notepad on the operator's workstation. The agent
cannot see it, cannot add to it, and cannot mark anything done — every backlog interaction requires a
**human as the transport layer**, pasting items into sessions and hand-editing a text file afterwards.
Meanwhile the repo is hosted on a self-hosted Forgejo instance that has been live for over a month,
processes every PR, ships a full issue tracker with a web UI — and holds zero issues. This PRD moves
the backlog into Forgejo Issues, driven by the agent from inside the dev container through a **thin
Claude Code skill wrapping the Forgejo REST API**. The selection rationale (vs Beads, Backlog.md,
git-bug, GitHub mirror, and heavier self-hosted trackers) is in `Issue-Tracking-Strategy.md`
(strategy folder, 2026-08-08); this PRD assumes that decision and specifies the implementation.

**Related:**
[.devcontainer/devcontainer.json](../../.devcontainer/devcontainer.json) (the `${localEnv}` credential pattern this extends),
[.devcontainer/init-firewall.sh](../../.devcontainer/init-firewall.sh) (the forge-host allowlist this relies on),
[docs/proposals/PRD-CISelfServeDiagnostics.md](PRD-CISelfServeDiagnostics.md) (§3.4 credential probes and §4.1 link budget this reuses),
[docs/runbooks/ci-diagnostics.md](../runbooks/ci-diagnostics.md) (`ci-status.mjs` — the container→forge-API precedent),
[.claude/skills/speckit-taskstoissues/SKILL.md](../../.claude/skills/speckit-taskstoissues/SKILL.md) (the GitHub-gated skill this supersedes),
CLAUDE.md § *SDD gates* (issues feed the proposal→spec lifecycle; they do not replace it).

---

## 1. Problem Statement

Two hard requirements define the feature:

- **R1** — Adding, updating, or closing a backlog item must never require a PR or a CI run.
- **R2** — The agent in the dev container must directly **create** issues, **read** issues to
  implement features, **update** issue status, and **close** issues.

The distance between today and R1+R2 is smaller than it looks. Most of the path already exists and
has been **measured**, not assumed (probes 2026-07-18, PRD-CISelfServeDiagnostics §3.4, against
Forgejo `15.0.3+gitea-1.22.0`):

| Capability | Status | Evidence |
| --- | --- | --- |
| Reach the forge API from the dev container | ✅ works | firewall allowlists `FORGE_REGISTRY_HOST` on every start; `GET /api/v1/version` → 200 over the tailnet |
| **Read** issues and comments | ✅ works | `MCM_FORGE_TOKEN` carries `read:issue`; `issues/{n}` and `issues/{n}/comments` → 200 (verified with the minted token) |
| **Write** issues (create / edit / close / comment / label) | ❌ **absent** | `MCM_FORGE_TOKEN` is deliberately read-only; the `git credential fill` credential is write-capable but **repository-scoped** — `issues/{n}/comments` → **403** |
| Agent guidance for issue endpoints | ❌ absent | no skill documents the API; `speckit-taskstoissues` is hard-gated to GitHub remotes + the GitHub MCP server and is dead weight on this repo |
| Backlog conventions (labels, templates, milestones) | ❌ absent | the repo has no issue template and the tracker has never been used |

So the gap is exactly: **one write-scoped credential, one skill, and a set of conventions.** Issue
operations are HTTP calls — R1 is satisfied by construction, with no analog of the file-based
trackers' commit→PR→CI cycle.

### Why a thin skill, not an MCP server

An MCP server (`gitea-mcp` v1.6.0, or the Forgejo-specific `raohwork/forgejo-mcp` v0.0.x) would load
10–50k tokens of tool schemas into **every** session, used or not. A skill loads ~1–2k tokens and
only when invoked — the same economics that justify RTK. The skill also works unchanged for the other
assistants that read this repo's guidance (OpenCode, Codex), where an MCP registration would be
per-tool configuration. An MCP server remains a compatible later addition if tool-native access ever
proves worth its context cost; nothing in this design blocks it.

---

## 2. Goals / Non-Goals

### Goals

- **G1** — The agent performs full issue CRUD (create, read, update, close, comment, label,
  dependency-link) from the dev container with no human transport (R2).
- **G2** — No issue operation involves a commit, branch, PR, or CI run (R1).
- **G3** — The operator manages the same backlog through the Forgejo web UI already in daily use;
  agent-filed and human-filed issues are indistinguishable in capability.
- **G4** — No credential literal and no forge-host literal enters git (secrets-management +
  topology-scrub gates), and API output surfaced into agent transcripts is host-redacted **by
  construction**.
- **G5** — A missing or under-scoped token fails **loudly with the missing scope named**, never
  silently (the FR-017 lesson from PRD-CISelfServeDiagnostics, paid for once already).
- **G6** — The backlog inherits the existing verified backup path (issues live in Forgejo's
  Postgres, inside the restic `forgejo dump` snapshot) with zero new backup machinery.

### Non-Goals

- **Not** a second source of truth: no Beads, no markdown task files, no local task database. The
  spec-kit `tasks.md` remains the **in-feature** decomposition artifact; Forgejo Issues is the
  **cross-feature** backlog. The two meet only at §3.4.
- **Not** kanban automation — Forgejo's Projects boards have **no API** in this build (upstream
  Projects REST API is in progress, targeted ~v16). Labels + milestones + dependencies are the
  machine-readable state; the board UI, if used, is human-only.
- **Not** CI writing to issues (auto-filing issues from failures is a possible successor feature;
  the digest/PR-comment path from PRD-CISelfServeDiagnostics already covers failure reporting).
- **Not** issue migration tooling — the Notepad backlog is imported once, conversationally, as the
  skill's first real exercise (§5).
- **Not** altering the merge gate, branch protection, or any workflow.

---

## 3. Proposed Solution

### 3.1 Credential model — a bot account and one new passthrough

**A dedicated Forgejo bot account** (e.g. `backlog-bot`) is created and granted collaborator access
on the repo, and a token is minted on that account scoped **`write:issue` + `read:repository`**.

Why a bot rather than a token on the operator account: Forgejo tokens are **account-wide** — there is
no repo-scoped token (upstream feature request open since 2024). A `write:issue` token minted on the
operator account could touch issues on every repo the operator can access; minted on a
single-collaborator bot, its blast radius is this repo's issue tracker and nothing else. This is the
same reasoning that produced the `actions-cd-push` user for CD.

Why not widen `MCM_FORGE_TOKEN`: that token's read-only scope set is load-bearing for CI diagnostics
(PRD-CISelfServeDiagnostics FR-015 explicitly requires read-only). Widening it would couple two
features to one credential and silently upgrade the diagnostics path to write capability. The two
tokens stay separate, on separate accounts, with separate revocation.

Delivery follows the established pattern exactly: set on the Windows host
(`setx MCM_FORGE_ISSUE_TOKEN ...`), passed through in `devcontainer.json` `containerEnv` as
`"MCM_FORGE_ISSUE_TOKEN": "${localEnv:MCM_FORGE_ISSUE_TOKEN}"` with a comment block in the house
style. The known `setx` gotcha applies and must be documented in the comment: VS Code must be fully
quit — not merely reloaded — before rebuild, or `${localEnv}` resolves to empty and the token
silently isn't there. Unset → empty → the skill degrades to read-only using `MCM_FORGE_TOKEN`
(which already reaches every issue read endpoint) and says so; the container still comes up.

### 3.2 The skill — `.claude/skills/forgejo-issues/SKILL.md` + `scripts/backlog.mjs`

Two artifacts, deliberately split:

**`scripts/backlog.mjs`** — Node, zero dependencies, matching the `ci-status.mjs` convention —
carries the parts that must be right *every time* and are wasted context as prose:

| Command | Behavior |
| --- | --- |
| `list [--label L] [--milestone M] [--state open\|closed] [--q text]` | Always sends `type=issues`; always paginates with `page` **and** `limit` together; server-side filters that the API honors, client-side for the rest. Compact table output. |
| `show <n> [--json]` | Issue body, labels, milestone, dependencies, comments — distilled. |
| `create --title T [--body-file F] [--label L…] [--milestone M]` | Body from file/stdin, never argv (secrets-in-argv rule from the maestro PRD). Prints the new issue number. |
| `update <n> [--state closed\|open] [--title] [--body-file] [--label add/remove]` | Close is `PATCH {"state":"closed"}` — there is no close endpoint. |
| `comment <n> --body-file F` | |
| `dep <n> --blocks <m> \| --blocked-by <m> [--remove]` | The dependencies/blocks endpoints exist in the API but not in SDKs; raw HTTP here. |

Output rules ported from `ci-status.mjs`, because they are the point:

- **Host redaction by construction** — every emitted URL rewrites the forge host literal to
  `<forge>`, so transcripts stay topology-scrub-compliant without the agent remembering to.
- **Scope failures named** — a 401/403 prints which token and which scope is missing (G5).
- **No raw payload to stdout** — responses distilled; `--json` gives a curated subset, not the raw
  body.
- **Base URL and repo derived, never hardcoded** — API base from `FORGE_REGISTRY_HOST` (already in
  `containerEnv` for the firewall), owner/repo from `git config --get remote.origin.url`. No literal
  in the script, the skill, or this PRD.

**`SKILL.md`** carries what an agent needs to *decide*, not to *type*: when to file an issue (work
discovered outside the current feature's scope), when to close one (acceptance criteria in the body
are met and verified), the label taxonomy (§3.3), how backlog issues relate to the SDD lifecycle
(§3.4), and the API quirks that would otherwise be re-derived by trial and error — `type=issues` or
PRs come back interleaved (PRs are issues internally, Gitea heritage); pagination defaults 30, caps
at 50, and `limit` without `page` is **silently ignored** (measured on `actions/runs`,
PRD-CISelfServeDiagnostics §4.1 — the issues endpoints must be probed once during implementation and
the observed behavior recorded in the skill, not assumed either way); a blocked issue cannot be
closed until unblocked.

### 3.3 Backlog conventions

Created once at setup, enforced socially by the skill's guidance (not by CI — see Non-Goals):

- **Labels** (org- or repo-level, colored): `type/bug`, `type/feature`, `type/tech-debt`,
  `type/chore`; `priority/p1`–`p3`; `status/blocked`, `status/needs-spec`. `status/needs-spec` is
  the explicit bridge marker: this item is big enough to require the SDD lifecycle before
  implementation.
- **Issue template** at `.forgejo/issue_template/backlog-item.yaml` (YAML form): context, acceptance
  criteria, affected component(s), discovered-during. Keeps human- and agent-filed issues
  structurally identical (G3).
- **Milestones** map to feature numbers (`NNN-slug`) when a backlog item belongs to a planned
  feature; unmilestoned issues are the free backlog.
- **Dependencies** encode ordering (`blocked-by`) so `list --ready`-style queries (open, unblocked,
  by priority) give the agent the same "what can I work on next" answer Beads' `bd ready` would have.

### 3.4 Spec-kit integration — repair `speckit-taskstoissues`

The existing skill refuses to run unless `remote.origin.url` is a GitHub URL and then requires the
GitHub MCP server — both dead ends on this repo. It is rewritten to: verify the remote matches the
forge (same derivation as `backlog.mjs`), then create one dependency-ordered issue per task via the
API, labeled and milestoned to the feature. The GitHub-gate CAUTION is retained in spirit —
**issues are only ever created on the repo the remote points at.** This makes the optional
tasks→issues fan-out real, but the primary flow stays: backlog issues are *inputs* to
`/speckit-specify`, and small items (`type/chore`, small `type/bug`) may be implemented directly
where the SDD gate permits.

---

## 4. Functional Requirements

- **FR-001** — The agent can create, read, update, close, comment on, label, and dependency-link
  issues on the repo from inside the dev container, via `scripts/backlog.mjs` and/or direct API
  calls as documented in the skill.
- **FR-002** — No issue operation creates a commit, branch, PR, or CI run.
- **FR-003** — Write auth uses a dedicated token (`write:issue` + `read:repository`) minted on a
  bot account with collaborator access to this repo only, delivered as `MCM_FORGE_ISSUE_TOKEN` via
  the devcontainer `${localEnv}` passthrough. No token literal enters git.
- **FR-004** — With `MCM_FORGE_ISSUE_TOKEN` unset, the tooling degrades to read-only via
  `MCM_FORGE_TOKEN` and states that writes are unavailable and why. The container comes up
  regardless.
- **FR-005** — On any 401/403, tooling names the token and missing scope; it never silently
  degrades or retries.
- **FR-006** — All tooling output rewrites the forge host literal to `<forge>`; neither the skill,
  the script, the template, nor this PRD carries the literal. Base URL derives from
  `FORGE_REGISTRY_HOST`; owner/repo derive from the git remote.
- **FR-007** — Issue listing always sends `type=issues` and always paginates with `page`+`limit`
  together; totals come from `x-total-count`, never from response length.
- **FR-008** — Issue bodies and comments are passed via file/stdin, never argv.
- **FR-009** — Close is implemented as `PATCH` with `{"state":"closed"}`; the tooling surfaces the
  blocked-issue-cannot-close error distinctly (unblock first, or override consciously).
- **FR-010** — The skill documents the decision rules: when to file, when to close, the label
  taxonomy, the `status/needs-spec` bridge to the SDD lifecycle, and the quirk list.
- **FR-011** — A YAML issue template exists so human- and agent-filed issues share structure.
- **FR-012** — `speckit-taskstoissues` operates against the Forgejo remote and refuses to create
  issues on any repo other than the one the remote points at.
- **FR-013** — A ready-work query exists (open + unblocked + priority-sorted) as a single command.

### 4.1 Non-Functional

- **NFR-001** — Issue payloads are small (KB-scale) and the §4.1 link budget from
  PRD-CISelfServeDiagnostics (~135 KB/s tailnet) makes any single correctly-paginated issue read
  sub-second; no caching layer is in scope. The one measured hazard — `limit` ignored without
  `page` — is prevented by FR-007.
- **NFR-002** — The skill's context cost stays in the ~1–2k token range; anything that would grow it
  beyond that (exhaustive endpoint reference, long examples) belongs in the script's `--help` or the
  runbook instead.

---

## 5. Testing Strategy

Per the constitution's TDD gate, `backlog.mjs`'s pure parts are unit-testable in
`scripts/__tests__/`:

- URL/repo derivation from remote URL shapes (ssh, http, with/without `.git`).
- Host-literal redaction on every output path (FR-006).
- Pagination assembly — `page`+`limit` always paired; `x-total-count` honored (FR-007).
- Scope-failure surfacing: 401/403 → named token + scope (FR-005) — regression-testing a diagnostic
  cost already paid once.
- Read-only degradation when the write token is absent (FR-004).
- Close-of-blocked-issue error surfacing (FR-009).

Live verification (one-time, against the real forge, mirroring the §3.4 probe discipline of
PRD-CISelfServeDiagnostics):

1. Mint the bot token; verify `POST issues` 201, `PATCH` close 200, `POST comments` 201,
   dependencies add/remove — and verify the same calls **403 under `MCM_FORGE_TOKEN`** (proving the
   scope split is real).
2. Probe the issues endpoints' query-parameter behavior (`limit`-alone, `type`, `labels`, `q`,
   `milestones`) and record observed behavior in the skill — the `actions/runs` measurements do not
   transfer on faith.
3. **Acceptance exercise:** import the Notepad backlog conversationally — the agent files every item
   as a labeled, prioritized issue; the operator reviews the result in the Forgejo UI. This
   simultaneously migrates the backlog and proves G1–G3 end-to-end.

---

## 6. Open Questions for Planning

- **OQ-1 — Bot permission granularity.** If the repo owner is an organization, a team grant can
  scope the bot to the issues unit only (code: none); if a user-owned repo, collaborator access is
  coarser. Decide at bot creation; the token scope (`write:issue`) bounds capability either way.
- **OQ-2 — Label taxonomy final form.** §3.3 is a starting set; calibrate against the actual
  Notepad backlog during the acceptance exercise rather than on paper.
- **OQ-3 — `tea` CLI as an operator convenience.** The official Gitea CLI works against Forgejo and
  could be baked into the toolchain image for human use at the container shell. Nice-to-have; not
  load-bearing for any FR.
- **OQ-4 — Nx target.** Whether `backlog.mjs` gets an Nx target or stays a direct `node scripts/…`
  invocation like `ci-status.mjs`. Precedent favors the latter.
- **OQ-5 — Issue-reference automation.** Whether commit messages / PR bodies should adopt
  `closes #N` conventions so merges auto-close backlog issues — attractive, but it couples issue
  closure to the merge event, and the skill's explicit-close discipline (verify acceptance criteria,
  then close) may be the better default. Decide during implementation.

---

## 7. Residual Risk (named deliberately)

**The token is account-wide on the forge side.** `write:issue` on the bot covers every repo the bot
can access; the mitigation is the bot's single-collaborator membership, not the token scope. If the
bot is ever added to a second repo, the blast radius grows silently. The runbook must state this at
the point where adding the bot to a repo would be typed.

**Issue writes are unauditable-by-diff.** Unlike the file-based trackers, issue history lives in
Forgejo's DB, not in git — a bad bulk edit has no `git revert`. Forgejo keeps per-issue edit history
and the restic snapshot bounds worst-case loss at one backup interval, but a mass-close mistake is
tedious to undo. The skill's guidance (no bulk operations without an explicit operator instruction)
is the practical mitigation.

**Projects boards stay manual.** If the operator adopts the kanban UI, board column state is
invisible to the agent until the upstream Projects API lands (~v16). Labels are the shared truth;
treating the board as authoritative would silently fork the state. The skill says so.

---

## 8. Documentation Impact

- **New:** `.claude/skills/forgejo-issues/SKILL.md` (the skill is itself documentation).
- **New:** bot-account + token provisioning steps (scopes, `setx`, the quit-VS-Code gotcha) in
  `docs/runbooks/dev-environment-setup.md` or a short new `docs/runbooks/backlog.md`; the token
  value never committed.
- **Changed:** `.devcontainer/devcontainer.json` — the new `containerEnv` passthrough with house-style
  comment; `docs/runbooks/devcontainer.md` env-var table gains a row.
- **Changed:** `.claude/skills/speckit-taskstoissues/SKILL.md` — rewritten per §3.4.
- **Changed:** the openwiki bundle gains a concept for the backlog workflow (per
  `openwiki/INSTRUCTIONS.md` placement rules) once the feature lands.
- **Process note:** this PRD is the proposal artifact; implementation code under `scripts/` and
  devcontainer changes go through the SDD gate as a numbered `specs/NNN-*` spec → plan → tasks set.
