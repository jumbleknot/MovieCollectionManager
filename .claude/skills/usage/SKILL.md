---
name: usage
description: Answer questions about Claude Code token usage — this session so far, recent sessions, trends by week or area, and side-by-side comparisons — from the feature 105 usage store and local transcripts.
compatibility: Needs the dev container's MCM_USAGE_* values for history; `now` works offline
user-invocable: true
---

# Claude Code usage

Counts only: tokens by type, turns, tool names and output sizes. No prompt or tool content is stored
(docs/runbooks/dev-usage.md §1).

## Which command

- "How much has this session used?" — always for THIS session:
  `node scripts/cc-usage.mjs now --session ${CLAUDE_SESSION_ID}`
- "Which sessions used the most this week?" / "on branch X?" / "touching docs?":
  `node scripts/cc-usage.mjs sessions --since 7d [--branch <b>] [--area <dir>]`
- "Is usage going up?" — `node scripts/cc-usage.mjs trend --by week` (or `area`, `activity`,
  `feature`, `spec`)
- "What did feature X cost, and what came of it?" — `node scripts/cc-usage.mjs feature <branch>`
  (or `spec:105`, or a feature id; `--all` for every feature of a reused branch name)
- "Which features cost the most?" — `node scripts/cc-usage.mjs features [--kind spec|no-spec]`;
  the last row is work on main ("no feature")
- Sessions for a feature, spec or kind of work:
  `node scripts/cc-usage.mjs sessions --feature <id>` (or `--spec 105`, `--activity implement`)
- "How did A compare with B?" — session ids, date ranges `YYYY-MM-DD..YYYY-MM-DD`, `branch:<name>`,
  `spec:NNN` or feature ids: `node scripts/cc-usage.mjs compare <a> <b>`
- Label a session for later comparison:
  `node scripts/cc-usage.mjs tag --session ${CLAUDE_SESSION_ID} <label>`
- Add `--json` for every row; tables stop at 10 rows.

## Findings (after two weeks of data)

`node scripts/cc-usage.mjs findings` lists rules that fired against the user's own baseline, or
`not enough data`. For a finding: read the repository files its evidence points at (instruction files
for a session floor, the commands for tool-output weight), then propose ONE change, its expected
effect, and the metric to watch. Only on the user's say-so: `accept <finding_id>` (or `reject`); a
larger change can be filed with the forgejo-issues skill. `findings --all` shows before/after.

## Rules

- Pass `--session ${CLAUDE_SESSION_ID}` wherever a command takes it. Never guess a session from the
  newest transcript: several sessions run at once.
- Run `sync` only when the user asks for it (it ships this session at once, outside the 15-minute
  interval): `node scripts/cc-usage.mjs sync --session ${CLAUDE_SESSION_ID}`.
- `usage history: store unreachable (spooled N)` means the store did not answer. Say so; `now` still
  answers from local state. Do not retry in a loop.
- Read sample sizes: a median over fewer than 5 sessions is not a trend. Say how many sessions an
  answer rests on.
- Compare features of the same kind: a spec feature's `tasks` and a no-spec feature's `tasks: n/a`
  are not comparable per task; per merged PR they are.
- Report what the numbers say and stop. Do not change settings or code to "fix" usage unless asked.
- If a command errors or `doctor` shows `configured: no`, point to docs/runbooks/dev-usage.md §4.
