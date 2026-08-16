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

# ── THE EXPECTED SET — twelve SCRIPTS, enumerated by name ────────────────────────────────────────
#
# TWELVE SCRIPTS, NOT TWELVE INVOCATIONS. `verify-engine-seam.sh` is ONE script run in THREE modes
# (in-container, --vm-check, --host-check), so the contract's aggregate list has fourteen rows but
# names twelve distinct scripts. Counting invocations gives fourteen and makes the run fail forever;
# counting scripts is what the contract and the Completion Checklist actually require.
#
# engine-seam's slot is green only if ALL THREE of its modes pass — a two-of-three engine seam is
# not a seam.
EXPECTED_SCRIPTS=(
  verify-engine-seam.sh
  verify-workspace-path.sh
  verify-host-isolation.sh
  verify-firewall-allowlist.sh
  verify-personal-layer.sh
  verify-portable-runner.sh
  verify-toolchain-present.sh
  verify-caches-persist.sh
  verify-committed-clean.sh
  verify-egress-allowlist-contract.sh
  verify-sandbox-egress.sh
  verify-reproducible-recreate.sh
)
EXPECTED_COUNT=${#EXPECTED_SCRIPTS[@]}

declare -A SCRIPT_STATE=()   # script -> pass|fail
declare -a RESULTS=()

# record <script-file> <display-name> <pass|fail> [detail]
# A script already marked failing STAYS failing: engine-seam must pass in every mode.
record() {
  local script="$1" name="$2" state="$3" detail="${4:-}"
  if [ "$state" = "pass" ]; then
    RESULTS+=("  PASS  $name")
    [ "${SCRIPT_STATE[$script]:-}" = "fail" ] || SCRIPT_STATE["$script"]="pass"
  else
    RESULTS+=("  FAIL  $name${detail:+  — $detail}")
    SCRIPT_STATE["$script"]="fail"
  fi
}

# in_container <display-name> <script> [args…]
in_container() {
  local script="$1" name="$2"; shift 2
  if [ -z "$DC" ]; then record "$script" "$name" fail "no dev container found"; return; fi
  if docker exec -u coder -w /workspaces/mcm "$DC" bash ".devcontainer/verify/$script" "$@" >/dev/null 2>&1; then
    record "$script" "$name" pass
  else
    record "$script" "$name" fail "non-zero exit in-container"
  fi
}

# vm_side <display-name> <script> [args…]
vm_side() {
  local script="$1" name="$2"; shift 2
  if MCM_DEVCONTAINER_NAME="$DC" bash "$VERIFY_DIR/$script" "$@" >/dev/null 2>&1; then
    record "$script" "$name" pass
  else
    record "$script" "$name" fail "non-zero exit VM-side"
  fi
}

echo "═══ MCM verify harness — expecting exactly $EXPECTED_COUNT results ═══"
echo "    dev container : ${DC:-<none found>}"
echo "    config        : ${CONFIG#$REPO_ROOT/}"
echo

# ── in-container (10) ────────────────────────────────────────────────────────────────────────────
in_container verify-engine-seam.sh            "engine-seam (in-container)"
in_container verify-workspace-path.sh         "workspace-path"
in_container verify-host-isolation.sh         "host-isolation"
in_container verify-firewall-allowlist.sh     "firewall-allowlist"
in_container verify-personal-layer.sh         "personal-layer"
in_container verify-toolchain-present.sh      "toolchain-present"
in_container verify-caches-persist.sh         "caches-persist"
in_container verify-committed-clean.sh        "committed-clean"
in_container verify-egress-allowlist-contract.sh "egress-allowlist-contract"

# portable-runner drives the CLI, so it runs where the CLI and its engine are: the VM.
vm_side      verify-portable-runner.sh        "portable-runner" "$CONFIG" /workspaces/mcm

# ── VM-side (2 more) ─────────────────────────────────────────────────────────────────────────────
vm_side      verify-engine-seam.sh            "engine-seam --vm-check" --vm-check
vm_side      verify-sandbox-egress.sh         "sandbox-egress"
vm_side      verify-reproducible-recreate.sh  "reproducible-recreate"

# ── host-side (1) — cannot be run from here; must be supplied ────────────────────────────────────
case "${MCM_HOST_CHECK:-}" in
  pass) record verify-engine-seam.sh "engine-seam --host-check (Windows)" pass ;;
  fail) record verify-engine-seam.sh "engine-seam --host-check (Windows)" fail "reported failing by the Windows-side run" ;;
  *)    echo "  !! MCM_HOST_CHECK not supplied — the Windows-side engine-seam proof was NOT run."
        echo "     Run it on Windows and re-invoke with MCM_HOST_CHECK=pass|fail."
        echo "     It is NOT counted, so this run will report fewer than $EXPECTED_COUNT and fail." ;;
esac

echo
printf '%s\n' "${RESULTS[@]}"
echo

# Tally by SCRIPT against the enumerated set, never by counting invocations. A file that was
# renamed, lost, or never reached leaves its slot empty and is named explicitly below — which is
# the whole point: a check that did not report is indistinguishable from a passing one unless
# something forces it to be visible.
reported=0; passed=0; failed=0; missing=""
for s_name in "${EXPECTED_SCRIPTS[@]}"; do
  case "${SCRIPT_STATE[$s_name]:-}" in
    pass) reported=$(( reported + 1 )); passed=$(( passed + 1 )) ;;
    fail) reported=$(( reported + 1 )); failed=$(( failed + 1 )) ;;
    *)    missing="$missing $s_name" ;;
  esac
done

echo "─────────────────────────────────────────────────────────────"
echo "  scripts reported: $reported / $EXPECTED_COUNT     passed: $passed     failed: $failed"
[ -n "$missing" ] && echo "  NO RESULT from:$missing"
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
