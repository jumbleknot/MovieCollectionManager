#!/usr/bin/env bash
# Secret-leak check for ZAP reports, run BEFORE they are uploaded (SC-008 / feature 031 C4).
#
# Extracted verbatim from app-ci.yml's inline "Scan reports for secret leakage" step by 048 T034.
# The logic had no local entry point, so it could not be run, tested, or deliberately broken —
# which is how it stayed fail-open for as long as it did.
#
# Usage: dast-leak-scan.sh [REPORTS_DIR]        (default: security/zap/reports)
# Exit:  0 = nothing leaked · 1 = a leak was found
#
# Secrets are read from the environment, never from arguments (argv is visible in `ps`):
#   E2E_TEST_PASSWORD, E2E_ROPC_CLIENT_SECRET, ANTHROPIC_API_KEY
set -uo pipefail

REPORTS_DIR="${1:-security/zap/reports}"

leak=0

# ── Preconditions: fail CLOSED (048 US5 / FR-018, FR-021) ───────────────────────────────────────
# Every per-secret scan below is guarded by `[ -n "$VAR" ] && grep …`, so an EMPTY variable skips
# its scan and the script still exits 0 — reporting "no leaks" having looked for nothing. Measured
# 2026-08-07 against this file as first extracted: blanking each of the three in turn gave 3 of 3
# exit 0.
#
# Today no reachable path produces an empty value: agent-stack.mjs aborts the dast job at stack
# bring-up, before this step. But that protection is INCIDENTAL — it comes from an unrelated
# script's argument validation, not from this check — and it evaporates if that validation is
# relaxed or if this step is ever reordered ahead of bring-up. A security control whose failure mode
# is "quietly scan nothing, report green" is precisely the defect class 048 exists to remove, so the
# precondition is asserted here on its own terms.
#
# These are ADDED to the guarded greps, not a replacement for them (the guards still matter: they
# keep a `grep -F ""` from matching every line once a value is legitimately absent).
require_secret() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "::error::${name} is empty, so its leak scan would silently scan nothing and this step" \
      "would exit 0 having verified nothing. Refusing to publish. Set ${name} in the job env; if" \
      "it is legitimately absent on some path, make that explicit in scripts/dast-leak-scan.sh."
    return 1
  fi
  return 0
}

require_secret E2E_TEST_PASSWORD "${E2E_TEST_PASSWORD:-}" || leak=1
require_secret E2E_ROPC_CLIENT_SECRET "${E2E_ROPC_CLIENT_SECRET:-}" || leak=1

# FR-019 / US5-AC3: the requirement is to fail on UNEXPECTED emptiness, not on emptiness.
# app-ci.yml's MODEL_PROVIDER is overridable by dispatch input or repo var, and under a
# non-Anthropic provider an empty ANTHROPIC_API_KEY is entirely legitimate — a blanket "fail if
# empty" would break that documented path. So this one requirement is conditional.
if [ "${MODEL_PROVIDER:-anthropic}" = "anthropic" ]; then
  require_secret ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}" || leak=1
else
  echo "note: MODEL_PROVIDER='${MODEL_PROVIDER:-}' is not anthropic — an empty ANTHROPIC_API_KEY" \
    "is legitimate on this path and is not required (FR-019 / US5-AC3)."
fi

# US5-AC5: with no reports present every grep below misses, so the script cannot distinguish
# "nothing leaked" from "nothing was scanned" — and by FR-018 that fails closed. If the ZAP step
# legitimately produced no reports, that is itself a DAST failure and must surface there rather than
# be absorbed by a security check reporting success.
if [ ! -d "$REPORTS_DIR" ]; then
  echo "::error::reports directory '${REPORTS_DIR}' does not exist — nothing was scanned, so this" \
    "check cannot tell 'no leak' from 'no input'. Refusing to publish."
  leak=1
elif [ -z "$(find "$REPORTS_DIR" -type f -print -quit 2>/dev/null)" ]; then
  echo "::error::reports directory '${REPORTS_DIR}' contains no files — nothing was scanned. The" \
    "ZAP scan step should have failed first. Refusing to publish."
  leak=1
fi

# A failed precondition makes the scans below untrustworthy, so stop here rather than run them and
# emit a reassuring silence next to the error.
if [ "$leak" -ne 0 ]; then
  exit "$leak"
fi

# ── The scans themselves — unchanged from the inline step (T034 was extraction only) ─────────────
if [ -n "${E2E_TEST_PASSWORD:-}" ] && grep -rqF "$E2E_TEST_PASSWORD" "$REPORTS_DIR" 2>/dev/null; then
  echo "::error::DAST report contains the test password — refusing to publish"; leak=1
fi
if [ -n "${E2E_ROPC_CLIENT_SECRET:-}" ] && grep -rqF "$E2E_ROPC_CLIENT_SECRET" "$REPORTS_DIR" 2>/dev/null; then
  echo "::error::DAST report contains the ROPC client secret — refusing to publish"; leak=1
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ] && grep -rqF "$ANTHROPIC_API_KEY" "$REPORTS_DIR" 2>/dev/null; then
  echo "::error::DAST report contains the Anthropic API key — refusing to publish"; leak=1
fi
# Bearer tokens are long JWTs (eyJ… .… .…). Any occurrence in a report is a leak.
if grep -rqE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' "$REPORTS_DIR" 2>/dev/null; then
  echo "::error::DAST report contains a JWT — refusing to publish"; leak=1
fi
exit "$leak"
