# Feature Specification: Claude Code token usage capture and efficiency analysis

**Feature Branch**: `105-cc-token-usage-capture`

**Created**: 2026-11-21

**Status**: Draft

**Input**: User description: "docs/proposals/MCM-Claude-Code-Token-Usage-Proposal.md"

## Context

AI coding in this repository runs on a flat-rate subscription with plan limits, across several
concurrent Claude Code sessions in the shared dev container. Nobody can say today how many tokens a
session used, which kinds of work consume the most, or whether a change to always-loaded instructions
made sessions cheaper. Claude Code already records every session locally, but those records live only
on the container's volume, are pruned after about a month, and are lost entirely when the sandbox is
removed.

This feature captures per-session usage automatically, keeps it durably on the homelab, makes it
queryable from inside a session, relates it to the kind of work and its outcome, and produces
evidence-backed recommendations that lower tokens per outcome. The proposal compares the candidate
approaches and gives the recommended architecture; this spec states what the result must do.

## Clarifications

### Session 2026-11-21

- Q: Should spec 105 cover all four stories, or stop before recommendations? → A: All four stories here. The spec stays open until the Story 4 exit (SC-008) is met after the baseline period.
- Q: Which Claude Code sessions should be captured? → A: Dev container only. Windows-host sessions are out of scope.
- Q: For each file a tool touches, top-level area or repo-relative path? → A: Top-level repository area only.
- Q: Where should usage records live on the homelab? → A: A new dedicated store, separate from production observability and included in the daily backup; not the existing LLM-observability instance.
- Q: One credential for capture and queries, or separate write and read credentials? → A: One credential shared by capture and in-session queries, able to insert, update and read but never delete.
- Q: How are requests to the store authenticated, given the constitution requires OAuth2/OIDC tokens for internal endpoints? → A: With short-lived tokens issued by the project's existing identity provider to a dedicated non-interactive client (client-credentials grant). Capture holds one client credential, obtains a token only when its cached token nears expiry, and the token carries a role that can insert, update and read but never delete. The store verifies every token against the identity provider's signing keys.
- Q: Can several sessions be tied to one feature, with feature metrics the sum of its sessions? → A: Yes. Usage is attributed to a feature per turn, not per session, from the branch of the worktree the turn actually worked in, so a session started in the main checkout that drives a worktree counts toward that worktree's feature, and a session that works on two features is split between them. Feature metrics are the sum of every turn attributed to the feature, across all sessions.
- Q: Which features are tracked: only spec-driven ones? → A: Every feature branch, whether or not it has a spec (docs-only, backlog fixes, infra, wiki). A spec is an optional attribute of a feature. Work done on the main branch belongs to no feature and is reported as its own bucket.
- Q: How are reused branch names (e.g. recurring dependency-update branches, a fix branch name used again) kept apart? → A: A feature is a branch name plus the pull request it ends in. Turns on a branch belong to its current unmerged run; after that run's pull request merges, the next session on the same name starts a new feature. Before a pull request exists, the feature is identified by branch name and the date first seen, and it adopts the pull request once one is opened.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every session is captured and kept, with no manual step (Priority: P1)

As the developer, I want every Claude Code session in the dev container (any worktree, any number
running at once) to have its token usage recorded and stored durably off the container, without me
starting or stopping anything, so that usage history accumulates and survives container rebuilds and
sandbox removal.

**Why this priority**: Nothing else works without data, and data only accumulates from the day capture
starts. It is also useful by itself: a durable per-session history answers "how much did that cost".

**Independent Test**: Run several ordinary sessions (including two at once, and one ended by the
sandbox idle-stop), then confirm the durable store holds one record per session, with token totals
that match an independent reference tool's totals for the same sessions, and a capture-health check
reports nothing unshipped.

**Acceptance Scenarios**:

1. **Given** the feature is merged, **When** a developer starts and ends a session normally, **Then** the durable store holds that session's record (start, end, branch, worktree, model, token totals by type, main vs subagent split, turns, end reason) with capture status "complete", and the developer did nothing beyond working normally.
2. **Given** a session ended without a clean exit (e.g. the sandbox VM idle-stopped), **When** any later session starts, **Then** the missing part of the earlier session is captured, and until then its status is "partial", never a total of zero.
3. **Given** transcripts from sessions that predate the feature are still on the volume, **When** the first session after merge starts, **Then** those sessions are backfilled without a separate action.
4. **Given** the homelab is unreachable, **When** sessions run, **Then** sessions are unaffected and their records are queued locally and delivered on a later trigger once the homelab is reachable again.
5. **Given** several sessions whose capture triggers overlap in time, **When** all have been shipped, **Then** row counts and token totals equal those of a single serial run over the same transcripts (no duplicates, no double counting).
6. **Given** any capture run, **When** its records are inspected, **Then** they contain no prompt text, assistant text, tool output, file contents or command arguments.

---

### User Story 2 - Ask about usage during a session (Priority: P2)

As the developer, I want to ask Claude mid-session how heavy this session is, how it compares with my
usual sessions of the same kind, and what recent sessions and trends look like, so that I can react
while the work is still in progress.

**Why this priority**: Turns stored data into decisions at the moment they are cheapest to act on.
It depends on Story 1 for history but answers "this session" from local data alone.

**Independent Test**: In a session with history in the store, invoke the usage capability for "now",
"recent sessions", "trend by week" and "compare two sessions"; each answers in a compact table about
the right session. Disconnect the homelab and confirm "now" still answers and history degrades to a
single clear "unreachable" line.

**Acceptance Scenarios**:

1. **Given** two sessions running at once, **When** each asks for "this session so far", **Then** each sees only its own numbers.
2. **Given** a session in progress, **When** the developer asks for "now", **Then** they see tokens by type, current context size, the largest tool outputs, the subagent share, and a comparison with the median of the developer's recent sessions when history exists — narrowed to sessions of the same kind of work once activity labels exist (Story 3).
3. **Given** history in the store, **When** the developer asks for recent sessions filtered by branch, spec, activity or repository area, or for a trend by week, activity, spec or area, **Then** the answer is a fixed-width table capped at a few rows, with a full machine-readable form available on request. (Filtering and trends by activity and spec need Story 3's labels and features and arrive with it.)
4. **Given** the developer explicitly asks to sync, **When** the sync runs, **Then** the current session is shipped immediately regardless of the normal shipping cap. The capability never syncs on its own initiative.
5. **Given** the developer asks for capture health, **When** the check runs, **Then** it reports the time of the last successful ship, the depth of the local queue, and any transcript with unshipped data.
6. **Given** the usage capability is not invoked, **When** a session runs, **Then** it adds nothing to the session's context.

---

### User Story 3 - Usage is attributed to the kind of work, the feature, and its outcome (Priority: P3)

As the developer, I want each turn labelled with the kind of work it was (specify, plan, implement,
test, CI diagnosis, explore, infra, docs, backlog, git, conversation) and attributed to the feature it
worked on, and each feature — every feature branch, with or without a spec — linked to its outcomes
(commits, tasks completed where a task list exists, pull request merged, CI red/green, backlog items
closed), so that I can see what a whole feature cost across all the sessions that worked on it,
compare tokens per outcome across like work, and see trends on a dashboard outside a session.

**Why this priority**: Raw totals cannot tell an expensive-but-productive session from a wasteful
one. Attribution is what makes the efficiency questions answerable; it builds on Stories 1 and 2.

**Independent Test**: Over a set of fixture and real sessions, every turn carries exactly one label
or "unclassified" and exactly one feature or "no feature"; unclassified turns are a small minority and
are listed; a feature worked on by three sessions shows totals equal to the sum of its attributed
turns; a merged feature shows its outcomes; the dashboard shows weekly trends by activity, area and
feature.

**Acceptance Scenarios**:

1. **Given** a captured turn, **When** labelling runs, **Then** the turn receives exactly one activity label from deterministic, ordered rules, or "unclassified", and a session is described by its mix of labels weighted by tokens.
2. **Given** a turn that matches no rule, **When** a report is produced, **Then** it is shown as unclassified, never guessed into a label.
3. **Given** three sessions that each worked on the same feature branch, **When** the developer asks for that feature's metrics, **Then** they see its session count and its tokens by type, main vs subagent, weighted tokens and turns, each equal to the exact sum of the turns attributed to the feature, alongside its outcomes recorded once for the feature.
4. **Given** a session started in the main checkout that worked in one feature's worktree and then in another's, **When** it is captured, **Then** each turn is attributed to the feature of the worktree it worked in, and the session's tokens are split between the two features with nothing counted twice or dropped.
5. **Given** a feature branch with no spec (e.g. docs-only work), **When** its outcomes are collected, **Then** commits, lines changed, pull request, CI runs and backlog items are recorded, and tasks completed is recorded as "not applicable", never as zero.
6. **Given** a feature linked to a spec, **When** its outcomes are collected, **Then** the spec is recorded on the feature and tasks completed comes from that spec's task list; a feature can be queried by branch or by spec.
7. **Given** turns that worked only on the main branch, **When** feature metrics are reported, **Then** those turns are counted in their sessions' totals and in a separate "no feature" bucket, and in no feature.
8. **Given** a developer wants to name a session's activity by hand, **When** they tag it, **Then** the tag is stored, and no metric depends on tags existing.
9. **Given** captured history, **When** the developer opens the usage dashboard on the homelab, **Then** it shows trends by week, activity, feature, spec and area from the same data the in-session capability uses.

---

### User Story 4 - Evidence-backed recommendations, tracked as experiments (Priority: P4)

As the developer, I want the system to flag where tokens per outcome are poor against my own baseline
(heavy always-loaded context, unfiltered tool output, context rebuilt after idle gaps, re-read files,
costly delegation, premium models on low-judgment work, rework after red CI), propose a specific change
with its expected effect, and then show before/after for any change I accept.

**Why this priority**: This is the end goal, but it needs a baseline of at least two weeks of data,
so it necessarily comes last.

**Independent Test**: With a baseline in place, ask for findings; each finding names a rule, its
evidence and sample size, a suggested change, and the metric to watch. Accept one; after further
sessions, findings show its before/after on both the target metric and its quality counter-metric.

**Acceptance Scenarios**:

1. **Given** fewer than two weeks of data, or fewer samples than a rule's minimum for an activity label, **When** findings are requested, **Then** the answer states "not enough data" instead of a recommendation.
2. **Given** a metric above the developer's own 90th percentile for the same activity label with enough samples, **When** findings are requested, **Then** the rule fires with its evidence, sample size, suggested change and metric to watch, worded as a hypothesis.
3. **Given** an accepted recommendation, **When** it is recorded, **Then** it is stored as an experiment with a start date, target metric and baseline, and later findings show before and after.
4. **Given** an experiment that lowered tokens but raised rework share or lowered the CI first-pass rate, **When** findings are shown, **Then** it is reported as a regression.
5. **Given** plan-limit figures are available to the session, **When** usage is captured, **Then** the share of the plan limit consumed per activity is recorded.

---

### Edge Cases

- A session runs on a branch cut before the feature merged (no capture triggers): a later session's sweep still captures it.
- The transcript format changes after a tool upgrade: unknown fields degrade the session to "partial" capture, and the reference-tool cross-check flags any drift in totals; numbers are never silently wrong.
- A turn is interrupted, or a single turn runs for most of an hour: the homelab may lag by the length of the turn; "now" is unaffected.
- The first backfill covers about a month of transcripts: it runs in batches at low priority and does not slow the starting session.
- Several sessions start together: the catch-up sweep is done once, not once per session.
- Two capture runs flush the local queue together: each queued batch is delivered exactly once in effect, and no batch is lost.
- A range of a transcript is shipped twice: totals do not double.
- Local capture state is deleted or corrupted: the next run re-ships from the transcript and the store converges to the same result.
- A capture run fails or times out: the session continues normally and prints nothing.
- Transcripts are pruned locally after about 30 days: the durable store keeps the history.
- A branch name is reused after its pull request merged (e.g. a recurring dependency-update branch): the later work is a new feature, and the merged one's totals do not change.
- A turn names no worktree path (a question answered from context, or only path-less calls such as a forge-API script run from the main checkout): it inherits the feature of the previous turn in the same session; only a session's first such turns fall back to the transcript's branch, so path-less work in the middle of a feature is never credited to "no feature".
- A turn touches two worktrees: it is attributed to the worktree with the most tool activity, and the tie-break is recorded so the rule can be audited.
- A feature branch is deleted without a pull request: its feature keeps its totals and is shown as abandoned.

## Requirements *(mandatory)*

### Functional Requirements

**Capture (Story 1)**

- **FR-001**: The system MUST capture token usage for every Claude Code session run in the dev container, triggered by the coding tool itself, with no manual action at session start or end. Sessions run directly on the Windows host are out of scope.
- **FR-002**: Capture MUST record, per session: start and end time, entry point (the editor extension or command line the session ran in), starting worktree and branch, tool version, models used, token totals for each of the four reported types (input, output, cache write, cache read) split into main session and subagents, turn count, compaction count, end reason, and capture status.
- **FR-003**: Capture MUST record, per turn: time, duration, idle gap before it, tokens by type, context size, model; and per tool within a turn: tool name, command family (first word of a shell command only), call count, result size, and whether output was compressed by the token-compression layer; and per turn the top-level repository areas its tools touched. File paths MUST NOT be stored; per-file measures such as the re-read rate are computed inside the container and only their counts are shipped.
- **FR-004**: Capture MUST record skill invocations per session (skill name, count, first turn).
- **FR-005**: Each session MUST carry a capture status of complete, partial or not captured. Missing data MUST be reported as not captured, never as zero.
- **FR-006**: Capture MUST catch up any transcript data not yet shipped, including sessions that ended without a clean exit and sessions from before the feature existed, on the next session start.
- **FR-007**: Capture MUST NEVER block, slow noticeably, fail, or print into a coding session; every failure path ends silently and successfully.
- **FR-008**: Capture MUST be incremental (only new transcript data is processed per run) and idempotent (re-shipping any range yields the same stored result; totals are derived, never incremented).
- **FR-009**: Capture MUST remain correct when several sessions' capture runs overlap, including overlapping catch-up sweeps and queue flushes.
- **FR-010**: When the durable store is configured but unreachable, records MUST be queued locally on the persistent volume and delivered on a later run; the queue MUST be capped in size, dropping the oldest records first and reporting every drop in the capture-health check (a dropped range is re-derived from the transcript by a later sweep while the transcript still exists). When the store is not configured at all, nothing is queued: the transcripts remain the source and the first sweep after configuration catches up. Network attempts MUST time out quickly and back off.
- **FR-011**: Shipping from routine triggers MUST be capped at once every 15 minutes per session (plus once at session end), and catch-up sweeps at once every 15 minutes per container; between ships a routine trigger does no parsing and no network work.
- **FR-012**: Records leaving the container MUST NOT contain prompt text, assistant text, tool output, file contents or command arguments.
- **FR-013**: Usage records MUST be stored durably in a dedicated store on the homelab, outside the dev container and separate from production observability, so they survive container rebuilds and sandbox removal, and MUST be included in the homelab's daily backup.
- **FR-014**: The durable store MUST be reachable only over the private tailnet and MUST require, on every request, a short-lived OAuth2/OIDC access token issued by the project's identity provider and verified by the store against that provider's signing keys. A single non-interactive client serves both capture and in-session queries; its tokens MUST carry a role that can insert, update and read usage data and MUST NOT be able to delete it. A token is obtained only when the cached one is missing or near expiry, so the identity provider being unavailable delays shipping (records are queued per FR-010) but never affects a session.
- **FR-015**: The store's address, the token endpoint's address and the client credential MUST come from the environment and MUST NOT appear in the repository or on a command line; a cached token MUST be stored readable only by the container user and MUST never be logged.
- **FR-016**: A capture-health check MUST report the time of the last successful ship, local queue depth, and every transcript with unshipped data.
- **FR-017**: Capture totals MUST agree with an independent reference tool's per-session totals on a set of fixture transcripts, checked automatically.

**In-session query (Story 2)**

- **FR-018**: Users MUST be able to ask, from inside a session, for: this session so far; recent sessions (filterable by feature, branch, spec, activity, area and time window); a single feature, or features over a time window; trends (by week, activity, feature, spec or area); a side-by-side comparison of two sessions, specs or date ranges; open findings; an immediate sync; a manual session tag; and capture health.
- **FR-019**: Every in-session answer MUST identify the current session explicitly and MUST NOT infer it (e.g. from the most recent transcript).
- **FR-020**: "This session so far" MUST work from local data when the durable store is unreachable; history queries MUST then answer with a single clear "unreachable" line.
- **FR-021**: In-session answers MUST be compact (fixed-width, capped at a few rows) with a full machine-readable form on request, and MUST redact host names.
- **FR-022**: The usage capability MUST add nothing to a session's context unless invoked, and the immediate sync MUST run only at the developer's explicit request.

**Attribution and outcomes (Story 3)**

- **FR-023**: Each turn MUST be assigned exactly one activity label by deterministic, ordered rules (specify, clarify, plan, tasks, implement, test, CI diagnosis, explore, infra and dev environment, docs and wiki, backlog, git and pull request, conversation), or "unclassified".
- **FR-024**: Unclassified turns MUST be reported so the rules can be improved.
- **FR-025**: Outcomes MUST be recorded per feature, not per session: commits and lines changed, pull request opened and merged, CI runs red and green, and backlog items closed for every feature, and tasks checked off only for a feature with a task list (otherwise "not applicable", never zero) — gathered from sources the repository already uses.
- **FR-026**: A weighted-token figure MUST be derived from the four token types using a dated weight table, so that a cache read does not count like an output token; it is a comparable unit, not a bill.
- **FR-027**: A homelab dashboard MUST show usage trends by week, activity, feature, spec and area from the same data the in-session capability reads.

**Features (Story 3)**

- **FR-034**: A feature MUST be any branch other than the main branch on which work was done, whether or not it has a spec. A spec MUST be an optional attribute of a feature, taken from the worktree's recorded active spec or from a spec directory matching the branch, and from the branch's number prefix only as a fallback.
- **FR-035**: A feature MUST have a stable identity created when work on its branch first appears. It MUST adopt its pull request once one is opened, without changing identity. After that pull request merges (or the branch closes unmerged or disappears), later work on the same branch name MUST start a new feature, leaving the earlier feature's totals unchanged.
- **FR-036**: Each turn MUST be attributed to exactly one feature, or to "no feature", from the branch of the worktree the turn's path-bearing tool calls worked in. A turn with no path-bearing tool call (no tool call at all, or only calls that name no path) MUST inherit the previous turn's feature in the same session; only when there is no earlier turn does it fall back to the transcript's branch for that turn. Work on the main branch MUST be attributed to "no feature". The rule that decided each attribution MUST be recorded.
- **FR-037**: Feature metrics MUST be the exact sum of all turns attributed to the feature, across every session that contributed: session count, tokens by type, main vs subagent, weighted tokens, turns, and activity mix, shown together with the feature's outcomes.
- **FR-038**: Users MUST be able to query a single feature (by branch, spec or feature identity) and to list features over a time window, filterable by whether they have a spec, both from inside a session and on the dashboard.
- **FR-039**: Efficiency comparisons MUST use each outcome only where it applies (tokens per completed task only for features with a task list; tokens per merged pull request for all) and MUST compare features of the same kind (with or without a spec, similar activity mix).

**Findings (Story 4)**

- **FR-028**: The system MUST compute, against the developer's own per-activity baseline (median and 90th percentile): tokens per outcome, rework share, session floor (context at first turn), cache-read ratio, idle tax, context growth and compactions, tool-output weight with compression share, re-read rate, subagent return ratio, model mix by activity, and (when available) plan-limit burn.
- **FR-029**: A rule MUST fire only above a minimum sample size for its activity label; below it, and during the first two weeks of data, the answer MUST be "not enough data".
- **FR-030**: Each finding MUST state its rule, evidence, sample size, suggested change and the metric to watch, worded as a hypothesis.
- **FR-031**: Every token metric MUST be paired with a quality counter-metric; a change that lowers tokens but worsens rework share or the CI first-pass rate MUST be reported as a regression.
- **FR-032**: Accepted recommendations MUST be stored as experiments (start date, target metric, baseline) and later findings MUST show before and after.
- **FR-033**: Where the session is given plan-limit figures, the share of the plan limit consumed per activity MUST be recorded.

### Key Entities *(include if feature involves data)*

- **Session**: One Claude Code session. Times, entry point, starting worktree and branch, tool version, models, token totals by type (main vs subagent), turn and compaction counts, end reason, capture status, optional manual tag. Contributes to zero, one or several features through its turns.
- **Turn**: One user prompt and all the work done in response. Time, duration, idle gap, tokens by type, context size, model, repository areas touched, activity label, feature (or "no feature") and the rule that attributed it. Belongs to a session.
- **Tool use**: Aggregated use of one tool within one turn. Tool name, command family, call count, result size, compression flag. Belongs to a turn.
- **Skill use**: One skill's invocations within a session. Skill name, count, first turn.
- **Feature**: One piece of work on a branch, identified by branch name plus the pull request it ends in (or branch name and first-seen date before a pull request exists). Optional spec. Outcomes: commits, lines changed, tasks completed (only with a task list), pull request and merge state, CI runs red and green, backlog items closed. Has many turns, from one or more sessions; its metrics are the sum of those turns.
- **Finding**: One rule hit in an analysis run. Rule, evidence, sample size, recommendation, status, metric before and after; an accepted finding is an experiment with a start date and baseline.
- **Weight table**: Dated ratios used to turn the four token types into weighted tokens.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After one week of normal use, 100% of sessions run in the dev container appear in the durable store, and the capture-health check reports no transcript with unshipped data older than one day.
- **SC-002**: On the fixture transcripts, per-session token totals match the independent reference tool exactly for every token type.
- **SC-003**: Overlapping capture runs over the same transcripts produce exactly the same row counts and totals as one serial run.
- **SC-004**: No shipped record contains prompt text, tool output, file contents or command arguments, verified by an automated check on every change to the capture logic.
- **SC-005**: Capture adds no visible output to any session, and a routine end-of-turn trigger completes in under one second when not shipping.
- **SC-006**: The developer can get "this session so far" mid-session in a single request, answered in under five seconds, with the homelab reachable or not.
- **SC-007**: After the baseline period, at most 10% of turns by weighted tokens are unclassified.
- **SC-010**: For every feature, its reported totals equal the sum of its attributed turns exactly, and the totals of all features plus the "no feature" bucket equal the totals of all sessions exactly.
- **SC-011**: On the fixtures, 100% of turns that worked in a feature's worktree are attributed to that feature, including turns of sessions started in the main checkout, and features without a spec are listed alongside those with one.
- **SC-008**: Within four weeks of capture starting, the first findings report contains at least one finding with evidence and sample size, and at least one accepted change is tracked as an experiment with before/after figures.
- **SC-009**: Usage history survives a dev container rebuild and a sandbox removal with no loss beyond sessions still queued locally at that moment.

## Assumptions

- **Scope covers all four stories in this one spec; delivery is phased.** Capture (P1) ships first so data accumulates while P2–P4 are built; P4's rules are enabled only after a two-week baseline, so the spec closes only when SC-008 is met. A short measurement phase before planning verifies the proposal's open technical assumptions (transcript fields, subagent storage, which triggers fire on which entry paths, session identity in skills, network-policy granularity, plan-limit availability, actual transcript retention, trigger cost).
- **Data classification**: usage records are **internal** — names, counts, sizes, labels and outcome figures about the developer's own work, never content. That classification is why the store requires identity-provider-issued tokens (FR-014) and is reachable only over the tailnet, and why no record may carry content (FR-012).
- **Assistants**: Claude Code only; Codex and OpenCode are out of scope.
- **Retention**: turn-level records are kept indefinitely; volume is small for one developer.
- **Units**: on the subscription, dollar figures are notional; tokens, weighted tokens and plan-limit share are the units of analysis.
- **Operator steps outside the repository**: the developer registers the capture client in the production identity provider (whose realm is configured by hand), adds the store address, token endpoint and client credential to the sandbox environment, allows the homelab endpoint in the sandbox network policy, and adds the new store to the homelab backup script. The feature documents these in a runbook.
- **Small samples**: one developer produces few sessions per label per week and model behaviour varies between identical runs; findings are hypotheses with stated sample sizes.
- **Dependencies**: the tool's local session transcripts and lifecycle triggers, the homelab deployment mechanism and dashboard host already in place, the forge API with the existing read access for outcomes, and the existing local token-compression layer whose coverage is measured.
