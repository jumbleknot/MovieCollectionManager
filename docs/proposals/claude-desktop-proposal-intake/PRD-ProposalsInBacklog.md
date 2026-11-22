# PRD — Proposals in the Backlog

**Status**: Draft for review · **Date**: 2026-11-21 · **Author**: Steven Watson (with Claude)
**Repository**: `jumbleknot/mcm`
**Input to**: a numbered spec (`specs/NNN-proposals-in-backlog/`).
**Relates to**: feature 049 (Forgejo issue tracking), `docs/runbooks/backlog.md`,
`openwiki/process/spec-driven-development.md`.
**Companion**: `PRD-PdlcMcpServer.md` in `jumbleknot/belay` — the Claude Desktop server that files
proposals. This PRD does not depend on it: everything here works from the forge's web UI alone.

---

## 1. Problem

Proposals are the first stage of the lifecycle and the only one with no structure and no home in
the backlog. They are free-form files under `docs/proposals/` and reach `/speckit-specify` by copy
and paste. Nothing records whether an idea is still being shaped or is ready to specify, and
`node scripts/backlog.mjs ready` cannot see proposals at all.

## 2. Goals and non-goals

**Goals**

- G1: A proposal is a backlog item with fixed sections, filed by a human in the web UI or by a
  Claude Desktop session, structurally identical either way.
- G2: Draft and ready are machine-readable states that `backlog.mjs` understands.
- G3: Claude Code picks up a ready proposal with the tooling it already has and feeds it to
  `/speckit-specify`.
- G4: A proposal closes when its spec exists, with a link to it.

**Non-goals**

- Migrating existing `docs/proposals/` files into items.
- Removing `docs/proposals/` — it stays for history and long research documents.
- Any change to how specs, plans or tasks are produced.

## 3. Decisions already made (2026-11-21)

| # | Decision |
|---|---|
| D2 | A proposal item **closes when `specs/NNN-*/` exists**, with a comment linking the spec. |
| D4 | Every proposal carries exactly one `priority/*`, asked at intake. |
| D5 | Ready reuses the existing **`status/needs-spec`** label — it is already the documented bridge into SDD. |

(Numbering matches the companion PRD.)

## 4. Shared contracts with BELAY

### 4.1 State mapping

| State | Labels | Item state |
|---|---|---|
| Draft | `type/proposal` + `status/proposal-draft` + one `priority/*` | open |
| Ready | `type/proposal` + `status/needs-spec` + one `priority/*` | open |
| Superseded by a spec | unchanged | closed, with a comment linking `specs/NNN-*/` |

`type/proposal` is the item's single `type/*` label, so the "exactly one" rule holds.
Title convention: `Proposal: <feature name>`.

### 4.2 Section headings

The form's field labels are a contract: the `pdlc` server writes and parses these exact `###`
headings, in this order. Renaming one here breaks the server.

Proposed feature name · Problem · Proposed value · Personas involved · Goals and success
definition · Rough scope · Open questions · Out of scope · Priority

BELAY holds the master copy of the form.

## 5. Changes

| File | Change |
|---|---|
| `.forgejo/issue_template/proposal.yaml` | New form (copied from BELAY). Takes effect only from the default branch. |
| `scripts/backlog.mjs` | Add `type/proposal` and `status/proposal-draft` to the label set used by `setup-labels` and by the unknown-label check. Exclude `status/proposal-draft` from `ready`. |
| `scripts/__tests__/` | Cover both changes. |
| `.claude/skills/forgejo-issues/SKILL.md` | Proposals: the two states, how to pick up a ready one, and the close-on-spec rule. |
| `.claude/skills/speckit-specify/` or an `after_specify` hook | When the feature came from a proposal item: comment with the spec path, then close the item. |
| `docs/runbooks/backlog.md` | Label table, the new form, the proposal states. |
| `openwiki/process/spec-driven-development.md` | Stage 1 now lives in the backlog. Refresh in the same pull request (V17). |

After merge, the operator runs `node scripts/backlog.mjs setup-labels` once to create the two
labels on the forge.

## 6. Success criteria

- [ ] A proposal filed from the web UI form carries `type/proposal` and `status/proposal-draft`.
- [ ] `node scripts/backlog.mjs ready` lists a ready proposal and does not list a draft.
- [ ] `node scripts/backlog.mjs list --label type/proposal` works; before `setup-labels` the name
      is refused locally rather than returning the unfiltered set.
- [ ] `/speckit-specify` run from a ready proposal leaves the item closed with a comment linking
      the spec folder.
- [ ] `validate-form` passes for both forms on the default branch.
- [ ] The wiki gates (okf-lint, okf-governance) pass in the same pull request.

## 7. Open questions

1. **Skill edit or hook for close-on-spec?** `speckit-specify` is upstream Spec Kit; a local edit
   has to survive upgrades (see `docs/runbooks/spec-kit.md`). An `after_specify` hook may be the
   cleaner seam.
2. **How does `/speckit-specify` know which item it came from?** Options: the operator passes the
   item number; or the skill looks for an open `type/proposal` item whose feature name matches.
3. **Does the item take the feature's milestone (`NNN-slug`) before it closes?** It would make the
   proposal findable from the feature.
4. **Does `validate-form` handle two forms**, or does it assume one?

## 8. Out of scope

- The Claude Desktop server and skill — see the companion PRD.
- Forgejo project boards — they have no API in this build.
