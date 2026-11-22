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
- "Is usage going up?" — `node scripts/cc-usage.mjs trend --by week` (or `--by area`)
- "How did A compare with B?" — two session ids or date ranges `YYYY-MM-DD..YYYY-MM-DD`:
  `node scripts/cc-usage.mjs compare <a> <b>`
- Label a session for later comparison:
  `node scripts/cc-usage.mjs tag --session ${CLAUDE_SESSION_ID} <label>`
- Add `--json` for every row; tables stop at 10 rows.

## Rules

- Pass `--session ${CLAUDE_SESSION_ID}` wherever a command takes it. Never guess a session from the
  newest transcript: several sessions run at once.
- Run `sync` only when the user asks for it (it ships this session at once, outside the 15-minute
  interval): `node scripts/cc-usage.mjs sync --session ${CLAUDE_SESSION_ID}`.
- `usage history: store unreachable (spooled N)` means the store did not answer. Say so; `now` still
  answers from local state. Do not retry in a loop.
- Read sample sizes: a median over fewer than 5 sessions is not a trend. Say how many sessions an
  answer rests on.
- Report what the numbers say and stop. Do not change settings or code to "fix" usage unless asked.
- If a command errors or `doctor` shows `configured: no`, point to docs/runbooks/dev-usage.md §4.
