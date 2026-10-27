# Quickstart: validating feature 084

Repository checks run in a worktree: `node --test` with node's flags **before** the path, plus
`node scripts/preflight.mjs --gates-only`. Each host step names the session it runs in. The prod user
cannot `sudo`; root steps run from the operator's own account. Never paste a secret: each block reads
it from a file or a container and prints only its length.

## 0 — Host facts the plan depends on (run before the task that needs each one)

0a–0d and 0f were answered 2026-10-27; the results are in research.md (R1, R6, R7, R8, R10). 0e has a
baseline (the 90-day default) and is re-run after PR B. 0g is the assistant's to run.

**0a — prod session (`sudo machinectl shell prod@`)**: which tools the alert scripts can use.
```bash
for t in curl python3 jq restic; do printf '%-8s ' "$t"; command -v "$t" || echo MISSING; done
```
Expected: a path for `curl`, `restic` and at least one of `python3` / `jq`.

**0b — prod session**: the restic version and the forge's data layout.
```bash
restic version
docker exec forgejo-forgejo-1 sh -c 'ls -1 /data/gitea; ls -1 /data/git'
```
Expected: restic 0.14 or later; `/data/gitea` lists `actions_artifacts`, `actions_log`, `packages`,
`indexers`, `queues`, `conf`, …

**0c — prod session**: how fast Komodo's scheduler history grows. Credentials as in Block 6c.
```bash
KUSER=$(grep -E '^KOMODO_DATABASE_USERNAME=' ~/komodo/compose.env | cut -d= -f2-)
KPASS=$(grep -E '^KOMODO_DATABASE_PASSWORD=' ~/komodo/compose.env | cut -d= -f2-); echo "kpass length: ${#KPASS}"
docker exec -e PGPASSWORD="$KPASS" komodo-postgres-1 psql -U "$KUSER" -d postgres -Atc \
 "select count(*), min(end_time), max(end_time) from cron.job_run_details;
  select jobid, schedule, left(command,80) from cron.job;"
```
Expected: `kpass length: 48`, then the row count with the oldest and newest run, then the job list.

**0d — prod session**: is there a repository checkout on the host, from Komodo's git clones?
```bash
find ~ -maxdepth 4 -type d -name infrastructure-as-code 2>/dev/null | head
```
If the output is empty, use the checksum comparison (R6).

**0e — after the first workflow run with `retention-days`**: does the forge honour it? Run in the
operator's account, which can reach the forge database container.
```bash
docker exec forgejo-forgejo-db-1 psql -U forgejo -d forgejo -Atc \
 "select artifact_name, to_timestamp(created_unix), to_timestamp(expired_unix) from action_artifact order by id desc limit 5;"
```
Expected: `expired_unix` is 14 days after `created_unix` for diagnostic artifacts.

**0h — prod session**: the four directories the snapshot also carries (R14).
```bash
du -sh ~/forgejo ~/komodo ~/rustfs ~/nx-cache 2>&1
ls -1 ~/rustfs ~/nx-cache | head -20
```
Expected: four sizes. The listing tells a build cache from data that must be kept.

**0f — operator decision**: do you accept a second, `read:package`-only host token, so that release
APKs are backed up (R10)? Answer yes or no.

**0g — the forge package API**: how a container version exposes its digest. The assistant runs this
with the `git credential fill` token (no host step):
`GET /api/v1/packages/jumbleknot/container/mc-service/<sha>/files`. Expected: an entry whose `sha256`
is the manifest digest.

## US1 — backup alerting

1. **Install.** In a prod session, paste the install block from the runbook. Then
   `systemctl --user list-timers 'homelab-backup*'` should show two timers.
2. **Induced failure.**
   ```bash
   systemctl --user start homelab-backup.service \
     --setenv=RESTIC_REPOSITORY=rclone:nas:homelab/does-not-exist
   ```
   Expected:
   - the unit ends `failed`;
   - **within a minute**, item `Prod backup: failed or stale` opens with reason `failed`;
   - a second induced failure **comments** on that item and does not open a new one.
3. **Forge dump fails, the rest still run.** In the repository:
   `node --test scripts/__tests__/backup-script.test.mjs`. Expected: every dump ran and `restic backup`
   was called, with `DUMP-FAILED-forge-data` in the staging dir.
4. **Empty or truncated dump.** Covered by the same test file, which truncates a fake pg dump and
   empties a fake tar. Expected: `failed-format` / `failed-min`.
5. **Staleness.**
   ```bash
   MCM_BACKUP_STALE_HOURS=0 ~/backup/backup-staleness.sh; echo "exit=$?"
   ```
   Expected: `exit=1` and a `stale` comment on the item. Then
   `RESTIC_REPOSITORY=rclone:nas:nope ~/backup/backup-staleness.sh` should give
   `staleness-unreadable`.
6. **Installed copy matches the repository.**
   ```bash
   sha256sum -c <(sed "s#  #  $HOME/#" infrastructure-as-code/backup/INSTALLED.sha256)
   ```
   This needs a copy of `INSTALLED.sha256` on the host (scp, or the checkout found at 0d). Expected:
   every line `OK`.
7. **Restore drill (FR-006).**
   - Restore the latest snapshot's `forge-db` into a scratch `postgres:18-alpine`, and `forge-data`
     into a scratch dir. Then `git -C <restored>/git/repositories/jumbleknot/mcm.git fsck --connectivity-only`.
   - Restore `mc-service-mongo` into a scratch `mongo` with `mongorestore --archive --gzip`, then count
     the collections.
   - Record the dates, snapshot id, durations and counts in the runbook's restore-drill log.

## US2 — ci-status

```bash
node --test scripts/__tests__/ci-status.test.mjs
node scripts/ci-status.mjs status --sha <a main sha whose deploy failed, e.g. the 2026-10-21 one>
node scripts/ci-status.mjs failure --sha <same>
```
Expected:
- `status` prints `cd-deploy / build-deploy (dispatched)  failed  run <id>` and an unchanged merge
  verdict;
- `failure` prints the cd-deploy digest from `ci-failures/<id>`;
- deleting the fallback (mutation) turns the dispatched-failed fixture test red.

## US3 — PR app-image scan

1. `node --test scripts/__tests__/app-image-scan.test.mjs`: the drift guard is green. Editing one
   gate's flags turns it red.
2. On the US3 PR, `app-image-scan` is green and names six images.
3. Mutation (FR-015): on a throwaway branch, re-add runtime pip on the pre-fix base. Expected:
   `app-image-scan` is red with the CVE named, and `app-e2e` is unaffected.

## US4 — backup size

1. After install, read the next nightly's journal in a prod session:
   `journalctl --user -u homelab-backup --since today | grep -E 'Added to the repository|dump-manifest'`.
   Expected:
   - `forge-data` + `forge-db` are about 1.5 GB in total, and Komodo is under 250 MB;
   - on the **second** night, `Added to the repository` is under 2 GiB (SC-008).
2. Komodo retention: re-run 0c a day after installing `komodo-cron-retention.sql`. Expected:
   `min(end_time)` is within the last 3 days (plus an hour), and
   `pg_total_relation_size('cron.job_run_details')` is under 75 MB after the one-off `VACUUM FULL`.
3. Record the before and after figures in the runbook (FR-017, SC-008).

## US5 — registry retention

```bash
node --test scripts/__tests__/registry-retention.test.mjs
node scripts/registry-retention.mjs --json > retention-report.json   # report-only
```
Expected:
- the tests are green, and a mutation that drops the protected-set filter turns them red;
- the report lists no `delete` row whose digest appears in any `.env.deploy`, or in the
  dev-container pin;
- the operator reviews the totals in the PR that sets `mode: apply`.

After the first `--apply` run and the forge's blob cleanup:
- one deploy and one rollback still succeed (`scripts/cd/rollback.sh` on a test promotion);
- `du -sh` of the package volume shows the drop from 109 G.
