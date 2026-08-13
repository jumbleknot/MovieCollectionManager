# Feature Specification: restore the dependency-security maintenance loop

**Feature Branch**: `057-dependency-security-loop`

**Created**: 2026-08-13

**Status**: Draft

**Input**: Backlog items **#160**, **#153**, **#152** and **#154**
(`node scripts/backlog.mjs show <n>`), taken as one feature because they are four faults in a single
loop rather than four unrelated chores.

## Context

This repository keeps its dependencies patched through a loop with four moving parts: a bot that
proposes updates, a schedule that lets it act, an override map that pins transitive floors the bot
cannot reach, and a gate that holds time-boxed accepted risks until they are remediated. Three of
those parts are broken and the fourth only speaks up on the morning it starts blocking everyone.

Each item reads as minor on its own. Together, the routine-patching half of the supply-chain posture
has been off since **2026-07-11**, and the half that still works is being produced by a bot running
outside its supported engine.

### The four faults, measured

| # | Fault | Evidence |
| --- | --- | --- |
| **#160** | The bot fails on every run — `renovate@44.14.12` requires `node ^24.11.0`, the job inherits the container's `v22.23.2` | Run 1587 (task 5278), `schedule`, 2026-08-09T03:50:08Z, exit 1, `EBADENGINE` then `Unsupported node environment` |
| **#153** | The bot is never awake inside its own permitted window | `renovate.yml:34` runs `0 3 * * *` (03:00 UTC); `renovate.json:16-17` permits `* 3 * * 5` in `America/New_York` = **07:00-07:59 UTC Friday**. The sets never intersect |
| **#152** | Two accepted risks expire **2026-08-31**, and the bot structurally cannot propose their fix | `security/sast/allowlist.yaml:111-121`. Renovate extracts **zero** deps from `pnpm-workspace.yaml`, so no `overrides:` floor is ever bumped automatically — **see the correction below; the conclusion holds, the stated reason does not** |
| **#154** | Expiry is binary — full suppression until the date, hard fail the next morning, no signal between | `check-sast-findings.mjs:80` and `check-infra-image-findings.mjs:89`: `if (entry.expiry && entry.expiry < now) return false;` |

### Why the loop looked healthy

Renovate's `vulnerabilityAlerts` preset defaults to an **empty** schedule, so security PRs bypass the
window entirely. Those kept landing — #121 (08-01), #141 (08-08) — while every routine update silently
deferred. The bot was visibly working, which is what masked #153 for four weeks. Item #29's dashboard
records the cost precisely: **eight** update groups sitting under "Awaiting Schedule" with
`unschedule-branch=` markers, across four Friday windows (07-17, 07-24, 07-31, 08-07) that produced
nothing.

The two faults compound. #153 leaves only the schedule-exempt security path working; #160 means that
remaining path is served by an unsupported Renovate.

### The failure mode all four share

**Each fault announces itself at the moment of maximum disruption, or not at all.** A schedule that
never opens is silent by construction. A nightly red job is the alarm people stop reading. An expiry
suppresses at full strength and then blocks every branch — usually surfacing on someone else's
unrelated PR. And the allowlist file itself records a fifth variant, discovered the hard way: the
aiohttp/cryptography entries re-blocked **early** because pip-audit switched from CVE ids to PYSEC
aliases, so an entry keyed on an exact advisory id *"does not expire, it just quietly matches
nothing"*.

This feature's through-line is therefore not "fix four bugs" but **restore the loop and make its
deadlines legible before they bite**.

### What this feature must not do

**Reach green by renewing an acceptance.** Deleting an expiry date is how a time-box becomes
permanent. The two #152 entries must be removed because the underlying versions were raised, not
re-dated because the date was inconvenient. The one legitimate exception — no published fix exists —
is already modelled by the `image-size` pair and requires the evidence written into the
justification.

> **CORRECTION — 2026-08-13 (feature 058 / item #184).** The "extracts **zero**" claim above, and in
> the paragraph below and in `research.md`, is **false**, and it was inherited from item #152 rather
> than measured. Run **1704** (2026-08-13, head `6afc2c8`) extracted **twelve** dependencies from
> `pnpm-workspace.yaml` via Renovate's **built-in npm manager** — all ten keyed override floors plus
> `postcss` and `@expo/dom-webview` — and the Dependency Dashboard that run wrote lists pending
> updates for five of them. There is no zero baseline to improve on.
>
> The *conclusion* #152 drew survives: no `overrides:` floor is ever bumped automatically. The
> *reason* is different, and the difference matters. It is not that the file is invisible to the bot;
> it is that (a) the bot proposes only when the current range fails to satisfy the newest version, and
> a floor like `>=3.1.5 <4` satisfies every 3.x, and (b) it reasons about the manifest range, never
> the lockfile resolution. Every one of the five pending updates the dashboard listed was an
> *upper*-bound widening (`<4`→`<5`, `<7`→`<9`), never a floor raise.
>
> This mattered practically twice over: the false premise made a regex `customManager` look like a
> free win when it would in fact double-manage an already-extracted file, and it caused item #184 to
> be filed against the half-bump rather than against the stale lockfile that actually cost ten days of
> red. Feature 058 fixes the real fault. This text is left standing as the record of what was believed
> at the time — see `specs/058-dependency-refresh-loop/research.md` R6.

**Ship a Renovate manager that reports success while extracting nothing.** That is today's fault
exactly: Renovate lists `pnpm-workspace.yaml` under Detected Dependencies and extracts zero from it.
A custom manager must be proven to extract before it is trusted. The mechanism itself is not new
here — a custom manager already keeps `nx.json`'s pinned version in lockstep with its manifest
entry — so this is a second instance of a proven pattern, not an experiment.

**Half-bump a security control.** Each override floor is stored as a *range keyed on a range* —
the key encodes the vulnerable span, the value the patched floor. A manager that rewrites only the
value leaves the key naming a stale vulnerable range. That is precisely the failure the nx manager
exists to prevent: PR #141 raised one half of a pinned pair, the stale half won at runtime, and the
security update the PR existed for would not have taken effect. Inside an override map, both halves
must move together or the change must not be proposed at all.

**Put the new warning where nobody reads it.** A warning inside a green job's log is the same
non-signal the feature exists to remove.

### Scope note on SDD

All four items live in `scripts/`, `.forgejo/workflows/`, `security/` and `pnpm-workspace.yaml` —
outside the directories the SDD gate covers (`backend/`, `frontend/`, `agents/`, `mcp-servers/`,
`infrastructure-as-code/`). The lifecycle is being run here by choice, because a four-item cluster
touching a merge gate and a scheduled bot warrants a written contract, not because a gate compels it.

## Clarifications

### Session 2026-08-13

- Q: US4 — what counts as success for making override floors bot-visible, given the floors are ranges
  keyed on ranges? → A: Full bump, guarded by a consistency check. The manager rewrites the floor
  value, and a new consistency gate fails when the key's vulnerable range and the value disagree —
  the same belt-and-braces pairing the nx custom manager already has with
  `check-toolchain-consistency.mjs`.
- Q: How should unmatched-entry reporting behave when a scanner contributed no findings at all,
  making every one of its entries trivially unmatched? → A: Only evaluate scanners that produced at
  least one finding in that run. A skipped, failed or clean scanner reports nothing rather than
  flagging its whole entry set, so a red weekly check always means real allowlist hygiene.
- Q: How long should the warning window be? → A: 14 days. Keeping entries out of the window as much
  as possible is worth more than maximum lead time, because a check that is usually quiet is one
  whose red is still read. The accepted cost is that a remediation needing its own branch and build —
  the `image-size` pair being the live example — gets two weeks' notice rather than three.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The bot runs on an engine it supports (Priority: P1)

The nightly dependency bot completes without an engine error, so the one update path that still works
today — schedule-exempt security PRs — is produced by a supported Renovate rather than an
unsupported one, and the nightly job stops being a permanently-red alarm.

**Why this priority**: It is the only fault that makes the bot exit non-zero on every single run, and
it degrades the security path that all the other faults currently leave as the last line.

**Independent Test**: Dispatch the workflow and read the log — no `EBADENGINE` warning, no
`Unsupported node environment` error, exit 0. Requires none of the other stories.

**Acceptance Scenarios**:

1. **Given** the workflow runs in a runner container bundling Node 22, **When** a scheduled or
   dispatched run executes, **Then** the job installs its own Node satisfying Renovate's declared
   engine range and the run exits 0.
2. **Given** the toolchain step ordering, **When** corepack is enabled, **Then** it is provisioned by
   the explicitly installed Node rather than the container's bundled one.
3. **Given** a future engine bump inside the pinned major, **When** a maintainer reads the pin's
   rationale comment, **Then** the comment names the engine-bump residual risk and what covers it.

---

### User Story 2 - Routine updates are actually proposed (Priority: P1)

Base-image, Actions, Cargo, Python and JS patch/minor updates — described in `renovate.json` as "the
main security win" — get proposed again, instead of deferring forever into a window the bot is never
awake for.

**Why this priority**: Four weeks of routine patching has silently not happened, and nothing in the
system reports that absence.

**Independent Test**: A dry-run dispatch lists branches it *would* open; a real run inside the window
creates them and item #29's "Awaiting Schedule" section shrinks. Independent of Stories 3-5.

**Acceptance Scenarios**:

1. **Given** the permitted window in the bot's configuration, **When** the workflow's scheduled
   triggers are enumerated, **Then** at least one falls inside that window.
2. **Given** the nightly trigger exists to keep schedule-exempt security updates prompt, **When** the
   window trigger is added, **Then** the nightly trigger is retained rather than moved.
3. **Given** the host's clock does not observe daylight saving, **When** the boundary between summer
   and winter time is crossed, **Then** the trigger still lands inside the permitted window.
4. **Given** a comment previously asserted the schedules matched, **When** a maintainer reads the
   trigger, **Then** the comment describes what is actually true.

---

### User Story 3 - The two expiring acceptances are remediated, not renewed (Priority: P2)

The `fast-uri` and `ip-address` advisories are cleared by raising the versions in use, and their
allowlist entries are removed — so a regression re-blocks, and the merge gate does not turn red on
every branch on 2026-08-31.

**Why this priority**: It carries a hard external date (**2026-08-31**, 18 days from spec creation),
but unlike Stories 1-2 nothing is degraded until that date arrives.

**Independent Test**: Run the scan and the gate — neither advisory appears as a blocking finding *or*
as a suppressed one, and the entries are gone from the allowlist file.

**Acceptance Scenarios**:

1. **Given** an advisory affecting a transitive dependency, **When** an override floor is raised or
   added, **Then** the lockfile resolves that package to a version at or above the advisory's fixed
   version.
2. **Given** a remediated advisory, **When** its allowlist entry is handled, **Then** the entry is
   deleted rather than given a later expiry date.
3. **Given** these are toolchain transitives whose breakage surfaces at build time rather than in
   unit tests, **When** the floors are raised, **Then** the application still builds and the web E2E
   baseline is unchanged.
4. **Given** a resolved version published inside the release-age cooldown, **When** the lockfile is
   refreshed, **Then** that version is recorded in the cooldown exclusion list.
5. **Given** no fixed release exists for one of the advisories at implementation time, **When** that
   entry is handled, **Then** it is re-dated with the absence of a fix written into its
   justification — and only that entry.

---

### User Story 4 - Transitive override floors stop being invisible (Priority: P2)

The version floors that exist solely to hold vulnerable transitive dependencies down become visible
to the update bot, so the next advisory on a transitive produces a proposed change instead of a
hand-written bump discovered under deadline. Because each floor is a range keyed on the vulnerable
range it excludes, a new consistency check guarantees both halves move together — a proposal that
raises the floor while leaving the key naming a stale vulnerable span fails the check rather than
merging as a half-remediation.

**Why this priority**: Without it Story 3 is a one-off and this item is refiled at the next
transitive advisory — every such bump in the git log so far was hand-written. It is deliberately
separated from Story 3 so that a manager that cannot be proven does not block the dated remediation.

**Independent Test**: Validate the configuration, then run the bot in dry-run and read its extraction
count for that file. Success is a non-zero count naming the override entries; the pre-change baseline
is zero. The consistency check is testable on its own against a hand-written mismatched pair.

**Acceptance Scenarios**:

1. **Given** the override map holds version floors the bot currently cannot see, **When** the bot
   extracts dependencies, **Then** it reports a non-zero count of dependencies from that file.
2. **Given** a configuration change to the bot, **When** it is proposed, **Then** the configuration
   passes the bot's own validator before merge.
3. **Given** an override entry whose key names a vulnerable range and whose value names the patched
   floor, **When** the two disagree — the floor raised but the key left stale, or the reverse —
   **Then** a consistency check fails and names the offending entry.
4. **Given** a consistent override map, **When** the consistency check runs, **Then** it passes and
   does not block any change.
5. **Given** extraction cannot be demonstrated, **When** the story is closed, **Then** the limitation
   is documented and a follow-up backlog item is filed — rather than merging a manager whose zero
   extraction is indistinguishable from today's behaviour.

---

### User Story 5 - Deadlines announce themselves before they bite (Priority: P3)

Anyone accepting a time-boxed risk hears about it while there is still time to remediate, and anyone
hitting a newly-re-blocking finding is told it used to be suppressed and by whom — instead of meeting
an unexplained new failure on an unrelated branch.

**Why this priority**: It is the largest slice and the only one not in a workflow file, but nothing
is currently broken by its absence — it is the signal that would have prevented the other items from
being discovered late.

**Independent Test**: Extend both gates' existing selftest harnesses; each new behaviour is a case
that fails before the change and passes after, with no change to any gate's exit code on a normal
run.

**Acceptance Scenarios**:

1. **Given** an entry whose expiry falls inside the warning window, **When** the gate runs normally,
   **Then** the finding is still suppressed, the exit code is unchanged, and the entry is reported in
   a distinct section naming its id, expiry date, days remaining and who added it.
2. **Given** an entry whose expiry has already passed, **When** its finding re-blocks, **Then** the
   message states that the finding was suppressed until that date by an entry added by that person.
3. **Given** an entry that matches no finding in a run whose scanner did produce findings, **When**
   the gate runs, **Then** that entry is reported as unmatched — covering both a stale entry left
   after a real remediation and an entry whose scanner switched identifier namespace.
4. **Given** a scanner that produced no findings at all in a run — skipped, failed, or genuinely
   clean — **When** the gate runs, **Then** none of that scanner's entries are reported as
   unmatched, so the signal never fires for a reason unrelated to allowlist hygiene.
5. **Given** both gates implement expiry identically today, **When** the warning window is
   introduced, **Then** the window's length is defined in exactly one place and both gates behave the
   same way.
6. **Given** a warning printed inside a passing job is easy to miss, **When** the dedicated
   check mode runs on its weekly schedule, **Then** it exits non-zero and is visible as a failure.
7. **Given** the same job also serves pull-request triggers, **When** a pull request runs it,
   **Then** the check mode does not run and no pull request is newly blocked.

---

### Edge Cases

- **An entry both expiring-soon and unmatched.** Reported once per category with no duplicate line,
  and the dedicated check mode's exit code is non-zero either way.
- **An entry with no expiry at all.** Never reported as expiring; still eligible to be reported as
  unmatched, subject to the scanner-produced-findings guard.
- **A scan that fails or is skipped entirely.** Its entries are not reported as unmatched, so the
  weekly check does not go red claiming stale allowlist entries when the real fault is a scanner
  that never ran. That fault is the scanning job's to report, not this check's to misattribute.
- **An expiry exactly N days away, and exactly today.** Window boundaries are inclusive at both ends
  and covered by selftest cases, so "14 days" is not ambiguous.
- **A finding covered by two entries, one expired and one live.** Still suppressed; the expired one
  is reported as unmatched or expired, never as the reason the finding blocks.
- **The weekly check mode's first run after merge.** It is expected to be **green**, and to go red
  on **Friday 2026-08-28**. Eight entries carry expiries; Story 3 deletes the two dated 2026-08-31,
  leaving 2026-09-07 as the earliest, which enters a 14-day window on 2026-08-24 — the first Friday
  after that is 08-28. Both are predictions this feature can be judged against, and the entries that
  trip it first are the `image-size` pair whose remediation needs its own branch and a real build.
  That is the mechanism working exactly as intended, not a regression.
- **A daylight-saving transition between the trigger and the permitted window.** The window is wide
  enough that the trigger lands inside it in both summer and winter time.
- **The update bot proposes a change to the override floors it can now see.** Nothing in this
  repository auto-merges, so the proposal is reviewed like any other; the consistency check is what
  stops a half-bumped one being reviewable as correct in the first place.
- **A proposal raises the floor value but leaves the vulnerable-range key stale.** The consistency
  check fails and names the entry. This is the single most likely way the new manager causes harm,
  because the result still *looks* remediated.
- **A hand-written override edit introduces the same mismatch.** The check does not care who made the
  change — it validates the map, not the author, so the guard holds whether the bot or a person
  edited it.
- **The application fails to build after a floor is raised.** The floor is the cause, not the
  advisory; the correct response is a narrower version range, never deleting the override.

## Requirements *(mandatory)*

### Functional Requirements

**The bot's runtime (Story 1)**

- **FR-001**: The dependency-bot workflow MUST install an explicit runtime version satisfying the
  bot's declared engine range, rather than inheriting the runner container's bundled version.
- **FR-002**: That installation MUST use the same commit-pinned action reference and explicit-version
  convention every other workflow in the repository already uses.
- **FR-003**: The runtime installation MUST precede package-manager provisioning, so the package
  manager is provisioned by the installed runtime.
- **FR-004**: The existing rationale comment for the bot's major-version pin MUST record that a
  major-only pin does not protect against an engine-requirement bump inside that major, and name what
  does.

**The bot's schedule (Story 2)**

- **FR-005**: The workflow MUST carry at least one scheduled trigger that falls inside the bot
  configuration's permitted branch-creation window.
- **FR-006**: The existing nightly trigger MUST be retained, because schedule-exempt security updates
  depend on it running promptly.
- **FR-007**: The permitted window MUST be wide enough that the scheduled trigger falls inside it
  under both daylight and standard time, given the scheduler runs in UTC and does not observe
  daylight saving.
- **FR-008**: Any comment describing the relationship between the trigger and the permitted window
  MUST describe the relationship that actually holds.

**The remediation (Story 3)**

- **FR-009**: The override map MUST carry a floor for each of the two affected packages at or above
  its advisory's fixed version, and the lockfile MUST resolve both to it.
- **FR-010**: Both allowlist entries MUST be deleted rather than re-dated, so that a regression
  re-blocks the gate.
- **FR-011**: After remediation the scan and gate MUST report neither advisory as a blocking finding
  nor as a suppressed one.
- **FR-012**: Any resolved version published inside the release-age cooldown MUST be added to the
  cooldown exclusion list, so a clean install is not rejected.
- **FR-013**: The build and the web end-to-end baseline MUST be unaffected by the raised floors.

**The blind spot (Story 4)**

- **FR-014**: The bot's configuration MUST extract a non-zero number of dependencies from the file
  holding the override map, verified by a dry run rather than assumed from the configuration's
  presence.
- **FR-015**: The changed bot configuration MUST pass the bot's own configuration validator.
- **FR-016**: The bot MUST be able to propose raising an override floor's patched-version value, not
  merely observe the dependency.
- **FR-017**: A consistency check MUST fail, naming the offending entry, whenever an override
  entry's vulnerable-range key and its patched-floor value disagree — in either direction.
- **FR-018**: That consistency check MUST run where it blocks a half-bumped proposal before merge,
  and MUST pass silently on a consistent override map.
- **FR-019**: If FR-014 cannot be demonstrated, the limitation MUST be documented and a follow-up
  backlog item filed; a manager extracting zero MUST NOT be merged.

**The warning tier (Story 5)**

- **FR-020**: Both allowlist gates MUST report entries whose expiry falls within a warning window,
  naming entry id, expiry date, days remaining and the person who added it.
- **FR-021**: Reporting an expiring entry MUST NOT change any gate's exit code on a normal run, and
  MUST NOT newly block any pull request.
- **FR-022**: When a finding blocks because its only matching entry has expired, the gate MUST state
  that the finding was suppressed until that date and by an entry added by that person.
- **FR-023**: Both gates MUST report allowlist entries that matched no finding in the run, evaluating
  an entry only when its scanner produced at least one finding in that run — so a scanner that was
  skipped, failed or came back clean never causes its entries to be reported as unmatched.
- **FR-024**: The warning window's length MUST be defined in exactly one place and shared by both
  gates, which MUST behave identically.
- **FR-025**: A dedicated check mode MUST exit non-zero when any entry is expiring, expired or
  unmatched, covering both allowlists.
- **FR-026**: That check mode MUST run on a recurring schedule in a job where a failure is visible,
  and MUST NOT run on that job's pull-request trigger.
- **FR-027**: Every new behaviour in FR-020, FR-021, FR-022, FR-023 and FR-025 MUST be covered by a
  case in each gate's existing self-test harness. FR-024 is excluded deliberately: "defined in exactly
  one place" is a structural property verified by inspection, and no self-test case can assert it.
- **FR-028**: The warning window MUST be documented where someone adding an allowlist entry will
  read it, so they know when they will hear about it.

### Key Entities

- **Allowlist entry**: A time-boxed, justified suppression of one scanner finding. Carries a scanner
  or image, an advisory or rule id, a location or image pattern, a justification, who added it, and
  an optional expiry date. Has three lifecycle states relevant here — *active*, *expiring soon*,
  *expired* — plus an orthogonal property, *matched nothing this run*.
- **Override floor**: A minimum version forced onto a transitive dependency to hold it above a known
  vulnerable range. Exists only as a security control; every one was added to clear a specific
  blocking finding. Has **two halves that must agree** — a key naming the vulnerable range being
  excluded, and a value naming the patched floor being forced. Either half alone is a
  half-remediation.
- **Warning window**: The single span of time before an expiry during which an entry is reported but
  still suppresses.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A scheduled run of the dependency bot completes with exit code 0 and zero engine
  warnings or errors in its log.
- **SC-002**: Within one full schedule cycle after merge, the dashboard's "Awaiting Schedule" backlog
  of eight update groups is reduced to zero groups still awaiting, having become real proposals.
- **SC-003**: Neither of the two remediated advisories appears in the gate output as a blocking
  finding or as a suppressed one, and neither entry remains in the allowlist file.
- **SC-004**: The bot reports a non-zero dependency-extraction count for the override-map file, up
  from a measured zero before the change.
- **SC-009**: A deliberately mismatched override pair — floor raised, vulnerable-range key left
  stale — is rejected before merge and the rejection names the entry, so a half-remediation cannot
  reach the map by either bot or hand.
- **SC-005**: No allowlist entry in either file reaches its expiry date without having been reported
  at least the full warning window in advance — verifiable against the eight entries expiring between
  2026-08-31 and 2026-10-24 (five in the SAST allowlist, three in the infra-image allowlist).
- **SC-006**: A finding that re-blocks because of an expired entry names that entry and its former
  expiry, so no such failure requires reading the allowlist file to understand.
- **SC-007**: The gate's exit code on every existing pull request is unchanged by this feature — zero
  pull requests newly blocked.
- **SC-008**: The application builds and the web end-to-end baseline is unchanged after the override
  floors are raised.

## Assumptions

- **A fixed release exists for both advisories at implementation time.** If one genuinely does not,
  US3 scenario 5 applies to that single entry only — the `image-size` pair is the precedent.
- **The custom manager can be made to extract.** If a dry run cannot demonstrate it, FR-019 is the
  agreed outcome; this is why US4 is separated from US3 rather than bundled with it. The mechanism
  has a working precedent in this repository (the nx lockstep manager), so the risk is the shape of
  the override map, not custom managers as such.
- **The consistency check is a repository-side guard, not a bot feature.** It validates the override
  map wherever the map is changed, which is why it holds for hand edits as well as proposals — the
  same relationship the nx lockstep manager has with its toolchain-consistency gate.
- **The weekly host for the check mode is the existing Friday-scheduled scanning job**, since the
  wiki-maintenance workflow has no cron trigger at all. Any job with a real recurring schedule and a
  pull-request trigger that must stay unaffected satisfies FR-023 equally.
- **Fourteen days is the warning window** — a decision, not a default. The trade-off was taken
  deliberately: a check that is quiet most of the time keeps its red meaningful, and that is worth
  more here than maximum lead time. It remains one constant in one place, so revisiting it is a
  one-line change if two weeks proves too short in practice.
- **These two advisories were never assessed for exploitability**, and this feature does not assess
  them — it clears the acceptance by raising the versions. Re-triage is not in scope.
- **The runtime version already proven on this runner is used**, rather than introducing an untested
  one.

## Out of Scope

- Re-triaging the exploitability of any advisory, including the two being remediated.
- The other five live allowlist entries (`image-size` x2, `click`, and three infra-image entries).
  They gain the warning tier like every other entry, but their remediation is separately dated and
  separately owned.
- Bringing any other unmanaged configuration file under bot management.
- Changing which findings are blocking, or any severity mapping.
- A new publish path for the expiry warning. None is needed: the weekly scanning job already routes
  its failures to the digest channel, so a check mode that exits non-zero there is announced by the
  existing mechanism. Making the *passing* case publish as well is deliberately not attempted.
