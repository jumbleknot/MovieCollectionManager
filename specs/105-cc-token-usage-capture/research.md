# Research: Claude Code token usage capture (feature 105)

Phase 0 of the plan. Where the proposal listed an assumption "to verify in phase 0", this file records
what was **measured in the dev container on 2026-11-21** (Claude Code 2.1.327, VS Code entry point) or
states plainly that it is still unverified and which task verifies it. Probes printed key names, type
tags and counts only — no transcript content was read or recorded.

## R1. What a transcript line carries

**Measured** over the 8 most recent main-session transcripts (4,170 lines, 0 unparseable):

- Every `assistant` line carries `message.id`, `message.model`, `message.usage`, `requestId`,
  `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain`, and — when a
  skill is active — `attributionSkill`.
- `message.usage` holds `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, plus `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
  `output_tokens_details.thinking_tokens`, `server_tool_use.{web_search_requests, web_fetch_requests}`,
  `service_tier`, `speed`.
- `user` lines carry `promptId`, `origin` (`{kind: "human"}` for a typed prompt, `task-notification`
  for a background-agent wake-up), `permissionMode`, `isMeta`, `isCompactSummary`, and on tool results
  a `toolUseResult` object whose keys include `persistedOutputSize`, `interrupted`, `agentId`,
  `agentType`, `toolsUsed`.
- `system` lines with `subtype: "compact_boundary"` carry `compactMetadata.{trigger, preTokens,
  postTokens, durationMs}`; `subtype: "stop_hook_summary"` carries `hookInfos[].{command, durationMs}`.
- Other line types (`api-request`, `api-request-blob`, `file-history-*`, `data-flow-*`, `ai-title`,
  `last-prompt`, `queue-operation`, `session-owner`, …) are present and are **ignored** by the parser.

**Decision**: parse `assistant` (usage, model, skill, tool_use names), `user` (turn boundaries, tool
result sizes), and `system` (compactions). Treat any other type as ignorable; treat an `assistant`
line without `message.usage` or `message.id` as a **format drift** signal that downgrades the session
to `partial` (FR-005).

**Rationale**: these are the only fields the spec's entities need, and narrowing the read set narrows
the drift surface.

## R2. Duplicate assistant lines

**Measured**: 1,022 of 2,046 usage-bearing assistant lines repeat a `message.id` already seen in the
same file (one line per content block of a streamed response). In **every** duplicate the four token
counts were identical to the first occurrence (0 differing).

**Decision**: one model call = one `message.id` (with `requestId` kept for diagnostics). Usage is taken
once per `message.id`; the store's natural key is `(session_id, message_id)` and writes are upserts.

**Alternatives considered**: summing every line (doubles totals — the classic ccusage-style bug);
keying on `requestId` alone (equivalent here, but `message.id` is what the reference tool keys on).

## R3. Where subagent activity lives

**Measured**: subagents are **separate files**, not inline entries:
`projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json`
(`agentType`, `toolUseId`, `spawnDepth`, `requestShape`, `finished`, and a free-text `description`).
Their lines carry `isSidechain: true`, `agentId`, `attributionAgent`. Across the volume there were 27
meta files but only 19 transcripts — **some subagents leave no transcript**.

**Decision**: the parser attributes a subagent file to its parent session by directory, and to the
parent turn by matching `meta.toolUseId` to the `tool_use` block that spawned it. A meta file with no
transcript marks the session `partial` with reason `subagent-transcript-missing`. The meta
`description` is free text and is **never** shipped (FR-012).

## R4. Worktree sessions write to their own project directory

**Measured**: `~/.claude/projects/` holds one directory per working directory, e.g.
`-workspaces-mcm` and `-home-coder-worktrees-<slug>`.

**Decision**: the catch-up sweep enumerates **every** directory under `$CLAUDE_CONFIG_DIR/projects/`,
not only the current project's. The worktree name is taken from the line's `cwd`, the branch from
`gitBranch`.

## R5. Transcript volume and retention

**Measured**: 172 MB across all project directories; no single transcript over 20 MB; the oldest
main-session transcript is dated 2026-11-04 (17 days), so the volume holds less than the 30-day
default retention (a recreate or manual prune happened earlier).

**Decision**: first backfill is bounded (~170 MB), processed one file at a time, offset-resumable, so
an interrupted sweep continues where it stopped. No change to `cleanupPeriodDays`: the homelab copy
is the durable one (FR-013).

## R6. Lifecycle triggers

**Measured**: the installed binary contains `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`,
`async`, `transcript_path` and `CLAUDE_PROJECT_DIR` handling. An existing plugin `Stop` hook
(`langsmith-tracing`) runs at **p50 90 ms, max 640 ms** over 235 turns — a direct precedent for the
per-turn cost budget (SC-005).

**Decision**: three command hooks in the committed `.claude/settings.json` — `SessionStart` (async),
`Stop` (async), `SessionEnd` (short timeout) — all invoking `node "$CLAUDE_PROJECT_DIR/scripts/cc-usage.mjs" hook`.
The hook reads the event from stdin (`hook_event_name`, `session_id`, `transcript_path`, `cwd`,
`reason`) and never trusts the newest-file heuristic (FR-019).

**Still unverified → task T-spike** (first implementation task, before any test is written):
`SessionEnd` behaviour when the VM idle-stops; `Stop` on an interrupted turn; `$CLAUDE_PROJECT_DIR`
resolving to the worktree in a worktree session; that project hooks merge with the user-level RTK
`PreToolUse` hook rather than replacing it. The design does not depend on any of these: the
`SessionStart` sweep is the backstop for every missed trigger.

## R7. Session identity inside the skill

**Measured**: `CLAUDE_SESSION_ID` appears in the binary (substitution support present).
**Still unverified → T-spike**: that `${CLAUDE_SESSION_ID}` is substituted in a *project* skill body.
**Fallback if not**: the skill instructs Claude to pass the session id it can read from the hook-written
marker `~/.claude/usage/state/by-cwd/<hash(cwd)>.json` **only when exactly one live session matches the
cwd**, otherwise to ask — never to guess (FR-019).

## R8. The reference tool for FR-017

**Decision**: ccusage, pinned to an exact version, run with `pnpm dlx` **only** by an on-demand Nx
target that regenerates `scripts/__tests__/fixtures/cc-usage/ccusage-oracle.json` from the fixture
transcripts. CI compares the parser's per-session totals with that committed oracle.

**Rationale**: a per-run `npx`/`dlx` fetch in CI would add an unpinned network dependency to the
guardrail job; adding ccusage to the workspace lockfile drags a transitive tree into every install for
a test-only oracle. A committed oracle is deterministic and its regeneration is reviewable.

**Alternatives considered**: devDependency in the root lockfile (rejected: install-surface cost);
hand-computed expected totals (rejected: then it is not an *independent* reference).

## R9. Fixtures

**Decision**: fixture transcripts are **synthetic**, hand-written to the R1–R3 shapes (including
duplicate streamed lines, a compaction, a subagent file with and without transcript, a malformed line,
a skill-attributed turn, an unknown line type). Real transcripts are never committed: they contain
prompts, tool output and account identifiers.

## R10. Store, interface and credential

**Decision**: a new Komodo stack `prod-dev-usage` with two upstream images — Postgres 18 and PostgREST
— on the homelab. PostgREST publishes **19040** (reserved range, unused today: 19002, 19030, 19099 are
taken), tailnet-only by host firewall like the other three. Requests carry a long-lived HS256 JWT whose
`role` claim maps to `usage_writer`: `INSERT, UPDATE, SELECT` on the `usage` schema, **no** `DELETE`,
no `TRUNCATE`, no DDL. Session totals are views over per-message rows, never counters (FR-008).

**Rationale**: upstream images only → no CI image build; views serve the skill and Grafana alike;
plain HTTP from Node's built-in `fetch` → no driver in the container (proposal, confirmed in clarify).

**Alternatives considered**: LangFuse (rejected in clarify); a direct Postgres connection from the
container (needs a driver dependency and a second egress shape); Keycloak-issued tokens (see plan
Complexity Tracking).

## R11. Configuration path into the container

**Measured**: credentials reach the sandbox container via `.devcontainer/gen-container-secrets-env.sh`
(`VARS=…` list → `--env-file`), and non-secret hosts such as `FORGE_REGISTRY_HOST` via `containerEnv`
`${localEnv:…}`.

**Decision**: `MCM_USAGE_INGEST_TOKEN` joins the `VARS` list (secret path); `MCM_USAGE_INGEST_URL`
joins `containerEnv` as `${localEnv:MCM_USAGE_INGEST_URL}` in both dev container configs (a tailnet URL
is topology, not a secret, but must still never be committed — FR-015). Unset either → capture spools
locally and `doctor` says "not configured"; it never fails.

## R12. Egress

**Measured**: `scripts/gen-egress-policy.mjs` already injects the forge host at runtime via
`--forge-host` and rejects any tailnet host committed to `egress-allowlist.json`.

**Decision**: no allowlist file change. If the ingest host equals the forge host the existing rule
covers it; if the sandbox policy is per host *and* port, the operator adds the port with
`sbx policy allow network` (runbook step). **T-spike** records which applies.

## R13. Repository gates the new stack must satisfy

**Measured** by reading the gates:

| Gate | Effect on this feature |
| --- | --- |
| `scripts/check-resource-naming.mjs` | Volume and identifier regexes have no `dev-usage` context → **update the gate** to admit `dev-usage` (the rule stays; its premise changes) |
| `scripts/check-prod-restart-policy.mjs` | Every service in a `compose.prod.yaml` needs `restart: always` |
| `scripts/check-prod-ci-port-collision.mjs` | 19040 must not collide with a CI/dev port |
| `okf` V17 | `openwiki/invariants/published-port-reservation.md` states "those three ports are the only published ports" → refresh in the same PR |
| CI `node --test scripts/__tests__/*.test.mjs` | New unit and guard tests are picked up by the glob with no wiring |

## R14. Plan-limit figures (FR-033)

**Measured**: `rate_limits` appears in the binary (statusline input). **Decision**: an **opt-in**
statusline wrapper (`cc-usage.mjs statusline`) records the latest `rate_limits` snapshot to local state
and prints whatever the user's existing statusline command prints, so it never displaces a personal
statusline. Not enabled in committed settings. Per-activity limit burn is derived from successive
snapshots. **T-spike** confirms the field is populated on this plan.

## R15. Outcomes

**Decision**: per feature, computed in the container (where git and the worktrees live) at
`SessionEnd` and during sweeps, at most once per 15 minutes per feature: commits and lines from
`git log origin/main..<branch>` (the PR's merge range once merged), PR state and CI runs from the forge
API through the existing `scripts/lib/forge-credential.mjs` read path, backlog items closed via the
same API. Tasks checked come from the feature's `tasks.md` **only when the feature has a spec**;
otherwise they are null ("not applicable"). Upserted on `feature_id`.

## R16. The transcript branch is the start directory's, not the work's

**Measured**: this planning session (main checkout, all work done in the 105 worktree) records
`gitBranch: main` and `cwd: /workspaces/mcm` on all 236 of its lines. AGENTS.md makes that the normal
pattern: sessions in the shared checkout drive worktrees, and Forge-API work needs no worktree at all.

**Decision**: attribute **turns**, not sessions, to features, from the worktree the turn's path-bearing
tool calls resolve to (data-model.md, Feature attribution). `gitBranch` is the fallback, not the source.
Feature totals are sums over turns, so a session split across two features divides exactly and the
conservation invariant (features + no-feature = sessions) holds.

**Alternatives considered**: session-level branch (misattributes exactly the sessions this repository
produces most); asking the user to tag sessions (a manual step, against FR-001).

## R17. Which branches are features, and reused names

**Decision**: every non-main branch with attributed turns is a feature; `kind` is `spec` or `no-spec`
(clarification 2026-11-21). The spec link comes from the worktree's `.specify/feature.json` first,
because branch names and spec directories are independent (spec 104's branch is
`fix/agent-billing-envelope`), then a matching `specs/*` directory, then an `NNN-` prefix.

Reused names (`renovate/uv-pin` recurs; a `fix/` name can come back) are kept apart by the identity
rule in data-model.md: a turn joins the branch's **open** feature; after its PR merges, the next turn
opens a new `branch@<date>` feature.

**Residual risk**: two sessions that first see the same new branch on different days, both offline
from the store, would mint two ids. The sweep reconciles: when it finds two open features on one
branch with no PR between them, it re-points the later one's turns to the earlier id (an upsert on
`turns`, which the role permits) and marks the later row `closed`. A guard test covers it.
