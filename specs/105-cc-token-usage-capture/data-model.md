# Data model: Claude Code token usage (feature 105)

All tables live in one schema, `usage`, in the dedicated store (research R10). The capture credential's
role `usage_writer` has `INSERT, UPDATE, SELECT` on every table and `SELECT` on every view; it has no
`DELETE`, `TRUNCATE` or DDL right (FR-014). Every write is an upsert on the natural key below, so
re-shipping is harmless (FR-008). **Totals are never stored as counters**: session- and turn-level
sums are views over `model_calls`.

No column holds prompt text, assistant text, tool output, file contents, file paths, command arguments,
or a subagent's free-text description (FR-003, FR-012). The privacy guard test asserts this over every
record the parser emits.

## Tables

### `sessions` — one row per Claude Code session

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | uuid PK | From the transcript, never inferred |
| `project_dir` | text | The `projects/` directory name, e.g. `-home-coder-worktrees-105-…` (no host path) |
| `starting_worktree` | text | Last path segment of the session's `cwd` |
| `starting_branch` | text | `gitBranch` of the transcript — the branch of the directory the session was started in, **not** necessarily the branch it worked on (research R16) |
| `entrypoint` | text | e.g. `claude-vscode`, `cli` |
| `cc_version` | text | |
| `started_at`, `ended_at` | timestamptz | `ended_at` null until `SessionEnd` or inferred by a later sweep |
| `end_reason` | text null | From `SessionEnd`, or `inferred-stale` when swept after no end |
| `compactions` | int | Count of `compact_boundary` lines |
| `capture_status` | enum `complete` \| `partial` \| `not_captured` | See state machine |
| `partial_reasons` | text[] | e.g. `subagent-transcript-missing`, `format-drift`, `no-session-end` |
| `manual_tag` | text null | `usage tag`; nothing depends on it |
| `parser_version` | int | Bumped when parsing or labelling rules change |
| `shipped_at` | timestamptz | Last upsert |

### `model_calls` — one row per model call (the atom)

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | uuid FK | |
| `message_id` | text | PK with `session_id` (research R2) |
| `request_id` | text | Diagnostics |
| `turn_seq` | int | Turn this call belongs to |
| `agent_id` | text null | Null for the main thread; subagent id otherwise |
| `ts` | timestamptz | |
| `model` | text | |
| `input_tokens`, `output_tokens`, `cache_read_tokens` | bigint | |
| `cache_write_5m_tokens`, `cache_write_1h_tokens` | bigint | Split from `cache_creation` (research R1); their sum equals `cache_creation_input_tokens` |
| `thinking_tokens` | bigint null | |
| `skill` | text null | `attributionSkill` |

A model call carries no feature of its own: it takes its turn's `feature_id`, so a call is never counted
toward two features.

### `turns` — one row per user prompt and the work it triggered

| Column | Type | Notes |
| --- | --- | --- |
| `session_id`, `turn_seq` | PK | `turn_seq` increments on a `user` line with `origin.kind = human` (or a task-notification wake-up, flagged) |
| `origin` | enum `human` \| `task_notification` \| `other` | |
| `started_at`, `ended_at` | timestamptz | |
| `idle_gap_s` | int | Seconds since previous turn ended |
| `context_tokens_at_start` | bigint | input + cache read + cache write of the first call |
| `activity` | text | One label (see Labelling), or `unclassified` |
| `activity_rule` | text | The rule id that fired, for auditing rules |
| `feature_id` | text null | FK → `features`; null means "no feature" (main-branch work) |
| `attribution_rule` | enum `worktree` \| `worktree-majority` \| `session-branch` \| `inherited` \| `main` | How `feature_id` was decided (FR-036) |
| `areas` | text[] | Top-level repository areas touched |
| `rereads` | int | Files read more than 3 times in the session, counted in the container; only the count ships |

### `tool_use` — one row per session, turn and tool (and command family)

| Column | Type | Notes |
| --- | --- | --- |
| `session_id`, `turn_seq`, `tool`, `command_family` | PK | `command_family` is the first word of a Bash command (`pnpm`, `git`, `node`); `''` for non-Bash |
| `calls` | int | |
| `result_bytes` | bigint | Sum of result sizes (`persistedOutputSize` or content length; the content itself is never read beyond its length) |
| `rtk_calls` | int | Bash calls whose command was rewritten by RTK |
| `subagent_type` | text null | For `Agent` calls, from `toolUseResult.agentType` |

### `skill_use` — one row per session and skill

`session_id`, `skill` (PK) · `invocations` int · `first_turn` int.

### `features` — one row per piece of work on a branch, with or without a spec

A feature is every non-main branch that work was done on (FR-034). Turns link to it by `feature_id`;
sessions link to it only through their turns, so one session can contribute to several features.

| Column | Type | Notes |
| --- | --- | --- |
| `feature_id` | text PK | `<branch>@<first_seen date>`, fixed for the feature's life (identity rule below) |
| `branch` | text | Not unique: a reused name yields a new feature |
| `first_seen_at` | timestamptz | First attributed turn |
| `kind` | enum `spec` \| `no-spec` | `spec` when `spec_dir` is set |
| `spec_dir` | text null | e.g. `specs/105-cc-token-usage-capture`; from the worktree's `.specify/feature.json`, else a `specs/*` directory matching the branch, else the branch's `NNN-` prefix |
| `spec_number` | int null | Derived from `spec_dir` |
| `commits`, `lines_added`, `lines_removed` | int | `origin/main..branch` while open; the PR's merge range once merged |
| `tasks_total`, `tasks_done` | int null | **Null = not applicable** (no task list), never 0 for a feature without a spec (FR-025) |
| `pr_number` | int null | Adopted when a PR for the branch is opened |
| `pr_state` | enum `none` \| `open` \| `merged` \| `closed` \| `abandoned` | `abandoned`: branch gone with no PR |
| `merged_at` | timestamptz null | Closes the feature to new turns |
| `ci_runs_red`, `ci_runs_green` | int | |
| `first_red_at` | timestamptz null | Starts the rework window |
| `backlog_closed` | int | |
| `collected_at` | timestamptz | Capped at once per 15 min per feature |

**Identity rule (FR-035)**: for a turn on branch `b`, the feature is the row with `branch = b` and
`pr_state` not in (`merged`, `closed`, `abandoned`); if none exists, a new row `b@<today>` is created.
The PR, once found, is recorded on that row (the id does not change, so turns never need re-keying).
After the PR merges, the row is closed and the next turn on `b` creates a new row. The resolution runs
in the container against the store's open-feature list, cached in local state; two sessions resolving
the same new branch at once derive the same `b@<date>` id, so their upserts converge.

### `token_weights` — the dated weight table

`as_of` date PK · `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h` numeric ·
`source` text. Seeded from `scripts/cc-usage-weights.json` by upsert; the latest `as_of` applies.

### `findings` — one row per rule hit; accepted ones are experiments

| Column | Type | Notes |
| --- | --- | --- |
| `finding_id` | text PK | `<rule>:<scope>:<window-start>` — deterministic, so re-running analysis upserts |
| `rule` | text | e.g. `tool-output-weight` |
| `scope` | text | e.g. `bash:pnpm`, `activity:implement` |
| `evidence` | jsonb | Numbers only: metric, baseline median and p90, sample size, contributing session ids |
| `sample_size` | int | |
| `suggestion` | text | Authored by the rule, not by a model |
| `watch_metric`, `counter_metric` | text | Every token metric is paired with a quality metric (FR-031) |
| `status` | enum `open` \| `accepted` \| `rejected` \| `regressed` \| `confirmed` | See state machine |
| `accepted_at` | timestamptz null | Experiment start |
| `baseline_value`, `after_value` | numeric null | |
| `counter_baseline`, `counter_after` | numeric null | |

## Views (read by the skill and the dashboard)

| View | Purpose |
| --- | --- |
| `v_call_weighted` | `model_calls` × latest `token_weights` → `weighted_tokens` per call |
| `v_session_totals` | Per session: tokens by type, main vs subagent, weighted, turns, floor (`context_tokens_at_start` of turn 1) |
| `v_turn_totals` | Per turn: tokens by type, weighted, activity, areas |
| `v_session_activity_mix` | Share of weighted tokens per activity per session |
| `v_baseline` | Per activity: median and p90 of each metric over a trailing window, with `n` |
| `v_feature_totals` | Per feature: sessions contributing, turns, tokens by type, main vs subagent, weighted, activity mix — a `SUM` over `v_turn_totals` grouped by `feature_id`, joined to `features` outcomes (FR-037) |
| `v_no_feature_totals` | The same sums for turns with `feature_id` null |
| `v_feature_efficiency` | Weighted tokens per merged PR (all features), per task done (only where `tasks_total` is not null), rework share (tokens after `first_red_at`), grouped by `kind` for like-with-like comparison (FR-039) |
| `v_weekly_trend` | Week × activity × area × feature × spec aggregates for Grafana |

**Conservation invariant** (SC-010, an integration-test assertion): `SUM(v_feature_totals) +
v_no_feature_totals = SUM(v_session_totals)` for every token type.

## Labelling (FR-023)

Rules are evaluated **in this order** per turn; the first match wins. Each rule has a stable id stored
in `turns.activity_rule`.

| Order | Label | Fires when the turn… |
| --- | --- | --- |
| 1 | `specify` / `clarify` / `plan` / `tasks` / `analyze` | has calls attributed to the matching `speckit-*` skill |
| 2 | `implement` | is attributed to `speckit-implement`, or edits files under `frontend/`, `backend/`, `agents/`, `mcp-servers/` |
| 3 | `test` | runs a Bash command whose family and target match a test tier (`nx test`/`e2e`, `playwright`, `maestro`, `cargo test`, `node --test`) |
| 4 | `ci-diagnosis` | runs `ci-status.mjs` or `ci-failure-digest.mjs` |
| 5 | `infra` | runs `docker`, `compose`, `sbx`, or edits under `.devcontainer/`, `infrastructure-as-code/` |
| 6 | `docs` | edits under `docs/`, `openwiki/`, or is attributed to `wiki-refresh` |
| 7 | `backlog` | runs `backlog.mjs` or is attributed to `forgejo-issues` |
| 8 | `git` | runs only `git` commands or the forge PR script |
| 9 | `explore` | uses only read and search tools |
| 10 | `conversation` | makes no tool call |
| — | `unclassified` | none of the above |

The rules run inside the container because they need command text and file paths, which never ship.
Only the resulting label, rule id and area list leave the container.

## Feature attribution (FR-036)

Per turn, in order; first match wins, and the rule's name is stored in `turns.attribution_rule`:

| Order | Rule | Decides the branch from |
| --- | --- | --- |
| 1 | `worktree` | All tool calls that name a path (Read, Edit, Write, Grep, Glob, and Bash `cd`/`git -C`) resolve to one git worktree → that worktree's current branch |
| 2 | `worktree-majority` | Several worktrees → the one with the most tool calls; ties go to the one touched last |
| 3 | `session-branch` | No path → the transcript's `gitBranch` for that turn |
| 4 | `inherited` | No tool call at all → the previous turn's feature in the same session |
| — | `main` | The decided branch is the main branch → `feature_id` null ("no feature") |

Worktree → branch is resolved in the container (`git -C <worktree> rev-parse --abbrev-ref HEAD`,
cached per worktree in local state for the session). A worktree removed before a sweep falls back to
the branch name recorded in the cache, then to rule 3. Paths are used only for this lookup and are
never shipped.

## State machines

**`sessions.capture_status`**

```text
(new) ── first ship ──▶ partial ── SessionEnd shipped, no drift, all subagent files present ──▶ complete
                          │  ▲
                          │  └── later sweep finds more bytes ── (stays partial until clean end)
                          └── swept > 24 h after last line, no SessionEnd ──▶ partial [no-session-end]
not_captured: a session known only from a subagent meta file or outcome link, with no main transcript
```

A `complete` session reverts to `partial` if a re-parse finds format drift. A gap is never stored as a
zero total.

**`features.pr_state`**

```text
(new: first turn on a non-main branch with no open feature) ── none
none ── PR opened for the branch ──▶ open ── merged ──▶ merged   (closed to new turns)
  │                                     └── closed unmerged ──▶ closed
  └── branch deleted, no PR ──▶ abandoned
```

**`findings.status`**

```text
open ── user accepts ──▶ accepted ── window elapsed, watch improved, counter not worse ──▶ confirmed
  │                         └────── counter-metric worse ──────────────────────────────▶ regressed
  └── user rejects ──▶ rejected
```

## Local state (never shipped)

Under `$CLAUDE_CONFIG_DIR/usage/`, on the persistent volume:

| Path | Content |
| --- | --- |
| `state/<sessionId>.json` | Byte offset per file (main + each subagent), last ship time, incremental summary for `usage now`. Written to a temp name and renamed; an offset never moves backwards. |
| `state/by-cwd/<hash>.json` | Live-session marker for the skill fallback (research R7) |
| `state/worktrees.json` | Worktree → branch cache, and branch → open `feature_id` cache, for attribution |
| `spool/<pid>-<ts>.ndjson` | Unshipped batches; a flusher claims one by renaming to `.claimed-<pid>` and deletes only after a 2xx |
| `locks/sweep.lock` | Sweep lock with a short expiry |
| `backoff` | Timestamp; while fresh, hooks skip the network |
| `ratelimits.json` | Latest statusline `rate_limits` snapshot (opt-in, research R14) |
| `cc-usage.log` | Structured JSON log lines, size-capped and rotated; no tokens, no host names |
