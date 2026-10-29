# Prod host backup

The nightly restic backup of the prod host, and the alerting that makes its failure visible. These
files are the source of truth (spec 084). The host runs copies, installed by the steps below, and
`INSTALLED.sha256` is how you check that the copies match.

What it does, what it excludes and how to restore: the **Backups** part of Phase 14 in
[Server-Setup-Runbook.md](../../docs/runbooks/Server-Setup-Runbook.md).

| File | Installed at | Role |
|---|---|---|
| `backup.sh` | `~/backup/backup.sh` | the nightly run: dumps, checks, `restic backup`, retention |
| `backup-alert.sh` | `~/backup/backup-alert.sh` | opens or comments on the backlog item `Prod backup: failed or stale` |
| `backup-staleness.sh` | `~/backup/backup-staleness.sh` | alerts when the newest snapshot is over 36 h old |
| `komodo-cron-retention.sql` | `~/backup/komodo-cron-retention.sql` | the hourly pg_cron job that purges Komodo's run history past 3 days (applied once, step 4) |
| `homelab-backup.service` / `.timer` | `~/.config/systemd/user/` | nightly at 03:30; `OnFailure=` alert; 2 h hang timeout |
| `homelab-backup-alert@.service` | `~/.config/systemd/user/` | runs `backup-alert.sh failed <unit>` |
| `homelab-backup-staleness.service` / `.timer` | `~/.config/systemd/user/` | every 6 h, independent of the backup run |
| `INSTALLED.sha256` | — | regenerate with `node scripts/backup-install-manifest.mjs --write` after any change |

## Install or update

Run everything in a **prod** session (`sudo machinectl shell prod@`). Nothing here prints a secret.

**1. Once per token: the host's three credentials.** In the forge UI, create each as an access token
for this host only, with **one** scope:

| File | Scope | Used by |
|---|---|---|
| `~/backup/forge-issue-token` | **issue: read and write** | `backup-alert.sh` |
| `~/backup/forge-package-token` | **package: read** | `backup.sh`, the `release-apks` dump |
| `~/.config/mcm-forge-read-token` | **repository: read** | the `~/mcm-main` checkout (step 2) |

Skip any file that already exists and passes the check below. The host has no `nano`. Create each
file empty and mode 600 first, then fill it with `cat`. For the issue token:

```bash
install -m 600 /dev/null ~/backup/forge-issue-token
```

Then run this line **on its own**, paste the token, press Enter, then Ctrl-D. `stty -echo` keeps the
token off the screen, so a terminal transcript pasted anywhere afterwards does not carry it (a bare
`cat >` echoed one into a chat on 2026-10-29, and it had to be rotated):

```bash
stty -echo; cat > ~/backup/forge-issue-token; stty echo; echo "written"
```

Check it:

```bash
stat -c '%a %n' ~/backup/forge-issue-token
echo "token length: $(tr -d '\n' < ~/backup/forge-issue-token | wc -c)"
```

Expected: `600 /home/prod/backup/forge-issue-token` and `token length: 40`. Repeat the three blocks
for `~/backup/forge-package-token`. For `~/.config/mcm-forge-read-token`, run
`mkdir -p ~/.config` first.

Then the forge URL, which the alert and the APK dump both read:

```bash
echo 'MCM_FORGE_URL=http://127.0.0.1:3000' > ~/backup/alert.env
curl -fsS http://127.0.0.1:3000/api/v1/version; echo
```

Expected: a `{"version":"…"}` line. If the forge does not answer on `127.0.0.1:3000`, put the URL you
use for it into `~/backup/alert.env` instead.

**2. Once: a checkout of `main` to install from.** A shallow clone, authenticated by the read token
through a credential helper, so the token never enters the URL, argv or `.git/config`:

```bash
FORGE=$(sed -n 's/^MCM_FORGE_URL=//p' ~/backup/alert.env)
GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 --branch main -c credential.helper='!f() { test "$1" = get && echo username=token && echo "password=$(tr -d "\n" < ~/.config/mcm-forge-read-token)"; }; f' "$FORGE/jumbleknot/mcm.git" ~/mcm-main
git -C ~/mcm-main log --oneline -1
```

Expected: one commit line from `main`. The helper is saved in the clone's config (it reads the token
file each time; the token itself is never stored there), so later updates need no token handling.
Older instructions used `~/mcm-080`, a single-branch clone of a branch that no longer exists; once
`~/mcm-main` works, `rm -rf ~/mcm-080`.

**3. Every time: update the checkout and copy the files.**

```bash
GIT_TERMINAL_PROMPT=0 git -C ~/mcm-main pull -q --ff-only && git -C ~/mcm-main log --oneline -1
SRC=~/mcm-main/infrastructure-as-code/backup
install -m 0750 "$SRC"/backup.sh "$SRC"/backup-alert.sh "$SRC"/backup-staleness.sh ~/backup/
install -m 0640 "$SRC"/komodo-cron-retention.sql ~/backup/
install -m 0644 "$SRC"/homelab-backup*.service "$SRC"/homelab-backup*.timer ~/.config/systemd/user/
(cd ~ && sha256sum -c "$SRC/INSTALLED.sha256")
systemctl --user daemon-reload
systemctl --user enable --now homelab-backup-staleness.timer
systemctl --user list-timers 'homelab-backup*' --no-pager
systemd-analyze calendar '*-*-* 00/6:15:00' | head -3
~/backup/backup.sh --check-staging
```

Expected:
- the commit line is the `main` you meant to install;
- every `sha256sum` line ends `OK`;
- two timers are listed, `homelab-backup.timer` and `homelab-backup-staleness.timer`;
- `systemd-analyze` prints the next 6-hourly elapse time;
- `--check-staging` prints a disk filesystem, not `tmpfs`.

**4. Once: Komodo's scheduler-history retention.** Install the purge job, then clear the backlog it
would otherwise take three days to reach. `VACUUM FULL` gives the space back to the host; it locks a
table only pg_cron writes to, and `time` measures how long it takes.

```bash
KU=$(grep -E '^KOMODO_DATABASE_USERNAME=' ~/komodo/compose.env | cut -d= -f2-)
export PGPASSWORD=$(grep -E '^KOMODO_DATABASE_PASSWORD=' ~/komodo/compose.env | cut -d= -f2-); echo "password length: ${#PGPASSWORD}"
docker exec -i -e PGPASSWORD komodo-postgres-1 psql -U "$KU" -d postgres -v ON_ERROR_STOP=1 < ~/backup/komodo-cron-retention.sql
docker exec -e PGPASSWORD komodo-postgres-1 psql -U "$KU" -d postgres -Atc "select jobname, schedule from cron.job where jobname = 'purge-cron-run-history'"
time docker exec -e PGPASSWORD komodo-postgres-1 psql -U "$KU" -d postgres -v ON_ERROR_STOP=1 -c "DELETE FROM cron.job_run_details WHERE end_time < now() - interval '3 days'" -c "VACUUM FULL cron.job_run_details"
unset PGPASSWORD
~/backup/backup.sh --ack-shrink komodo
```

Expected:
- `password length: 48`;
- the SQL file prints an (empty, the first time) `unschedule` result and a job id;
- `purge-cron-run-history|17 * * * *`;
- `DELETE <rows>`, `VACUUM`, and the `real` time;
- `the next run accepts a shrink of komodo`. Komodo's dump drops from about 2 GB, so without the ack
  the first night would raise a `shrink` alert. The new forge and APK dumps have no previous size,
  so they need no ack.

Applying the SQL file again is safe: it removes the job if it exists, then creates it.

## Check the alerting works (once after install)

These steps are quickstart US1 steps 2 and 5 in `specs/084-silent-failure-visibility/quickstart.md`.

> **Do not press Ctrl-C during the first line.** It points the backup at a repository that does not
> exist and restores the default only when the run ends. Interrupted, the override stays set, and
> every nightly run fails until you clear it with
> `systemctl --user unset-environment RESTIC_REPOSITORY`.

```bash
systemctl --user set-environment RESTIC_REPOSITORY=rclone:nas:homelab/does-not-exist; systemctl --user start homelab-backup.service; echo "exit=$?"; systemctl --user unset-environment RESTIC_REPOSITORY
systemctl --user status homelab-backup-alert@homelab-backup.service.service --no-pager | tail -3
MCM_BACKUP_STALE_HOURS=0 ~/backup/backup-staleness.sh; echo "exit=$?"
```

Expected:
- the backup start reports `exit=1` within ~10 min;
- the alert unit's last line says `alert delivered: failed, opened item #…`;
- the staleness check prints `exit=1`, and the same item gains a `stale` comment.

Confirm the default is restored with
`systemctl --user show-environment | grep RESTIC || echo "default restored"`. If it were left set,
every nightly would fail — loudly, through this same alert.

## After an expected shrink

When a dump is meant to get much smaller (data deliberately deleted, or a new exclusion), tell the
next run to accept it once:

```bash
~/backup/backup.sh --ack-shrink <dump>   # forge-db forge-data komodo keycloak agent-db mc-service-mongo bff-mongo release-apks
```
