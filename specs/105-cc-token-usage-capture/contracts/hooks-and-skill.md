# Contract: committed hooks and the `usage` skill

## `.claude/settings.json` — `hooks` block added beside the existing plugin keys

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "async": true,
      "command": "node \"$CLAUDE_PROJECT_DIR/scripts/cc-usage.mjs\" hook" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "async": true,
      "command": "node \"$CLAUDE_PROJECT_DIR/scripts/cc-usage.mjs\" hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "timeout": 10,
      "command": "node \"$CLAUDE_PROJECT_DIR/scripts/cc-usage.mjs\" hook" }] }]
  }
}
```

A guard test pins: the three events are present; each command is exactly the line above; no hook
writes stdout; the existing `extraKnownMarketplaces` and `enabledPlugins` keys are unchanged.
Key spellings `async` and `timeout` were confirmed against the installed 2.1.327 by T001
(research "Spike results" (b)). The project hooks merge with the user-level RTK `PreToolUse` hook
(Spike results (d)), and `$CLAUDE_PROJECT_DIR` is the session's own checkout, so a worktree session runs
that worktree's script (Spike results (c)).

## `.claude/skills/usage/SKILL.md`

- Frontmatter: `name: usage`, a one-line description naming the questions it answers, user-invocable.
- Body (≤ 60 lines): when to run which command; always pass `--session ${CLAUDE_SESSION_ID}` (substituted
  in a project skill body — research "Spike results" (g)); never
  run `sync` unless the user asked; how to read sample sizes (below the rule minimum, say so and stop);
  `findings` → read the repository files the evidence points at, then propose one change with its
  expected effect and the metric to watch; accepted changes go through `accept`, larger ones may be
  filed with the `forgejo-issues` skill.
- It is loaded only on invocation, so it adds nothing to an uninvoked session (FR-022).
