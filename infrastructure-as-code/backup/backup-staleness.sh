#!/usr/bin/env bash
# Alert when the newest prod backup snapshot is over 36 h old — read from the backup repository
# itself, so it does not depend on the backup run reporting its own failure (spec 084 FR-002).
# Installed as ~/backup/backup-staleness.sh, run every 6 h by homelab-backup-staleness.timer.
#
# A hung run, a stopped timer or an upload that silently did nothing never fires OnFailure; this
# catches all three. Anything it cannot read is an alert too: "could not tell" is never "fresh".
# MCM_BACKUP_STALE_HOURS exists for tests only; no unit sets it.
set -euo pipefail
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
export RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-rclone:nas:homelab/restic}   # overridable only to induce a failure (README)
export RESTIC_PASSWORD_FILE=$HOME/.config/restic-password

THRESHOLD_HOURS=${MCM_BACKUP_STALE_HOURS:-36}
ALERT="$HOME/backup/backup-alert.sh"

[ "$#" -eq 0 ] || { echo "usage: $0   (takes no arguments)" >&2; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

alert() {
  "$ALERT" "$1" "$WORK/detail" || echo "  alert '$1' NOT delivered (exit $?)" >&2
  exit 1
}

# Every homelab snapshot, not --latest: that is per path group, and the staging path is random.
if ! restic snapshots --tag homelab --json > "$WORK/snapshots.json" 2> "$WORK/restic.err"; then
  { echo "restic could not list snapshots:"; tail -n 20 "$WORK/restic.err"; } > "$WORK/detail"
  alert staleness-unreadable
fi

# Prints "<short_id> <time> <age in whole hours>" for the newest snapshot; exits 1 if there is none
# or its time cannot be parsed.
if ! newest=$(python3 - "$WORK/snapshots.json" << 'PY'
import datetime, json, re, sys
try:
    snaps = json.load(open(sys.argv[1]))
    def parsed(s):
        # restic writes nanoseconds; Python parses at most microseconds.
        t = re.sub(r"(\.\d{6})\d+", r"\1", s["time"]).replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(t), s
    newest_time, snap = max(map(parsed, snaps), key=lambda p: p[0])
except Exception as e:
    print(f"no readable snapshot: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
age = datetime.datetime.now(datetime.timezone.utc) - newest_time
print(snap.get("short_id", "?"), newest_time.isoformat(timespec="seconds"), int(age.total_seconds() // 3600))
PY
); then
  { echo "could not read the newest snapshot's time:"; head -c 2000 "$WORK/snapshots.json"; } > "$WORK/detail"
  alert staleness-unreadable
fi

read -r id time hours <<< "$newest"
if [ "$hours" -ge "$THRESHOLD_HOURS" ]; then
  echo "newest snapshot $id at $time is $hours h old (threshold $THRESHOLD_HOURS h)" | tee "$WORK/detail"
  alert stale
fi
echo "newest snapshot $id at $time is $hours h old — fresh (threshold $THRESHOLD_HOURS h)"
