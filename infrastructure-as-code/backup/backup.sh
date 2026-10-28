#!/usr/bin/env bash
# Prod host nightly backup. Installed as ~/backup/backup.sh and run by homelab-backup.service;
# the source of truth is infrastructure-as-code/backup/ (spec 084), installed per its README.
#
# It failed every night from 2026-07-27 to 2026-10-22 and nobody was told. So: every dump runs
# through run_dump, and one failure can no longer skip the rest; each dump is checked in its own
# format and against last night's size (dump-manifest.tsv travels inside the snapshot); and a
# failed run exits 1, so the unit's OnFailure= opens the backlog alert.
#
# What it carries (spec 084 US4, research R7/R8/R10): the forge as a database dump plus an
# UNCOMPRESSED tar of /data without CI artifacts, packages, indexes or scratch (a gzip stream
# de-duplicated nothing: ~20 GiB new per night); Komodo without pg_cron's run history; and the
# release APKs, the one registry artefact a rebuild cannot reproduce.
#
#   backup.sh                      the nightly run
#   backup.sh --ack-shrink <dump>  accept ONE expected shrink of <dump> (e.g. after an exclusion)
#   backup.sh --check-staging      refuse a RAM-backed staging dir, without backing anything up
set -euo pipefail
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
export RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-rclone:nas:homelab/restic}   # overridable only to induce a failure (README)
export RESTIC_PASSWORD_FILE=$HOME/.config/restic-password

BACKUP_DIR="$HOME/backup"
STATE="$BACKUP_DIR/state"
ALERT="$BACKUP_DIR/backup-alert.sh"
LAST_GOOD="$STATE/last-good.tsv"
PACKAGE_TOKEN_FILE="$BACKUP_DIR/forge-package-token"   # read:package only (R10)
DUMPS="forge-db forge-data komodo keycloak agent-db mc-service-mongo bff-mongo release-apks"
SHRINK_ALERT_PCT=50   # a dump under half of last good night's size alerts (FR-003b)
FORGE_OWNER=jumbleknot
APK_PACKAGE=mcm-app-android

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
OVERSIZE=""
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

# What a tar dump must list for a restore to work (R7): the repositories, the config, and the JWT
# signing keys (without them every issued token and the Actions OIDC identity change).
tar_requires() {
  case "$1" in
    forge-data) printf '%s\n' '^(\./)?git/repositories/' '^(\./)?gitea/conf/app\.ini$' '^(\./)?gitea/jwt/' ;;
  esac
}

# Prints the verdict for one written dump. Size first: an empty file fails every format check too,
# and "failed-min" names the actual problem.
check_dump() {
  local name=$1 min=$2 max=$3 format=$4 path=$5 bytes listing re
  bytes=$(stat -c %s "$path")
  if [ "$bytes" -lt "$min" ]; then echo failed-min; return; fi
  case "$format" in
    pg-plain) tail -c 256 "$path" | grep -qE '^-- PostgreSQL database (cluster )?dump complete$' || { echo failed-format; return; } ;;
    pg-custom) [ "$(head -c 5 "$path")" = PGDMP ] || { echo failed-format; return; } ;;
    gzip) gzip -t "$path" 2>/dev/null || { echo failed-format; return; } ;;
    tar)
      listing=$(tar -tf "$path" 2>/dev/null) || { echo failed-format; return; }
      while read -r re; do
        [ -z "$re" ] || grep -qE "$re" <<< "$listing" || { echo "  $name: the archive lists nothing matching $re" >&2; echo failed-format; return; }
      done <<< "$(tar_requires "$name")"
      ;;
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
    verdict=$(check_dump "$name" "$min" "$max" "$format" "$out")
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
  case "$verdict" in
    failed-*) FAILED="$FAILED $name"; : > "$STAGE/DUMP-FAILED-$name" ;;
    warn-max) OVERSIZE="${OVERSIZE}${name} ${bytes} > ${max}"$'\n' ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$file" "$bytes" "$min" "$max" "$format" "$prev" "$verdict" >> "$MANIFEST"
  echo "  $name: $bytes bytes, $verdict"
}

# Roles from pg_dumpall, then each database from pg_dump WITHOUT cron.job_run_details' rows: the
# table pg_cron logs every run into, which no job purged (2,147 MB on 2026-10-27; R8). pg_dumpall
# has no --exclude-table-data. On the host the only database is `postgres` (2026-10-28), but they
# are listed, not assumed. The password reaches docker by NAME (`-e PGPASSWORD`), never in argv.
dump_komodo() {
  local kuser dbs db
  local -x PGPASSWORD
  kuser=$(grep -E '^KOMODO_DATABASE_USERNAME=' "$HOME/komodo/compose.env" | cut -d= -f2-) || return 1
  PGPASSWORD=$(grep -E '^KOMODO_DATABASE_PASSWORD=' "$HOME/komodo/compose.env" | cut -d= -f2-) || return 1
  docker exec -e PGPASSWORD komodo-postgres-1 pg_dumpall -U "$kuser" --globals-only || return 1
  dbs=$(docker exec -e PGPASSWORD komodo-postgres-1 psql -U "$kuser" -d postgres -Atc \
    'select datname from pg_database where not datistemplate order by 1') || return 1
  for db in $dbs; do
    docker exec -e PGPASSWORD komodo-postgres-1 pg_dump -U "$kuser" -d "$db" --exclude-table-data=cron.job_run_details || return 1
  done
}

# <container> [pg_dump options…]
dump_postgres() {
  local c=$1
  shift
  docker exec "$c" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"
}

# <app container> <env var holding the URI> <mongo container>
dump_mongo() {
  local uri
  uri=$(cenv "$1" "$2") && [ -n "$uri" ] || { echo "  cannot read $2 from $1" >&2; return 1; }
  uri="${uri/@$3:/@127.0.0.1:}"
  docker exec -e U="$uri" "$3" sh -c 'mongodump --uri="$U" --archive --gzip'
}

# Every file of every mcm-app-android version, as an uncompressed tar of release-apks/<version>/<file>:
# the files are immutable, so restic stores each APK once. A subshell, so the token's header file
# and the download dir (outside $STAGE: neither may be uploaded) are removed however it ends.
dump_release_apks() (
  [ -f "$PACKAGE_TOKEN_FILE" ] || { echo "  token file $PACKAGE_TOKEN_FILE is missing" >&2; exit 1; }
  [ "$(stat -c %a "$PACKAGE_TOKEN_FILE")" = 600 ] || { echo "  token file $PACKAGE_TOKEN_FILE must be mode 600" >&2; exit 1; }
  # shellcheck source=/dev/null
  [ ! -f "$BACKUP_DIR/alert.env" ] || . "$BACKUP_DIR/alert.env"
  [ -n "${MCM_FORGE_URL:-}" ] || { echo "  MCM_FORGE_URL is not set (expected in $BACKUP_DIR/alert.env)" >&2; exit 1; }
  work=$(mktemp -d "$BACKUP_DIR/apk-work.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  # The token reaches curl through a header FILE: never argv, where `ps` and the journal can see it.
  printf 'Authorization: token %s\n' "$(tr -d '\n' < "$PACKAGE_TOKEN_FILE")" > "$work/auth"
  get() { curl -fsS --connect-timeout 30 -H @"$work/auth" "$1"; }
  # Only names safe as a path segment; `q=` is a substring match, so the name must match exactly.
  names() {
    python3 -c 'import json, re, sys
for x in json.load(open(sys.argv[1])):
    v = str(x.get(sys.argv[2], ""))
    if (len(sys.argv) < 4 or x.get("name") == sys.argv[3]) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", v):
        print(v)' "$@"
  }
  # Pages of 50 until a short one: one unpaginated read stops seeing versions (publish-apk.mjs).
  : > "$work/versions"
  page=1
  while :; do
    get "$MCM_FORGE_URL/api/v1/packages/$FORGE_OWNER?type=generic&q=$APK_PACKAGE&page=$page&limit=50" > "$work/page.json" || exit 1
    names "$work/page.json" version "$APK_PACKAGE" >> "$work/versions" || exit 1
    [ "$(python3 -c 'import json, sys; print(len(json.load(open(sys.argv[1]))))' "$work/page.json")" -ge 50 ] || break
    page=$((page + 1))
  done
  while read -r v; do
    get "$MCM_FORGE_URL/api/v1/packages/$FORGE_OWNER/generic/$APK_PACKAGE/$v/files" > "$work/files.json" || exit 1
    names "$work/files.json" name > "$work/files" || exit 1
    [ -s "$work/files" ] || { echo "  $APK_PACKAGE $v lists no files" >&2; exit 1; }
    mkdir -p "$work/release-apks/$v"
    while read -r f; do
      get "$MCM_FORGE_URL/api/packages/$FORGE_OWNER/generic/$APK_PACKAGE/$v/$f" > "$work/release-apks/$v/$f" || exit 1
    done < "$work/files"
  done < "$work/versions"
  tar -cf - -C "$work" release-apks
)

KIB=1024
MIB=$((1024 * KIB))

echo "[1/8] Forgejo database dump (pg_dump custom format)..."
run_dump forge-db $((1 * MIB)) - pg-custom forge-db.dump -- dump_postgres forgejo-forgejo-db-1 -Fc

echo "[2/8] Forgejo data (uncompressed, without CI artifacts, packages, indexes or scratch)..."
# BusyBox tar 1.37 in the image (2026-10-28): --exclude before the named members. Uncompressed on
# purpose: restic de-duplicates an unchanged file, never a gzip stream (R7).
run_dump forge-data $((10 * MIB)) - tar forge-data.tar -- \
  docker exec forgejo-forgejo-1 tar -cf - -C /data \
  --exclude=gitea/actions_artifacts --exclude=gitea/packages --exclude=gitea/repo-archive \
  --exclude=gitea/indexers --exclude=gitea/queues --exclude=gitea/tmp --exclude=gitea/log \
  --exclude=gitea/sessions gitea git

echo "[3/8] Komodo Postgres dump (without pg_cron run history)..."
# Maximum 500 MB: the run history's return alerts instead of silently re-inflating the dump.
run_dump komodo $((1 * MIB)) 500000000 pg-plain komodo-postgres.sql -- dump_komodo

echo "[4/8] Keycloak Postgres dump..."
run_dump keycloak $((50 * KIB)) - pg-plain keycloak-postgres.sql -- dump_postgres keycloak-store-postgres

echo "[5/8] Agent-db Postgres dump..."
# Minimum 1 byte: agent_db has no tables by design (the gateway checkpoints in memory).
run_dump agent-db 1 - pg-plain agent-db-postgres.sql -- dump_postgres movie-assistant-store-postgres

echo "[6/8] MongoDB dumps (mc-service movie data + BFF agent config)..."
run_dump mc-service-mongo $((100 * KIB)) - gzip mc-service-mongo.archive.gz -- \
  dump_mongo mc-service MC_DB_URL mc-service-store-mongo
run_dump bff-mongo $((1 * KIB)) - gzip bff-mongo.archive.gz -- \
  dump_mongo mcm-bff-service MONGO_URL mcm-bff-store-mongo

echo "[7/8] Release APKs (the mcm-app-android package)..."
run_dump release-apks $((10 * MIB)) - tar release-apks.tar -- dump_release_apks

echo "[8/8] restic backup (dumps + all compose/.env config)..."
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

if [ -n "$OVERSIZE" ]; then
  printf 'Dumps over their maximum (bytes > max); for komodo, check cron.job_run_details:\n%s' "$OVERSIZE" > "$STAGE/oversize.txt"
  alert komodo-oversize "$STAGE/oversize.txt"
fi

if [ -n "$FAILED$RESTIC_FAILED" ]; then
  echo "FAILED — dumps:${FAILED:- none}; restic:${RESTIC_FAILED:- ok}" >&2
  exit 1
fi
if [ -z "$SHRINKS" ]; then
  cp "$MANIFEST" "$LAST_GOOD"
  # Not after an oversize alert: "recovered" would close the item that alert just opened.
  [ -n "$OVERSIZE" ] || alert recovered -
fi
echo "Done."
restic snapshots --compact
