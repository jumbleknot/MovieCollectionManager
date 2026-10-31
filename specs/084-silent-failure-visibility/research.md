# Research: Silent-failure visibility (feature 084)

Each decision rests on the spec's Measured Baseline. Items still marked **verify on host** are facts
about the prod or ci host that the repository cannot show; each one has a paste-safe step in
[quickstart.md](./quickstart.md) step 0, which runs before the task that depends on it.

## R1 — Where the backup alert goes, and how it is raised from the host

- **Decision**: A host-side `backup-alert.sh` opens or updates **one** open backlog item, titled
  exactly `Prod backup: failed or stale`, labelled `type/bug` and `priority/p1`. It talks to the forge
  API with `curl`. It finds the item by searching open issues for that exact title, then
  - **comments** when the item exists, or
  - **creates** it when none is open.

  It never closes the item: closing stays a human act (FR-002). A successful run that finds the item
  open adds a "recovered: snapshot <id> at <time>" comment.
- **Credential**: a **new, dedicated issue-scoped token** for the host, stored in a mode-600 file
  under `~/backup/`. It has the same scope as `MCM_FORGE_ISSUE_TOKEN` (issues only), but is a separate
  token, so it can be revoked without breaking the coding assistant's backlog writes, and the reverse.
  The script never echoes it; `curl` reads it with `-H @file`.
- **Rationale**: the clarification fixed the channel (the backlog). `node scripts/backlog.mjs` cannot
  run on the host without a repo checkout and a Node toolchain. The issue API is small, and its traps
  are already recorded in the forgejo-issues skill. In particular, always pass `type=issues`, and
  treat an unknown label name as silently ignored. So the script sends **no label filter**: it
  matches by exact title, then checks the labels client-side.
- **Alternatives rejected**:
  - Email or ntfy: neither is a channel the operator watches.
  - A forge commit status: it attaches to a commit, not to a host event.
  - Reusing `MCM_FORGE_ISSUE_TOKEN`: it couples two consumers' revocation.
- **Host tools (0a, verified 2026-10-27)**: `curl`, `python3` and `restic` are present; `jq` is
  **missing**. So `python3` parses restic's JSON and builds every issue body (no shell-quoted JSON).
  The scripts check for `curl` and `python3` at their top and fail loudly if either is absent.

## R2 — Failure alerting and hang detection

- **Decision**:
  - `homelab-backup.service` gains `OnFailure=homelab-backup-alert@%n.service` (a template unit that
    runs `backup-alert.sh failed <unit>`, which attaches the last 40 journal lines).
  - It also gains `TimeoutStartSec=2h`. A whole run measures 8–10 min (2026-10-22..26), so a hang
    becomes a failure and fires the same `OnFailure`.
- **Rationale**: the run's own failure is the cheapest and fastest signal. The timeout covers the
  "hung" case that `OnFailure` alone misses. Staleness (R3) remains the backstop for "the timer never
  fired".
- **Alternatives rejected**: a `trap ERR` inside the script misses a SIGKILL, an OOM kill, or the unit
  never starting. systemd sees all of those.

## R3 — The 36 h staleness check

- **Decision**:
  - A **separate** timer and service pair, `homelab-backup-staleness.timer` (every 6 h,
    `Persistent=true`) and `homelab-backup-staleness.service`, runs `backup-staleness.sh`.
  - The script reads `restic snapshots --tag homelab --latest 1 --json`, computes the age of the
    newest snapshot, and calls `backup-alert.sh stale <age>` when it is over 36 h.
  - **Any** failure to read the age (restic error, empty list, unparsable time) is itself an alert,
    with reason `staleness-unreadable`. It is never treated as fresh.
- **Rationale**: it is independent of the backup run, which is what FR-002 requires. It reads the NAS
  itself, so it catches "timer stopped", "run hung" and "upload silently skipped". It runs on the host
  that already holds the restic credentials.
- **Alternatives rejected**:
  - **A scheduled CI workflow** would need the restic password, which decrypts every backup, in Actions
    secrets. A read-only check does not justify that exposure.
  - **A heartbeat file pushed to the forge** is written by the very run being checked, so it is not
    independent.
- **Accepted gap** (spec, Edge Cases): if the prod user's systemd manager is down, both timers stop.
  That state also stops every prod container, so it is not silent.

## R4 — A failed dump must not skip the others (FR-003)

- **Decision**:
  - Every dump runs through one function, `run_dump <name> <min-bytes> <format> -- <command…>`. It
    writes to `<name>.<ext>`, and on a non-zero exit writes `DUMP-FAILED-<name>` and **returns 0**.
  - The forge dump uses it like every other dump.
  - `set -euo pipefail` stays for everything else.
- **Rationale**: one code path means the measured defect cannot recur in one dump while the other
  dumps are protected. A guard test runs the script with a fake `docker` that fails the forge dump,
  then asserts that all other dumps ran and that restic was called.

## R5 — Checking each dump (FR-003a, FR-003b)

- **Decision**: after each dump, `check_dump` verifies it in its own format:

  | Format | Check |
  |---|---|
  | Postgres plain SQL | last non-empty line is `-- PostgreSQL database dump complete` |
  | Postgres custom (`-Fc`) | `pg_restore --list` succeeds (run inside the db container, file piped in) |
  | gzip / Mongo `--archive --gzip` | `gzip -t` |
  | tar | `tar -tf` succeeds and lists at least the paths the manifest requires (R7) |

  It also checks `bytes >= min-bytes`. The minimum is set per dump in the script; agent-db's minimum
  is 1 byte, because that database is empty by design. A failed check is handled exactly like a failed
  dump: `DUMP-FAILED-<name>` plus an alert.
- **Shrink check**:
  - Each run writes `dump-manifest.tsv` (`name  bytes  min  verdict`) into the staging dir, so it is
    uploaded **in** the snapshot.
  - A copy goes to `~/backup/state/last-good.tsv` on success.
  - The next run compares each dump with that file. Shrinking below **50 %** of the previous size
    alerts, with the name and both sizes; the snapshot is still uploaded.
  - **Acknowledgement**: the operator runs `backup.sh --ack-shrink <name>`, which writes
    `~/backup/state/ack-shrink-<name>`. The next run consumes it, then deletes it, so it covers one run
    only. The threshold is never raised.
  - If `last-good.tsv` is missing, as on the first run of this version, the manifest records
    `compare=skipped (no previous manifest)` and the run log says so.
- **Rationale**: a local state file is cheap and deterministic to test. Reading the previous snapshot
  from the NAS would cost a restic call per run and add a second failure mode. The manifest inside the
  snapshot keeps the comparison auditable from the backup alone.
- **Dump formats are inherited from the host script.** T001 commits it verbatim, so the format column
  above is finalised against the real commands, not assumed.

## R6 — Moving the script into the repository (FR-004)

- **Decision**:
  - The files live in `infrastructure-as-code/backup/`: `backup.sh`, `backup-alert.sh`,
    `backup-staleness.sh`, the units, and `README.md`.
  - The **first commit is the host script, byte for byte**: the operator pastes `cat`, and the
    repository records its sha256. Every change after that is reviewable as a diff against what
    actually ran.
  - The operator installs with a documented `install -m 0750 …` block.
  - **Comparison command**: `sha256sum ~/backup/*.sh ~/.config/systemd/user/homelab-backup*` against
    `infrastructure-as-code/backup/INSTALLED.sha256`, which is regenerated by
    `node scripts/backup-install-manifest.mjs`. A guard test fails when the committed file disagrees
    with the scripts in the directory.
- **Rationale**: the host has no guaranteed checkout of the repository at a known revision. A
  committed checksum list is the one artefact both sides can compute with coreutils. (0d found one
  checkout on the host, `/home/prod/mcm-080`, left over from feature 080. It is not kept current, so
  it is not a reference. The checksum comparison is the documented command, and the install block
  can copy `INSTALLED.sha256` from a freshly fetched checkout there.)
- **Guards (static and behavioural)**, `scripts/__tests__/backup-script.test.mjs`:
  1. The staging dir is not under `/tmp`, `/dev/shm` or `$XDG_RUNTIME_DIR`. The script also refuses
     at runtime when `stat -f` reports tmpfs.
  2. `forget` carries `--group-by host,tags` and `--tag homelab`, never a path-grouped default.
  3. A failing forge dump still runs the others (R4).
  4. The script contains no literal secret. The test reuses the repository's secret patterns, then
     checks that every credential is read from an env file, a container, or `RESTIC_PASSWORD_FILE`.
  5. The forge data exclusions (R7) are present.

## R7 — What the forge backup contains (US4: FR-017–FR-019a)

- **Decision**: replace `forgejo dump` with two dumps.
  1. **`forge-db`**: `pg_dump -Fc` of the forge database from `forgejo-forgejo-db-1`, which is
     consistent on its own.
  2. **`forge-data`**: an **uncompressed** tar, streamed with
     `docker exec forgejo-forgejo-1 tar -cf - -C /data …`, excluding the paths below.

  | Path under `/data` | Size (2026-10-26) | Decision | Restore consequence |
  |---|---|---|---|
  | `gitea/actions_artifacts` | 21.8 G | **exclude** | CI diagnostic uploads are lost. They expire within 90 days anyway (FR-019c sets 14). Releases live in the `mcm-app-android` package. |
  | `gitea/packages` | 109.1 G | **exclude** (unchanged) | Images are rebuilt by cd-deploy. Release APKs: see R10. |
  | repository archives (`repo-archive`) | — | **exclude** (unchanged) | Regenerated on demand. |
  | `gitea/indexers`, `gitea/queues` | ≈ 15 M total with sessions | **exclude** | Rebuilt on start (code search re-indexes). |
  | `gitea/tmp`, `gitea/log`, `gitea/sessions` | small | **exclude** | Scratch, the forge's own log files, and web sessions (users sign in again). |
  | `gitea/jwt`, `gitea/actions_id_token` | small | **keep** | Signing keys: without them, issued tokens and the Actions OIDC identity change on restore. |
  | `gitea/home`, `gitea/f3`, `gitea/repo-avatars` | small | **keep** | Git's home config, federation state, avatars. |
  | `gitea/actions_log` | 447 M | **keep** | Run history in the UI. The files are immutable once written, so they de-duplicate after the first night. |
  | `git/repositories` | 138 M | **keep** | The source of truth. |
  | `gitea/conf`, avatars, attachments, LFS, `ssh` | small | **keep** | Needed to restore. |

  The database's Actions tables (652 MB) stay in `forge-db`: they shrink as artifacts expire, and a
  restore needs run and job rows to keep the UI consistent.
- **Why uncompressed**: restic chunks content-defined. A gzip stream changes after its first changed
  byte, so nothing de-duplicates (measured: 19.8–21.1 GiB added per night). An uncompressed tar of
  mostly-unchanged files de-duplicates to roughly the day's real change, which is FR-019a. restic
  compresses on its own (repository v2).
- **Consistency**: the repositories are copied while the forge is live. A push mid-copy can leave a
  ref ahead of its objects in the archive. Git tolerates this on restore (`git fsck` reports it), and
  it is the same exposure `forgejo dump` had. It is documented, not engineered around (no forge stop
  at 03:30).
- **Host facts (0b, verified 2026-10-27)**:
  - restic **0.18.1**, so repository v2 compression is available.
  - `/data/gitea` holds `actions_artifacts actions_id_token actions_log attachments avatars conf f3
    home indexers jwt log packages queues repo-archive repo-avatars sessions tmp`, and `/data/git`
    holds `lfs repositories`. The table above classifies every one of them. A guard test pins the
    exclude list, and the dump check fails when `forge-data`'s tar listing lacks `git/repositories/`,
    `gitea/conf/app.ini` or `gitea/jwt/`.
- **Alternatives rejected**:
  - **`forgejo dump --type tar`** (uncompressed) still includes artifacts; there is no skip flag.
  - **Backing up the volume directory directly with restic**: in rootless Docker, the files are owned
    by a sub-UID that the prod user cannot read.

## R8 — The Komodo dump (FR-019d)

- **Decision**: three changes.
  1. **Dump**: the host script (T001, verbatim 2026-10-27) dumps Komodo with **`pg_dumpall`**, which
     has no `--exclude-table-data`, and sends its stderr to `/dev/null`. The dump therefore becomes:
     - `pg_dumpall --globals-only` for roles;
     - one `pg_dump` per non-template database (listed by `psql`, so there is nothing to hard-code),
       each with `--exclude-table-data=cron.job_run_details`. The pattern matches nothing in
       databases without that schema, which `pg_dump` accepts without `--strict-names`.

     stderr goes to the run log instead of `/dev/null`. This keeps the table's definition, drops its
     2,147 MB of run history, and fixes the snapshot from the next run, independently of step 2.
  2. **Retention inside the database**: schedule a pg_cron job, `purge-cron-run-history`, that hourly
     deletes rows with `end_time < now() - interval '3 days'`. It is installed idempotently by
     `infrastructure-as-code/backup/komodo-cron-retention.sql` (unschedule-if-exists, then schedule).
  3. **Once**: the operator deletes the backlog and runs `VACUUM FULL cron.job_run_details` to give
     about 2 GB back to the host. The rewrite takes an exclusive lock on a log table only Postgres
     writes to; quickstart step 4c measures how long it takes.
- **Rationale**: step 1 alone fixes the backup but leaves the database growing. Step 2 alone leaves
  the backup exposed to a regression. Disabling run logging (`cron.log_run = off`) would need a
  Postgres restart through Komodo's own stack, and it throws away the only record of the extension's
  background jobs.
- **Guard**: the backup-script test asserts the exclusion flag. The dump check gives Komodo a
  **maximum** as well as a minimum (warn above 500 MB), so a return of the bloat alerts instead of
  silently re-inflating the dump.
- **Host facts (0c, verified 2026-10-27)**:
  - 11,908,573 rows, from 2026-06-21 22:48 to 2026-10-27 02:16 (about 128 days), so about 180 bytes
    per row and about 93,000 rows per day.
  - The growth comes from four DocumentDB jobs. Two run **every 2 seconds**
    (`build_index_concurrently(1)` and `(2)`, 43,200 runs a day each), and two every minute
    (`delete_expired_rows`, `cursor_directory_cleanup`). That gives 89,280 rows a day, which matches.
  - **No job purges the table.**
  - Retention is therefore **3 days**, not 7: about 270,000 rows, ≈ 50 MB. A week would hold
    ≈ 113 MB of a log nobody reads past a day. The Komodo dump's 500 MB maximum stays as the
    regression guard.
  - The Komodo dump command itself is fixed by T001's verbatim script.

## R9 — Diagnostic artifact retention (FR-019c)

- **Decision**: every `actions/upload-artifact` step in `.forgejo/workflows/` sets `retention-days`:
  - **14** for diagnostics (`maestro-debug`, container logs, scan reports, Playwright reports);
  - **7** for the release APK artifact, which is also published to the `mcm-app-android` package.

  A guard test fails on any upload step without `retention-days`, or with a value over 30. The forge
  server default (`[actions] ARTIFACT_RETENTION_DAYS`) is set to 30 in the runbook's forge compose
  block, as a backstop for any workflow outside this repository.
- **Baseline (0e, 2026-10-27)**: the five newest artifacts (`dast-report`, `sast-report`) expire at
  exactly created + 90 days. That confirms the default applies today.
- **Verified after PR B (0e, 2026-10-31, T036)**: Forgejo 15 honours the per-upload value. The 15
  newest artifacts expire at created + **14.0** days (`sast-report`, `infra-image-scan-report`) and
  created + **7.0** days (the release APK, 57 MB). The server's 30 days is a backstop only. Artifacts
  uploaded before the change keep the 90 days they were stamped with (expiry is set at upload), so
  the last of them expire in late January 2027.
- **Context**: the artifacts are now excluded from the backup (R7), so this bounds host disk, not
  backup size. PR #864 already stops the Maestro accumulation (FR-019b).

## R10 — Is the registry backed up at all?

- **Decision**: no, except release APKs. The nightly backup adds a small dump of the
  `mcm-app-android` package files (5 versions, 609 MB, about one new version per release),
  downloaded from the forge's generic-package API with a second host token scoped `read:package`
  only. The download is a dump like any other (`run_dump`, min size, shrink check). Because the files
  are immutable, restic stores each APK once. The operator confirms at quickstart step 0f that they
  accept a second host token. **Operator answer 2026-10-27: yes**, so the `release-apks` dump is in
  PR B, with its token in `~/backup/forge-package-token` (mode 600).
- **Rationale**: the six app images and the dev-container image are rebuildable from git. A release
  APK is not bit-for-bit rebuildable, and it is the only artefact users actually installed.

## R11 — ci-status sees the dispatched deploy (US2)

- **Facts (repo)**:
  - `trigger-cd` dispatches `cd-deploy.yml` on `ref: main` with `inputs.deploy=true`. The run's
    `head_sha` is main's head **at dispatch time**, which is the pushed sha unless main moved within
    seconds.
  - `cd-deploy` posts no commit status.
  - The `ci-failures` bundle is published by `ci-failure-digest.mjs` and named by
    **`GITHUB_RUN_ID`**.
- **Decision**: add a resolver, `findDispatchedDeploy(sha, runs)`, that selects runs where
  `workflow_id` is `cd-deploy.yml`, the event is `workflow_dispatch` and `head_sha` equals the sha. It
  takes the **newest** (a re-run wins) and maps the run's status to the existing check states.
  - `status`/`watch` add it as a non-required context named `cd-deploy / build-deploy (dispatched)`.
    The existing `requiredGlobs` mechanism excludes it from the merge verdict by construction, which
    satisfies FR-012.
  - `watch` treats a terminal deploy failure as an exit condition.
  - `failure --sha` (and `--run`) on a failed dispatched run with no statuses falls back to the bundle
    `ci-failures/<run_id>`. When the bundle is missing it prints
    `deploy run <id> FAILED; no evidence bundle published` and exits non-zero. It never prints
    "No failed jobs".
- **Fixtures**: recorded API payloads under `scripts/__tests__/fixtures/ci-status/` for three cases:
  dispatched-failed with no status, dispatched-success, and dispatched-in-progress. A test asserts
  that deleting the fallback turns the failed fixture red (FR-011).
- **Rejected**: making `cd-deploy` post a commit status. It is optional per the spec's Assumptions,
  and it would need a status-write token in cd-deploy. It can follow later, and the resolver still
  works for historical runs.

## R12 — PR-time app-image scan (US3)

- **Facts (repo)**:
  - `app-e2e` runs on the ci host (`runs-on: kvm`).
  - It builds `mc-service` and `mcm-bff` in "Build mc-service + mcm-bff images", and the four agent
    images through `agent-stack.mjs` (compose build) during "bring up containerized agent".
  - `scan-push.sh` scans the local tags `mc-service:latest`, `mcm-bff:latest`, `agent-gateway:latest`,
    `movie-mcp:latest`, `web-api-mcp:latest` and `spreadsheet-mcp:latest`, using
    `infra-image-scan.mjs` then `check-infra-image-findings.mjs`.
- **Decision**:
  - **Shared step**: extract the per-image scan-and-verdict block of `scan-push.sh` into
    `scripts/cd/scan-app-image.sh <local-tag>`, with its two distinct failure meanings unchanged.
    `scan-push.sh` calls it, and so does the new job. One pipeline means one scanner pin (inside
    `infra-image-scan.mjs`), one set of flags and one allowlist (`security/infra-images/allowlist.yaml`).
  - **Image hand-off**: at the end of image building, `app-e2e` re-tags each of the six images as
    `app-scan/<name>:run-${{ github.run_id }}`. The tag is immutable per run, so a later run that
    rebuilds `:latest` on the same host daemon cannot change what is scanned.
  - **New job**: `app-image-scan`, required, `runs-on: kvm`, `needs: [changes, app-e2e]`,
    `if: always()`.
    - When `changes.app` is false it exits 0 with "no app path changed — images identical to main's".
      This follows the pattern `infra-image-scan` uses so a required context always posts.
    - When `app-e2e` failed **before** tagging, it fails, naming the missing tags. It never passes
      on images it could not find.
    - Otherwise it scans the six tags through `scan-app-image.sh`, then removes them.
  - **Requirement wiring**: add `app-image-scan*` to `REQUIRED_CONTEXT_GLOBS` (the fallback) and to
    branch protection (operator step). Add it to `trigger-cd`'s `needs` and condition, so a deploy is
    never dispatched past a red scan.
  - **Drift guard**: `scripts/__tests__/app-image-scan.test.mjs` asserts that
    - `scan-push.sh` and the job both invoke `scan-app-image.sh`;
    - neither calls `trivy` or `infra-image-scan.mjs` directly;
    - the job's tag list equals `scan-push.sh`'s map.
- **Also on `main` pushes**, deliberately. This duplicates the deploy gate's scan, but blocks
  `trigger-cd` before dispatch, so a vulnerability-database change shows as a red on `main` instead
  of a failed deploy. Cost: one scan of six already-built images.
- **Cost**: the scan runs after app-e2e, so a red arrives after the e2e suite (~35 min), still before
  merge. Building the images a second time in a parallel job would double ~5 min of builds on the one
  ci runner and contend with app-e2e. The trade is recorded; FR-013 asks for reuse where it is
  cheaper, and on a single runner it is.
- **Mutation (FR-015)**: on a throwaway branch, re-add runtime pip to `movie-mcp`'s image on the
  pre-fix base, and observe `app-image-scan` red with the CVE named. Record the run id in the PR.

## R13 — Registry retention (US5)

- **Decision**: a repository script, `scripts/registry-retention.mjs`, configured by
  `infrastructure-as-code/forgejo/registry-retention.yaml`, run by a weekly workflow,
  `.forgejo/workflows/registry-retention.yml`, plus `workflow_dispatch`.
  - **Report-only by default.** It deletes only with `--apply` **and** `mode: apply` in the committed
    config. Unknown flags are rejected by the repository's shared rejecting parser; the
    `prune-bff-runtime-modules.mjs` precedent is the reason.
  - The first production run is report-only, and its list is reviewed in the PR that flips `mode`
    (FR-023).
- **Rules** (initial values, recorded in the config):

  | Package | Keep (whichever keeps more) | Always protected |
  |---|---|---|
  | six app images | newest 40 versions **or** 30 days | each digest pinned in `infrastructure-as-code/docker/*/.env.deploy` on `main` **and** in the previous 5 commits touching those files (rollback = `git revert` of a promotion) |
  | `mcm-devcontainer` | newest 4 **or** 21 days | the digest pinned in `.devcontainer/devcontainer.json` on `main` |
  | `ci-failures` | newest max(400, 25 × bundle-publishing jobs) **or** 45 days | — (window ≥ `DEFAULT_DURATION_RUNS` = 25 per job; a guard test reads the constant) |
  | `mcm-app-android` | all | all (not rebuildable) |
  | any package not in the config | **report it, delete nothing** | — |

- **Protection proof (FR-021)**: protections are computed from git **before** any API call. The script
  refuses to apply when a protected digest cannot be resolved to a registry version, and exits
  non-zero naming it. A unit test feeds a version list containing the deployed and rollback digests
  and asserts that neither appears in the delete list, under every rule. A mutation that drops the
  protected-set filter turns it red.
- **Credential**: a new Actions secret, `REGISTRY_CLEANUP_TOKEN`, scoped `write:package` only.
- **Verify on forge (0g)**:
  - how a container version's manifest digest is exposed by the package API (expected: the package
    files list of the version carries the manifest `sha256`);
  - that deleting a version frees blobs only after the forge's `cleanup_packages` cron (the 122 MB of
    unreferenced blobs measured suggests it runs);
  - that a deleted version cannot be pulled by digest.
- **Answered on the forge (0g, 2026-10-31, T059)**. Fixtures are in
  `scripts/__tests__/fixtures/registry-retention/`.
  - **Listing**: `GET /api/v1/packages/{owner}?page&limit=50`, ordered by name, with
    `X-Total-Count` (3,739 on the day). `q=` is a substring match, so filter by exact name.
  - **The digest**: a tag version's `GET …/container/<name>/<tag>/files` has one `manifest.json`,
    and its `sha256` is the digest `.env.deploy` pins. That digest is an OCI image **index**.
  - **Children**: one push also creates `sha256:<digest>` versions, the platform manifest that owns
    the layers, plus an attestation. They are read from the index via `GET /v2/{owner}/<name>/manifests/<tag>`
    (basic auth). **An unchanged image reuses the previous push's platform manifest**: the 07:48
    `mc-service` index pointed at a child created at 03:14. So children are kept by reference, never
    by age. This is the design change from the decision above.
  - **Delete**: `DELETE /api/v1/packages/{owner}/{type}/{name}/{version}`, from the forge's swagger.
    It was not exercised here; T068/T069 run it.
  - **`ci-failures` already has a deleter**: `ci-failure-digest.mjs` prunes at `RETENTION_DAYS`
    (30) on every publish, so the oldest bundle was 2026-10-01. The retention config only enforces
    the `durations` floor: 25 × 23 publishing jobs = 575, set to 600.
  - **The dev-container pin is not in git.** It is only in each developer's gitignored
    `MCM_DEVCONTAINER_IMAGE`. `devcontainer.json` holds the placeholder. So it has no git
    protection, and the newest 4 / 21 days is what keeps a pin alive.
  - **The first report (read-only, 2026-10-31)**: 2,496 deletes of 3,739, up to 138.6 GB. That is an
    upper bound, since shared blobs are counted per version. 36 protected digests, all resolved.
    0 pinned digests among the deletes, and 0 unsafe among the 72 children of protected indexes.
- **Alternatives rejected**: the forge's built-in package cleanup rules. They match names by regex, so
  they cannot protect a digest named in a git file. They are configured only in the web UI, which
  conflicts with FR-024. And they have no report-only run besides an interactive preview.

## R14 — What the verbatim host script showed (T001, 2026-10-27)

The repository copy's sha256 matches the host for all three files: `backup.sh 2ce6ffd0…`,
`homelab-backup.service c068245d…`, `homelab-backup.timer bbb8a3db…`.

- **Dump formats**: Komodo, Keycloak and agent-db are plain SQL. The two Mongo dumps use
  `--archive --gzip`. The forge dump is `tar.gz`. R5's check table covers all of them.
- **The forge dump is the only one without `|| touch DUMP-FAILED-…`**. This confirms FR-003.
- **Komodo's stderr goes to `/dev/null`**, so a failed Komodo dump leaves a marker but no reason. R8
  fixes this.
- **The snapshot also includes four host directories**: `~/forgejo`, `~/komodo`, `~/rustfs` and
  `~/nx-cache`, none of which is in the per-dump size table. **Measured 2026-10-27 (0h)**:

  | Directory | Size | Contents |
  |---|---|---|
  | `~/forgejo` | 20 K | `compose.yaml` |
  | `~/komodo` | 112 M | Komodo's compose and env |
  | `~/rustfs` | 12 K | `compose.yaml` only (its data is in a Docker volume, not here) |
  | `~/nx-cache` | 7.3 M | `nx-cache-aws` plus `nx-cache.env`: stack config, not the cache itself |

  All four directories hold stack configuration: 120 M in total, almost unchanged from night to
  night. **Keep all four**; T022 needs no exclusion. restic encrypts the env files they contain.

  The 112 M in `~/komodo` is unexplained. Komodo's own scheduled database backups would land there,
  which would be a second copy of the Komodo dump. This is not a defect at this size, and T037 records
  it.
- **The unit has no `OnFailure=`, no `TimeoutStartSec=`, and no `Environment=`.** The script sets
  `DOCKER_HOST` and `RESTIC_*` itself, so the staleness script copies the same three exports.
