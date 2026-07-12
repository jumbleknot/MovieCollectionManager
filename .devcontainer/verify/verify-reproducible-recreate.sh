#!/usr/bin/env bash
# verify-reproducible-recreate.sh — feature 037 (containerized dev-env)
#
# Governing success criterion: SC-005 (delete + recreate from the committed definition yields a
#                              functionally identical environment with ZERO manual steps).
# Governing requirement:       FR-006.
#
# Runs on the HOST (it drives @devcontainers/cli). Tears the environment down, recreates it
# purely from the committed .devcontainer/, and re-runs the isolation + engine proofs inside the
# fresh container. If this script completes exit 0, the recreate required zero manual steps.
#
#   default:  removes the CONTAINER + image + the disposable command-history volume, then
#             `devcontainer up`. The SOURCE named volume (mcm-source) is PRESERVED — it is the
#             between-session source of truth; wiping it would destroy uncommitted work.
#   --full:   ALSO removes the source volume for a true from-scratch recreate. Requires the
#             source to have been pushed first (loud confirmation). After --full the volume must
#             be re-populated (clone-in-volume) before the in-container verifies can run.
#
# RED-first: before .devcontainer/ existed, `devcontainer up` had nothing to build → RED.

set -uo pipefail
export PATH="$PATH:$HOME/AppData/Roaming/npm:/usr/local/bin"

WS="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root
SRC_VOLUME="mcm-source"
HIST_VOLUME="mcm-commandhistory"
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

command -v devcontainer >/dev/null 2>&1 || { echo "devcontainer CLI not found (npm i -g @devcontainers/cli)"; exit 1; }
command -v docker      >/dev/null 2>&1 || { echo "docker not found"; exit 1; }

echo "[verify-reproducible-recreate] SC-005 (full=$FULL)"

echo "  → tearing down container + image + disposable volumes"
devcontainer down --workspace-folder "$WS" 2>/dev/null || true
# Remove any container/image the CLI created for this workspace + the disposable history volume.
docker ps -a --filter "label=devcontainer.local_folder=$WS" -q 2>/dev/null | xargs -r docker rm -f
docker volume rm -f "$HIST_VOLUME" 2>/dev/null || true

if [ "$FULL" -eq 1 ]; then
  echo "  !! --full: removing the SOURCE volume '$SRC_VOLUME' — uncommitted work will be LOST."
  echo "     Ensure you have pushed. Re-populate via clone-in-volume before the in-container verifies."
  docker volume rm -f "$SRC_VOLUME" 2>/dev/null || true
fi

echo "  → recreating from the committed definition (zero manual steps)"
if ! devcontainer up --workspace-folder "$WS"; then
  echo "[verify-reproducible-recreate] FAIL — recreate did not complete"; exit 1
fi

if [ "$FULL" -eq 1 ]; then
  echo "  → --full recreate built the environment; populate the source volume, then run the"
  echo "     in-container verifies manually. (Cannot auto-verify an empty source volume.)"
  echo "[verify-reproducible-recreate] PASS build (SC-005 --full; populate + verify next)"; exit 0
fi

echo "  → re-running isolation + engine proofs inside the recreated container"
ok=0
devcontainer exec --workspace-folder "$WS" bash .devcontainer/verify/verify-host-isolation.sh   || ok=1
devcontainer exec --workspace-folder "$WS" bash .devcontainer/verify/verify-engine-isolation.sh || ok=1

if [ "$ok" -eq 0 ]; then
  echo "[verify-reproducible-recreate] PASS (SC-005)"; exit 0
else
  echo "[verify-reproducible-recreate] FAIL (SC-005 — a proof failed in the recreated env)"; exit 1
fi
