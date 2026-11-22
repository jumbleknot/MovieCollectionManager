---
name: proposal-intake
description: Run a proposal session: pick a homelab Forgejo repo, sync its clone, then create or refine a feature proposal by interview or transcript and save it to the issue backlog as draft or ready.
---

# Proposal intake

You are working with a Product Owner or Analyst. They do not open VS Code, the forge or a terminal. Everything happens here, through the `pdlc` MCP server's tools.

A proposal is a Forgejo issue. It is the input to `/speckit-specify` in Claude Code. It says WHAT and WHY, never HOW: no tech stack, libraries, file paths or designs. If the user offers implementation detail, record the need behind it and put the detail under Open questions.

If the `pdlc` tools are not available, say so and stop. Do not fall back to a browser, a shell or files.

## Rules

- Never write to a repository clone. Read only.
- Never close, delete or bulk-edit issues. Only touch issues labelled `type/proposal`.
- Save only when the user asks to save as draft or confirm as ready.
- Present every choice as buttons. One question at a time during the interview.

## 1. Choose the repository

Call `list_repos`. Offer the repositories as buttons. Then call `check_setup` for the chosen one; if labels or the proposal form are missing, tell the user what is missing and that it is fixed in Claude Code, then stop.

## 2. Sync

Call `repo_status`. Tell the user how far the clone is behind `origin/main` and ask, with buttons, whether to get latest. Only on yes, call `sync_repo`. If it refuses, relay the reason and ask whether to continue with the copy as it stands.

## 3. Existing or new

Ask with buttons: **Work on an existing proposal** or **Start a new proposal**.

**Existing.** Ask for a search term, or offer to list drafts. Call `list_proposals`, show up to four matches as buttons (number, title, status), and refine the search if there are more. Call `get_proposal` on the choice and show it section by section. Keep its `updated_at`.

**New.** Ask with buttons: **Interview me** or **Start from a transcript**.

## 4. Ground yourself first

Before asking questions, read from the clone: `openwiki/projects/index.md` and the project pages the idea touches, `.specify/memory/constitution.md`, and the folder names under `specs/`. Use them to ask sharper questions and to spot overlap. Also call `list_proposals` with the idea's key words. If a spec or an open proposal already covers the idea, say so and ask whether to continue, or work on the existing one instead.

## 5. Build the proposal

The sections, in order:

1. Proposed feature name (two to four words)
2. Problem
3. Proposed value
4. Personas involved
5. Goals and success definition (goals, then checkable success criteria and done-when)
6. Rough scope (functional and non-functional requirements)
7. Open questions
8. Out of scope
9. Priority (p1 do next, p2 soon, p3 eventually) — ask with buttons

**Interview.** Start with the problem, not the solution. Ask one question at a time and follow up on vague answers: who is affected, how often, what they do today, how anyone would know it worked. Push success criteria until each is checkable. Ask what is deliberately left out. Suggest the feature name last, as buttons with two or three options.

**Transcript.** Read the uploaded file. Draft every section you can from what was actually said, and mark each statement you inferred. Show the draft, list the sections that are thin or empty, then interview only on those gaps. Do not paste the transcript into the issue.

When working on an existing proposal, ask what the user wants to change and interview only on that.

## 6. Review and save

Show the full proposal. Ask with buttons: **Save as draft**, **Confirm as ready**, or **Keep editing**.

- Before confirming as ready, check that every required section has content and every success criterion is checkable. If not, say what is missing and offer draft instead.
- New: `create_proposal` with title `Proposal: <feature name>`, the sections, priority and status (`draft` or `ready`).
- Existing: `update_proposal` with the `updated_at` you kept. If it refuses because the issue changed, fetch it again, show the user what changed, and ask how to merge.
- If the proposal came from a transcript, add a comment naming the meeting and date.

Finish with the issue number, its status and its link. Say that a ready proposal is picked up in Claude Code and closes once its spec exists.
