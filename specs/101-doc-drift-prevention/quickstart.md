# Quickstart: validating doc-drift prevention

Run from the worktree root.

## 1. The guard passes on the tree

```bash
node scripts/check-speckit-overrides.mjs --selftest   # expect: exit 0
node scripts/check-speckit-overrides.mjs              # expect: ✓ … exit 0
node --test scripts/__tests__/check-speckit-overrides.test.mjs   # expect: fail 0, skipped 0
```

## 2. Verify RED → GREEN on a core-template change (SC-002, shown in the PR)

```bash
echo "<!-- upstream change -->" >> .specify/templates/tasks-template.md
node scripts/check-speckit-overrides.mjs; echo "exit=$?"
#   expect: ✗ core-changed … names both files, prints the diff, exit=1     (Verify RED)
node scripts/check-speckit-overrides.mjs --record
node scripts/check-speckit-overrides.mjs; echo "exit=$?"
#   expect: ✓ … exit=0                                                       (Verify GREEN)
git checkout -- .specify/templates/tasks-template.md .specify/templates/overrides/tasks-template.md
```

## 3. Task generation resolves the override (shown in the PR)

```bash
pwsh -NoProfile .specify/scripts/powershell/setup-tasks.ps1 -Json
#   expect: TASKS_TEMPLATE ends in .specify/templates/overrides/tasks-template.md
```

Then run `/speckit-tasks` for a scratch feature dir (a throwaway `specs/999-scratch/` with a stub
spec.md and plan.md, never committed). Confirm the generated `tasks.md` contains a
`**Doc-impact sweep**` task with recorded search terms, and no `Documentation updates in docs/` line.

## 4. Unknown arguments are refused

```bash
node scripts/check-speckit-overrides.mjs --recrod; echo "exit=$?"   # expect: usage, exit=2, header unchanged
```

## 5. Docs and wiki gates

```bash
node scripts/wiki-refresh.mjs --stale        # expect: empty
node scripts/check-openwiki-okf.mjs          # expect: ✅
node scripts/check-openwiki-governance.mjs   # expect: ✅
```
