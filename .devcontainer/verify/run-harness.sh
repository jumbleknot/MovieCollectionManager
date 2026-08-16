#!/usr/bin/env bash
# run-harness.sh — feature 060 (dev container on Docker Sandbox)
#
# Governing: FR-020, SC-002, and the Completion Checklist item
#            "Twelve verify scripts report a result and all are green".
# Contract:  specs/060-devcontainer-docker-sandbox/contracts/verify-harness.md § Aggregate run
#
# ── Why this file exists ─────────────────────────────────────────────────────────────────────────
#
# The harness was previously a ritual: a human ran some scripts and judged the result. That has two
# failure modes the contract names explicitly, and this script exists to make both impossible:
#
#   1. A GLOB SILENTLY SHRINKS. `for f in verify-*.sh` reports success while checking eleven, or
#      nine, because a file was renamed or lost. The expected set is therefore ENUMERATED BY NAME
#      below and the run FAILS if fewer than twelve report a result.
#   2. A SKIPPED CHECK READS AS A PASS. Anything that does not produce an explicit pass is counted
#      as a FAILURE here, never as "not applicable".
#
# ── The three vantage points, and why the host-side one cannot be faked ──────────────────────────
#
# The twelve do not all run in one place. Ten run in the dev container, three VM-side (one of which
# is engine-seam in another mode), and one on Windows. This script runs from the SANDBOX VM, which
# can reach the container via `docker exec` and run the VM-side checks directly.
#
# It CANNOT run the host-side check, because that check's entire value is that it reads the real
# Windows engine from outside the microVM — a claim asserted from inside the thing being claimed
# about is not proof. So it refuses to invent a result: run
#
#     bash .devcontainer/verify/verify-engine-seam.sh --host-check <probe>   # on Windows
#
# and pass the outcome in as MCM_HOST_CHECK=pass|fail. Without it the run reports ELEVEN and FAILS,
# which is the correct behaviour — an unproven claim is not a passing one.
#
# Usage (from the sandbox VM):
#   MCM_HOST_CHECK=pass bash .devcontainer/verify/run-harness.sh
# Env:
#   MCM_DEVCONTAINER_NAME  dev container to exec into (default: discovered by devcontainer label)
#   MCM_HOST_CHECK         pass|fail — the result of the Windows-side engine-seam run
#   MCM_CONFIG             devcontainer config for the portable-runner check
#                          (default: .devcontainer/sandbox/devcontainer.json)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY_DIR="$REPO_ROOT/.devcontainer/verify"
CONFIG="${MCM_CONFIG:-$REPO_ROOT/.devcontainer/sandbox/devcontainer.json}"

DC="${MCM_DEVCONTAINER_NAME:-$(docker ps --filter 'label=devcontainer.local_folder' --format '{{.Names}}' 2>/dev/null | head -1)}"

# ── THE EXPECTED SET — enumerated by name. Changing this count is a deliberate act. ──────────────
EXPECTED_COUNT=12

reported=0
passed=0
failed=0
declare -a RESULTS=()

record() {  # $1=name  $2=pass|fail  $3=detail
  reported=$(( reported + 1 ))
  if [ "$2" = "pass" ]; then
    passed=$(( passed + 1 )); RESULTS+=("  PASS  $1")
  else
    failed=$(( failed + 1 )); RESULTS+=("  FAIL  $1${3:+  — $3}")
  fi
}

# in_container <display-name> <script> [args…]
in_container() {
  local name="$1"; shift
  if [ -z "$DC" ]; then record "$name" fail "no dev container found"; return; fi
  if docker exec -u coder -w /workspaces/mcm "$DC" bash ".devcontainer/verify/$1" "${@:2}" >/dev/null 2>&1; then
    record "$name" pass
  else
    record "$name" fail "non-zero exit in-container"
  fi
}

# vm_side <display-name> <script> [args…]
vm_side() {
  local name="$1"; shift
  if MCM_DEVCONTAINER_NAME="$DC" bash "$VERIFY_DIR/$1" "${@:2}" >/dev/null 2>&1; then
    record "$name" pass
  else
    record "$name" fail "non-zero exit VM-side"
  fi
}

echo "═══ MCM verify harness — expecting exactly $EXPECTED_COUNT results ═══"
echo "    dev container : ${DC:-<none found>}"
echo "    config        : ${CONFIG#$REPO_ROOT/}"
echo

# ── in-container (10) ────────────────────────────────────────────────────────────────────────────
in_container "engine-seam (in-container)"      verify-engine-seam.sh
in_container "workspace-path"                  verify-workspace-path.sh
in_container "host-isolation"                  verify-host-isolation.sh
in_container "firewall-allowlist"              verify-firewall-allowlist.sh
in_container "personal-layer"                  verify-personal-layer.sh
in_container "toolchain-present"               verify-toolchain-present.sh
in_container "caches-persist"                  verify-caches-persist.sh
in_container "committed-clean"                 verify-committed-clean.sh
in_container "egress-allowlist-contract"       verify-egress-allowlist-contract.sh

# portable-runner drives the CLI, so it runs where the CLI and its engine are: the VM.
vm_side      "portable-runner"                 verify-portable-runner.sh "$CONFIG" /workspaces/mcm

# ── VM-side (2 more) ─────────────────────────────────────────────────────────────────────────────
vm_side      "engine-seam --vm-check"          verify-engine-seam.sh --vm-check
vm_side      "sandbox-egress"                  verify-sandbox-egress.sh
vm_side      "reproducible-recreate"           verify-reproducible-recreate.sh

# ── host-side (1) — cannot be run from here; must be supplied ────────────────────────────────────
case "${MCM_HOST_CHECK:-}" in
  pass) record "engine-seam --host-check (Windows)" pass ;;
  fail) record "engine-seam --host-check (Windows)" fail "reported failing by the Windows-side run" ;;
  *)    echo "  !! MCM_HOST_CHECK not supplied — the Windows-side engine-seam proof was NOT run."
        echo "     Run it on Windows and re-invoke with MCM_HOST_CHECK=pass|fail."
        echo "     It is NOT counted, so this run will report fewer than $EXPECTED_COUNT and fail." ;;
esac

echo
printf '%s\n' "${RESULTS[@]}"
echo
echo "─────────────────────────────────────────────────────────────"
echo "  reported: $reported / $EXPECTED_COUNT     passed: $passed     failed: $failed"
echo "─────────────────────────────────────────────────────────────"

rc=0
if [ "$reported" -ne "$EXPECTED_COUNT" ]; then
  echo "✗ HARNESS INCOMPLETE — $reported of $EXPECTED_COUNT scripts reported a result."
  echo "  A check that did not report is a check that did not run. It counts as a FAILURE,"
  echo "  never as 'not applicable'."
  rc=1
fi
if [ "$failed" -ne 0 ]; then
  echo "✗ $failed check(s) FAILED."
  rc=1
fi
[ "$rc" -eq 0 ] && echo "✓ all $EXPECTED_COUNT checks reported and passed."
exit "$rc"
