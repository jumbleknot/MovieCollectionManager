---
type: Runbook
title: The agent-driven backlog (Forgejo Issues)
description: How the MCM backlog lives in the repository's own Forgejo tracker and is worked by the coding assistant through scripts/backlog.mjs — the credential whose reach is bounded by a client-side write guard rather than by its scope, and the measured API traps that make a filter fail open.
resource: docs/runbooks/backlog.md
tags: [backlog, forgejo, issues, tooling, runbook]
timestamp: 2026-08-08T00:00:00+00:00
---

# The agent-driven backlog (Forgejo Issues)

The backlog is the repository's own Forgejo issue tracker. The operator works it in the web UI; the
coding assistant works it with `scripts/backlog.mjs` from inside the dev container. There is no second
source of truth — `tasks.md` stays the *in-feature* decomposition, the tracker is the *cross-feature*
backlog, and a backlog item is an **input** to `/speckit-specify` rather than a replacement for it.

No backlog operation produces a commit, branch, pull request or CI run: issue changes are HTTP calls, so
a one-line backlog edit costs nothing. Ten labels (`type/*`, `priority/*`, `status/*`) carry the
machine-readable state; milestones map to feature directories (`NNN-slug`); an unmilestoned item is the
free backlog, which is the normal case.

## Gotchas

- **The write credential's reach is account-wide by decision, so the CLIENT-SIDE guard is the bound.**
  `MCM_FORGE_ISSUE_TOKEN` carries `write:issue` + `read:repository` and is deliberately not restricted to
  this repository. Every write therefore asserts that its target owner/repo matches the origin remote and
  refuses otherwise — checked once against any `--repo` value and again at the request boundary, so a
  mis-built path cannot slip through. Comparing the derived slug against itself would be a tautology that
  protects nothing; the guard only means something against a target that came from elsewhere.
- **`permissions` in the repository payload is NOT a scope check.** It reports what the owning *account*
  may do with the repository, not what the token may do — an item-write-only token on an admin account
  reports `admin: true` and still cannot push a commit. No endpoint the token can reach reports its own
  scopes (`/user` → 403, no `read:user`), so the scope split is proven behaviourally: the write sequence
  succeeds under the write token and the same four write verbs return 403 under `MCM_FORGE_TOKEN`. That
  negative half is the only check that the read-only diagnostics token has not been widened.
- **An unknown label name in a filter is silently ignored and returns the UNFILTERED set** — a typo reads
  as "matched everything". The tooling resolves every label and milestone name against the repository
  first and refuses an unknown one locally. With a real label the filter is correct and fails closed, and
  multiple label values are AND, not OR (measured 2026-08-08).
- **Pull requests are issues internally**, so a listing without `type=issues` returns them too — 143 rows
  where 1 was correct on this repository. Numbers also share ONE sequence, which is why prose says
  "item #N" and why merge-time `closes #N` auto-closing is deliberately not used: a mistyped number could
  close an unrelated item.
- **A page caps at 50 rows** (default 30), and totals come from `x-total-count`, never from the row count.
- **Closing a blocked item fails with 412** `cannot close this issue because it still has open
  dependencies`, and the tooling surfaces that distinctly from other failures. **The dependency endpoint
  needs `{owner, repo, index}`** — a bare `{index}` answers 404 `IsErrRepoNotExist`, naming the repository
  rather than the missing fields. A dependency cycle is refused before the call, because every item in one
  becomes permanently uncloseable.
- **The issue form only takes effect from the default branch**, so `validate-form` reports "not configured
  yet" on a feature branch — expected, not broken.
- **Projects boards have no API in this build**, so board columns are invisible to the assistant. Labels
  are the shared truth; treating the board as authoritative silently forks the state.
- **Item #29 is Renovate's Dependency Dashboard** and carries `status/bot-managed` — never edited, closed
  or swept, because Renovate rewrites its body on its own schedule. Bulk operations generally need an
  explicit operator instruction: item history lives in the forge's database, not in git, so there is no
  `git revert` for a mass close.
- **Not an Nx target**, unlike the gate scripts — an Nx invocation costs ~60 s in this workspace against
  ~0.09 s direct. See [Nx as the universal task runner](/openwiki/invariants/nx-task-runner.md). Its unit
  tests still run under Nx via `preflight`.

Provisioning, the full command surface and the diagnosis table: `docs/runbooks/backlog.md`.
