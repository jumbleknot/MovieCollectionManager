---
name: forgejo-issues
description: The MCM backlog lives in this repository's Forgejo issue tracker. Use when filing, finding, updating or closing backlog items, or when deciding whether work belongs in the backlog rather than in the current change.
compatibility: Requires the dev container (MCM_FORGE_ISSUE_TOKEN for writes)
user-invocable: true
---

# The backlog

`node scripts/backlog.mjs <command>` — full flag reference in `--help`, which also carries the measured
API quirks. This file is only the decisions the tool cannot make for you.

```bash
node scripts/backlog.mjs ready              # what can I work on next?
node scripts/backlog.mjs list --label type/bug --state all
node scripts/backlog.mjs show 144
node scripts/backlog.mjs create --title "…" --body-file /tmp/item.md --label type/bug --label priority/p2
node scripts/backlog.mjs update 144 --state closed
node scripts/backlog.mjs comment 144 --body-file /tmp/note.md
node scripts/backlog.mjs dep 145 --blocked-by 144
```

Bodies come from a file or stdin — never a flag, so nothing lands in shell history. Writes need
`MCM_FORGE_ISSUE_TOKEN`; without it reads still work and writes say so.

## When to file

File when you notice work that is **outside the current change's scope** — a defect you are not fixing
now, tech debt you just paid interest on, a follow-up too large for this branch. Filing is cheap and
losing it is not: before this existed, discovered work died with the session.

Do **not** file: the current change's own steps (that is `tasks.md`), or a vague idea with no acceptance
criteria — write the criteria first, or it cannot ever be closed honestly.

Check for a duplicate first; `create` does this for you and refuses rather than filing a second copy.

## When to close

**When the acceptance criteria in the body are met and verified** — not when the work feels done, and
not because a pull request merged. Closure is an explicit act: verify, then close. If the criteria were
wrong, edit them and say why in a comment before closing.

Never close, edit or relabel an item carrying `status/bot-managed` (today: item #29, Renovate's
Dependency Dashboard — it rewrites its own body on a schedule).

**No bulk operations without an explicit instruction from the operator.** Item history lives in the
forge's database, not in git: there is no `git revert` for a mass close.

## Labels are the machine-readable state

- `type/bug` · `type/feature` · `type/tech-debt` · `type/chore` — exactly one
- `priority/p1`…`p3` — exactly one; p1 = do next
- `status/blocked` — a hint only; the **dependency graph is the authority** and `ready` warns when they disagree
- `status/needs-spec` — **the bridge to SDD**: too large to implement directly, so it needs
  `specs/NNN-*/` spec → plan → tasks first. Apply it rather than starting to code
- `status/bot-managed` — another automation owns this item

Milestones map to feature directories (`NNN-slug`); no milestone is normal — that is the free backlog.

## Backlog items feed the SDD lifecycle, they do not replace it

An item is an **input** to `/speckit-specify`. Small `type/chore` and small `type/bug` items may be
implemented directly where the SDD gate permits; anything larger gets `status/needs-spec` and goes
through the lifecycle. `tasks.md` remains the in-feature decomposition — the backlog is cross-feature.

## Measured traps (do not re-derive these)

Forge `15.0.3+gitea-1.22.0`, measured 2026-08-08. The tool already handles all of these; they are here
because you will read raw API output eventually.

- **An unknown label name in a filter is silently ignored and returns the UNFILTERED set.** A typo reads
  as "matched everything". The tool refuses unknown names locally for exactly this reason. With a *real*
  label the filter is correct and fails closed, and multiple `--label` values are **AND**, not OR.
- **Pull requests are issues internally** — a listing without `type=issues` returns them too (143 rows
  where 1 was correct on this repository).
- **Issue and pull-request numbers share one sequence.** Write "item #144" when you mean a backlog item;
  a bare `#144` is ambiguous. This is also why `closes #N` auto-closing is deliberately not used here.
- **A page caps at 50 rows** (default 30). Totals come from `x-total-count`, never from the row count.
- **Closing a blocked item fails with 412** `cannot close this issue because it still has open
  dependencies`. Unblock first; the tool reports this distinctly from other failures.
- **The dependency endpoint needs `{owner, repo, index}`**, not a bare index — `{index}` alone answers
  404 `IsErrRepoNotExist`, naming the repository rather than the missing fields.
- **The issue form only takes effect from the default branch**, so `validate-form` reports "not
  configured yet" on a feature branch. That is expected, not broken.
- **Projects boards have no API in this build.** Board columns are invisible here; labels are the shared
  truth. Treating the board as authoritative silently forks the state.
- **A 403 is granular scope, not expiry** — the same credential can return 200 elsewhere in the same
  second. The repository payload's `permissions` block is *not* a scope check.

## Two invariants worth stating plainly

No backlog operation ever creates a commit, branch, pull request or CI run — that is the point of the
feature. And every write is refused unless it targets the repository this working copy's origin points
at: the write credential can reach other repositories, so that guard is what keeps writes here.

Details, provisioning and the credential model: `docs/runbooks/backlog.md`.
