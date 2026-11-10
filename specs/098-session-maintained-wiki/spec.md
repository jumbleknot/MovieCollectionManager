# Feature Specification: Session-Maintained Wiki Summaries

**Feature Branch**: `098-session-maintained-wiki`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "Session-maintained wiki summaries. Each derived page gets a single-resource sha256 fingerprint and a blocking okf rule. Add a wiki-refresh skill and script. Retire the claims sidecars, the page manifest, V16 and the `sources:` list (gitignored). Keep the generator as a manual named-page rebuild. Change the policy.yaml actor. Record the history in ADR-0004. Run a cut-over catch-up." Source: [docs/proposals/PRD-SessionMaintainedWiki.md](../../docs/proposals/PRD-SessionMaintainedWiki.md), merged in PR #980.

## Context

The `openwiki/` summaries exist mainly so a **coding session** can get oriented quickly before it
touches an area. Accuracy matters more than polish.

Keeping them fresh with a paid model in CI did not converge, despite four rounds of cost work:

- moving from Anthropic to Fireworks,
- rerunning pages stopped at the deadline at low effort,
- longer job windows,
- a daily schedule with cooldowns (features 044, 078 and 082).

Spend was about $37 a week. On 2026-11-09 the first daily run spent about $1.44 to land one page,
while 30 unrequested pages starved the 4 that were asked for. The schedule was paused on
2026-11-10 (PR #980).

This feature moves freshness to the place where staleness is created. The coding session that
changes a page's source refreshes that page in the same pull request. That costs nothing beyond
the session itself, which runs on the operator's subscription, and CI blocks the PR if the session
forgets.

**Actors**:
- **Coding session**: the AI coding assistant working on a PR, on the operator's subscription.
- **Operator**: the repository owner, who reviews and merges PRs and may dispatch a manual rebuild.
- **CI**: the required `okf` check, which runs on every PR and on `main`.
- **Automated writers**: CD's digest-promote commit and Renovate.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A stale summary blocks the pull request (Priority: P1)

A coding session edits a document that a summary page is built on, for example
`docs/runbooks/renovate.md`, and does not touch `openwiki/runbooks/renovate.md`. The required check
fails on the PR. The failure names the summary page, the source it is built on, and the one
command that lists and refreshes it. Once the summary is refreshed in the same PR, the check passes.

**Why this priority**: This is the guarantee the operator asked for ("CI should block the PR until
the summary is refreshed"). Without it, summaries drift silently and mislead the next session.

**Independent Test**: On a branch, change one byte of a page's source without touching the page.
The check fails and names that page. Refresh the page. The check passes.

**Acceptance Scenarios**:

1. **Given** every summary is fresh, **When** a PR changes a page's source and leaves the page alone,
   **Then** the required check fails, naming the page, its source and the refresh command.
2. **Given** that failing PR, **When** the session refreshes the page and records its new
   fingerprint, **Then** the check passes.
3. **Given** a PR that changes no source of any summary, **When** the check runs, **Then** it
   passes, with no added duration a person would notice.
4. **Given** a page that is hand-written (canonical, with no source document), **When** any file
   changes, **Then** this check never fails on that page.

---

### User Story 2 - A session refreshes a summary cheaply and honestly (Priority: P1)

A session that has just made a summary stale runs one command. The command lists the stale pages
and shows, for each one, **only what changed in its source** since the page was last refreshed.
The session updates just what that change invalidates, keeping the page's structure and the
bundle's writing rules, and then records the fingerprint. If the source change does not affect
anything the page says, such as a typo fix, the session records the fingerprint without changing
the text, and the reviewer sees exactly that.

**Why this priority**: The block in Story 1 only works if satisfying it is easy. A heavy ritual
gets routed around, for example by bumping fingerprints blind.

**Independent Test**: Make a page stale, run the list command (it shows the page and the source
diff), edit the page, run the record command. The check passes, and the PR diff shows the page edit
plus a one-line fingerprint change.

**Acceptance Scenarios**:

1. **Given** stale pages exist, **When** the session runs the list command, **Then** it reports
   exactly the pages the check would fail on, never more or fewer.
2. **Given** a stale page, **When** the session asks for its source diff, **Then** it sees the
   change since the recorded fingerprint, not the whole source.
3. **Given** an edited page, **When** the session records the fingerprint, **Then** only the
   fingerprint and the page's timestamp change in front matter. No prose is written by the tool.
4. **Given** a session starting work that will edit a source document, **When** it reads the
   project instructions, **Then** it learns of the refresh duty and the skill before CI enforces it.

---

### User Story 3 - The bundle carries only what helps the assistant (Priority: P2)

The generator's own bookkeeping leaves the repository. That means:

- the per-page Claims sidecars,
- the page manifest and the run marker,
- the per-page `sources:` list in front matter, which nothing reads,
- the check that blocked any hand edit to a generated page.

The policy that named the generator as the only writer of summary pages is widened to coding
sessions. A decision record (ADR-0004) explains the whole progression and why each step was taken,
and it explicitly supersedes the Claims half of ADR-0003.

**Why this priority**: The old check directly forbids what Story 2 asks sessions to do, so it must
go. Its removal and the policy change must be a recorded decision, not a silent edit.

**Independent Test**: After this story, a hand edit to a summary passes every check, provided the
fingerprint is current. The sidecars, manifest and marker are absent and gitignored. ADR-0004
exists and is linked from ADR-0003.

**Acceptance Scenarios**:

1. **Given** the bundle after this story, **When** the sidecar directory, the manifest and the
   marker are looked for, **Then** none is tracked, and all three are gitignored.
2. **Given** a summary edited by a session with its fingerprint recorded, **When** every bundle
   check runs, **Then** all pass.
3. **Given** the policy file, **When** governance checks run, **Then** a coding session is a
   permitted writer of summary pages, and the change is cited to ADR-0004.
4. **Given** ADR-0004, **When** a reader follows it, **Then** it walks the dated steps from manual
   generation through to this decision, each with the measured number that drove it, and records
   which part of ADR-0003 it supersedes.

---

### User Story 4 - The operator can still rebuild named pages by hand (Priority: P3)

Occasionally the operator wants a page regenerated from scratch, for example after a large rewrite
of its source. They dispatch the existing workflow with a list of pages. Only those pages are
regenerated, and the result is a PR for review that already passes the freshness check. Nothing
runs on a schedule, and no state carries over between dispatches. A list that does not finish is
dispatched again with the pages that remain, and the run says which pages landed.

**Why this priority**: It is a safety valve, needed rarely. The operator explicitly asked to keep
it.

**Independent Test**: Dispatch with one page named. The resulting PR changes only that page and its
directory index, carries a current fingerprint, and adds no sidecar or manifest.

**Acceptance Scenarios**:

1. **Given** a dispatch naming two pages, **When** it completes, **Then** the PR touches only those
   pages, plus index entries, and both pass the freshness check without hand-fixing.
2. **Given** a dispatch that ran out of time after one of two pages, **When** it ends, **Then** it
   reports which named page landed and which did not, and nothing is recorded for a later run to
   resume.
3. **Given** the workflow definition, **When** it is inspected, **Then** it has no schedule and no
   push trigger.

---

### User Story 5 - The switch-over leaves `main` green (Priority: P1)

Before the check becomes blocking, a one-time catch-up refreshes every summary that is stale today
(about 30 pages) and records a fingerprint on every summary. The check is turned on in the same PR
that records the last fingerprints, so `main` is green at the moment the check starts blocking.

**Why this priority**: The check scans the whole tree. Turned on against a stale bundle, it would
block every PR at once.

**Independent Test**: On the switch-over PR, the list command reports zero stale pages and the
required check passes.

**Acceptance Scenarios**:

1. **Given** the switch-over PR, **When** the check runs, **Then** every summary carries a
   fingerprint matching its source, and the check passes.
2. **Given** the two pages whose source is a whole directory today, **When** the switch-over
   completes, **Then** each either points at a single file or is a hand-written canonical page.
   `process/spec-driven-development.md` is canonical.

---

### Edge Cases

- **A source file is renamed or deleted.** The check fails, naming the page and the missing source.
  The session re-points the page or retires it. This is never skipped silently.
- **A source differs only in line endings.** The fingerprint follows a stated normalisation, so
  checking out on another OS does not make every page stale.
- **Several pages share one source** (`docs/MCM-Architecture.md` backs three). The check names all
  three, and refreshing one does not satisfy the others.
- **An automated commit changes a source.** CD's promote commit touches only deploy-digest files,
  which no page may cite; a governance check enforces this. A Renovate PR that changes a cited file
  fails like any other PR, and a session refreshes the page.
- **A gotcha page is built on a code file** (`keycloak.ts`, `server.js`, `session-manager.ts`,
  `playwright.config.ts`, `movie-detail.tsx`, `error_handler.rs`, `observability.py`). It stays
  under the check (operator decision, 2026-11-10). A code PR touching that file refreshes the
  gotcha.
- **The manual rebuild's generator recreates sidecars or a manifest in its working tree.** They are
  gitignored, so they never reach the PR.
- **A page's fingerprint field is missing or malformed.** The check fails with the page named,
  rather than treating the page as fresh.
- **Two PRs both refresh the same page against different source versions.** The second to merge
  fails the check on its rebased branch, and is refreshed again. This is a normal merge conflict
  and not a special case.

## Requirements *(mandatory)*

### Functional Requirements

**Freshness check**
- **FR-001**: Every summary page that is built on a source document MUST record a fingerprint of
  that source's committed contents.
- **FR-002**: The fingerprint MUST cover only the page's single declared source. Other files the
  page mentions MUST NOT be fingerprinted.
- **FR-003**: The required bundle check MUST fail when any summary's recorded fingerprint differs
  from its source, or when the fingerprint is missing or malformed. The failure MUST name the page,
  the source and the refresh command.
- **FR-004**: The check MUST cover the whole tree on every run, on PRs and on `main`, not only the
  files a PR touched.
- **FR-005**: The check MUST be offline, free (no model calls), and need no credential.
- **FR-006**: A summary's declared source MUST be a single file. A directory source MUST fail the
  governance check.
- **FR-007**: No summary's source may be a file rewritten by an automated writer: CD's deploy-digest
  files, or files Renovate manages. The governance check MUST fail if one is declared.

**Refresh**
- **FR-008**: A refresh tool MUST:
  - (a) list the stale pages, computing staleness exactly as the check does;
  - (b) show a stale page's source diff since its recorded fingerprint;
  - (c) record a page's fingerprint and timestamp without writing any prose.
- **FR-009**: The check and the refresh tool MUST share one definition of the fingerprint.
- **FR-010**: A project skill MUST describe the refresh procedure: read the diff, update only what
  it invalidates, follow the bundle's writing brief, record, commit in the same PR. The skill MUST
  explicitly allow a fingerprint-only change when the source change does not affect the page.
- **FR-011**: The project instructions (CLAUDE.md index, AGENTS.md) MUST tell a session of the
  refresh duty before CI does, and MUST no longer say that derived pages are never hand-edited.

**Retirement**
- **FR-012**: The following MUST be removed from the repository and gitignored:
  - the Claims sidecars,
  - the page manifest,
  - the generator's run marker.
- **FR-013**: The `sources:` front-matter list MUST be removed from every summary page.
- **FR-014**: The check that fails hand edits to generated pages (V16) MUST be removed. The
  redundant drift warning (V12) MUST be retired in favour of FR-003.
- **FR-015**: The regeneration policy MUST permit coding sessions to write summary pages. Governance
  rules that tie meaning to the writer MUST be updated at the cause, not deleted.
- **FR-016**: The machinery that exists only to make unattended runs affordable MUST be deleted or
  frozen. This covers:
  - the quiet-trigger,
  - the backlog, escalation and cooldown maps in the run record,
  - drift re-planning,
  - forced-page handling,
  - the Claims audit.
  The guard tests that protected that machinery MUST be removed together with it, or re-pointed
  at what replaces it.

**Manual rebuild**
- **FR-017**: The maintenance workflow MUST have no schedule and no push trigger. It MUST be started
  only by manual dispatch, with a list of pages.
- **FR-018**: A manual rebuild MUST regenerate only the named pages and their directory index
  entries. Each page it writes MUST get a current fingerprint and no `sources:` list. The rebuild
  MUST open a PR for review and never merge it.
- **FR-019**: A manual rebuild MUST report which named pages landed. It MUST NOT persist any state
  for a later run.

**Records and switch-over**
- **FR-020**: ADR-0004 MUST record:
  - the progression, with dates and the measured driver of each step,
  - this decision,
  - the reversal of the Claims half of ADR-0003.
  ADR-0003 MUST link to it as partly superseded.
- **FR-021**: The maintenance runbook and the bundle's writing brief (`openwiki/INSTRUCTIONS.md`)
  MUST describe the new model, including where a new learning goes now that sessions write
  summaries.
- **FR-022**: The switch-over MUST:
  - refresh every currently stale summary,
  - fingerprint every summary,
  - turn the check on in the PR that completes this.
  `main` MUST pass the check from that merge onwards.
- **FR-023**: `process/spec-driven-development.md` MUST become a hand-written canonical page with no
  source fingerprint. Backlog item #739's parked status is closed out accordingly. Backlog item #977
  is closed as superseded, with the reason stated.

### Key Entities

- **Summary page (derived)**: a page in the bundle that is built on exactly one source file. It
  carries a source reference, a source fingerprint and a timestamp.
- **Canonical page**: a hand-written page with no source. It is listed in the protection manifest
  and is unaffected by the freshness check.
- **Source fingerprint**: a content hash of the source file as committed, under a stated
  line-ending normalisation. It changes only when the source's content changes.
- **Regeneration policy**: the file stating which writers may change which paths. After this
  feature, it names coding sessions as a writer of summary pages.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Routine summary freshness costs **$0** in model API spend. In the 4 weeks after the
  switch-over, the only paid wiki runs are ones the operator dispatched by hand. Compare a baseline
  of about $37 a week.
- **SC-002**: **100%** of summary pages carry a current fingerprint at the switch-over merge, and
  `main` stays green on the bundle check for every merge after it.
- **SC-003**: **0** PRs reach `main` that change a summary's source without refreshing that summary.
  This is verified at 4 weeks by replaying the check across every first-parent merge since the
  switch-over.
- **SC-004**: **0** `main` failures of the bundle check caused by an automated commit (CD promote,
  Renovate) in the 4 weeks after switch-over.
- **SC-005**: A session refreshes one stale summary, from listing it to recording it, in **under 10
  minutes** of session time for a typical documentation change.
- **SC-006**: The bundle check's added run time stays **under 5 seconds** on the full tree.
- **SC-007**: The repository shrinks by the bookkeeping removed, about 4.5 MB of sidecars plus the
  manifest, and nothing in the repository reads the removed files.

## Assumptions

- Coding sessions run on the operator's Max subscription. The rule that the API key is used only by
  the movie assistant and OpenWiki is unchanged. Only a manual rebuild uses it.
- The fingerprint proves a page was refreshed against the current source, not that the refresh is
  correct. Correctness rests on the skill's procedure and on PR review, where a fingerprint-only
  change is visible. The operator accepted this.
- `architecture/data-model.md` (source today: a directory) is re-pointed at a single file or made
  canonical. The plan chooses, from what the page actually summarizes.
- The manual rebuild keeps the existing generator, provider and verification. This feature removes
  what is unattended, not what makes a rebuild correct.
- The roughly 30 stale pages come from openwiki's forced-page list and the maintenance backlog on
  2026-11-09. The catch-up refreshes whatever the list command reports at the time.
- Item #977 (scoring the daily schedule's weekly target) is superseded. The schedule it measured no
  longer exists.
