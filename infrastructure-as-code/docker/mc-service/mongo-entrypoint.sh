#!/bin/sh
# feature 026 (Workstream A) — materialize the MongoDB replica-set keyfile from an env var at start-up.
#
# Why this exists: feature 022 removed host file-secrets — every production secret arrives via env
# (Komodo Variable -> .env.prod), never as a committed or bind-mounted file. But `mongod --keyFile`
# requires an actual FILE, owned by the mongod runtime user, mode 0400 (mongod refuses a group/world-
# readable keyfile, or one it does not own). This wrapper writes $MONGO_MC_KEYFILE to an in-container
# file, sets 0400, then `exec`s mongod. Because mongod is exec'd in the SAME user context that wrote
# the file, the keyfile owner always matches the mongod runtime user by construction — no chown, no
# uid guesswork. No host bind-mount, no data volume, nothing committed.
#
# Rehearsed on a restored prod-volume snapshot (feature 026 T020) before any production cutover.
set -eu

: "${MONGO_MC_KEYFILE:?MONGO_MC_KEYFILE must be set (base64 replica-set keyfile content)}"
KEYFILE_PATH="${MONGO_KEYFILE_PATH:-/tmp/mongo-keyfile}"

mkdir -p "$(dirname "$KEYFILE_PATH")"
# Create restrictively (umask 377 -> 0400) then set the mode explicitly for clarity/idempotency.
( umask 377; printf '%s' "$MONGO_MC_KEYFILE" > "$KEYFILE_PATH" )
chmod 0400 "$KEYFILE_PATH"

# Hand off to mongod (passed as the container `command`). exec preserves the current user, so the
# keyfile is owned by whoever runs mongod.
exec "$@"
