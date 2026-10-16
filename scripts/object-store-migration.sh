#!/usr/bin/env bash
# Feature 080 — run scripts/object-store-migration.mjs ON THE PRODUCTION HOST, inside a pinned
# container, against the host's own Docker daemon. TEMPORARY: deleted with the tool (tasks.md T048).
#
# WHY A WRAPPER (decided 2026-10-11, tasks.md T003): the prod host has no `node`, and the tool must
# not be driven from the dev container over `DOCKER_HOST=ssh://` — that would put standing control
# of the prod daemon (root-equivalent) into the assistant's sandbox, which this repository keeps
# free of prod credentials. So the operator runs this script on the host. Nothing is installed:
#
#   1. the Docker CLI binary is copied out of a digest-pinned `docker:<v>-cli` image;
#   2. a digest-pinned `node:<v>-alpine` container is CREATED (not started) with the host's Docker
#      socket mounted, and the CLI binary, the tool, its one library and the compose file it reads
#      the RustFS pin from are copied INTO it with `docker cp` — no bind mount of a checkout path,
#      so it works from any directory the daemon can or cannot see;
#   3. the working directory ($MIGRATION_DIR) is copied in, the tool runs, and the directory is
#      copied back out, so relative `--out manifest.json` / `--manifest manifest.json` paths land on
#      the host.
#
# CREDENTIALS are passed by NAME (`-e S3_ACCESS_KEY -e S3_SECRET_KEY`) from this shell's
# environment, never as values: set them with `read -rs` and `export`, not on the command line.
#
# REFUSALS happen here BEFORE any container exists, consistent with the tool: `copy` without
# `--apply` and `rehearse` (a dev-container activity — it pulls the old MinIO image and creates
# scratch volumes) are refused, and the tool refuses anything it does not recognise.
#
# Usage (from a checkout of this repository on the host):
#   export MIGRATION_DIR=$HOME/080-cutover        # evidence lands here (default: ./object-store-migration)
#   scripts/object-store-migration.sh inventory --volume observability-langfuse-minio-data --out inventory.json
#
# Docker socket: $MIGRATION_DOCKER_SOCK, else the unix path in $DOCKER_HOST, else
# $XDG_RUNTIME_DIR/docker.sock (the rootless daemon), else /var/run/docker.sock. It is the path the
# DAEMON sees, because the daemon performs the mount.
set -euo pipefail

NODE_IMAGE='node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2'
DOCKER_CLI_IMAGE='docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

sub="${1:-}"
case "$sub" in
  -h | --help | '') usage; exit 0 ;;
  rehearse)
    echo "refused: rehearse runs in the dev container (node scripts/object-store-migration.mjs rehearse), not on the production host" >&2
    exit 2 ;;
  copy)
    apply=0
    for a in "$@"; do [ "$a" = --apply ] && apply=1; done
    if [ "$apply" -ne 1 ]; then
      echo "refused: copy writes a new volume and needs --apply (there is no dry-run spelling; use inventory to look)" >&2
      exit 2
    fi ;;
esac

if [ -n "${MIGRATION_DOCKER_SOCK:-}" ]; then
  sock="$MIGRATION_DOCKER_SOCK"
elif [[ "${DOCKER_HOST:-}" == unix://* ]]; then
  sock="${DOCKER_HOST#unix://}"
elif [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/docker.sock" ]; then
  sock="$XDG_RUNTIME_DIR/docker.sock"
else
  sock=/var/run/docker.sock
fi

work="${MIGRATION_DIR:-$PWD/object-store-migration}"
mkdir -p "$work"

tmp="$(mktemp -d)"
cid=''
cleanup() {
  [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# 1. The Docker CLI, out of its pinned image.
cli="$(docker create "$DOCKER_CLI_IMAGE")"
docker cp "$cli:/usr/local/bin/docker" "$tmp/docker" >/dev/null
docker rm "$cli" >/dev/null

# 2. The runner, created with the socket and the caller's credentials BY NAME.
env_args=()
for v in S3_ACCESS_KEY S3_SECRET_KEY; do
  [ -n "${!v:-}" ] && env_args+=(-e "$v")
done
cid="$(docker create -w /work -v "$sock:/var/run/docker.sock" -e DOCKER_HOST=unix:///var/run/docker.sock \
  ${env_args[@]+"${env_args[@]}"} "$NODE_IMAGE" node /tool/scripts/object-store-migration.mjs "$@")"

mkdir -p "$tmp/tool/scripts/lib" "$tmp/tool/infrastructure-as-code/docker/observability"
cp "$REPO_ROOT/scripts/object-store-migration.mjs" "$tmp/tool/scripts/"
cp "$REPO_ROOT/scripts/lib/argv-contract.mjs" "$tmp/tool/scripts/lib/"
cp "$REPO_ROOT/infrastructure-as-code/docker/observability/compose.prod.yaml" "$tmp/tool/infrastructure-as-code/docker/observability/"
docker cp "$tmp/docker" "$cid:/usr/local/bin/docker" >/dev/null
docker cp "$tmp/tool" "$cid:/tool" >/dev/null
docker cp "$work/." "$cid:/work" >/dev/null

# 3. Run, then bring the evidence back whatever the verdict.
set +e
docker start -a "$cid"
rc=$?
set -e
docker cp "$cid:/work/." "$work" >/dev/null
echo "evidence: $work" >&2
exit "$rc"
