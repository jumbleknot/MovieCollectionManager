#!/usr/bin/env bash
# Prod host nightly backup. Installed as ~/backup/backup.sh and run by homelab-backup.service;
# the source of truth is infrastructure-as-code/backup/ (spec 084), installed per its README.
#
# It failed every night from 2026-07-27 to 2026-10-22 and nobody was told. So: every dump runs
# through run_dump, and one failure can no longer skip the rest; each dump is checked in its own
# format and against last night's size (dump-manifest.tsv travels inside the snapshot); and a
# failed run exits 1, so the unit's OnFailure= opens the backlog alert.
#
#   backup.sh                      the nightly run
#   backup.sh --ack-shrink <dump>  accept ONE expected shrink of <dump> (e.g. after an exclusion)
#   backup.sh --check-staging      refuse a RAM-backed staging dir, without backing anything up
set -euo pipefail
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
export RESTIC_REPOSITORY=rclone:nas:homelab/restic
export RESTIC_PASSWORD_FILE=$HOME/.config/restic-password

BACKUP_DIR="$HOME/backup"
STATE="$BACKUP_DIR/state"
ALERT="$BACKUP_DIR/backup-alert.sh"
LAST_GOOD="$STATE/last-good.tsv"
DUMPS="forge komodo keycloak agent-db mc-service-mongo bff-mongo"
SHRINK_ALERT_PCT=50   # a dump under half of last good night's size alerts (FR-003b)

usage() { echo "usage: $0 [--ack-shrink <dump> | --check-staging]   dumps: $DUMPS" >&2; exit 2; }

# /tmp here is a 29G tmpfs: the forge dump outgrew it, which is how the July outage began.
check_staging() {
  local fs
  fs=$(df --output=fstype "$BACKUP_DIR" | tail -1)
  if [ "$fs" = tmpfs ]; then
    echo "staging $BACKUP_DIR is on tmpfs — refusing: dumps must be staged on disk" >&2
    return 1
  fi
  echo "staging $BACKUP_DIR is on $fs"
}

case "$#:${1:-}" in
  0:) ;;
  1:--check-staging) check_staging; exit ;;
  2:--ack-shrink)
    case " $DUMPS " in *" $2 "*) ;; *) echo "unknown dump: $2" >&2; usage ;; esac
    mkdir -p "$STATE"
    : > "$STATE/ack-shrink-$2"
    echo "the next run accepts a shrink of $2"
    exit 0
    ;;
  *) usage ;;
esac

check_staging || exit 1
mkdir -p "$STATE"
STAGE=$(mktemp -d "$HOME/backup/stage.XXXXXX")   # on disk: /tmp is a 29G tmpfs the dump outgrew (no backup 2026-07-26 → 2026-10-22)
trap 'rm -rf "$STAGE"' EXIT
MANIFEST="$STAGE/dump-manifest.tsv"
printf 'name\tfile\tbytes\tmin_bytes\tmax_bytes\tformat\tprev_bytes\tverdict\n' > "$MANIFEST"
[ -f "$LAST_GOOD" ] || echo "# compare=skipped (no previous manifest)" >> "$MANIFEST"
FAILED=""
SHRINKS=""
ACKED=""

# read one env var from a running container (keeps secrets out of this file)
cenv() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$2=//p"; }

prev_bytes() {
  if [ -f "$LAST_GOOD" ]; then
    awk -F'\t' -v n="$1" '$1 == n { print $3; found = 1 } END { if (!found) print "-" }' "$LAST_GOOD"
  else
    echo -
  fi
}

# Prints the verdict for one written dump. Size first: an empty file fails every format check too,
# and "failed-min" names the actual problem.
check_dump() {
  local min=$1 max=$2 format=$3 path=$4 bytes
  bytes=$(stat -c %s "$path")
  if [ "$bytes" -lt "$min" ]; then echo failed-min; return; fi
  case "$format" in
    pg-plain) tail -c 256 "$path" | grep -qE '^-- PostgreSQL database (cluster )?dump complete$' || { echo failed-format; return; } ;;
    gzip) gzip -t "$path" 2>/dev/null || { echo failed-format; return; } ;;
    tar.gz) tar -tzf "$path" > /dev/null 2>&1 || { echo failed-format; return; } ;;
    *) echo "unknown dump format: $format" >&2; echo failed-format; return ;;
  esac
  if [ "$max" != - ] && [ "$bytes" -gt "$max" ]; then echo warn-max; return; fi
  echo ok
}

# run_dump <name> <min-bytes> <max-bytes|-> <format> <file> -- <command…>
# Never fails the script: a failed dump leaves DUMP-FAILED-<name> in the snapshot, the run carries
# on, and the run's exit status reports it.
run_dump() {
  local name=$1 min=$2 max=$3 format=$4 file=$5 verdict bytes prev
  shift 6
  local out="$STAGE/$file"
  if "$@" > "$out"; then
    verdict=$(check_dump "$min" "$max" "$format" "$out")
  else
    echo "  WARNING: $name dump command failed" >&2
    verdict=failed-command
  fi
  bytes=$(stat -c %s "$out" 2>/dev/null || echo 0)
  prev=$(prev_bytes "$name")
  if [ "$verdict" = ok ] && [ "$prev" != - ] && [ $((bytes * 100)) -lt $((prev * SHRINK_ALERT_PCT)) ]; then
    if [ -f "$STATE/ack-shrink-$name" ]; then
      verdict=ack-shrink
      ACKED="$ACKED $name"
    else
      verdict=alert-shrink
      SHRINKS="${SHRINKS}${name} ${prev} → ${bytes}"$'\n'
    fi
  fi
  case "$verdict" in failed-*) FAILED="$FAILED $name"; : > "$STAGE/DUMP-FAILED-$name" ;; esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$file" "$bytes" "$min" "$max" "$format" "$prev" "$verdict" >> "$MANIFEST"
  echo "  $name: $bytes bytes, $verdict"
}

dump_komodo() {
  local kuser kpass
  kuser=$(grep -E '^KOMODO_DATABASE_USERNAME=' "$HOME/komodo/compose.env" | cut -d= -f2-) || return 1
  kpass=$(grep -E '^KOMODO_DATABASE_PASSWORD=' "$HOME/komodo/compose.env" | cut -d= -f2-) || return 1
  docker exec -e PGPASSWORD="$kpass" komodo-postgres-1 pg_dumpall -U "$kuser"
}

dump_postgres() {
  docker exec "$1" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

# <app container> <env var holding the URI> <mongo container>
dump_mongo() {
  local uri
  uri=$(cenv "$1" "$2") && [ -n "$uri" ] || { echo "  cannot read $2 from $1" >&2; return 1; }
  uri="${uri/@$3:/@127.0.0.1:}"
  docker exec -e U="$uri" "$3" sh -c 'mongodump --uri="$U" --archive --gzip'
}

KIB=1024
MIB=$((1024 * KIB))

echo "[1/6] Forgejo dump (repos + DB + config; registry skipped — rebuilt from git)..."
run_dump forge $((10 * MIB)) - tar.gz forgejo-dump.tar.gz -- \
  docker compose -p forgejo -f "$HOME/forgejo/compose.yaml" exec -T -u git forgejo \
  forgejo dump --type tar.gz --skip-package-data --skip-repo-archives --file - -c /data/gitea/conf/app.ini

echo "[2/6] Komodo Postgres dump..."
run_dump komodo $((1 * MIB)) - pg-plain komodo-postgres.sql -- dump_komodo

echo "[3/6] Keycloak Postgres dump..."
run_dump keycloak $((50 * KIB)) - pg-plain keycloak-postgres.sql -- dump_postgres keycloak-store-postgres

echo "[4/6] Agent-db Postgres dump..."
# Minimum 1 byte: agent_db has no tables by design (the gateway checkpoints in memory).
run_dump agent-db 1 - pg-plain agent-db-postgres.sql -- dump_postgres movie-assistant-store-postgres

echo "[5/6] MongoDB dumps (mc-service movie data + BFF agent config)..."
run_dump mc-service-mongo $((100 * KIB)) - gzip mc-service-mongo.archive.gz -- \
  dump_mongo mc-service MC_DB_URL mc-service-store-mongo
run_dump bff-mongo $((1 * KIB)) - gzip bff-mongo.archive.gz -- \
  dump_mongo mcm-bff-service MONGO_URL mcm-bff-store-mongo

echo "[6/6] restic backup (dumps + all compose/.env config)..."
RESTIC_FAILED=""
restic backup --tag homelab \
  "$STAGE" \
  "$HOME/forgejo" "$HOME/komodo" "$HOME/rustfs" "$HOME/nx-cache" \
  --exclude "**/.cache" --exclude "**/node_modules" || RESTIC_FAILED="$RESTIC_FAILED backup"

echo "retention prune (7 daily / 4 weekly / 6 monthly)..."
restic forget --prune --tag homelab --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6 || RESTIC_FAILED="$RESTIC_FAILED forget"   # group by tag: the stage dir name is random, so the default host+paths grouping kept every snapshot

for name in $ACKED; do rm -f "$STATE/ack-shrink-$name"; done

alert() {
  if [ -x "$ALERT" ]; then
    "$ALERT" "$@" || echo "  alert '$1' NOT delivered (exit $?)" >&2
  else
    echo "  alert '$1' NOT delivered: $ALERT is not installed" >&2
  fi
}

if [ -n "$SHRINKS" ]; then
  printf 'Dumps under %s%% of the last good run (bytes, previous → now):\n%s' "$SHRINK_ALERT_PCT" "$SHRINKS" > "$STAGE/shrink.txt"
  alert shrink "$STAGE/shrink.txt"
fi

if [ -n "$FAILED$RESTIC_FAILED" ]; then
  echo "FAILED — dumps:${FAILED:- none}; restic:${RESTIC_FAILED:- ok}" >&2
  exit 1
fi
if [ -z "$SHRINKS" ]; then
  cp "$MANIFEST" "$LAST_GOOD"
  alert recovered -
fi
echo "Done."
restic snapshots --compact
