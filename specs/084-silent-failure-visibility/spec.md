# Feature Specification: Silent-failure visibility — backups, deploys and app-image scans

**Feature Branch**: `084-silent-failure-visibility`

**Created**: 2026-10-26

**Status**: Draft

**Input**: Backlog items #830, #823, #822 and #863 — three failures that currently happen without anyone
being told. Make each one visible somewhere already watched, with a check that proves it. Extended
2026-10-26 by the operator: measure the backup dump and exclude what does not belong in it, add a
retention rule for the forge's package registry, and detect empty or truncated dumps.

## Measured Baseline *(evidence for every claim in this spec)*

All three items share one defect: **the failure happened, was recorded somewhere, and nothing put it in
front of a person.** None of them is a missing capability — in each case the evidence already existed.

### #830 — the prod backup failed nightly for ~3 months

- The nightly host backup failed every night from about **2026-07-27 to 2026-10-22**. The last good
  snapshot before the fix was taken **2026-07-26 03:31**. It was found by chance on 2026-10-22.
- Cause: dumps were staged on a 28.8 GB RAM-backed `/tmp`; the Forgejo dump (then including the
  container registry) outgrew it (`write /dev/stdout: no space left on device`). The script aborts on
  the first error, so **every** database dump and the off-site upload were skipped — not just the
  Forgejo dump.
- A `Failed with result 'exit-code'` line sat in the host journal every night. Nothing reads it.
- **Already fixed on the host, not in the repository** (2026-10-22/23): on-disk staging, the Forgejo
  dump skips package data and repository archives, and retention now groups by tag so it actually
  prunes (41 snapshots → 11). The first unattended nightly since July succeeded on 2026-10-23.
- The backup script and its timer/service units exist **only on the prod host**. The runbook's Backups
  section still describes the pre-fix script (temp-dir staging, registry included).
- The dump is still ~21.7 GiB without the registry (July: 22.3 GiB with it), so the registry was not
  the bulk. (The `3:48` restic printed on 2026-10-22 is **3 min 48 s**, not hours: a whole nightly run
  takes 8–10 min wall clock — measured 2026-10-22..26 from the unit's journal.)
- **Measured on the host by the operator, 2026-10-26** (forge data volume, `du` inside the forge
  container; forge database via `pg_total_relation_size`):

  | Component | Size | In the dump? |
  |---|---|---|
  | Actions **artifacts** — 354,028 files; 13.7 GiB older than 30 d, none older than 90 d | **21.8 G** | yes — **≈ the entire dump** |
  | Actions logs — 21,375 files | 447 M | yes |
  | Forge database (Postgres) — of which Actions tables 652 MB (`action_artifact` 272 MB / 452,748 rows, `action_task` 154 MB, `action_run_job` 123 MB, `action_task_step` 67 MB) | 783 MB | yes |
  | Repositories | 138 M | yes |
  | Indexes, queues, sessions, avatars, attachments, LFS, config | ≈ 15 M | yes |
  | Package registry | **109.1 G** | no (skipped since 2026-10-22) |

  - **Artifacts are the dump.** They are CI's diagnostic uploads, expiring at the forge's 90-day
    default (no `[actions]` retention key is set). Live artifacts by name, from `action_artifact`:

    | Artifact | Rows | Size | Note |
    |---|---|---|---|
    | `maestro-debug` | 330,497 | **11 GB** | **accumulation confirmed** 2026-10-27: rows per upload 6, 9, 12, 15, 18 … 5,819 over 154 uploads; the job runs on the CI host, whose `~/.maestro/tests` held 967 entries / 5.8 G (Maestro self-prunes at ~14 d). Fixed by PR #864 |
    | `infra-image-scan-report` | 10,899 | 1.3 GB | |
    | `agent-e2e-container-logs` | 2,461 | 126 MB | |
    | `MovieCollectionManager-release-<sha>` | 1 each | 57 MB each | one per deploy; the same APK is also published to the `mcm-app-android` package |

  - **The forge dump has no option to exclude Actions artifacts** (`forgejo dump --help` on the
    running version lists `--skip-repository/-log/-custom-dir/-lfs-data/-attachment-data/
    -package-data/-index/-repo-archives` only). Excluding them means either shrinking them at the
    source or backing the forge up without its dump command.
  - **Every night stores ~20 GiB of new data** (`Added to the repository: 19.8–21.1 GiB`, five nights):
    the dump is a single compressed stream, so the backup tool can de-duplicate almost nothing between
    nights. At 7 daily / 4 weekly / 6 monthly retention that converges on ~17 snapshots ≈ **340 GiB on
    the NAS** for a forge whose irreplaceable content is ~1 GB. The cost is NAS space, not upload time.
  - **Per-dump sizes, latest snapshot (2026-10-26)**: forge 22,534,842,559 B; **Komodo 2,038,219,396 B
    (2.0 GB — the second-largest; explained below)**; mc-service Mongo 813,102 B; Keycloak 381,023 B;
    BFF Mongo 2,891 B; agent-db 670 B.
  - **After US4 (first night, 2026-10-29, T034)**:
    - forge 774,210,710 B (`forge-db` 188,797,590 + `forge-data` 585,413,120);
    - Komodo 84,853,276 B;
    - `cron.job_run_details` 46 MB, from 2,180 MB;
    - `release-apks` 639,047,680 B (new);
    - `Added to the repository` 937.5 MiB on the first night, from 21.107 GiB the night before.
    The per-night figure on a typical day is the second night's (T035).
  - **agent-db is empty by design** (operator, 2026-10-27): `agent_db` has zero tables, and its
    7.7 MB size equals an empty `postgres` database. The gateway compiles its graph with an
    in-memory checkpointer (`MemorySaver`), and no Python code reads `AGENT_DB_URL`. The 670-byte
    dump is a correct dump of an empty database — so "non-empty" alone is the wrong check (FR-003a).
  - **Komodo's database is 2,284 MB, but its collections total ~120 MB** (`Stats` 113 MB, the rest
    under 5 MB each). **The other ~2.1 GB is `cron.job_run_details` — 2,147 MB** (operator,
    2026-10-27): the run history of the database's own scheduler. Komodo runs on FerretDB over
    Postgres with the DocumentDB extension, whose background jobs are scheduled by `pg_cron`, and
    `pg_cron` records every run and never purges that table. It is a log, not Komodo state: about
    94% of the Komodo dump is restorable to nothing useful.
  - The earlier hypothesis — Actions *logs* — is **refuted**: 447 M, about 2%.
  - The database's Actions tables (652 MB) are mostly artifact and task metadata; they shrink with the
    artifacts.
  - The source repository is 126–138 MB; every other repository is under 1 MB.
- The current script (read 2026-10-26): step 1, the forge dump, is the only dump with no
  `|| DUMP-FAILED` fallback, so under `set -e` it is still fatal to every later dump (FR-003). Secrets
  are read live from compose env files and running containers; the backup password comes from a file
  outside the script.
- **A dump that succeeds but is empty or truncated is not detected today.** Only a dump *command* that
  exits non-zero leaves a `DUMP-FAILED-*` marker; a zero-byte or cut-off file is uploaded as if good,
  and nothing compares it with the previous night's.

### The package registry grows without bound

- **3,657 package versions** on 2026-10-26 (2026-06: 34 created; 07: 894; 08: 650; 09: 938; 10: 1,141
  so far), with no cleanup rule:

  | Package | Versions | Blob bytes referenced | Kind |
  |---|---|---|---|
  | **mcm-devcontainer** | 194 | **84 GB** | dev-container image (scheduled rebuilds) |
  | mcm-bff | 557 | 39 GB | app image |
  | agent-gateway | 616 | 31 GB | app image |
  | movie-mcp | 485 | 2.2 GB | app image |
  | web-api-mcp | 485 | 2.2 GB | app image |
  | spreadsheet-mcp | 484 | 2.2 GB | app image |
  | mc-service | 536 | 1.0 GB | app image |
  | mcm-app-android | 5 | 609 MB | release APK |
  | ci-failures | 295 | 18 MB | CI evidence bundle |

  Layers are shared between versions, so rows overlap; the exact total is **8,468 distinct blobs,
  109 GB**, of which only 122 MB (5 blobs) is unreferenced. **The dev-container image alone accounts
  for most of the registry.** Measured 2026-10-26 from the forge database.

- Two readers depend on old versions and constrain any cleanup: production **rollback redeploys the
  prior promoted digest** (`scripts/cd/rollback.sh`), and `ci-status` reads recent `ci-failures`
  bundles (including step-duration history sampled newest-first) as diagnostic evidence.
- The registry is excluded from the backup (above), so its growth costs host disk, not backup size —
  and that cost is the largest single item on the host: **109.1 G of the 301 G used** (36%) on
  2026-10-26, from about four months of CI.

### #823 — `ci-status` reports green while the deploy has failed

- Production deploys run as a dispatched workflow that posts **no commit status** for its outcome.
- On 2026-10-21 a deploy failed at its image-scan step. `ci-status failure --sha` answered "No failed
  jobs"; `--run` either mapped to a different commit or stopped at "posted NO commit status".
- The evidence existed throughout, as a `ci-failures` bundle — reachable only by hand.
- A session waiting for the post-deploy promote commit timed out silently instead of learning the
  deploy had failed.

### #822 — a fixable Critical in our own images surfaces only after merge

- PR CI builds all six application images but never runs the deploy-time vulnerability gate on them.
  PR CI's image scan covers only third-party infrastructure images.
- On 2026-10-21 a green, merged PR was followed by a deploy blocked on a Critical in a vendored
  dependency of a base image. **Three consecutive deploys** (two from unrelated docs merges) failed the
  same way until a fix PR landed.

## Clarifications

### Session 2026-10-26

- Q: Do the backup script and its systemd units move into the repository? → A: Yes — versioned,
  reviewed, guard-tested, operator-installed (FR-004).
- Q: Where is the 36 h staleness red shown? → A: A p1 backlog item opened/updated through the existing
  backlog write path; the run's own failure uses the same item, so there is one channel (FR-001, FR-002).
- Q: Does the PR scan run inside app-e2e or as its own job? → A: Its own required job, reusing built
  images (FR-013).
- Operator, 2026-10-26: the dump-size analysis and its exclusions are **in** this feature (US4); a
  registry retention rule for old CI images and evidence bundles is **in** (US5); an empty or
  truncated dump is **in** scope for alerting, not left to the restore drill (FR-003a, FR-003b).

## User Scenarios & Testing *(mandatory)*

The "users" here are the operator (who owns the prod host) and the coding assistant sessions (which
merge and then watch for a deploy). Each story is delivered as its own pull request. US1–US3 each
close their backlog item; US4 completes the remaining part of #830; US5 closes item #863.

### User Story 1 - A failed or stale prod backup is visible without anyone looking (Priority: P1)

The operator learns within a day that the nightly backup failed, did not run, or hung — without
reading the host journal. A failure in one dump cannot silently take every other dump down with it.
The runbook describes the backup as it actually is, and a restore from the current backup has been
proven.

**Why this priority**: This is the only item where the silent failure costs data. Three months without
a usable backup on the single host that holds the source forge and every application database. It is
backlog p1.

**Independent Test**: Run a deliberately broken copy of the backup (for example, an unreachable backup
repository) and observe the alert appear in the agreed place; separately, present a newest-snapshot age
over the threshold and observe the staleness red.

**Acceptance Scenarios**:

1. **Given** the nightly backup fails for any reason, **When** the run ends, **Then** an alert appears
   in a place the operator already watches, within 24 hours of the failure.
2. **Given** the backup never ran, or ran but produced no new snapshot (timer stopped, run hung),
   **When** the newest snapshot is more than 36 hours old, **Then** the staleness check shows red in a
   place already watched — independently of whether the run itself reported failure.
3. **Given** the Forgejo dump fails, **When** the backup continues, **Then** every database dump and
   the off-site upload still happen, and the snapshot carries a visible marker naming the failed dump.
3a. **Given** a dump command exits successfully but its output is empty, unreadable or truncated,
   **When** the run checks its dumps, **Then** that dump is treated as failed — marker in the
   snapshot and the same alert as scenario 1.
3b. **Given** a dump that is readable but far smaller than the same dump in the previous good
   snapshot, **When** the run checks it, **Then** the alert names the dump and both sizes.
4. **Given** the runbook's Backups section, **When** compared with the deployed script, **Then** it
   matches: on-disk staging, registry and repository archives excluded on purpose, how to restore
   without them (images are rebuilt by the deploy pipeline), and the retention grouping rule.
5. **Given** the post-fix snapshot, **When** the operator runs the restore drill, **Then** the forge
   database plus repositories restore, and one application database restores into a scratch
   container, and the result is recorded.

---

### User Story 2 - `ci-status` sees a failed deploy (Priority: P2)

A session or person asking "did this `main` commit deploy?" gets the real answer. A failed deploy shows
as failed, `watch` returns instead of waiting forever, and `failure` prints the deploy's failure digest.

**Why this priority**: It cost a session a silent time-out and lets a broken deploy go unnoticed after
every merge. It is cheaper than US3 and a prerequisite for noticing US3-class failures that still slip
through (the deploy-time scan remains the source of truth).

**Independent Test**: Against a recorded fixture of a `main` commit whose dispatched deploy failed and
posted no commit status, the tool reports the failure; removing the new fallback turns the fixture red.

**Acceptance Scenarios**:

1. **Given** a `main` commit whose deploy dispatch succeeded and whose deploy then failed, **When**
   `ci-status status --sha <sha>` runs, **Then** it shows the failed deploy job as an advisory context
   with its real outcome.
2. **Given** the same commit, **When** `ci-status watch --sha <sha>` runs, **Then** it returns with the
   failure rather than waiting for a context that will never appear.
3. **Given** the same commit, **When** `ci-status failure --sha <sha>` (or `--run <id>`) runs, **Then**
   it prints the deploy's failure digest from its evidence bundle.
4. **Given** a `main` commit whose deploy succeeded, **When** `status` runs, **Then** the deploy shows
   as passing, and nothing about existing required-context verdicts changes.

---

### User Story 3 - A fixable Critical in an app image fails the PR, not the deploy (Priority: P2)

A pull request that would introduce an un-allowlisted fixable Critical vulnerability into any of the
six application images fails a required check before merge, using exactly the rules the deploy gate
uses.

**Why this priority**: When it happens, every later merge fails to deploy until a fix lands. It is
rarer than US2's blind spot and costs CI time on every PR, so it follows US2.

**Independent Test**: On a PR that re-introduces the pre-fix condition (runtime pip in a Python image on
the affected base), the new check is red; on a clean PR it is green.

**Acceptance Scenarios**:

1. **Given** a PR introducing an un-allowlisted fixable Critical into any of mc-service, mcm-bff,
   agent-gateway, movie-mcp, web-api-mcp or spreadsheet-mcp, **When** PR CI runs, **Then** a required
   check fails before merge and names the image and finding.
2. **Given** a finding the deploy gate allowlists, **When** PR CI runs, **Then** the PR check passes it
   too.
3. **Given** someone changes the scanner version, flags or allowlist used by one gate but not the
   other, **When** the guards run, **Then** a guard fails.

---

### User Story 4 - The backup carries only what a restore needs (Priority: P2)

The operator knows what makes up the ~21.7 GiB forge dump, and anything in it that is diagnostic,
expiring or rebuildable is excluded on purpose, with the reason and the restore consequence recorded.
The nightly upload and the backup repository's growth shrink accordingly.

**Why this priority**: Size drove the original outage (the dump outgrew its staging area), and it
drives off-site growth: ~20 GiB stored per night, heading for ~340 GiB of NAS for ~1 GB of
irreplaceable forge data. It is not itself a silent failure, so it follows US2/US3.

**Independent Test**: The per-component size table exists, each excluded component has a recorded
reason and restore note, and the next snapshot's forge dump is smaller by the measured amount of what
was excluded.

**Acceptance Scenarios**:

1. **Given** the forge data directory, **When** the operator runs the documented measurement, **Then**
   a per-component size table (database, repositories, Actions logs, Actions artifacts, indexes,
   attachments, LFS, other) is recorded in the runbook.
2. **Given** that table, **When** each component is classified, **Then** every component is either
   kept (needed to restore) or excluded with its reason and what a restore loses.
3. **Given** the exclusions are applied, **When** the next nightly runs, **Then** its forge dump is
   smaller by roughly the excluded components' measured size, and a restore drill (US1 scenario 5)
   still succeeds against it.

---

### User Story 5 - The package registry keeps what is needed and drops the rest (Priority: P2)

Old CI-built images and old CI evidence bundles are removed on a rule, so the registry stops growing
without bound — without ever removing an image production runs or would roll back to, or evidence a
recent failure still needs.

**Why this priority**: Raised from P3 after measurement: the registry is 109 G, the largest thing on
the host (36% of used disk), growing by over a thousand versions a month. It costs disk, not data or
visibility, and deletion is irreversible, so it still ships last and with a report-only first run.

**Independent Test**: The rule's report-only run lists what it would delete; the currently deployed
and rollback digests for all six app images are absent from that list; after the rule acts, the
version count is back within its bound and a deploy and a rollback both still work.

**Acceptance Scenarios**:

1. **Given** the retention rule, **When** it runs, **Then** each package holds no more than its
   configured number of versions or age, whichever keeps more.
2. **Given** the digest each app is currently deployed at, and the prior promoted digest rollback
   would use, **When** the rule runs, **Then** neither is ever deleted.
3. **Given** a `ci-failures` bundle from a run within the evidence window, **When** the rule runs,
   **Then** it is kept, and `ci-status` can still read it.
4. **Given** the rule is new, **When** it first runs, **Then** it only reports what it would delete;
   it acts only after that list is reviewed.
5. **Given** release APKs and the dev-container image the sandbox pulls, **When** the rule runs,
   **Then** the versions in use are kept.

---

### Edge Cases

- **US1**: The run's own failure alert cannot be posted (token expired, forge briefly down) — the
  scheduled staleness check is the independent second path and still raises the item within 36 h. A
  staleness check that cannot read the snapshot age MUST itself fail loudly, never report fresh.
- **US1**: The backup run hangs and never exits — no failure event fires; only staleness catches it.
- **US1**: The host is down entirely — CI runs on the same physical host, so the staleness check goes
  down too. Accepted: the forge, the app and every CI run go down with it, which is not silent. The
  check covers the host-up-backup-broken case, which is the one that went unseen for 3 months.
- **US1**: A dump succeeds but is empty or truncated — treated as a failed dump (FR-003a). A dump
  that is complete but suspiciously small is flagged against the previous snapshot (FR-003b); a
  legitimate large shrink (data deliberately deleted, a new exclusion from US4) is acknowledged by the
  operator rather than silently accepted.
- **US1**: The first run after this ships has no previous snapshot to compare with in the new format —
  the size comparison is skipped *and says so*; the emptiness and readability checks still apply.
- **US4**: Excluding something from the dump makes the next snapshot much smaller — that is the
  expected-shrink case of FR-003b and must not page as a failure once acknowledged.
- **US5**: The digest currently deployed, or the one rollback would return to, is older than the
  retention window — it MUST be kept regardless of age.
- **US5**: A cleanup rule deletes something still needed — deletion is not undoable, so the rule is
  first run in a report-only mode and its would-delete list reviewed before it acts.
- **US2**: More than one deploy run exists for a sha (a re-run) — the newest run's outcome wins.
- **US2**: The deploy is still running — reported as pending, and `watch` keeps waiting.
- **US2**: A deploy failed but its evidence bundle is missing — say so explicitly; never report
  "no failed jobs".
- **US2**: The bundle is named by run id, not run number — the lookup must use the id (a constructed
  name from the number 404s for a bundle that exists).
- **US3**: The vulnerability database changes between the PR scan and the merge — the deploy gate stays
  authoritative; a PR-green, deploy-red outcome is still possible and US2 makes it visible.
- **US3**: The scanner's vulnerability database cannot be downloaded — the check fails, it does not
  pass silently.

## Requirements *(mandatory)*

### Functional Requirements

**US1 — backups (#830)**

- **FR-001**: A failed nightly backup run MUST produce an alert in a place the operator already
  watches, within 24 hours. That place is the backlog: the failure opens (or updates, never
  duplicates) a p1 backlog item.
- **FR-002**: A newest-snapshot age over 36 hours MUST show red in the backlog (the same single
  item FR-001 uses), from a scheduled check that does not depend on the backup run reporting its own
  failure — it reads the snapshot age itself. When the next good snapshot lands, the item says so;
  closing it stays a human act.
- **FR-003**: A failing Forgejo dump MUST NOT prevent the database dumps or the off-site upload; it
  MUST leave a failure marker in the snapshot like the other dumps do.
- **FR-003a**: Every dump MUST be checked after it is written: complete and readable in its own
  format (the archive lists, the database dump runs to its end marker), and at least a per-dump
  expected minimum size that is recorded with the dump and may legitimately be near zero (agent-db is
  empty by design). A dump that fails the check MUST be treated exactly as a failed dump — marker
  plus alert.
- **FR-003b**: Every dump's size MUST be compared with the same dump in the previous good snapshot; a
  shrink beyond a documented threshold MUST alert with the dump name and both sizes. An expected
  shrink is acknowledged by the operator through a documented step, not by raising the threshold.
- **FR-004**: The backup script and its scheduling units MUST live in the repository, versioned and
  reviewed, with guards that fail on the failure modes measured here: staging on RAM-backed storage,
  retention grouped by a randomised path, and a fatal Forgejo dump that skips the rest. The operator
  installs them on the host; the repository copy and the installed copy MUST be comparable by one
  documented command. The script MUST hold no secret (credentials stay read live, as today).
- **FR-005**: The runbook's Backups section MUST match the deployed script, including the registry
  and repository-archive exclusions, how to restore without them, and the retention grouping rule, and
  MUST record this outage as a case study.
- **FR-006**: The operator MUST perform and record a restore drill from a post-fix snapshot: forge
  database plus repositories, and one application database into a scratch container.
- **FR-007**: *(moved to US4: FR-017–FR-019)*

**US2 — deploy visibility (#823)**

- **FR-008**: `ci-status status --sha` on a `main` commit whose deploy was dispatched MUST report the
  deploy job's outcome as an advisory context.
- **FR-009**: `ci-status watch --sha` MUST return when that deploy has failed.
- **FR-010**: `ci-status failure` MUST fall back to the evidence bundle for a failed run that posted no
  commit status, and print its digest; when no bundle exists it MUST say so rather than report health.
- **FR-011**: A selftest fixture MUST cover a dispatched run with no commit status, and removing the
  fallback MUST fail it.
- **FR-012**: Adding the advisory deploy context MUST NOT change which contexts are required or how a
  PR's mergeability is judged.

**US3 — PR-time app-image scan (#822)**

- **FR-013**: PR CI MUST scan all six application images it builds and fail a required check on any
  un-allowlisted fixable Critical. The scan is its **own required job**, separate from app-e2e, so a
  red names the scan and app-e2e's runtime is unchanged; it reuses images PR CI already builds rather
  than building them a second time where that is measurably cheaper.
- **FR-014**: The PR scan and the deploy-time scan MUST share one scanner version, one set of flags and
  one allowlist — one pipeline, not a copy — and a guard MUST fail if they diverge.
- **FR-015**: A mutation test MUST show the check red: re-adding runtime pip to a Python image on the
  pre-fix base turns it red on a PR.
- **FR-016**: The deploy-time scan MUST remain in place and authoritative.

**US4 — backup size (#830, remainder)**

- **FR-017**: The forge data directory MUST be measured by component by a documented, repeatable
  operator command, and the result recorded in the runbook with its date.
- **FR-018**: Each component MUST be classified keep or exclude, with the reason and the restore
  consequence of each exclusion recorded; Actions logs and artifacts are decided explicitly.
- **FR-019**: Exclusions MUST be applied in the repository's backup script (FR-004) and guarded, so a
  later edit that drops one is caught.
- **FR-019a**: The data a nightly backup newly stores MUST be roughly proportional to what actually
  changed that day, not a full copy of the forge each night.
- **FR-019b**: A CI diagnostic upload MUST contain only the files of the run that produced it.
  The Maestro accumulation was confirmed 2026-10-27 and is fixed by PR #864.
- **FR-019c**: Diagnostic artifacts MUST have a documented retention, set deliberately rather than
  inherited from the 90-day default; release artifacts that are also published as packages need not
  be kept twice.
- **FR-019d**: The Komodo database's scheduler run history (`cron.job_run_details`, 2,147 MB of a
  2,284 MB database) MUST be bounded by a retention that runs without an operator, and the existing
  backlog purged once, so the Komodo dump reflects Komodo's own state (~120 MB). Explained 2026-10-27;
  the 670-byte agent-db dump is explained too: an empty database by design.

**US5 — registry retention (item #863)**

- **FR-020**: Each package in the forge registry MUST have a retention rule bounding its versions by
  count and/or age.
- **FR-021**: The rule MUST never delete the digest any app is deployed at or the prior promoted
  digest rollback would use; a check MUST prove both survive a run.
- **FR-022**: `ci-failures` bundles within a documented evidence window MUST be kept, and that window
  MUST cover what `ci-status` reads (including its duration-history sample).
- **FR-023**: The rule MUST support a report-only run, and its first run in production MUST be
  report-only and reviewed before it deletes anything.
- **FR-024**: The rule MUST be configuration recorded in the repository (or a documented setting with
  its values recorded there), not an undocumented forge setting.

### Key Entities

- **Backup run**: one nightly execution; outcome (success / failed / never ran / hung), the dumps it
  attempted and their per-dump outcomes, the snapshot it produced.
- **Snapshot**: the off-site backup artefact; its timestamp drives the staleness check.
- **Deploy run**: the dispatched production deploy for a `main` commit; its outcome and its evidence
  bundle (keyed by run id).
- **Advisory context**: a reported outcome that informs but does not gate mergeability.
- **Dump check**: per dump — complete and readable, at or above its minimum size, size, size of the same dump in the previous good
  snapshot, and the verdict.
- **Retention rule**: per package — the count/age bound, the protected versions (deployed, rollback,
  in-use), and its mode (report-only or acting).
- **Scan finding**: an image, a vulnerability id, its severity and fixability, and whether the shared
  allowlist covers it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For each of the three failure classes, a deliberately induced failure becomes visible to
  the operator or a session **without anyone going to look for it** — backups within 24 hours, deploy
  failure on the next `ci-status` query, image Critical before merge.
- **SC-002**: The longest a backup outage can go unnoticed drops from ~3 months (measured) to at most
  36 hours, including the case where the backup job never runs.
- **SC-003**: Zero cases where `ci-status` answers "no failed jobs" for a `main` commit whose deploy
  failed, across the recorded fixtures.
- **SC-004**: Zero merges blocked-at-deploy by a fixable Critical the deploy gate would have caught,
  other than those caused by a vulnerability-database change after the PR scan.
- **SC-005**: A restore from the current backup has been performed and recorded at least once after the
  fix.
- **SC-006**: Every new check has a mutation-RED: undoing the fix it guards turns it red.
- **SC-007**: A deliberately emptied or truncated dump is reported as failed on the run that produced
  it — zero such dumps uploaded silently.
- **SC-008**: The forge's share of a nightly snapshot falls from ~21.5 GiB to under 2 GiB, and the new
  data stored per night falls from ~20 GiB (measured 2026-10-22..26) to under 2 GiB on a typical day;
  both before and after figures are recorded. The Komodo dump falls from 2.0 GB to under 250 MB and
  stays there.
- **SC-009**: The registry's version count and on-disk size stop growing month on month and stay
  within the rule's bound (from 109 G measured 2026-10-26), with zero deploys or rollbacks failing for
  a missing image.

## Assumptions

- The operator performs every host-side step (installing units, the induced failure, the restore
  drill); the assistant supplies paste-safe commands with expected output.
- The host-side fixes of 2026-10-22/23 (on-disk staging, dump exclusions, retention grouping) stay in
  place and are the baseline this feature documents and guards — not re-done.
- The 36-hour threshold allows one missed nightly plus margin; it is not tunable per run.
- The deploy-time scan remains the source of truth (FR-016); the PR scan is early warning.
- The registry retention rule (US5) is backlog item #863 and is closed by its own criteria.
- The release APK is also published to the `mcm-app-android` package, so excluding Actions
  artifacts from the backup loses no release; that package **is** backed up by its own
  dump (operator decision 2026-10-27). The rest of the registry is rebuildable; release APKs are not
  bit-for-bit rebuildable.
- The posting of a native deploy commit status by the deploy workflow itself is optional; US2 is
  satisfied by `ci-status` resolving the dispatched run.
- Delivery is five pull requests, one per story; each closes its backlog item when that item's
  acceptance criteria are verified, not when the PR merges.
