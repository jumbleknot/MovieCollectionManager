# Contract: `scripts/cc-usage.mjs` command line

Zero runtime dependencies (Node built-ins and the global `fetch` only), in the style of
`scripts/backlog.mjs`. Argument parsing goes through `scripts/lib/argv-contract.mjs`, so an unknown flag
is an **error**, never silently ignored (AGENTS.md "check the instrument").

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `MCM_USAGE_INGEST_URL` | no | Base URL of the store's HTTP interface (tailnet) |
| `MCM_USAGE_TOKEN_URL` | no | Keycloak realm token endpoint (tailnet) |
| `MCM_USAGE_CLIENT_SECRET` | no | Secret of client `dev-usage-capture`. Read from the environment only, sent only in the token request body, never logged, never in argv |
| `CLAUDE_CONFIG_DIR` | no | Defaults to `~/.claude` |
| `CC_USAGE_SHIP_INTERVAL_S` | no | Default `900` (FR-011). Tests lower it |

Any of the first three unset → **not configured**: hooks parse nothing and spool nothing (the transcripts stay
the source; the first sweep after configuration catches up), and `doctor` reports `not configured`.

## `hook` (invoked by Claude Code only)

```text
node scripts/cc-usage.mjs hook        # event JSON on stdin
```

Stdin fields read: `hook_event_name` (`SessionStart` | `Stop` | `SessionEnd`), `session_id`,
`transcript_path`, `cwd`, `reason` (SessionEnd). Unknown fields ignored.

| Event | Behaviour |
| --- | --- |
| `SessionStart` | Write the by-cwd marker. If the sweep lock is free and the last sweep was more than 15 min ago: sweep every `projects/*/` transcript with unshipped bytes, batch by batch. Flush the spool. |
| `Stop` | If the last ship of this session was less than `CC_USAGE_SHIP_INTERVAL_S` ago: **exit** with no parsing and no network. Otherwise ship this session's new bytes. |
| `SessionEnd` | Ship this session's tail, record `end_reason`, collect outcomes for each feature the session's turns touched, if due and if at least 3 s of the hook timeout remain (otherwise the next sweep collects them). A run killed by the timeout loses nothing: offsets advance only after a confirmed send, so the next sweep re-derives the unsent range. |

**Invariants** (each has a guard test):

- Exit code is **always 0**. Stdout is **always empty** (SessionStart stdout would enter Claude's context).
- Stderr is empty on every expected path; unexpected errors go to `cc-usage.log`, not stderr.
- Network calls (token endpoint and store): connect timeout 2 s, total 5 s; any failure writes `backoff` and spools the batch, within the 50 MB spool cap (data-model.md "Local state").

## Interactive commands (invoked by the `usage` skill or a human)

| Command | Output (default: fixed-width, ≤ 10 rows; `--json` for full) | Network |
| --- | --- | --- |
| `now --session <id>` | Tokens by type, context now, top 5 tool outputs by bytes, subagent share; the median of recent sessions when reachable, narrowed to the same activity once labels exist (US3) | Optional GET |
| `sessions [--since 7d] [--feature f] [--branch b] [--spec n] [--activity a] [--area x]` | One row per session; with a feature filter, the session's tokens **attributed to that feature** beside its total | GET |
| `feature <branch\|spec:NNN\|feature_id> [--all]` | One feature: kind, spec, PR state, contributing sessions (count and list), turns, tokens by type, main vs subagent, weighted, activity mix, outcomes (`tasks: n/a` for a feature without a task list). A branch with several features (reused name) shows the open one; `--all` lists them all | GET |
| `features [--since 30d] [--kind spec\|no-spec] [--state open\|merged\|all]` | One row per feature, plus a final `no feature` row | GET |
| `trend --by week\|area\|activity\|feature\|spec [--since 8w]` | One row per bucket (`activity`, `feature`, `spec` from US3) | GET |
| `compare <a> <b>` | Side by side; `a`/`b` are session ids, feature ids, `branch:<name>`, `spec:NNN`, or `YYYY-MM-DD..YYYY-MM-DD` | GET |
| `findings [--all]` | Open findings with rule, evidence, sample size, suggestion, watch metric; `not enough data` below thresholds | GET |
| `accept <finding_id>` / `reject <finding_id>` | Confirms the status change | PATCH |
| `sync --session <id>` | Ships this session now, ignoring the interval, resets the timer | POST |
| `tag --session <id> <label>` | Confirms | PATCH |
| `doctor` | Last successful ship, spool depth and any spool drops, back-off state, token state (`valid until …` / `client credential rejected` / `store rejects token`), transcripts with unshipped bytes, `configured` yes/no | Optional GET |
| `statusline` | Opt-in. Reads statusline JSON on stdin, stores `rate_limits` locally, then execs the command in `CC_USAGE_STATUSLINE_NEXT` and prints its output | none |
| `oracle-check` | Compares parser totals on the fixtures with the committed ccusage oracle; exit 1 on any mismatch | none |

Rules shared by every interactive command:

- `--session` is **required** where listed; the command never picks the newest transcript (FR-019).
- Store unreachable → history commands print exactly one line, `usage history: store unreachable (spooled N)`, and exit 0; `now` still answers from local state (FR-020).
- Host names are redacted from every output line (FR-021), as `backlog.mjs` does.
- Exit codes: `0` success or degraded answer, `2` usage error (unknown flag, missing `--session`).
