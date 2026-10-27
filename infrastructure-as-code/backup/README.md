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
| `homelab-backup.service` / `.timer` | `~/.config/systemd/user/` | nightly at 03:30; `OnFailure=` alert; 2 h hang timeout |
| `homelab-backup-alert@.service` | `~/.config/systemd/user/` | runs `backup-alert.sh failed <unit>` |
| `homelab-backup-staleness.service` / `.timer` | `~/.config/systemd/user/` | every 6 h, independent of the backup run |
| `INSTALLED.sha256` | — | regenerate with `node scripts/backup-install-manifest.mjs --write` after any change |

## Install or update

Run everything in a **prod** session (`sudo machinectl shell prod@`). Nothing here prints a secret.

**1. Once: the alert's credential and forge URL.** In the forge UI, create an access token for this
host only, with the single scope **issue: read and write**. Then put it in a mode-600 file through an
editor, so it never appears in shell history:

```bash
install -m 600 /dev/null ~/backup/forge-issue-token && nano ~/backup/forge-issue-token
echo "token length: $(tr -d '\n' < ~/backup/forge-issue-token | wc -c)"
echo 'MCM_FORGE_URL=http://127.0.0.1:3000' > ~/backup/alert.env
curl -fsS http://127.0.0.1:3000/api/v1/version; echo
```

Expected: `token length: 40` and a `{"version":"…"}` line. If the forge does not answer on
`127.0.0.1:3000`, put the URL you use for it into `~/backup/alert.env` instead.

**2. Every time: copy the files from a checkout of `main`.** Set `SRC` to that checkout's
`infrastructure-as-code/backup`. For example, after `git -C ~/mcm-080 pull --ff-only` on `main`:

```bash
SRC=~/mcm-080/infrastructure-as-code/backup
install -m 0750 "$SRC"/backup.sh "$SRC"/backup-alert.sh "$SRC"/backup-staleness.sh ~/backup/
install -m 0644 "$SRC"/homelab-backup*.service "$SRC"/homelab-backup*.timer ~/.config/systemd/user/
(cd ~ && sha256sum -c "$SRC/INSTALLED.sha256")
systemctl --user daemon-reload
systemctl --user enable --now homelab-backup-staleness.timer
systemctl --user list-timers 'homelab-backup*' --no-pager
systemd-analyze calendar '*-*-* 00/6:15:00' | head -3
~/backup/backup.sh --check-staging
```

Expected:
- every `sha256sum` line ends `OK`;
- two timers are listed, `homelab-backup.timer` and `homelab-backup-staleness.timer`;
- `systemd-analyze` prints the next 6-hourly elapse time;
- `--check-staging` prints a disk filesystem, not `tmpfs`.

## Check the alerting works (once after install)

These steps are quickstart US1 steps 2 and 5 in `specs/084-silent-failure-visibility/quickstart.md`.

```bash
systemctl --user set-environment RESTIC_REPOSITORY=rclone:nas:homelab/does-not-exist; systemctl --user start homelab-backup.service; echo "exit=$?"; systemctl --user unset-environment RESTIC_REPOSITORY
systemctl --user status homelab-backup-alert@homelab-backup.service.service --no-pager | tail -3
MCM_BACKUP_STALE_HOURS=0 ~/backup/backup-staleness.sh; echo "exit=$?"
```

Expected:
- the backup start reports `exit=1` within ~10 min;
- the alert unit's last line says `alert delivered: failed, opened item #…`;
- the staleness check prints `exit=1`, and the same item gains a `stale` comment.

The first line points one run at a repository that does not exist, then restores the default **on
the same line**. Confirm the restore with
`systemctl --user show-environment | grep RESTIC || echo "default restored"`. If it were left set,
every nightly would fail — loudly, through this same alert.

## After an expected shrink

When a dump is meant to get much smaller (data deliberately deleted, or a new exclusion), tell the
next run to accept it once:

```bash
~/backup/backup.sh --ack-shrink <dump>   # forge komodo keycloak agent-db mc-service-mongo bff-mongo
```
