#!/usr/bin/env bash
# verify-portable-runner.sh — feature 037 (containerized dev-env); parameterised in 060 (T034)
#
# Governing success criterion: SC-006 (the SAME committed devcontainer.json runs unmodified
#                              under a SECOND conformant runner).
# Governing requirement:       FR-008.
#
# ── What this script actually asserts, stated plainly ────────────────────────────────────────────
#
# Despite FR-008 being a DUAL-runner requirement, every assertion here is CLI-side:
# `devcontainer read-configuration`, `devcontainer up`, then the proofs via `devcontainer exec`.
# **IT NEVER DRIVES THE VS CODE EXTENSION.** The extension half of the property is verified by being
# used every day, not by this script. Saying so explicitly matters, because the script's name
# invites the assumption that it covers both.
#
# ── What feature 060 changes about that ──────────────────────────────────────────────────────────
#
# The two runners SWAP ROLES. On Docker Desktop the extension was the daily driver and the CLI was
# the independent second runner this script exercises. In the sandbox the CLI is the runner that
# BUILDS DAILY (headless, inside the microVM) and the extension becomes the unasserted alternate.
# The property does not shrink — it points the other way — and this script becomes MORE load-bearing,
# because it now covers the primary build path rather than the alternate one.
#
# ── What is deliberately NOT decided here ────────────────────────────────────────────────────────
#
# Whether the sandbox variant retains a second runner AT ALL depends on a G4 measurement: does
# *Reopen in Container* work over the sandbox Remote-SSH session (the extension builds), or only
# *Attach to Running Container* (the CLI must have built it first)? See research.md D-15. Until G4
# answers that, this script:
#   • does NOT assert extension-buildability of either config — it never did;
#   • does NOT declare the sandbox variant CLI-only — that would pre-decide G4 and quietly give up
#     an anti-lock-in property this repository deliberately paid for.
# If G4 lands attach-only, the constraint is recorded in the runbook TOGETHER WITH a CLI-recovery
# path, because a single-runner environment on a hand-provisioned Node has no fallback when that
# runner breaks.
#
# Usage:
#   bash verify-portable-runner.sh [config-path] [workspace-folder]
#     config-path       default: the repo-root .devcontainer/devcontainer.json (previous behaviour)
#     workspace-folder  default: the repo root
#
# Runs HOST-side (or VM-side for the sandbox variant — wherever the CLI and its engine live).

set -uo pipefail
export PATH="$PATH:$HOME/AppData/Roaming/npm:/usr/local/bin"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-$REPO_ROOT/.devcontainer/devcontainer.json}"
WS="${2:-$REPO_ROOT}"

# Accept a repo-relative path for convenience.
case "$CONFIG" in
  /*) ;;
  *) CONFIG="$REPO_ROOT/$CONFIG" ;;
esac

command -v devcontainer >/dev/null 2>&1 || { echo "devcontainer CLI not found (npm i -g @devcontainers/cli)"; exit 1; }
command -v docker      >/dev/null 2>&1 || { echo "docker not found"; exit 1; }

echo "[verify-portable-runner] SC-006 — @devcontainers/cli runner"
echo "  → config under test: ${CONFIG#$REPO_ROOT/}"
echo "  → workspace folder : $WS"

if [ ! -f "$CONFIG" ]; then
  echo "  ✗ config not found: $CONFIG"
  echo "[verify-portable-runner] FAIL (SC-006)"; exit 1
fi

# Confirm THIS config parses under the CLI with no edits (the portability precondition).
if ! devcontainer read-configuration --workspace-folder "$WS" --config "$CONFIG" >/dev/null 2>&1; then
  echo "  ✗ ${CONFIG#$REPO_ROOT/} does not resolve under @devcontainers/cli"
  echo "[verify-portable-runner] FAIL (SC-006)"; exit 1
fi
echo "  ✓ ${CONFIG#$REPO_ROOT/} resolves under the CLI runner unmodified"

echo "  → bringing the environment up under the CLI runner"
if ! devcontainer up --workspace-folder "$WS" --config "$CONFIG"; then
  echo "[verify-portable-runner] FAIL — CLI runner could not bring up ${CONFIG#$REPO_ROOT/}"; exit 1
fi

# ── Which engine proof to run depends on the config, because their premises are INVERTED ─────────
#
# verify-engine-isolation.sh asserts that NO docker socket is mounted; the sandbox variant mounts
# one on purpose. verify-engine-seam.sh asserts the opposite. Running the wrong one reports a
# failure that is really a mismatch between the check and the topology (research D-06). Selected by
# the config under test rather than hardcoded, so this script is correct for both while the two
# configs coexist. verify-engine-isolation.sh is deleted at adoption (T060), after which the
# selection collapses to engine-seam.
case "$CONFIG" in
  *"/sandbox/"*) ENGINE_CHECK="verify-engine-seam.sh" ;;
  *)             ENGINE_CHECK="verify-engine-isolation.sh" ;;
esac
echo "  → engine proof for this config: $ENGINE_CHECK"

echo "  → running isolation + engine proofs under the CLI runner"
ok=0
devcontainer exec --workspace-folder "$WS" --config "$CONFIG" \
  bash .devcontainer/verify/verify-host-isolation.sh || ok=1
devcontainer exec --workspace-folder "$WS" --config "$CONFIG" \
  bash ".devcontainer/verify/$ENGINE_CHECK" || ok=1

if [ "$ok" -eq 0 ]; then
  echo "[verify-portable-runner] PASS (SC-006 — ${CONFIG#$REPO_ROOT/} builds + runs + proofs hold under @devcontainers/cli)"; exit 0
else
  echo "[verify-portable-runner] FAIL (SC-006 — a proof failed under the CLI runner for ${CONFIG#$REPO_ROOT/})"; exit 1
fi
