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
#
# ── 060 (T034 companion): parameterised by config, for the same reason portable-runner was ──────
#
# ⚠️ THIS SCRIPT IS DESTRUCTIVE BY DESIGN. It removes the dev container and rebuilds it. Anything
# that runs AFTER it in an aggregate harness is talking to a different container than the checks
# before it, so it must run LAST. Measured 2026-08-16: run mid-harness it tore the container down
# and then FAILED to rebuild, leaving the environment with no dev container at all — and the
# checks after it failed with "No such container", which reads as an isolation fault rather than
# as this script's side effect.
#
# The rebuild failed because this script hardcoded the repo-root config: it ran
# `devcontainer up --workspace-folder "$WS"` with no --config, so under the sandbox topology it
# rebuilt the DOCKER DESKTOP variant, whose BASE_IMAGE then defaulted to the bare local tag and
# produced `docker pull mcm-devcontainer` → "No manifest found". It now takes the config as a
# parameter, exactly as verify-portable-runner.sh does.
#
# Usage:
#   bash verify-reproducible-recreate.sh [--full] [config-path] [workspace-folder]

set -uo pipefail
export PATH="$PATH:$HOME/AppData/Roaming/npm:/usr/local/bin"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_VOLUME="mcm-source"
HIST_VOLUME="mcm-commandhistory"
FULL=0
if [ "${1:-}" = "--full" ]; then FULL=1; shift; fi

CONFIG="${1:-$REPO_ROOT/.devcontainer/devcontainer.json}"
case "$CONFIG" in /*) ;; *) CONFIG="$REPO_ROOT/$CONFIG" ;; esac
WS="${2:-$REPO_ROOT}"

# The engine proof must match the config, because the two configs' premises are INVERTED (D-06):
# verify-engine-isolation.sh asserts NO socket is mounted; the sandbox variant mounts one on
# purpose. Running the wrong one reports a check/topology mismatch as a failure.
case "$CONFIG" in
  *"/sandbox/"*) ENGINE_CHECK="verify-engine-seam.sh" ;;
  *)             ENGINE_CHECK="verify-engine-isolation.sh" ;;
esac

command -v devcontainer >/dev/null 2>&1 || { echo "devcontainer CLI not found (npm i -g @devcontainers/cli)"; exit 1; }
command -v docker      >/dev/null 2>&1 || { echo "docker not found"; exit 1; }

echo "[verify-reproducible-recreate] SC-005 (full=$FULL)"
echo "  → config under test: ${CONFIG#$REPO_ROOT/}"
echo "  → engine proof     : $ENGINE_CHECK"
if [ ! -f "$CONFIG" ]; then
  echo "  ✗ config not found: $CONFIG"; echo "[verify-reproducible-recreate] FAIL (SC-005)"; exit 1
fi

# ── The BASE_IMAGE pin, and why this is checked BEFORE anything is destroyed ─────────────────────
#
# Taking the config as a parameter (above) fixed half of the 2026-08-16 failure. The other half bit
# again on 2026-09-19: the sandbox config's BASE_IMAGE is
# `${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}`, and that variable lives in ~/.mcm-sandbox-env,
# which is deliberately NOT auto-sourced from .bashrc (D-07). A non-login shell — which is exactly
# what run-harness.sh gives this script — therefore has it unset, the arg falls back to the bare tag,
# and `devcontainer up` turns that into `docker pull mcm-devcontainer` → not a pullable reference.
#
# The damage is not the failed rebuild, it is the ORDER: the teardown below had already removed the
# container, so the environment was left with NO dev container and every later check read as an
# isolation fault. So: source the pin, then PROVE the base image is obtainable, and only then
# destroy anything. A check that cannot rebuild must fail while the thing it would rebuild is still
# standing.
if [ -f "$HOME/.mcm-sandbox-env" ]; then
  echo "  → sourcing the VM-local pin from ~/.mcm-sandbox-env (D-07: not auto-sourced)"
  set -a; . "$HOME/.mcm-sandbox-env"; set +a
fi

BASE_IMAGE="${MCM_DEVCONTAINER_IMAGE:-mcm-devcontainer}"
echo "  → base image       : $BASE_IMAGE"
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "  → base image not present locally; pulling before teardown"
  if ! docker pull "$BASE_IMAGE" >/dev/null 2>&1; then
    echo "  ✗ base image '$BASE_IMAGE' is neither present nor pullable."
    echo "    NOTHING WAS TORN DOWN — the dev container is untouched."
    if [ "$BASE_IMAGE" = "mcm-devcontainer" ]; then
      echo "    This is the bare fallback tag, so MCM_DEVCONTAINER_IMAGE was not set. On the sandbox"
      echo "    it lives in ~/.mcm-sandbox-env; see docs/runbooks/devcontainer-sandbox.md §8b."
    fi
    echo "[verify-reproducible-recreate] FAIL (SC-005 — base image unobtainable, recreate not attempted)"
    exit 1
  fi
fi

echo "  → tearing down container + image + disposable volumes"
devcontainer down --workspace-folder "$WS" --config "$CONFIG" 2>/dev/null || true
# Remove any container/image the CLI created for this workspace + the disposable history volume.
docker ps -a --filter "label=devcontainer.local_folder=$WS" -q 2>/dev/null | xargs -r docker rm -f
docker volume rm -f "$HIST_VOLUME" 2>/dev/null || true

if [ "$FULL" -eq 1 ]; then
  echo "  !! --full: removing the SOURCE volume '$SRC_VOLUME' — uncommitted work will be LOST."
  echo "     Ensure you have pushed. Re-populate via clone-in-volume before the in-container verifies."
  docker volume rm -f "$SRC_VOLUME" 2>/dev/null || true
fi

echo "  → recreating from the committed definition (zero manual steps)"
if ! devcontainer up --workspace-folder "$WS" --config "$CONFIG"; then
  echo "[verify-reproducible-recreate] FAIL — recreate did not complete"; exit 1
fi

if [ "$FULL" -eq 1 ]; then
  echo "  → --full recreate built the environment; populate the source volume, then run the"
  echo "     in-container verifies manually. (Cannot auto-verify an empty source volume.)"
  echo "[verify-reproducible-recreate] PASS build (SC-005 --full; populate + verify next)"; exit 0
fi

echo "  → re-running isolation + engine proofs inside the recreated container"
ok=0
devcontainer exec --workspace-folder "$WS" --config "$CONFIG"   bash .devcontainer/verify/verify-host-isolation.sh || ok=1
devcontainer exec --workspace-folder "$WS" --config "$CONFIG"   bash ".devcontainer/verify/$ENGINE_CHECK" || ok=1

if [ "$ok" -eq 0 ]; then
  echo "[verify-reproducible-recreate] PASS (SC-005)"; exit 0
else
  echo "[verify-reproducible-recreate] FAIL (SC-005 — a proof failed in the recreated env)"; exit 1
fi
