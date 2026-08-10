#!/usr/bin/env bash
# Feature 052 US2 — lift the BFF's contention counters into a channel a working session can read.
#
# WHY THIS EXISTS: the counts this prints answer a question that has been argued twice from
# configuration alone — does the concurrent-session cap actually evict, and does the per-session
# refresh bucket actually reject, during `app-e2e`? The BFF now logs both (feature 052 US1), but a
# count that only exists inside a container on the CI host is not a result:
#
#   * `Collect container logs on failure` is gated on `failure()`, so a PASSING run collects nothing —
#     and a passing run's counts are exactly what proves the contention is gone.
#   * `agent-e2e-container-logs` is an upload-artifact the forge API cannot read (the premise of
#     feature 042), and `~/mcm-ci-last-failure` needs host SSH.
#   * The failure digest is tail-biased and keeps at most 3 sources, so a line early in a
#     multi-thousand-line BFF log is dropped.
#
# Routed through `ci-log-step.sh`, this output becomes a `step:` source, which
# `ci-failure-digest.mjs`'s selectSources ranks 0 — above `_ps.txt`, above unhealthy-container logs,
# above everything. That is the highest-priority readable channel that exists.
#
# Contract: specs/052-e2e-worker-session-contention/contracts/contention-tally.md
# Pinned by: scripts/__tests__/e2e-contention-tally.test.mjs
#
# CRITICAL — this script ALWAYS exits 0. It is a diagnostic; it must never fail the job it is
# diagnosing. In particular `grep -c` exits 1 when it matches nothing and `ci-log-step.sh` re-raises
# the wrapped exit code by design, so naive counting would redden a job on an ALL-ZEROS measurement —
# the best possible news this can carry.
#
# Deliberately NOT `set -e`: an early exit here would drop the tally line entirely, which reads as
# "the step did not run" rather than "nothing was measured". `-u` and `pipefail` are kept.
set -uo pipefail

# `--gate` — the deliberate exception to the exit-0 rule below (feature 052, SC-007).
#
# WHY IT HAD TO EXIST: SC-007 asked for the tally to be readable on every run "including the ones
# that pass". Measured 2026-08-10, that is impossible as stated — the failure digest publishes ONLY on
# failure, so bundles 1623/1624--app-e2e (runs 1622/1623, both green) do not exist. The tally is
# therefore emitted and then unreadable exactly when the run looks fine.
#
# That is not merely untidy. If the refresh contention partially returned, the retries would absorb it,
# `app-e2e` would go green, and `refresh_429 > 0` would be invisible. So the judgement moves INTO the
# job, where nobody has to remember to look — the same move `e2e-failure-set.mjs gate` makes for skips.
GATE=0
[ "${1:-}" = "--gate" ] && GATE=1

CONTAINER="${E2E_CONTENTION_CONTAINER:-mcm-bff-service-nonsecure}"
MARKER='[e2e-contention]'

# The file seam is the test seam. A script that could only read a live container could only be
# verified by running CI — the loop this feature exists to shorten.
LOG_FILE="${E2E_CONTENTION_LOG_FILE:-}"

log_source=""
unavailable_reason=""

if [ -n "$LOG_FILE" ]; then
  if [ -r "$LOG_FILE" ]; then
    log_source=$(cat "$LOG_FILE" 2>/dev/null)
  else
    unavailable_reason="log file not readable: $LOG_FILE"
  fi
elif command -v docker >/dev/null 2>&1; then
  if log_source=$(docker logs "$CONTAINER" 2>&1); then
    :
  else
    unavailable_reason="docker logs failed for container '$CONTAINER' (absent, or the daemon is unreachable)"
  fi
else
  unavailable_reason="no docker CLI on PATH and no E2E_CONTENTION_LOG_FILE set"
fi

# "not measured" and "measured zero" are opposite conclusions. SC-001 is satisfied only by the
# latter, so a missing source must never render as 0.
if [ -n "$unavailable_reason" ]; then
  echo "$MARKER refresh_total=unavailable refresh_429=unavailable session_evicted=unavailable"
  echo "$MARKER reason: $unavailable_reason"
  # `--gate` does NOT fail here, and the reason is structural rather than lenient. This step runs
  # AFTER the web E2E and BEFORE teardown, so the BFF container exists whenever the web suite ran at
  # all. `unavailable` therefore implies bring-up already failed — the job is red for a cause that is
  # upstream of this, and failing again would only compete with it for the reader's attention
  # (measured on run 1611, where a Keycloak import error was the real story). It cannot produce a
  # false GREEN, which is the only thing a gate must never allow.
  exit 0
fi

# Count one audit action. `grep -c` returns 1 on "no matches" and 2 on a real error; both are
# reported here as 0 rather than propagated, because this script's contract is to always exit 0 and
# always print a number. The source-availability question was already settled above.
count_action() {
  local action="$1" n
  n=$(printf '%s\n' "$log_source" | grep -c "\"action\":\"${action}\"") || n=0
  # grep -c prints nothing on some error paths; normalise to a number.
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  printf '%s' "$n"
}

refresh_total=$(count_action refresh_attempted)
refresh_429=$(count_action refresh_rate_limited)
session_evicted=$(count_action session_evicted)

echo "$MARKER refresh_total=${refresh_total} refresh_429=${refresh_429} session_evicted=${session_evicted}"

# The last false-zero hole, and the one the 0-vs-unavailable rule does NOT cover: a BFF running a
# build WITHOUT feature 052's instrumentation reports a clean, confident `0` for everything. That is
# not a measurement — it is the absence of one, wearing a measurement's clothes.
#
# `refresh_attempted` fires on every refresh attempt, and refresh cadence is set by the 5-minute CI
# access-token lifespan, not by test behaviour. Across a full multi-worker E2E run, `refresh_total=0`
# alongside ordinary BFF traffic therefore means the instrumented build did not ship — not that
# nothing refreshed. Say so, rather than letting a reader take the zeros at face value.
if [ "$GATE" = "1" ]; then
  violations=""
  [ "$refresh_429" != "0" ] && violations="${violations} refresh_429=${refresh_429}"
  [ "$session_evicted" != "0" ] && violations="${violations} session_evicted=${session_evicted}"
  if [ -n "$violations" ]; then
    echo "$MARKER GATE FAILED —${violations}"
    echo "$MARKER The worker/session contention has returned. Feature 052 drove refresh_429 from"
    echo "$MARKER 32/66 to 0 by giving each worker its own session and a CI access token that"
    echo "$MARKER outlives the run. A non-zero count here means one of those regressed — check"
    echo "$MARKER MAX_E2E_WORKERS, the per-worker storageState fixture, and ci-realm's"
    echo "$MARKER accessTokenLifespan. Do NOT silence this by raising the BFF's refresh rate limit:"
    echo "$MARKER it is an anti-abuse control on a production auth endpoint (052 FR-011)."
    exit 1
  fi
  echo "$MARKER gate passed — no rate-limited refreshes, no session evictions"
fi

if [ "$refresh_total" = "0" ]; then
  bff_lines=$(printf '%s\n' "$log_source" | grep -c '"service":"mcm-bff"') || bff_lines=0
  case "$bff_lines" in ''|*[!0-9]*) bff_lines=0 ;; esac
  if [ "$bff_lines" -gt 0 ]; then
    echo "$MARKER caution: refresh_total=0 across ${bff_lines} BFF log entries — over a full run this" \
         "indicates the instrumented build did NOT ship, not that no refresh occurred. Verify the BFF" \
         "image was rebuilt from this branch before reading the zeros as a result."
  fi
fi

exit 0
