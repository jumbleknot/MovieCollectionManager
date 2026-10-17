#!/usr/bin/env bash
# Shared helpers for the CI mobile runners — sourced (never executed) by
#   scripts/ci-mobile-agent-flows.sh  (the default agent half: always runs when the mobile half does)
#   scripts/ci-mobile-full-flows.sh   (the OPT-IN full mobile suite: label `mobile-e2e-full` or a
#                                      dispatch with `mobile_suite=full`)
# so both capture device evidence and reset Chrome's SSO session the SAME way. cwd is the repo root.

# ── Device-side diagnostics on a failed attempt (feature 062) ─────────────────────────────────────
#
# WHY THIS EXISTS. A mobile flow that fails on `Assert that id: X is visible` says only that X was
# not found. It cannot say whether the screen crashed, rendered empty, or was never navigated to —
# and the two channels that CAN say are both unreachable from a session:
#
#   * the Maestro debug directory (view hierarchy + screenshots) is uploaded as a Forgejo Actions
#     artifact, and this Forgejo build exposes NO artifacts API — `/api/v1/repos/…/actions/runs/
#     {n}/artifacts` 404s, and the web download needs a browser session cookie. (The failure digest
#     used to report it as "not present" as well, for a second reason — it packed container-logs/
#     from a FLAT listing, so this directory was dropped; fixed under item #241, which also made
#     "captured but not carried" render differently from "not present".)
#   * `adb logcat` holds the ReactNativeJS exception for a JS render error, and the emulator is
#     TERMINATED by the android-emulator-runner action before the workflow's collect-logs step
#     runs — so logcat must be captured HERE, inside the emulator script, or not at all.
#
# Both are copied into `mobile-diagnostics/`, which the collect step folds into `container-logs/`
# — the bundle `node scripts/ci-status.mjs failure --run <id> --full` can actually retrieve.
#
# Measured on run 2043: the settings destination failed 3/3 on native while the whole 165-test web
# tier passed on the same commit, and no channel existed to see what the device was showing.
capture_mobile_diagnostics() {
  # SEPARATE `local` statements, deliberately. Bash expands every assignment word in a single
  # `local` builtin call BEFORE any of the locals exist, so `local a="$1" b="${a}"` interpolates the
  # OUTER `a`, not the one being assigned. Measured on run 2049: the admin flow's capture landed in
  # `mobile-diagnostics/assistant-config-disable-attempt1` — the previous flow's name (the global
  # left behind by the `for flow in …` loop) and the global `attempt`. The evidence was filed under
  # the wrong flow, which is the one thing a diagnostic must never do.
  local flow="$1"
  local attempt="$2"
  local dest="mobile-diagnostics/${flow}-attempt${attempt}"
  mkdir -p "$dest" || return 0
  # ReactNativeJS carries a JS exception; AndroidRuntime carries a native crash. `-d` dumps and
  # exits rather than streaming. Never fail the run on a diagnostic.
  adb logcat -d -v time ReactNativeJS:V ReactNative:V AndroidRuntime:E '*:S'     > "$dest/logcat-react.log" 2>&1 || true
  adb logcat -d -v time > "$dest/logcat-full.log" 2>&1 || true
  # Maestro writes a timestamped directory per flow run; take the newest.
  local latest
  latest="$(ls -1dt "$HOME"/.maestro/tests/*/ 2>/dev/null | head -1)"
  [ -n "$latest" ] && cp -r "$latest" "$dest/maestro/" 2>/dev/null || true
  echo "--- captured device diagnostics -> $dest ---"
}

# Drop Chrome's persistent Keycloak SSO session (and with it the First-Run Experience, which is
# therefore re-skipped right after). Without this, a flow that must log in as a DIFFERENT user than
# the previous flow silently re-authenticates as the previous user via the SSO cookie — see the
# admin-settings-access note in ci-mobile-agent-flows.sh, and the post-admin reset in
# ci-mobile-full-flows.sh.
reset_chrome_sso() {
  echo "--- reset Chrome SSO (pm clear com.android.chrome) + re-skip FRE ---"
  adb shell pm clear com.android.chrome >/dev/null 2>&1 || true
  for _ in 1 2 3; do
    maestro test frontend/mcm-app/tests/e2e/mobile/_chrome-skip-fre.yaml && break || true
  done
}
