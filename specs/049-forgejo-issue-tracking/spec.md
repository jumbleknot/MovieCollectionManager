# Feature Specification: Forgejo issue tracking — an agent-driven backlog with no human transport layer

**Feature Branch**: `049-forgejo-issue-tracking`

**Created**: 2026-08-08

**Status**: Draft

**Input**: User description: "docs/proposals/PRD-ForgejoIssueTracking.md"

## User Scenarios & Testing *(mandatory)*

The backlog for this repository currently lives in a plain text file on the operator's workstation. The
assistant cannot see it, add to it, or mark anything done, so every backlog interaction requires the
operator to act as the transport layer — pasting items into a session and hand-editing the text file
afterwards. The forge that hosts this repository ships an issue tracker with a web UI the operator
already uses daily, and it holds zero items. These journeys move the backlog there and give the
assistant first-class access to it.

Throughout: **operator** is the human who owns the backlog and reviews it in the forge's web UI;
**assistant** is the AI coding assistant working inside the development container.

### User Story 1 - File a backlog item without a human in the middle (Priority: P1)

While working on one thing, the assistant notices work that belongs elsewhere — a defect, a piece of
tech debt, a follow-up too large for the current change. It files that work as a backlog item on the
forge's tracker itself, in the same turn, with a title, a structured body (context, acceptance
criteria, affected components, what it was discovered during), a type label and a priority label. The
operator finds it in the web UI moments later, indistinguishable in structure from an item they filed
themselves.

**Why this priority**: This is the requirement the whole feature exists for. Without it the operator
remains the transport layer, and discovered work continues to be lost between sessions. It delivers
standalone value on day one: even with no other journey implemented, work stops falling on the floor.

**Independent Test**: In a session, ask the assistant to file a described item. Verify the item exists
on the forge with the expected title, labels and structured body; verify the operator can see it in the
web UI; verify no commit, branch, change proposal or pipeline run was produced.

**Acceptance Scenarios**:

1. **Given** a write-capable backlog credential is present in the container, **When** the assistant
   files an item with a title, body, type label and priority label, **Then** the item is created on the
   repository's tracker, its identifying number is reported back into the session, and the item is
   immediately visible to the operator in the web UI.
2. **Given** the item body contains multiple lines and markdown structure, **When** it is filed,
   **Then** the body arrives intact and is not truncated or reordered, and is not exposed anywhere it
   could be captured by shell history or a process listing.
3. **Given** an item has just been filed, **When** the repository state is inspected, **Then** no new
   commit, branch, change proposal, or pipeline run exists as a result of filing it.
4. **Given** the operator files an item through the web UI using the repository's item form, **When**
   the assistant reads it back, **Then** it has the same structural sections as an assistant-filed
   item and requires no special handling.

---

### User Story 2 - Ask what to work on next and get an answer (Priority: P1)

The assistant starts a session and asks the backlog for actionable work: items that are open, not
blocked by anything unfinished, ordered by priority, optionally narrowed to a type, a milestone, or a
free-text match. It can then open one item and read everything needed to act — body, labels,
milestone, blocking relationships, and the discussion so far.

**Why this priority**: Reading is what turns the tracker into the assistant's work queue rather than a
write-only archive. It is the other half of removing the operator as transport, and it is independently
valuable the moment any items exist — including items the operator filed by hand.

**Independent Test**: Seed a handful of items with mixed states, priorities and blocking
relationships. Run the ready-work query and verify it returns exactly the open, unblocked items in
priority order. Open one item and verify body, labels, milestone, dependencies and comments are all
present.

**Acceptance Scenarios**:

1. **Given** a backlog containing open, closed and blocked items across several priorities, **When**
   the assistant asks for ready work, **Then** a single command returns only the open, unblocked items,
   ordered by priority, and blocked and closed items are absent.
2. **Given** a backlog larger than one page of results, **When** the assistant lists items, **Then**
   the result set is either complete or explicitly reports that it was truncated together with the
   authoritative total — and the total is never inferred from the number of rows returned.
3. **Given** the tracker also contains change proposals, **When** the assistant lists backlog items,
   **Then** only backlog items appear; change proposals are never mixed into the list.
4. **Given** an item with labels, a milestone, blocking relationships and several comments, **When**
   the assistant opens it, **Then** all of those are reported in a distilled form rather than as a raw
   payload dump.

---

### User Story 3 - Update and close items against verified acceptance criteria (Priority: P1)

The assistant progresses an item: adds a comment recording what was found or done, adjusts labels
(including marking something blocked or needing a full specification), edits the title or body, and
closes the item once the acceptance criteria written in its body are met and verified. If the item is
blocked by unfinished work, the attempt to close it fails in a way that says so.

**Why this priority**: An item that can be created and read but never resolved leaves the backlog
permanently growing and untrustworthy. Closure discipline — verify the stated criteria, then close — is
what makes item state meaningful to the operator.

**Independent Test**: Against an existing open item, add a comment, add and remove a label, edit the
body, then close it — verifying each change in the web UI. Separately, attempt to close an item that is
blocked and verify the refusal is reported distinctly from any other kind of failure.

**Acceptance Scenarios**:

1. **Given** an open item whose acceptance criteria the assistant has verified, **When** it closes the
   item, **Then** the item's state becomes closed on the forge and the operator sees it as closed in
   the web UI.
2. **Given** an open item, **When** the assistant adds a comment, adds a label, removes a label, or
   edits the title or body, **Then** each change is applied and reported, and comment text is supplied
   through a channel that does not expose it in shell history or a process listing.
3. **Given** an item that is blocked by another unfinished item, **When** the assistant attempts to
   close it, **Then** the refusal is surfaced distinctly as "blocked — unblock first", not as a generic
   failure, and the item remains open.
4. **Given** an instruction that would change many items at once, **When** the assistant considers it,
   **Then** it does not perform the bulk change unless the operator explicitly asked for that bulk
   change.

---

### User Story 4 - Know instantly when backlog writes are unavailable (Priority: P2)

The write-capable credential is missing, empty, expired, or lacks the needed permission. Instead of
appearing to work, the backlog tooling says exactly which credential is absent or under-permissioned
and what is consequently unavailable — and falls back to read-only access rather than failing
outright. The development container still starts normally either way.

**Why this priority**: A silent credential failure has already cost this project real time once; the
lesson is paid for and must not be re-learned. It is P2 rather than P1 only because it protects the
other journeys rather than delivering backlog capability itself — but it is independently testable and
independently valuable.

**Independent Test**: Start the environment with the write credential unset and confirm the container
comes up and the first backlog interaction states that writes are unavailable and why, while reads
still work. Then present an under-permissioned credential and confirm the authorization failure names
both the credential and the missing permission.

**Acceptance Scenarios**:

1. **Given** the write credential is unset or empty, **When** the container is built and started,
   **Then** the container comes up successfully and no backlog capability failure blocks startup.
2. **Given** the write credential is unset or empty, **When** the assistant performs any backlog
   operation, **Then** read operations succeed using the existing read-only credential and any write is
   refused with a message naming the missing credential and the fact that writes are unavailable.
3. **Given** a credential that lacks the permission for the attempted operation, **When** the operation
   is refused by the forge, **Then** the reported failure names which credential was used and which
   permission is missing, and the operation is not silently retried or silently downgraded.
4. **Given** any backlog output surfaced into the session, **When** it is inspected, **Then** the
   forge's host name does not appear anywhere in it — it is replaced by a placeholder — and no
   committed artifact of this feature contains that host name either.

---

### User Story 5 - Encode ordering so "ready" means ready (Priority: P2)

The assistant records that one item is blocked by another, or blocks another, and can remove that
relationship again. The ready-work query of User Story 2 honours those relationships, so the answer to
"what can I work on next" excludes work whose prerequisites are unfinished.

**Why this priority**: Without recorded ordering, the ready query degrades into "everything open", and
the assistant will pick up work it cannot finish. It is separable from Story 2 — a ready query without
dependencies is still useful — so it ships after it.

**Independent Test**: Create two items, mark one blocked by the other, verify the blocked item is
absent from the ready query and visible as blocked when opened, then finish or unlink the blocker and
verify the item becomes ready.

**Acceptance Scenarios**:

1. **Given** two open items, **When** the assistant records that one is blocked by the other, **Then**
   the relationship is visible on both items in the web UI and in the assistant's view of each item.
2. **Given** a recorded blocking relationship, **When** the blocker is closed or the relationship is
   removed, **Then** the previously blocked item appears in the ready-work query.
3. **Given** a recorded blocking relationship, **When** the assistant asks for ready work, **Then** the
   blocked item is excluded.

---

### User Story 6 - Move the existing workstation backlog into the tracker (Priority: P3)

The operator hands over the contents of the workstation text file in a session. The assistant files
every entry as a structured, labelled, prioritized item, reports what it filed, and the operator
reviews the result in the web UI — after which the text file is no longer the backlog.

**Why this priority**: This is the migration that retires the old backlog and the end-to-end proof that
Stories 1–3 work in anger, but it depends on them and happens once. Its value is realized only after
the capability exists.

**Independent Test**: Provide the backlog text in a session; verify every entry has a corresponding
item with a type label and a priority label; verify the operator can review and correct the set in the
web UI; verify no entry was dropped or duplicated.

**Acceptance Scenarios**:

1. **Given** the workstation backlog text, **When** the assistant imports it, **Then** every entry
   exists as exactly one item with a type label, a priority label and a structured body, and the
   assistant reports the mapping from entries to item numbers.
2. **Given** the imported set, **When** the operator reviews it in the web UI, **Then** items are
   editable, re-labellable and closable through the UI with no assistant involvement.
3. **Given** an entry too large or too vague to implement directly, **When** it is imported, **Then**
   it is marked as needing a full specification before implementation.

---

### User Story 7 - Fan a planned feature's task list out into the backlog (Priority: P3)

For a feature that already has a specification and a task breakdown, the assistant can optionally
create one dependency-ordered backlog item per task, labelled and grouped to that feature's milestone.
It refuses to create items anywhere other than the repository this working copy points at.

**Why this priority**: Useful for coordinating a large feature in the open, but strictly optional — the
in-feature task breakdown remains the authoritative decomposition artifact. It is last because it adds
convenience, not capability, and the existing equivalent capability is currently inert.

**Independent Test**: For a feature with an existing task breakdown, run the fan-out and verify one
item per task, correctly ordered by blocking relationships and grouped to the feature's milestone. Then
point the working copy at a different repository and verify the fan-out refuses to run.

**Acceptance Scenarios**:

1. **Given** a feature with a completed task breakdown, **When** the assistant fans it out, **Then**
   one item exists per task, each grouped to that feature's milestone, with blocking relationships
   reflecting the task ordering.
2. **Given** a working copy whose origin is any repository other than this one, **When** the fan-out is
   attempted, **Then** it refuses and creates nothing.
3. **Given** the fan-out has run, **When** the in-feature task breakdown is consulted, **Then** it is
   still the authoritative decomposition and the items are a mirror of it, not a replacement.

### Edge Cases

- **Write credential absent, empty, or whitespace-only** — reads continue via the read-only
  credential, writes are refused with a named cause, and the container still starts (Story 4).
- **Credential present but under-permissioned** — the refusal names the credential and the missing
  permission rather than reporting a generic failure.
- **Credential set on the host but not visible in the container** — the known cause is a host
  environment change that the editor process never picked up; the remedy (fully quit the editor before
  rebuilding, not merely reload it) must be stated where the credential is configured, because the
  symptom is an empty value rather than an error.
- **Forge unreachable** — network egress or the forge itself is down; the failure is reported as
  unreachable-forge, distinct from an authorization failure, so the operator is not sent looking for a
  credential problem.
- **Change proposals interleaved with backlog items** — the tracker treats change proposals as items
  internally; listings that do not exclude them silently mix them into the backlog (Story 2).
- **Paginated listings** — a listing that returns a page-sized result must not be mistaken for a
  complete one, and the total must come from the authoritative count rather than the row count.
- **Filter behaviour assumed rather than observed** — the tracker's handling of listing filters (label,
  milestone, free-text, state, page size) must be observed once against the live forge and the observed
  behaviour recorded in the assistant's guidance; behaviour measured on unrelated endpoints does not
  transfer.
- **Closing a blocked item** — refused by the forge; surfaced distinctly (Story 3).
- **A referenced label or milestone does not exist** — reported as a missing label or milestone by
  name, not as a generic rejection, so the operator can create it.
- **The operator edits or closes an item between the assistant reading and writing it** — the
  assistant's later write does not silently overwrite the operator's newer state; the divergence is
  surfaced.
- **A body or comment would contain a secret or a host name** — the host name is replaced by
  construction; secrets must not be filed into item bodies at all, since item history is not
  revertible through version control.
- **Bulk change requested implicitly** — mass edits or mass closures are not performed without an
  explicit operator instruction, because item history lives outside version control and a mass mistake
  is tedious to undo.
- **Duplicate filing** — the assistant checks for an existing open item covering the same work before
  filing a new one.
- **The operator uses the tracker's board UI** — board column state is not readable by the assistant in
  the forge version in use; labels remain the shared source of truth and the board must not be treated
  as authoritative.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The assistant MUST be able to create, read, update, close, comment on, label, and
  dependency-link backlog items on this repository's tracker from inside the development container,
  without the operator relaying any content.
- **FR-002**: No backlog operation MAY produce a commit, branch, change proposal, or pipeline run.
- **FR-003**: Backlog writes MUST authenticate with a dedicated credential whose permissions are
  limited to writing items and reading the repository, and nothing more. It MUST be supplied to the
  container from the host environment and MUST NOT appear in any committed artifact. The credential's
  reach is deliberately **not** narrowed to a single repository — that is the operator's recorded
  decision (see Assumptions), so permission scope, not account isolation, is what bounds it.
- **FR-004**: The existing read-only diagnostics credential MUST NOT be widened to grant write access;
  the two credentials remain separate, on separate accounts, separately revocable.
- **FR-005**: With the write credential absent or empty, backlog tooling MUST degrade to read-only
  using the existing read-only credential, MUST state that writes are unavailable and why, and MUST NOT
  prevent the development container from starting.
- **FR-006**: On any authorization failure, the tooling MUST name both the credential used and the
  permission missing, and MUST NOT silently retry, silently degrade, or report a generic failure.
- **FR-007**: Every backlog output surfaced into a session MUST have the forge's host name replaced by
  a placeholder, and no artifact of this feature (tooling, guidance, item form, documentation) MAY
  contain that host name. The forge location and the target repository MUST be derived at runtime from
  values already present in the environment and the working copy.
- **FR-008**: Item listings MUST exclude change proposals, MUST report either a complete result set or
  an explicit truncation notice, and MUST take totals from the tracker's authoritative count rather
  than from the number of rows returned.
- **FR-009**: Item bodies and comment text MUST be supplied through a channel that does not expose them
  in shell history or process listings.
- **FR-010**: A refusal to close an item because it is blocked MUST be surfaced distinctly from other
  failures, and MUST leave the item open.
- **FR-011**: A single command MUST answer "what can I work on next" — open items, excluding those
  blocked by unfinished work, ordered by priority.
- **FR-012**: A documented label taxonomy MUST exist covering item type, priority, blocked state, and
  an explicit marker for items too large to implement without going through the specification lifecycle
  first.
- **FR-013**: A structured item form MUST exist in the repository so that operator-filed and
  assistant-filed items share the same sections: context, acceptance criteria, affected components, and
  what the item was discovered during.
- **FR-014**: Milestones MUST be usable to group items belonging to a planned feature, and items
  without a milestone MUST be valid — the free backlog.
- **FR-015**: The assistant's backlog guidance MUST state the decision rules it cannot derive from the
  tooling: when to file an item, when it is legitimate to close one, the label taxonomy, the bridge from
  a backlog item into the specification lifecycle, that the board UI is not authoritative, that bulk
  operations require an explicit instruction, and the observed tracker quirks.
- **FR-016**: Every write MUST target the repository the working copy points at, and the tooling MUST
  refuse to write to any other repository. Because the write credential can reach other repositories by
  design (FR-003), this guard — not the credential — is the client-side bound on blast radius, so it
  applies to every write path, not only to the task fan-out.
- **FR-017**: The tracker's actual listing-filter and pagination behaviour MUST be observed once against
  the live forge and recorded in the assistant's guidance; it MUST NOT be assumed from behaviour
  measured elsewhere.
- **FR-018**: Provisioning steps for the write credential — the permissions to grant, how the value
  reaches the container, and the failure mode where a host-set value silently arrives empty — MUST be
  documented, with no credential value committed.
- **FR-019**: The documentation MUST state plainly that the write credential is account-wide by
  decision — it can reach items on every repository its account can access — and that the tooling's
  same-repository guard (FR-016) is what keeps this feature's writes inside this repository.
- **FR-020**: Backlog items MUST require no new backup mechanism — they MUST be covered by the existing
  verified backup of the forge.

### Key Entities

- **Backlog item**: A unit of tracked work on the repository's tracker. Has an identifying number, a
  title, a structured body (context, acceptance criteria, affected components, discovered-during), an
  open/closed state, labels, an optional milestone, blocking relationships, and a comment thread. Filed
  by either the operator or the assistant, with no structural difference between the two.
- **Label**: A named, coloured marker on an item. Grouped into type, priority, and status families;
  labels are the machine-readable state of an item.
- **Milestone**: A named grouping that maps an item to a planned feature. Optional; unmilestoned items
  form the free backlog.
- **Blocking relationship**: A directed link between two items meaning one cannot be completed before
  the other. Determines whether an item counts as ready work, and prevents closure while unsatisfied.
- **Item form**: The repository-level structured template that shapes a newly filed item's body.
- **Write credential**: The dedicated secret used for backlog writes, permitted to write items and read
  the repository and nothing else, delivered from the host environment. Externally contracted as
  `MCM_FORGE_ISSUE_TOKEN`. Its reach is not limited to this repository by decision, so it does not
  itself bound which repository is written — see **Same-repository guard**.
- **Read-only credential**: The existing diagnostics secret, externally contracted as
  `MCM_FORGE_TOKEN`, which already reaches every item read; the read-only fallback when the write
  credential is absent.
- **Same-repository guard**: The rule that a write is refused unless its target repository is the one
  the working copy points at. Given a credential that can reach further, this is the bound that keeps
  this feature's writes where they belong.
- **Backlog guidance**: The assistant-facing decision rules and recorded tracker quirks — when to file,
  when to close, the taxonomy, the specification bridge, and what not to trust.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Filing, reading, updating and closing a backlog item each take zero operator copy-paste
  or hand-editing steps — the operator's involvement in a backlog change drops from every change to
  none.
- **SC-002**: Across the full acceptance exercise, backlog operations produce zero commits, zero
  branches, zero change proposals, and zero pipeline runs.
- **SC-003**: 100% of authorization failures name both the credential used and the permission missing;
  zero backlog failures are reported generically or silently.
- **SC-004**: 100% of backlog output surfaced into a session is free of the forge's host name, and zero
  committed artifacts of this feature contain it.
- **SC-005**: With the write credential absent, the development container starts successfully 100% of
  the time, reads still succeed, and the read-only condition is stated at the first backlog
  interaction.
- **SC-006**: Every entry of the existing workstation backlog is present in the tracker exactly once,
  labelled by type and priority, and the operator confirms the imported set in the web UI in a single
  review pass — after which the workstation file is no longer consulted.
- **SC-007**: "What can I work on next" is answered by one command and returns only open, unblocked
  items in priority order — verifiable against a seeded backlog with known blocked and closed items.
- **SC-008**: A blocked item cannot be closed accidentally: 100% of such attempts are refused with the
  blocked cause named, and the item remains open.
- **SC-009**: Consulting the backlog guidance costs no more than roughly 2,000 tokens of session
  context, and it is consulted only when the backlog is actually in use — never on every session.
- **SC-010**: The feature adds zero new backup jobs, schedules, or storage locations; a restore of the
  existing forge backup restores the backlog with it.
- **SC-011**: A backlog item filed by the assistant and one filed by the operator through the web UI
  are structurally identical — same sections present, no field a reviewer can use to tell which filed
  it.

## Assumptions

- The decision to host the backlog on this repository's own forge tracker — rather than in a file-based
  tracker, a dedicated tool, or a mirror on a third-party host — is already taken in the governing
  strategy document and is not revisited here.
- The development container can already reach the forge, and the existing read-only credential already
  reaches every item read endpoint; both were measured, not assumed. Only the write path is new.
- The passthrough that delivers the write credential into the container has already landed on the main
  branch; this feature consumes it rather than introducing it, and must keep its documented failure
  mode (a host value set but not picked up arrives empty, not as an error) accurate.
- **The write credential's reach is account-wide by operator decision, not by oversight.** The operator
  confirmed (2026-08-08) that `MCM_FORGE_ISSUE_TOKEN` was deliberately not restricted to this
  repository, and that its permissions are exactly repository-read plus item-write. This supersedes the
  source PRD's single-repository bot requirement. Two consequences are carried into the design rather
  than left implicit: permission scope is the only server-side bound (the credential cannot push code,
  read packages, or administer anything), and the tooling's same-repository guard (FR-016) is the only
  client-side bound, which is why it applies to every write rather than only to the task fan-out.
- Minting and delivering that credential are operator actions performed outside version control; this
  feature documents them and consumes the result.
- The initial label taxonomy is a starting set, expected to be calibrated against the real backlog
  during the migration rather than settled on paper.
- Closing an item stays an explicit, verified act. Merge-time automatic closure (a change proposal
  closing an item when it merges) is deliberately not adopted, because it would couple item closure to
  the merge event and bypass the verify-then-close discipline.
- Backlog items are inputs to the specification lifecycle, not a replacement for it: an item large
  enough to need a specification is marked as such, and the in-feature task breakdown remains the
  authoritative decomposition artifact for a feature under construction.
- Item history lives outside version control, so there is no revert for a bad bulk edit; the mitigation
  is procedural (no bulk operations without an explicit instruction) plus the existing forge backup.
- Out of scope for this feature: a second backlog source of truth of any kind; board/kanban automation
  (the forge version in use exposes no board state to automation); the pipeline filing items
  automatically on failure; general-purpose migration tooling (the one-time migration is
  conversational); and any change to merge gates, branch protection, or existing pipelines.
