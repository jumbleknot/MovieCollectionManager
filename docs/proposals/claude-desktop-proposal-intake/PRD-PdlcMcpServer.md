# PRD — `pdlc` MCP Server (Claude Desktop proposal intake)

**Status**: Draft for review · **Date**: 2026-11-21 · **Author**: Steven Watson (with Claude)
**Repository**: `jumbleknot/belay` (Build, Engineering, Lifecycle & Automation Yard)
**Input to**: the first numbered spec in BELAY.
**Companion**: `PRD-ProposalsInBacklog.md` in `jumbleknot/mcm` — the form, labels and Claude Code
side. The two share the contracts in §5 and §6.

---

## 1. Problem

The Product Owner and Analyst roles cannot ideate, capture or refine a feature proposal without
opening VS Code, the forge's web UI or a CLI. Claude Desktop is the natural place for that
conversation, but it has no way to reach the homelab forge or keep a repository copy current.

Measured 2026-11-21: Claude Desktop's session shell cannot reach
`<tailnet-host>:3000` (HTTP 403, "Connection blocked by network allowlist"). Neither the
forge API nor `git fetch` works from the session. Both work from the Windows host, so the access
has to be a local MCP server running there.

`mcm`'s `scripts/backlog.mjs` cannot fill the gap: it derives its repository from
`git remote get-url origin` and refuses any other target, which is right for one working copy and
wrong for a pick-a-repository flow.

## 2. Goals and non-goals

**Goals**

- G1: A proposal session runs entirely in Claude Desktop.
- G2: The session works in any repository under `jumbleknot`, grounded in that repository's latest
  `main` through a dedicated clone.
- G3: Proposals are read, created and updated in the repository's Forgejo issue backlog, with
  draft and ready as machine-readable states.
- G4: No operation creates a commit, branch, pull request or CI run in the target repository.

**Non-goals**

- Writing specs, plans or tasks.
- Closing proposals. Claude Code closes one when its spec folder exists.
- Other users or machines. One operator, one workstation, for now.
- A hosted (HTTP) server.
- Moving `backlog.mjs`, the speckit skills or the gates out of `mcm`.

## 3. Decisions already made (2026-11-21)

| # | Decision |
|---|---|
| D1 | Each repository gets a **dedicated clone** for proposal sessions. A development working tree is never synced by this server. |
| D2 | A proposal issue **closes when `specs/NNN-*/` exists**, with a comment linking the spec. Done in Claude Code, not here. |
| D3 | The operator plays Product Owner and Analyst. No additional accounts or access. |
| D4 | The interview **asks for priority**. |
| D5 | Ready reuses the existing **`status/needs-spec`** label. |
| D6 | The server lives in **BELAY**, not in `mcm`. |
| D7 | **Tool names and parameters in §5 are a fixed contract.** The `proposal-intake` skill calls them by these exact names. |

## 4. Configuration

Environment variables, set in the Claude Desktop server entry.

| Variable | Meaning |
|---|---|
| `PDLC_FORGE_URL` | `http://<tailnet-host>:3000` |
| `PDLC_FORGE_OWNER` | `jumbleknot` — the only owner the server will address |
| `PDLC_FORGE_TOKEN` | A **new, dedicated** token: `write:issue` + `read:repository`. Separate from `MCM_FORGE_ISSUE_TOKEN` so it revokes separately. |
| `PDLC_CLONE_ROOT` | Folder holding the dedicated clones, e.g. `E:\Programming\pdlc-clones`. One sub-folder per repository. This folder is connected to the Claude Desktop project. |

A missing variable is a startup failure that names the variable.

## 5. Tool contract (normative — D7)

The server is registered under the name **`pdlc`**. Tool names, parameter names and the values of
`status` are fixed. A change to any of them is a breaking change and must update
`skills/proposal-intake/SKILL.md` in the same pull request.

| Tool | Parameters | Does |
|---|---|---|
| `list_repos` | — | Repositories under the configured owner: name, description, default branch, whether a clone exists |
| `repo_status` | `repo` | Clone path, current branch, clean or dirty, commits behind `origin/main`. Runs `git fetch`; changes no files |
| `sync_repo` | `repo` | Clone if absent; otherwise fast-forward `main` to `origin/main`. Refuses if the clone is dirty, not on `main`, or has diverged — reports why and changes nothing |
| `check_setup` | `repo` | Whether the proposal labels exist and the proposal form is on the default branch. A failure names what is missing |
| `list_proposals` | `repo`, `status` (`draft` \| `ready` \| `all`), `query?`, `state?` (`open` \| `closed` \| `all`, default `open`) | Number, title, status, priority, last updated |
| `get_proposal` | `repo`, `number` | Body parsed into its sections, labels, comments, and `updated_at` |
| `create_proposal` | `repo`, `title`, `sections`, `priority` (`p1` \| `p2` \| `p3`), `status` (`draft` \| `ready`) | Files a new proposal. Refuses when an open proposal has the same title |
| `update_proposal` | `repo`, `number`, `expected_updated_at`, `title?`, `sections?`, `priority?`, `status?` | Edits a proposal. Refuses if the issue changed since `expected_updated_at` |
| `add_comment` | `repo`, `number`, `body` | Adds a comment |

`sections` is an object keyed by the section ids in §6.

There is deliberately **no close, delete, arbitrary-relabel or bulk tool**.

## 6. Shared contracts with `mcm`

### 6.1 State mapping

| State | Labels | Issue state |
|---|---|---|
| Draft | `type/proposal` + `status/proposal-draft` + one `priority/*` | open |
| Ready | `type/proposal` + `status/needs-spec` + one `priority/*` | open |
| Superseded by a spec | unchanged | closed, with a comment linking `specs/NNN-*/` |

A ready proposal can be moved back to draft. Title convention: `Proposal: <feature name>`.

### 6.2 Body format

The server writes the body exactly as the forge renders the issue form: one `### <Label>` heading
per section, in this order. `get_proposal` parses the same headings, so a proposal filed in the web
UI and one filed by a session are structurally identical.

| Section id | Heading |
|---|---|
| `feature_name` | Proposed feature name |
| `problem` | Problem |
| `proposed_value` | Proposed value |
| `personas` | Personas involved |
| `goals_success` | Goals and success definition |
| `rough_scope` | Rough scope |
| `open_questions` | Open questions |
| `out_of_scope` | Out of scope |
| `priority` | Priority |

The headings must match `proposal.yaml` exactly. BELAY holds the master copy of the form; each
target repository carries a copy at `.forgejo/issue_template/proposal.yaml`.

## 7. Guards

Each is a lesson already measured in `mcm` feature 049.

- **Owner and repository guard.** Every request path must address `PDLC_FORGE_OWNER` and a
  repository returned by `list_repos`. Checked at the request boundary. The token is account-wide;
  this guard is what keeps writes where they belong.
- **Proposals only.** A write is refused unless the target issue carries `type/proposal`. It is
  always refused for `status/bot-managed`.
- **Labels resolved by name to id; unknown names refused.** The API silently ignores an unknown
  label in a filter and returns the unfiltered set.
- **`type=issues` on every listing.** Pull requests are issues internally.
- **Pagination by `x-total-count`.** A page caps at 50; a truncated answer says so.
- **Stale-write check** on `update_proposal`.
- **Git never writes history.** No commit, push, branch or stash. The token is passed to git per
  invocation, never stored in the clone's remote URL.
- **Bodies never appear in process arguments.**
- **The token never appears in a tool result or log line.**

## 8. Proposed BELAY layout

```
belay/
  mcp-servers/pdlc/            the server (Node — reuses the patterns in mcm's backlog.mjs)
  skills/proposal-intake/      master copy of the Claude Desktop skill
  forgejo/issue_template/      master copy of proposal.yaml
  forgejo/labels.json          the proposal label definitions
  docs/proposals/              this file
```

## 9. Success criteria

- [ ] From Claude Desktop alone: select `mcm`, sync, create a proposal, save as draft, reopen it in
      a later session, confirm as ready.
- [ ] `sync_repo` on a dirty, off-`main` or diverged clone changes nothing and says why.
- [ ] Every guard in §7 has a test that observes the refusal.
- [ ] A write aimed at another owner, or at an issue without `type/proposal`, is refused.
- [ ] The tool list the server announces matches §5 exactly — checked by a test.
- [ ] No step created a commit, branch, pull request or CI run in the target repository.

## 10. Open questions

1. **Does `write:issue` + `read:repository` allow listing an owner's repositories?** `/user`
   answers 403 under `mcm`'s existing token. Measure `/users/{owner}/repos` and
   `/orgs/{owner}/repos` before fixing the `list_repos` design.
2. **Is anonymous clone allowed**, or must `sync_repo` authenticate the fetch?
3. **Full or shallow clone?** A shallow, blobless clone is faster; the session only reads `main`.
4. **Should `check_setup` offer to create missing labels**, or only report them? Reporting only
   keeps label creation in each repository's own tooling.
5. **How does BELAY itself run SDD?** It is a new repository with no Spec Kit, constitution or CI
   yet. Decide the minimum before the first spec.
6. **How do copies of the form stay in step with BELAY's master?** By hand for one repository; a
   check is worth having at two.

## 11. Dependencies

`check_setup` passes for `mcm` only after `PRD-ProposalsInBacklog.md` has merged there and its
labels have been created. The server can be built and tested against a scratch repository first.
