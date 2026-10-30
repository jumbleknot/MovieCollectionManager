---
type: Service
title: Prod host backup (restic) and its failure alerting
description: The nightly restic snapshot of the prod host — eight per-service dumps (the forge split into a database dump and an uncompressed data tar, plus the release APKs), per-dump format/minimum/shrink checks, the on-disk staging requirement, Komodo's scheduler-history purge, tag-grouped retention, and the two independent alerting paths (OnFailure on a failed or hung run, and a separate 6-hourly staleness check that reads the newest snapshot from the repository itself) that make a silent failure visible.
tags: [backups, restic, systemd, disaster-recovery, alerting, forgejo, homelab]
resource: infrastructure-as-code/backup/README.md
verified:
  - by: openwiki/0.7.1
    at: 2026-10-28T02:33:05.629Z
sources:
  - id: openwiki-source-fd77a504cc309a02ead6fecf
    resource: repo://.forgejo/workflows/guardrails.yml
  - id: openwiki-source-0bf17bd5484fe4c2f5eafbab
    resource: repo://docs/runbooks/Server-Setup-Runbook.md
  - id: openwiki-source-22fe053486b82dac6259f473
    resource: repo://infrastructure-as-code/backup/backup-alert.sh
  - id: openwiki-source-c56aca4c7fefae967d931edd
    resource: repo://infrastructure-as-code/backup/backup-staleness.sh
  - id: openwiki-source-78ec32b51a25a8fb66d5b292
    resource: repo://infrastructure-as-code/backup/backup.sh
  - id: openwiki-source-21be9cebbe365fe55ab381fd
    resource: repo://infrastructure-as-code/backup/homelab-backup-alert%40.service
  - id: openwiki-source-cc66fcd22d8bffc3f973b0ae
    resource: repo://infrastructure-as-code/backup/homelab-backup-staleness.timer
  - id: openwiki-source-1be01bc0222d08bf89a6ee08
    resource: repo://infrastructure-as-code/backup/homelab-backup.service
  - id: openwiki-source-5f9c91a5ef0e61e1e3b45cef
    resource: repo://infrastructure-as-code/backup/komodo-cron-retention.sql
  - id: openwiki-source-e984dbbbf12bd4ee3c4e7961
    resource: repo://infrastructure-as-code/backup/README.md
  - id: openwiki-source-5560229e88c2aa91002a3238
    resource: repo://scripts/__tests__/backup-alert.test.mjs
  - id: openwiki-source-62d227af87c6a9ae6df49e2f
    resource: repo://scripts/__tests__/backup-install-manifest.test.mjs
  - id: openwiki-source-e7f0e8dc4c3a226a7016ac70
    resource: repo://scripts/__tests__/backup-script.test.mjs
  - id: openwiki-source-846dbf0390c104f672d08dfc
    resource: repo://scripts/__tests__/backup-staleness.test.mjs
  - id: openwiki-source-df39e2c4cf5113ffc6347c6f
    resource: repo://scripts/__tests__/backup-units.test.mjs
  - id: openwiki-source-95bfea7e625c030a4806299d
    resource: repo://scripts/__tests__/host-shims.mjs
  - id: openwiki-source-715432c2fa445bfbb51b85ee
    resource: repo://scripts/__tests__/komodo-cron-retention.test.mjs
  - id: openwiki-source-1bce6b78afa7160b5f9a9d66
    resource: repo://scripts/backup-install-manifest.mjs
  - id: openwiki-source-d7d2cddf4ddb5ba9b5d29860
    resource: repo://specs/084-silent-failure-visibility/contracts/cli-contracts.md
  - id: openwiki-source-75f8add1789d37f1c762c383
    resource: repo://specs/084-silent-failure-visibility/quickstart.md
  - id: openwiki-source-e9740ee34eee91e33cfb77d0
    resource: repo://specs/084-silent-failure-visibility/research.md
  - id: openwiki-source-e4b41dde0467ae4ba999bc66
    resource: repo://specs/084-silent-failure-visibility/spec.md
generated: { by: "openwiki/0.7.1", at: "2026-10-27T23:08:42.159Z" }
---

# Prod host backup (restic) and its failure alerting

**Not the same thing as the in-app backups.** This page is the operator's **host-level disaster
recovery**: one restic snapshot of every stateful service on the prod host (Forgejo, Komodo, Keycloak,
agent-db and both Mongo instances), the service config directories, and the release APKs a rebuild
cannot reproduce — pushed to a remote the operator controls. Feature 073's per-user **collection
backups** are an application feature — each member exports their own collections to S3-compatible or
WebDAV storage *they* own, scheduled by the BFF — and they have their own page,
[Per-user collection backups](../runbooks/backups.md). Neither replaces the other: **a user's own
backup does not protect the host, and the host snapshot cannot be restored per user.** That
disambiguation is the source runbook's own, at
[Phase 14 — Backups, disaster recovery & UPS](../../docs/runbooks/Server-Setup-Runbook.md#phase-14--backups-disaster-recovery--ups),
which is also where the restore procedure lives.

The whole thing is **config-as-code** in [`infrastructure-as-code/backup/`](../../infrastructure-as-code/backup/),
moved into the repository by spec 084 on 2026-10-27 — before that it existed only on the host. Its
[README](../../infrastructure-as-code/backup/README.md) is the canonical file for this subject: the
install/update/verify contract, the file-to-install-path table, and the induced-failure checks.

## What one nightly run does

`backup.sh` runs from the **prod** user's systemd user manager, on a nightly timer (03:30,
`Persistent=true`), against a restic repository on an rclone remote (`rclone:nas:homelab/restic`); the
repository password comes from `RESTIC_PASSWORD_FILE` outside the script, and every other credential is
read live from a compose env file or a running container, so **the script holds no secret**.

1. **Staging on disk.** A staging directory is created under `~/backup/` and removed on exit. This is
   not cosmetic — see the staging gotcha below.
2. **Eight dumps, each through `run_dump`**: `forge-db`, `forge-data`, `komodo`, `keycloak`,
   `agent-db`, `mc-service-mongo`, `bff-mongo`, `release-apks`. Each writes one file into the staging
   directory, is checked in its own format against a per-dump minimum size, and is compared against its
   size in the last good run.
3. **A manifest that travels inside the snapshot.** `dump-manifest.tsv` records, per dump, the file,
   bytes, minimum, maximum, format, the previous run's bytes and the verdict. A copy of it becomes
   `~/backup/state/last-good.tsv` after a fully good run, and the next run compares against that.
4. **`restic backup`** of the staging directory *plus* the service config directories (`~/forgejo`,
   `~/komodo`, `~/rustfs`, `~/nx-cache` — compose files and `.env`s, enough to stand each service back
   up; the RustFS Nx-cache store's **data** volume is excluded as rebuildable).
5. **`restic forget --prune`** with 7 daily / 4 weekly / 6 monthly retention.
6. **Alerting and exit status** — a shrink alert, a `komodo-oversize` alert, a `recovered` note on a
   fully good run, or exit 1 with the failed dumps named.

### The dump list grew from six to eight

The forge used to be one dump. It is now two, and the APKs are new:

- **`forge-db`** — a `pg_dump -Fc` **custom-format** database dump of the forge's own Postgres
  (dependency-ordered, so a restore is one `pg_restore` pass), checked for the `PGDMP` magic.
- **`forge-data`** — an **uncompressed** `tar` of `/data` (repositories, config, attachments, the JWT
  signing keys, Actions run logs) with **eight** `--exclude`s: `gitea/actions_artifacts`,
  `gitea/packages`, `gitea/repo-archive`, `gitea/indexers`, `gitea/queues`, `gitea/tmp`, `gitea/log`
  and `gitea/sessions`. Its format check is a **content** check: the listing must contain
  `git/repositories/`, `gitea/conf/app.ini` and `gitea/jwt/`, because without the JWT signing keys every
  issued token and the Actions OIDC identity change on restore. The eight excludes are pinned by the
  test suite, so dropping one is a deliberate, reviewed decision about what a restore loses.
- **`release-apks`** — every file of every `mcm-app-android` version, read from the forge's
  generic-package API through the package token, as an uncompressed tar of
  `release-apks/<version>/<file>`: the one registry artefact a rebuild cannot reproduce.

**Why the data tar is uncompressed.** restic chunks content-defined and compresses on its own, so an
unchanged file costs nothing the second night. A gzip stream changes from its first changed byte
onwards, so the old `forgejo dump --type tar.gz` **de-duplicated nothing: 19.8–21.1 GiB were added to
the repository every night.** An uncompressed tar of mostly-unchanged files adds roughly the day's real
change instead.

### Komodo's scheduler history

pg_cron logs every job run into `cron.job_run_details`, and nothing purged it: 11.9 M rows and
2,147 MB by 2026-10-27, about 89,000 rows a day from DocumentDB's own jobs, two of which run every 2
seconds. Two things bound it, and they are separate:

- The **`komodo` dump** excludes the table's *rows* (the roles come from `pg_dumpall --globals-only`,
  then each database `psql` lists from `pg_dump --exclude-table-data=cron.job_run_details`), and it
  carries a **maximum of 500 MB**. Exceeding that is not a failure: the verdict becomes `warn-max`, a
  `komodo-oversize` alert names the dump and both sizes, the snapshot is **still uploaded**, and the
  `recovered` note is suppressed so it cannot close the item the oversize alert just opened.
- [`komodo-cron-retention.sql`](../../infrastructure-as-code/backup/komodo-cron-retention.sql) stops
  the *table* growing: it installs the hourly pg_cron job `purge-cron-run-history`
  (`17 * * * *`), which deletes runs older than **3 days**. It is applied by hand and **safe to
  re-apply** — it unschedules the job if it exists (by `jobid`, since unscheduling by name fails on a
  first apply) and then creates it, and it touches no other table.

## The two independent alerting paths

Every backup problem lands on **one** backlog item, titled `Prod backup: failed or stale`, labelled
`type/bug` and `priority/p1`. It is opened the first time an event occurs; every later event comments
on it; **only a human closes it.** The two paths that raise it are deliberately independent, and that
independence is the whole point:

```mermaid
flowchart TD
  Timer["homelab-backup.timer nightly 03:30"] --> Run["homelab-backup.service backup.sh"]
  Run -->|exit 0| Snap["snapshot uploaded"]
  Run -->|"exit 1, or the 2 h timeout"| Fail["OnFailure="]
  Fail --> AlertUnit["homelab-backup-alert@.service"]
  AlertUnit --> Alert["backup-alert.sh"]
  StaleTimer["homelab-backup-staleness.timer every 6 h"] --> StaleRun["homelab-backup-staleness.service backup-staleness.sh"]
  StaleRun -->|"newest snapshot over 36 h, or unreadable"| Alert
  Alert --> Item["one open backlog item: Prod backup failed or stale"]
  Run -.->|"writes"| Repo["restic repo rclone:nas:homelab/restic"]
  StaleRun -.->|"reads the newest snapshot"| Repo
```

*Two independent paths to the same backlog item: the run's own failure (`OnFailure=`, plus a hang
becoming a failure at the 2 h timeout) and a separate 6-hourly check that reads the snapshot age from
the repository itself — so a run that never happened still raises it.*

- **Path 1 — the run reports its own failure.** A failed run exits 1, and
  `OnFailure=homelab-backup-alert@%n.service` on `homelab-backup.service` runs
  `backup-alert.sh failed <unit>`, which attaches the journal tail with credentials redacted. A run
  still going at `TimeoutStartSec=2h` is a failure too, and is reported as `hung` (the script reads the
  unit's `Result=` property to tell the two apart). A whole run measures 8–10 minutes, so 2 h is
  unambiguous. The alert unit itself has no `OnFailure=` — an alert that fails must not recurse.
- **Path 2 — a check that does not depend on the run.** `homelab-backup-staleness.timer` fires every
  6 h (`Persistent=true`) and runs `backup-staleness.sh`, which lists the `homelab` snapshots **from
  the repository** and computes the newest one's age. Past **36 h** it alerts `stale`; if it cannot
  read the age at all (restic error, empty list, unparsable time) it alerts
  `staleness-unreadable` — **"could not tell" is never reported as fresh.** This is what catches a hung
  run, a stopped timer, or an upload that silently did nothing, none of which fires `OnFailure`.
  `MCM_BACKUP_STALE_HOURS` exists for tests only; no unit sets it. Like the alert unit, the staleness
  service has no `OnFailure=`, because it raises its own alert and would otherwise double-report.

### Reasons, and what an undelivered alert looks like

`backup-alert.sh` accepts exactly these reasons, and `failed` is the only one that re-reads the unit
state:

| Reason | Raised when |
|---|---|
| `failed` / `hung` | the run exited non-zero, or was killed at `TimeoutStartSec=2h` and reports `Result=timeout` |
| `stale` | the newest `homelab` snapshot is 36 h old or more |
| `staleness-unreadable` | the age could not be read at all — never treated as fresh |
| `shrink` | a dump came in under 50 % of its last-good size (the snapshot still uploaded) |
| `komodo-oversize` | the `komodo` dump exceeded its 500 MB maximum (the snapshot still uploaded) |
| `recovered` | a fully good run, which comments on an open item and no-ops when none is open |

Exit codes are part of the contract, because a silent alert is the failure this whole system exists to
remove: **0** delivered (or nothing to do), **2** usage, **3** not configured (missing or
non-600 token file, unset `MCM_FORGE_URL`), **4** the forge API call failed. Codes 3 and 4 print
`alert NOT delivered` to the journal, and the callers echo that line too rather than swallowing it.

## Gotchas

- **Staging must be on disk, and that is measured, not theoretical.** `/tmp` on this host is a **29 G
  tmpfs** (RAM), the forge dump outgrew it, and the original script staged there: backups failed
  **every night from 2026-07-27 to 2026-10-22**, and the failure was found by chance. `--check-staging`
  exists to refuse a tmpfs **before** a run starts — it prints the filesystem and exits non-zero
  without backing anything up, and the nightly run calls the same check and refuses to dump into RAM.
- **One dump's failure must never skip the rest.** Each dump runs through `run_dump`, which never
  fails the script: a failure leaves a `DUMP-FAILED-<name>` marker inside the snapshot, the remaining
  dumps and the upload still run, and the run's exit status reports it so `OnFailure=` fires. The July
  script's forge step was the one step with no fallback, so under `set -e` its failure took every
  database dump and the off-site upload down with it — for three months, with only a `Failed with
  result 'exit-code'` journal line that nothing read.
- **Retention must group by tag, never by path.** `restic forget` is called with `--tag homelab
  --group-by host,tags`, because the staging directory's name is random: restic's default `host,paths`
  grouping put every snapshot in a group of one and **pruned nothing**. The same randomness is why the
  staleness check reads all `homelab` snapshots rather than `--latest`, which is per path group.
- **Whenever a stateful service is added, its dump must be added to `backup.sh` — with a minimum size
  and a format check.** The original script dumped only Forgejo, Komodo and the object-store/nx-cache
  config directories; a reboot then corrupted Forgejo's Postgres, and Forgejo happened to be the only
  stateful service with a real backup. Format checks are per dump (a plain SQL dump must end at
  Postgres's `dump complete` marker, a custom-format dump must start with `PGDMP`, a Mongo archive must
  pass `gzip -t`, the forge tar must list what a restore needs), and the minimum may legitimately be
  near zero: `agent-db`'s is **1 byte** because `agent_db` has no tables by design (the gateway
  checkpoints in memory), so "non-empty" alone is the wrong test. The only dump with a maximum is
  `komodo`; exceeding it is recorded as `warn-max`, which alerts `komodo-oversize` but neither fails the
  run nor stops the upload.
- **A shrink below 50 % of the last good run alerts but still uploads, and an `ack-shrink` covers
  exactly one run.** `~/backup/backup.sh --ack-shrink <dump>` writes a state file that the next run
  consumes and deletes, so an expected shrink (data deliberately deleted, a new exclusion) is
  acknowledged once rather than accepted forever. **The threshold is never raised instead.** Only a
  fully good run rewrites `last-good.tsv` — a failed run must not become the baseline — and a run with
  no previous manifest records `compare=skipped` in the manifest rather than silently skipping. The
  dump names to ack are the eight above; the old `forge` name is refused.
- **Komodo's dump size and the retention job are two halves of one problem.** The dump excluding
  `cron.job_run_details` keeps last night's *snapshot* small; `komodo-cron-retention.sql` keeps the
  *table* small. Installing the job drops the dump from about 2 GB, so the README pairs it with a
  `--ack-shrink komodo` — without the ack the first night would raise a `shrink` alert. If the dump
  starts creeping back over 500 MB, the alert names it and the first thing to check is whether the
  purge job is still scheduled.
- **A run that never happens, or an upload that silently did nothing, fires no `OnFailure`.** That is
  exactly why the staleness check is a **separate unit** reading the newest snapshot from the
  repository itself, and why "could not tell" is reported as an alert and never as fresh. A heartbeat
  file written by the run being checked would not be independent; a CI-hosted check would need the
  restic password (which decrypts every backup) in Actions secrets.
- **The alert needs a token file (mode 600) and the forge's local URL in its env file.** The token
  reaches `curl` through a header **file**, never argv, so `ps` and the journal never see it; a missing
  token, a wrong mode, or an unset URL exits **3**, an HTTP failure exits **4**, and both say
  `alert NOT delivered` in the journal rather than being silent. The script also redacts what it posts:
  URI user-info is masked and any line naming a credential is dropped, because a backup journal is
  exactly where a connection string turns up. The forge host is never committed to the repository — it
  lives only in `~/backup/alert.env` as `MCM_FORGE_URL`.
- **The committed `INSTALLED.sha256` is what lets an operator with no checkout prove the host runs
  what the repository says.** The host has no guaranteed checkout, so the committed checksum list is
  the one artefact both sides can compute with coreutils. Regenerate it with
  `node scripts/backup-install-manifest.mjs --write` and check it with `--check`; each line is
  `<sha256>  <path relative to $HOME>` at the path the README's install block puts the file at, so the
  operator's check is `cd ~ && sha256sum -c <checkout>/infrastructure-as-code/backup/INSTALLED.sha256`.
  **A stale list is worse than none**, because the operator's `sha256sum -c` would then pass against
  an old script — which is why a guard fails when the committed file disagrees with the directory, and
  when a new installable file is not listed.

## Installing, verifying and restoring

`infrastructure-as-code/backup/README.md` owns the how, and the two source documents together are the
operating manual: the README's install/update block, its once-only credential setup, its induced-failure
check, and the `--check-staging` and `--ack-shrink` steps; and the
[Phase 14 Backups section](../../docs/runbooks/Server-Setup-Runbook.md#phase-14--backups-disaster-recovery--ups)
for what a run includes, what is excluded on purpose and how to restore without it, the retention rule,
and the proven Forgejo-Postgres restore procedure. The contract, at the level of what each piece
achieves:

- **Three host tokens, each with exactly one scope.** They are created in the forge UI for this host
  alone, as files with mode 600, and each is used by exactly one caller:
  `~/backup/forge-issue-token` (**issue: read and write**) is what `backup-alert.sh` opens and comments
  with; `~/backup/forge-package-token` (**package: read**) is what `backup.sh` reads the
  `release-apks` files with, and a missing or loose one fails only that dump; and
  `~/.config/mcm-forge-read-token` (**repository: read**) is what the `~/mcm-main` checkout clones
  through a credential helper, so the token never enters the URL, argv or `.git/config`. Nothing here
  is broader than it needs to be — the alert token cannot read packages, the package token cannot open
  issues.
- **`MCM_FORGE_URL` in `~/backup/alert.env`.** One line naming the forge as the host reaches it, read
  by *both* the alert and the APK dump; the real host is never committed. The README has a `curl`
  one-liner to confirm the URL answers before you rely on it.
- **`--check-staging`** answers "where would a dump be staged?" without backing anything up: reach for
  it after any change to the host's filesystems, and after installing, as the last line of the install
  block. It must print a disk filesystem, not `tmpfs`.
- **`--ack-shrink <dump>`** pre-approves one expected shrink, for one run. Reach for it when you
  deliberately delete data, add an exclusion, or install the Komodo retention job — never to silence a
  shrink you have not explained, and never as a way to move the threshold.
- **`sha256sum -c` against the committed manifest.** The install is a **copy**: the host runs
  `~/backup/*.sh` and `~/.config/systemd/user/homelab-backup*`, installed from a checkout and followed
  by `daemon-reload` and enabling the staleness timer. `cd ~ && sha256sum -c <checkout>/INSTALLED.sha256`
  is the one-line proof that the copies match the repository, and `scripts/backup-install-manifest.mjs
  --check` is the same proof inside CI.
- **The once-after-install proof that the alerting works is an induced failure:** point the run at a
  repository that does not exist with `systemctl --user set-environment RESTIC_REPOSITORY=…`, start
  `homelab-backup.service`, expect `exit=1` and an `alert delivered` line, and restore the default **on
  the same line** — an interrupted override stays set and every nightly fails until it is cleared with
  `systemctl --user unset-environment RESTIC_REPOSITORY`. The staleness path is exercised the same way
  with `MCM_BACKUP_STALE_HOURS=0`.
- **A restore is a Phase 14 procedure, not a script here.** The registry and repository archives are
  excluded on purpose because they are rebuildable; after a restore, `cd-deploy` must be re-run once
  before a rollback to an older digest is available.

## The accepted gap

If the whole host, or the **prod user's systemd manager**, is down, both timers stop — so the staleness
check goes down with the backup. That is accepted rather than engineered around, because the same
state also stops the forge, the application and every CI run, so it is loud rather than silent. What
the two paths cover is the case that actually went unseen for three months: **the host is up, and the
backup is broken.**

## Guards

The scripts are guarded behaviourally rather than by inspection, and each suite is a guard for one
thing: `scripts/__tests__/backup-script.test.mjs` runs `backup.sh` against a fake host (docker, restic,
curl, `systemctl` and `df` are shims; `tar`, `gzip` and `python3` are real) and pins the measured
failure modes — a failing forge dump still runs every other dump and still calls `restic backup`, each
dump's format and minimum verdict, the eight forge-data excludes, shrink and ack-shrink, staging under
`~/backup` with tmpfs refused, `--group-by host,tags` on `forget`, and the absence of any literal
credential; `scripts/__tests__/backup-units.test.mjs` pins the unit wiring (`OnFailure=`,
`TimeoutStartSec=2h`, the timers' `OnCalendar` and `Persistent=true`, and that neither the alert unit
nor the staleness service recurses); `scripts/__tests__/backup-alert.test.mjs` pins the exact forge API
calls, the one-open-item rule and the token never appearing in argv; `scripts/__tests__/backup-staleness.test.mjs`
pins "unreadable is never fresh"; `scripts/__tests__/backup-install-manifest.test.mjs` pins the
committed manifest against the directory; and `scripts/__tests__/komodo-cron-retention.test.mjs` pins
the purge job as hourly, idempotent and touching nothing but its own table. All of them run in
`guardrails.yml`'s `naming` job, whose `node --test scripts/__tests__/*.test.mjs` step picks them up
automatically.

Related: [Homelab server setup](../runbooks/server-setup.md) for the phase that owns this,
[Prod reboot resilience](../runbooks/prod-reboot-resilience.md) for the graceful-shutdown drain unit
that prevents the DB corruption a restore would otherwise be needed for,
[Secrets management](../invariants/secrets-management.md) for the redaction posture the alert follows,
and [CI/CD pipeline](ci-cd-pipeline.md) / [Infrastructure stacks](infrastructure-stacks.md) for what the
excluded, rebuildable pieces are rebuilt by.
