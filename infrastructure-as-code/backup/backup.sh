#!/usr/bin/env bash
set -euo pipefail
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
export RESTIC_REPOSITORY=rclone:nas:homelab/restic
export RESTIC_PASSWORD_FILE=$HOME/.config/restic-password
STAGE=$(mktemp -d "$HOME/backup/stage.XXXXXX")   # on disk: /tmp is a 29G tmpfs the dump outgrew (no backup 2026-07-26 → 2026-10-22)
trap 'rm -rf "$STAGE"' EXIT

# read one env var from a running container (keeps secrets out of this file)
cenv() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$2=//p"; }

echo "[1/6] Forgejo dump (repos + DB + config; registry skipped — rebuilt from git)..."
docker compose -p forgejo -f "$HOME/forgejo/compose.yaml" exec -T -u git forgejo \
  forgejo dump --type tar.gz --skip-package-data --skip-repo-archives --file - -c /data/gitea/conf/app.ini > "$STAGE/forgejo-dump.tar.gz"

echo "[2/6] Komodo Postgres dump (best-effort)..."
KUSER=$(grep -E '^KOMODO_DATABASE_USERNAME=' "$HOME/komodo/compose.env" | cut -d= -f2-)
KPASS=$(grep -E '^KOMODO_DATABASE_PASSWORD=' "$HOME/komodo/compose.env" | cut -d= -f2-)
docker exec -e PGPASSWORD="$KPASS" komodo-postgres-1 pg_dumpall -U "$KUSER" \
  > "$STAGE/komodo-postgres.sql" 2>/dev/null \
  || { echo "  WARNING: komodo pg_dump failed"; touch "$STAGE/DUMP-FAILED-komodo"; }

echo "[3/6] Keycloak Postgres dump..."
docker exec keycloak-store-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$STAGE/keycloak-postgres.sql" \
  || { echo "  WARNING: keycloak pg_dump failed"; touch "$STAGE/DUMP-FAILED-keycloak"; }

echo "[4/6] Agent-db Postgres dump..."
docker exec movie-assistant-store-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$STAGE/agent-db-postgres.sql" \
  || { echo "  WARNING: agent-db pg_dump failed"; touch "$STAGE/DUMP-FAILED-agent-db"; }

echo "[5/6] MongoDB dumps (mc-service movie data + BFF agent config)..."
MC_URI=$(cenv mc-service MC_DB_URL); MC_URI="${MC_URI/@mc-service-store-mongo:/@127.0.0.1:}"
docker exec -e U="$MC_URI" mc-service-store-mongo sh -c 'mongodump --uri="$U" --archive --gzip' \
  > "$STAGE/mc-service-mongo.archive.gz" \
  || { echo "  WARNING: mc-service mongodump failed"; touch "$STAGE/DUMP-FAILED-mc-service-mongo"; }

BFF_URI=$(cenv mcm-bff-service MONGO_URL); BFF_URI="${BFF_URI/@mcm-bff-store-mongo:/@127.0.0.1:}"
docker exec -e U="$BFF_URI" mcm-bff-store-mongo sh -c 'mongodump --uri="$U" --archive --gzip' \
  > "$STAGE/bff-mongo.archive.gz" \
  || { echo "  WARNING: bff mongodump failed"; touch "$STAGE/DUMP-FAILED-bff-mongo"; }

echo "[6/6] restic backup (dumps + all compose/.env config)..."
restic backup --tag homelab \
  "$STAGE" \
  "$HOME/forgejo" "$HOME/komodo" "$HOME/rustfs" "$HOME/nx-cache" \
  --exclude "**/.cache" --exclude "**/node_modules"

echo "retention prune (7 daily / 4 weekly / 6 monthly)..."
restic forget --prune --tag homelab --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6   # group by tag: the stage dir name is random, so the default host+paths grouping kept every snapshot
echo "Done."
restic snapshots --compact
