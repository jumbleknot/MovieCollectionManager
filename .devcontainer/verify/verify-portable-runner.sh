#!/usr/bin/env bash
# verify-portable-runner.sh — feature 037 (containerized dev-env)
#
# Governing success criterion: SC-006 (the SAME committed devcontainer.json runs unmodified
#                              under a SECOND conformant runner).
# Governing requirement:       FR-008.
#
# The daily driver is the VS Code Dev Containers extension; the independent second runner is the
# reference @devcontainers/cli. This script proves the committed definition builds and runs
# under the CLI with ZERO edits, and that the isolation + engine proofs hold there too — so the
# setup is not hostage to any single tool.
#
# Runs on the HOST. RED-first: before .devcontainer/ existed there was nothing to bring up.

set -uo pipefail
export PATH="$PATH:$HOME/AppData/Roaming/npm:/usr/local/bin"

WS="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root

command -v devcontainer >/dev/null 2>&1 || { echo "devcontainer CLI not found (npm i -g @devcontainers/cli)"; exit 1; }
command -v docker      >/dev/null 2>&1 || { echo "docker not found"; exit 1; }

echo "[verify-portable-runner] SC-006 — @devcontainers/cli runner"

# Confirm the committed config parses under the CLI with no edits (portability precondition).
if ! devcontainer read-configuration --workspace-folder "$WS" >/dev/null 2>&1; then
  echo "  ✗ committed devcontainer.json does not resolve under @devcontainers/cli"
  echo "[verify-portable-runner] FAIL (SC-006)"; exit 1
fi
echo "  ✓ committed devcontainer.json resolves under the CLI runner unmodified"

echo "  → bringing the environment up under the CLI runner"
if ! devcontainer up --workspace-folder "$WS"; then
  echo "[verify-portable-runner] FAIL — CLI runner could not bring the environment up"; exit 1
fi

echo "  → running isolation + engine proofs under the CLI runner"
ok=0
devcontainer exec --workspace-folder "$WS" bash .devcontainer/verify/verify-host-isolation.sh   || ok=1
devcontainer exec --workspace-folder "$WS" bash .devcontainer/verify/verify-engine-isolation.sh || ok=1

if [ "$ok" -eq 0 ]; then
  echo "[verify-portable-runner] PASS (SC-006 — builds + runs + proofs hold under @devcontainers/cli)"; exit 0
else
  echo "[verify-portable-runner] FAIL (SC-006 — a proof failed under the CLI runner)"; exit 1
fi
