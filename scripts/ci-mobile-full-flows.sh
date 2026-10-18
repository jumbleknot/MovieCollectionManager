#!/usr/bin/env bash
# OPT-IN full mobile suite — the NON-agent Maestro flows on the CI emulator (item #254 follow-on).
#
# By default app-ci's app-e2e job runs only the agent flows (scripts/ci-mobile-agent-flows.sh); the
# non-agent flows (login, registration, collection/movie CRUD, browse/sort/search, settings, theme)
# were run only on a LOCAL emulator against Metro. That is the wrong place to prove a NATIVE-layer
# change — an Expo / React Native SDK bump or a native-module change alters the binary every flow
# runs on, and a local DinD emulator is the slow, flaky way to get that evidence. This script runs
# them against the same standalone (Metro-less) release APK and containerized dev BFF + Keycloak the
# agent half used, AFTER it — on a SECOND, phone-sized (pixel_6) emulator, because these flows were
# written against a Pixel 7 screen and the agent step's default 320x640 AVD fails them on geometry
# alone (see the step's comment in app-ci.yml).
#
# It runs only when app-e2e's MOBILE_SUITE is `full`: a pull request labelled `mobile-e2e-full`, or a
# workflow_dispatch with `mobile_suite=full`. Every other run is unchanged (agent flows only).
#
# WHICH flows: `node scripts/mobile-flows.mjs ci-full` — the SAME selection the local `e2e:mobile`
# suite (frontend/mcm-app/scripts/maestro-e2e.mjs) makes, minus the agent flows (owned by the agent
# half) and minus scripts/mobile-flows.mjs's CI_FULL_EXCLUDED, each entry of which states its reason.
# There is no second list here to drift.
#
# HOW each flow runs, and why it differs from the agent half:
#   * The non-agent flows `launchApp` with `clearState: false` — they rely on the harness to hand
#     them a logged-out app (locally maestro-e2e.mjs `pm clear`s before every flow). So does this:
#     force-stop + `pm clear` of the app before EVERY attempt. No Metro SharedPref is written — the
#     APK embeds its bundle.
#   * Chrome is reset (`pm clear` + First-Run-Experience skip, reset_chrome_sso) ONCE before the
#     batch: this AVD is freshly created, so Chrome's FRE would otherwise sit on top of the OAuth
#     Custom Tab, and no SSO session from another user may leak in. It is reset again before a
#     retry, since a failed attempt can leave Chrome mid-login.
#   * 2 attempts per flow (one bounded retry — the local suite's MAX_RETRIES=1), not the agent
#     half's 3: these flows drive no model turn, so the CCT-crash flake is the only transient left.
#   * scripts/mobile-flows.mjs CI_FULL_NON_BLOCKING flows still RUN (one attempt) and are reported as
#     FAIL-NONBLOCKING, but cannot fail the step; each entry states whether it is ENVIRONMENTAL or a
#     KNOWN DEFECT, with the run that measured it. One that passes is reported PASS-REMOVE-NONBLOCKING.
#   * The batch does NOT stop at the first failure. Every flow runs, a per-flow result table is
#     printed at the end (and written to mobile-diagnostics/full-suite-results.log, which the failure
#     path folds into the evidence bundle), and the step fails if ANY flow failed. One ~30-min run
#     must answer for all of them — a fail-fast batch would hide every flow after the first red.
#
# Env (from the job): E2E_TEST_USER, E2E_TEST_PASSWORD (secrets — handed to Maestro by
# scripts/maestro-run.sh via the MAESTRO_-prefixed process env, never on argv). The two fixture keys
# the local `.env.e2e.local` supplies are NON-secret and fixed here, from the seeded fixture dataset
# (frontend/mcm-app/tests/e2e/fixtures/base-dataset.ts, seeded by the web E2E's global setup that ran
# earlier in this job): E2E_COLLECTION_NAME = the read-only BROWSE collection, E2E_MOVIE_TITLE = one
# of its titles. cwd is the repo root.
set -euo pipefail

# shellcheck source=scripts/ci-mobile-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/ci-mobile-lib.sh"

APP_ID=com.grumpyrobot.mcmapp
FIXTURE_ENV=(--env "E2E_COLLECTION_NAME=E2E Browse" --env "E2E_MOVIE_TITLE=Alpha")
RESULTS=mobile-diagnostics/full-suite-results.log

mapfile -t flows < <(node scripts/mobile-flows.mjs ci-full)
# Run, reported, but never fail the step — each entry's category + evidence is in CI_FULL_NON_BLOCKING.
mapfile -t non_blocking < <(node scripts/mobile-flows.mjs ci-non-blocking)
is_non_blocking() { local f; for f in "${non_blocking[@]}"; do [ "$f" = "$1" ] && return 0; done; return 1; }
if [ "${#flows[@]}" -eq 0 ]; then
  # A selection that came back empty is a broken selector, not a passing suite.
  echo "::error::scripts/mobile-flows.mjs ci-full selected NO flows — refusing to report a vacuous pass"
  exit 1
fi
echo "=== full mobile suite: ${#flows[@]} non-agent flow(s) ==="
printf '  %s\n' "${flows[@]}"

mkdir -p mobile-diagnostics
printf 'flow\tresult\tattempts\tseconds\n' > "$RESULTS"

fresh_app() {
  adb shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  adb shell pm clear "$APP_ID" >/dev/null 2>&1 || true
}

reset_chrome_sso

failed=()
for flow in "${flows[@]}"; do
  echo "=== flow: $flow (full suite) ==="
  started=$SECONDS
  attempt=1; max=2; result=PASS
  # A non-blocking flow gets ONE attempt: its failure is already explained, so a retry buys nothing.
  is_non_blocking "$flow" && max=1
  while :; do
    fresh_app
    if bash scripts/maestro-run.sh "frontend/mcm-app/tests/e2e/mobile/$flow.yaml" "${FIXTURE_ENV[@]}"; then
      break
    fi
    capture_mobile_diagnostics "$flow" "$attempt"
    if [ "$attempt" -ge "$max" ]; then
      if is_non_blocking "$flow"; then
        result=FAIL-NONBLOCKING
        echo "::warning::flow $flow failed — listed non-blocking in scripts/mobile-flows.mjs (see its reason)"
      else
        result=FAIL
        echo "::error::flow $flow failed after $max attempts"
        failed+=("$flow")
      fi
      break
    fi
    echo "flow $flow failed (attempt $attempt/$max) — retrying"
    attempt=$((attempt + 1))
    reset_chrome_sso
  done
  if [ "$result" = PASS ] && is_non_blocking "$flow"; then
    # It passes now: the entry is stale, and a stale non-blocking entry hides the NEXT regression.
    result=PASS-REMOVE-NONBLOCKING
    echo "::warning::flow $flow PASSED but is listed non-blocking — remove it from CI_FULL_NON_BLOCKING"
  fi
  printf '%s\t%s\t%s\t%s\n' "$flow" "$result" "$attempt" "$((SECONDS - started))" >> "$RESULTS"
done

echo "=== full mobile suite results ==="
column -t -s $'\t' "$RESULTS" 2>/dev/null || cat "$RESULTS"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::full mobile suite: ${#failed[@]}/${#flows[@]} flow(s) failed: ${failed[*]}"
  exit 1
fi
nb_failed="$(grep -c $'\tFAIL-NONBLOCKING\t' "$RESULTS" || true)"
echo "full mobile suite: no blocking failure across ${#flows[@]} flow(s) (${nb_failed} non-blocking failure(s) — see the table)"
