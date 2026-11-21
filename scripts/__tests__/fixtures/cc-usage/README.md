# cc-usage fixtures (feature 105)

Synthetic Claude Code transcripts, laid out as a `CLAUDE_CONFIG_DIR`, for the `cc-usage` tests.
Nothing here comes from a real transcript (research R9): every content-bearing field holds a
`SENTINEL-<field>-<n>` string, which the privacy guard proves never reaches a shipped batch.

Regenerate with `node scripts/__tests__/fixtures/cc-usage/generate-fixtures.mjs`, then refresh the
oracle with `pnpm nx cc-usage-oracle infrastructure-as-code` and review both diffs.

| File | Exercises |
| --- | --- |
| `projects/-workspaces-mcm/11111111-….jsonl` (session A) | Main-checkout session: two human turns and one task-notification wake-up; a streamed response written as two lines with identical usage (`msg_A1`, research R2); the 5m/1h cache-write split; a `compact_boundary`; turns attributed to the `speckit-plan` skill (`attributionSkill`); Bash `pnpm`, `git`, `rtk git` and a `VAR=<url> curl …` command whose family must be `curl`; an Edit under `docs/`; one file read four times (a re-read); an `Agent` call with `persistedOutputSize`; an unknown line type (`queue-operation`); one malformed line |
| `projects/-workspaces-mcm/11111111-…/subagents/agent-x.jsonl` + `agent-x.meta.json` | A subagent transcript attributed to its parent turn through `meta.toolUseId = toolu_A4` |
| `projects/-workspaces-mcm/11111111-…/subagents/agent-y.meta.json` | A subagent meta file with **no** transcript → session A is `partial` (`subagent-transcript-missing`) |
| `projects/-workspaces-mcm/44444444-…/subagents/agent-z.meta.json` (session D) | A session known only from a subagent meta file, with no main transcript → `not_captured`, never zero totals |
| `projects/-home-coder-worktrees-feat-a/22222222-….jsonl` (session B) | A worktree session on `feat-a`: an Edit under `frontend/`; an assistant line **without** usage → `partial` (`format-drift`); an unknown line type (`ai-title`) |
| `projects/-workspaces-mcm/33333333-….jsonl` (session C) | A main-checkout session (`gitBranch: main`) that works in worktree `feat-a`, then `docs-b`; a path-less turn (`node scripts/forge-pr.mjs open`) that inherits `docs-b`; a turn with no tool call; a turn reading two worktrees where the majority (`feat-a`) wins |
| `worktrees.json` | The fake worktrees' branches and `.specify/feature.json` (`docs-b` → `specs/107-docs-b`) |
| `ccusage-oracle.json` | Per-session totals from the pinned reference tool (written by the `cc-usage-oracle` target, research R8) |
| `generate-fixtures.mjs` | The generator for everything above except the oracle |
