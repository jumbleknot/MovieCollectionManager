# The backlog — Forgejo Issues, driven by the assistant

The MCM backlog lives in this repository's own Forgejo issue tracker. The operator works it through the
web UI; the coding assistant works it through `scripts/backlog.mjs` from inside the dev container. There
is no second source of truth — no task file, no local database, no mirror.

Feature: [specs/049-forgejo-issue-tracking](../../specs/049-forgejo-issue-tracking/spec.md). Decision
rules for the assistant: [.claude/skills/forgejo-issues/SKILL.md](../../.claude/skills/forgejo-issues/SKILL.md).

**No backlog operation creates a commit, branch, pull request or CI run.** That is the property the whole
design rests on: issue changes are HTTP calls, so there is no commit → PR → CI cycle to pay for a
one-line backlog edit.

## Commands

```bash
node scripts/backlog.mjs --help          # full flag reference, exit codes, measured API quirks
node scripts/backlog.mjs ready           # open, unblocked, priority-ordered
node scripts/backlog.mjs list [--state open|closed|all] [--label L]... [--milestone M] [--q TEXT]
node scripts/backlog.mjs show <n>
node scripts/backlog.mjs create --title T --body-file F [--label L]... [--milestone M]
node scripts/backlog.mjs update <n> [--state closed] [--add-label L] [--remove-label L] [--body-file F]
node scripts/backlog.mjs comment <n> --body-file F
node scripts/backlog.mjs dep <n> --blocked-by <m> [--remove]
node scripts/backlog.mjs setup-labels [--dry-run]     # idempotent
node scripts/backlog.mjs setup-milestone NNN-slug     # idempotent
node scripts/backlog.mjs validate-form
```

Deliberately **not** an Nx target, unlike the gates: an Nx invocation costs ~60 s in this workspace
against ~0.09 s direct, which is fine once per push and unusable for a command run several times in one
session. See [the Nx invariant](../../openwiki/invariants/nx-task-runner.md) for the measured numbers and
the rule. Its unit tests do run under Nx, via `pnpm nx preflight infrastructure-as-code`.

## The credential

| Variable | Permissions | Used for |
| --- | --- | --- |
| `MCM_FORGE_ISSUE_TOKEN` | `write:issue` + `read:repository` | every write; preferred for reads |
| `MCM_FORGE_TOKEN` | read-only (CI diagnostics) | read fallback when the write token is absent |

Set the write token on the Windows host with `setx MCM_FORGE_ISSUE_TOKEN <value>`, then **fully quit VS
Code** — a window reload is not enough, because the reused process keeps its old environment, so
`${localEnv}` resolves to empty and the token is *silently absent* rather than failing loudly. Then
rebuild the container. With it unset, reads still work through `MCM_FORGE_TOKEN`, writes are refused
naming the missing variable, and the container comes up regardless.

The two tokens stay separate on purpose. `MCM_FORGE_TOKEN`'s read-only scope set is load-bearing for CI
diagnostics; widening it would couple two features to one credential and silently upgrade the diagnostics
path to write capability. Separate tokens, separate revocation.

### Its reach is account-wide, by decision

> The write credential is **not** restricted to this repository. That is the operator's deliberate choice
> (2026-08-08), not an oversight. Forgejo tokens are account-wide — there is no repo-scoped token
> upstream — so **permission scope** is the server-side bound: this credential can write items and read
> repositories, and cannot push code, read packages or administer anything.
>
> The client-side bound is the tooling's **same-repository write guard**: every write asserts that the
> owner/repo it is about to address is the one derived from `git remote get-url origin`, and refuses
> otherwise. It is checked twice — once against any `--repo` value, and again at the request boundary so
> a mis-built path cannot slip through. **That guard, not the credential, is what keeps writes here.**

Do **not** try to check the token's permissions by reading `permissions` from the repository API: it
reports what the owning *account* may do with the repository, not what the token may do. An
item-write-only token on an admin account reports `admin: true` and still cannot push a commit. No
endpoint this token can reach reports its own scopes (`/user` → 403; it carries no `read:user`), so the
scope split is proven behaviourally — the write sequence succeeds under it and the same four write verbs
return **403** under `MCM_FORGE_TOKEN`. That negative half is the only check that the read-only token has
not been widened; re-run it if either credential is ever re-minted.

## Conventions

**Labels** (created once by `setup-labels`, ten of them):

| Family | Names |
| --- | --- |
| type | `type/bug` `type/feature` `type/tech-debt` `type/chore` — exactly one |
| priority | `priority/p1` `priority/p2` `priority/p3` — exactly one |
| status | `status/blocked` (hint; the dependency graph is the authority) · `status/needs-spec` (the bridge into the SDD lifecycle) · `status/bot-managed` (another automation owns it) |

**Milestones** map to feature directories (`NNN-slug`). No milestone is normal — that is the free
backlog. A milestone must exist before it can be used: an unknown name is refused locally, because the
API would silently ignore it.

**The item form** at `.forgejo/issue_template/backlog-item.yaml` fixes four sections — context,
acceptance criteria, affected components, discovered-during — so an operator-filed item and an
assistant-filed item are structurally identical. It only takes effect from the **default branch**;
`validate-form` says so explicitly rather than reporting the form as broken.

**Item #29 is Renovate's Dependency Dashboard** and carries `status/bot-managed`. Nothing here ever
edits, closes or sweeps it — Renovate rewrites its body on its own schedule.

## Operating notes

- **Closure is an explicit, verified act.** Merge-time auto-closing (`closes #N`) is deliberately not
  used: it would bypass the verify-then-close discipline, and issue and pull-request numbers share one
  sequence here, so a mistyped `#N` in a commit message could close an unrelated item.
- **No bulk operations without an explicit instruction.** Item history lives in the forge's database, not
  in git — there is no `git revert` for a mass close. Forgejo keeps per-issue edit history and the restic
  snapshot bounds worst-case loss at one backup interval, but undoing a mass mistake is tedious.
- **Backup is inherited, not added.** Items live in Forgejo's Postgres, inside the existing
  `forgejo dump` restic snapshot. This feature adds no backup machinery.
- **Projects boards have no API in this build.** Board state is invisible to the assistant; labels are
  the shared truth. Treating the board as authoritative would silently fork the state.

## Diagnosing

| Symptom | Cause |
| --- | --- |
| exit 3, names `MCM_FORGE_ISSUE_TOKEN` | write token absent or empty — often a `setx` without fully quitting VS Code |
| exit 4, names a token and a permission | granular scope refusal; the same token can return 200 elsewhere in the same second |
| exit 5, "could not reach the forge at …" | transport, not permissions. Check the base named in the message carries host **and port**, the container firewall, and that the forge is up |
| exit 2, "No such label" | the name does not exist on the repository. Refused locally on purpose — the API would silently return the unfiltered set |
| exit 2, "item #N is BLOCKED" | 412 from the forge; unblock first (`dep N --blocked-by M --remove`) or close the blocker |
| a listing shows pull requests | `type=issues` was dropped; on this repository that turns 1 row into 143 |
