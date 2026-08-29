#!/usr/bin/env bash
# Feature 054 US3 — say whether a run COLLAPSED, instead of leaving it to be counted by hand.
#
# WHY THIS EXISTS: roughly one `app-e2e` run in seven collapses — every agent/dock spec fails at
# once, `flaky=0`, and the gateway receives about a quarter of its usual traffic while answering
# everything it does receive with 200. Turns are not being SENT (backlog item #173).
#
# From the outside that is indistinguishable from "some tests failed". Telling them apart meant
# downloading the failure bundle and counting `POST /agent/movie-assistant` by hand — which nobody
# does, so the reflex became "re-run it". That reflex is how five stale specs hid for three weeks
# (item #150), and how two consecutive samples of a 1-in-7 event were mistaken for a regression
# caused by feature 053's fix, which was then reverted for no reason.
#
# Contract: specs/054-app-e2e-reliability-cluster/contracts/run-health-signal.md
# Pinned by: scripts/__tests__/e2e-turn-tally.test.mjs
#
# THIS LABELS; IT DOES NOT GATE. A collapsed run already fails on its test failures. Failing it a
# second time adds nothing and buys a new false-failure mode. Unlike e2e-contention-tally.sh there is
# deliberately no `--gate`.
#
# CRITICAL — this script ALWAYS exits 0, for the same reason the contention tally does: `grep -c`
# exits 1 when it matches nothing, and `ci-log-step.sh` re-raises the wrapped exit code by design. A
# zero-POST run is the single most interesting measurement this can take, so counting it must not
# redden the job.
#
# Deliberately NOT `set -e`: an early exit would drop the line entirely, which reads as "the step did
# not run" rather than "nothing was measured". `-u` and `pipefail` are kept.
set -uo pipefail

MARKER='[e2e-turns]'

# The measured discriminator: a healthy run drives ~155-169 of these, a collapsed one ~39-56.
AGENT_POST_PATTERN='POST /agent/movie-assistant'

# Normalised against tests executed, not against a raw count. A bare threshold on the POST count
# becomes wrong the first time a spec is added or removed — and becomes wrong SILENTLY, reporting
# `collapsed` for a run that merely got smaller.
#
# 50 sits between a measured healthy minimum of 88 and a measured collapsed maximum of 32. The GAP is
# what makes a crude threshold workable; the precision of the number is not the point, and a run near
# the boundary is one to read by hand rather than to trust the verdict on.
HEALTHY_FLOOR_PER_100=50

CONTAINER="${E2E_TURN_GATEWAY_CONTAINER:-movie-assistant-gateway}"

# Both file seams are test seams. A script that could only read a live container and a live CI step
# log could only be verified by running CI — the loop this feature exists to shorten.
GATEWAY_LOG_FILE="${E2E_TURN_GATEWAY_LOG_FILE:-}"
# Run- AND job-scoped, matching ci-log-step.sh's `dir=` (item #180): app-e2e and dast share this
# runner's $HOME, so a run-only path would read whichever job wrote last.
COUNTS_FILE="${E2E_TURN_COUNTS_FILE:-${HOME:-}/mcm-ci-step-logs/${GITHUB_RUN_ID:-local}/${GITHUB_JOB:-local}/e2e-result-gate.log}"

gateway_log=""
unavailable_reason=""

if [ -n "$GATEWAY_LOG_FILE" ]; then
  if [ -r "$GATEWAY_LOG_FILE" ]; then
    gateway_log=$(cat "$GATEWAY_LOG_FILE" 2>/dev/null)
  else
    unavailable_reason="gateway log file not readable: $GATEWAY_LOG_FILE"
  fi
elif command -v docker >/dev/null 2>&1; then
  if ! gateway_log=$(docker logs "$CONTAINER" 2>&1); then
    unavailable_reason="docker logs failed for container '$CONTAINER' (absent, or the daemon is unreachable)"
  fi
else
  unavailable_reason="no docker CLI on PATH and no E2E_TURN_GATEWAY_LOG_FILE set"
fi

# "Not measured" and "measured zero" are opposite conclusions, and only one of them is a finding.
# Rendering an unreadable log as `collapsed` would be a confident verdict drawn from no data — the
# exact shape of error this feature exists to stop.
emit_indeterminate() {
  echo "$MARKER gateway_posts=unavailable tests_executed=unavailable posts_per_100_tests=unavailable verdict=indeterminate"
  echo "$MARKER reason: $1"
  exit 0
}

[ -n "$unavailable_reason" ] && emit_indeterminate "$unavailable_reason"

# `grep -c` returns 1 on "no matches" and 2 on a real error; both are normalised to 0 here rather
# than propagated. The source-availability question was already settled above, so a zero at this
# point is a measurement.
gateway_posts=$(printf '%s\n' "$gateway_log" | grep -c "$AGENT_POST_PATTERN") || gateway_posts=0
case "$gateway_posts" in
  ''|*[!0-9]*) gateway_posts=0 ;;
esac

# The denominator comes from the `E2E result gate` step, which runs immediately before this one. That
# ordering is load-bearing in both directions and is asserted in the test file: before the gate there
# is no counts line to read, and after teardown there is no container to count.
if [ ! -r "$COUNTS_FILE" ]; then
  emit_indeterminate "no e2e-result-gate counts at $COUNTS_FILE — the result gate did not run, or ran after this step"
fi

counts_line=$(grep -o '\[e2e-gate\] failed=[0-9]* flaky=[0-9]* passed=[0-9]*[^ ]*.*' "$COUNTS_FILE" 2>/dev/null | tail -n 1)
[ -z "$counts_line" ] && emit_indeterminate "no [e2e-gate] line in $COUNTS_FILE"

# BOTH TIERS, or the ratio is inflated (feature 056). The gateway serves every turn the job drives,
# but since the split the counts file above holds only the GATE tier's tests. MEASURED on run #1686:
# 149 posts against 155 gate tests read as 96 per 100, where the same job pre-split read 83 — the
# model tier's 22 tests contributed posts to the numerator and nothing to the denominator.
#
# It did not change that verdict, and "it happened not to matter" is not a reason to leave a
# measurement wrong: the threshold is calibrated against a band, and an inflated ratio drifts out of
# comparability with it.
MODEL_COUNTS_FILE="${E2E_TURN_MODEL_COUNTS_FILE:-${HOME:-}/mcm-ci-step-logs/${GITHUB_RUN_ID:-local}/${GITHUB_JOB:-local}/e2e-result-gate-model.log}"
model_counts_line=""
[ -r "$MODEL_COUNTS_FILE" ] && model_counts_line=$(grep -o '\[e2e-gate\] failed=[0-9]* flaky=[0-9]* passed=[0-9]*[^ ]*.*' "$MODEL_COUNTS_FILE" 2>/dev/null | tail -n 1)

field() {
  local name="$1" v
  v=$(printf '%s' "$counts_line" | grep -o "${name}=[0-9]*" | head -n 1 | cut -d= -f2)
  case "$v" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$v" ;;
  esac
}

# Executed = attempted at least once. `skipped` and `did-not-run` are excluded by definition: a test
# that never ran cannot have driven a turn, so counting it would depress the ratio and manufacture a
# collapse out of a path-gated run.
failed=$(field failed)
flaky=$(field flaky)
passed=$(field passed)
tests_executed=$((failed + flaky + passed))

# Add the model tier's executed count when that tier ran. Absent on a pull request, where only the
# gate runs — and an absent file must add nothing rather than read as zero tests having run.
if [ -n "$model_counts_line" ]; then
  saved_line="$counts_line"
  counts_line="$model_counts_line"
  tests_executed=$((tests_executed + $(field failed) + $(field flaky) + $(field passed)))
  counts_line="$saved_line"
fi

# Bash division by zero prints nothing and exits 1 — silent in both directions, which is why this is
# checked rather than guarded by arithmetic.
[ "$tests_executed" -eq 0 ] && emit_indeterminate "the result gate reports 0 tests executed — the web suite never ran"

# Integer arithmetic scaled by 100. Bash has no floats, and a ratio expressed per 100 tests keeps the
# comparison exact rather than approximately right.
posts_per_100=$(( gateway_posts * 100 / tests_executed ))

# TIER-AWARE, and this is a correction to this script's own calibration (feature 056).
#
# The floor of 50 was measured on a suite that INCLUDED the model-decision tests, and those are the
# ones that drive most gateway turns. After the split a `pull_request` runs the gate tier alone —
# 19 agent tests instead of 41, several doing no model turn at all — so a perfectly healthy run reads
# ~31 posts per 100 tests and the floor called it `collapsed`. MEASURED on PR #181's run: green by
# every count (`failed=0 flaky=1 passed=154`), verdict `collapsed`. A confident wrong label on every
# PR would teach people to ignore the field, which is the re-run reflex this script exists to remove.
#
# The gate-only baseline has ONE sample, and one sample is not a calibration — the contract says so
# about the original five. So a gate-only run reports `indeterminate` WITH THE REASON rather than
# guessing a floor. That is the same rule the unreadable-log path already follows: a measurement that
# cannot be made must not read as a good one, and it must not read as a bad one either.
#
# Signalled EXPLICITLY by `E2E_TURN_TIER=gate`, not inferred from the model counts file being absent.
# That inference was written first and was wrong: a LOCAL full-suite run (`E2E_TIER` unset, all 177 in
# one selection) also has no model counts file, and abstaining there would throw away the verdict in
# the one place a developer reads it directly.
if [ "${E2E_TURN_TIER:-}" = "gate" ]; then
  echo "$MARKER gateway_posts=${gateway_posts} tests_executed=${tests_executed} posts_per_100_tests=${posts_per_100} verdict=indeterminate"
  echo "$MARKER reason: gate tier only (the model tier did not run — normal on a pull request). The"
  echo "$MARKER healthy floor of ${HEALTHY_FLOOR_PER_100} was calibrated on the FULL suite, where the"
  echo "$MARKER model-decision tests drive most turns; a healthy gate-only run reads far lower. Judging"
  echo "$MARKER against that floor here would call a green run collapsed. Recalibrate with gate-only"
  echo "$MARKER samples before giving this a verdict — see specs/056-agent-gate-split/."
  exit 0
fi

if [ "$posts_per_100" -ge "$HEALTHY_FLOOR_PER_100" ]; then
  verdict=healthy
else
  verdict=collapsed
fi

echo "$MARKER gateway_posts=${gateway_posts} tests_executed=${tests_executed} posts_per_100_tests=${posts_per_100} verdict=${verdict}"

# ZERO turns is a different finding from FEW turns, and pointing it at the client would be wrong.
# MEASURED 2026-08-12: `movie-assistant-gateway` reported `status=running restarts=0` while /health
# timed out and it had stopped logging 40 minutes earlier. Two full local runs were measured against
# it and both read `collapsed` — a dead stack, not a defect, and the same trap the runbook records
# ("a container can be Up and dead"). A detector that blames the client for a corpse is worse than no
# detector, because it is confidently wrong in the direction of an expensive investigation.
if [ "$verdict" = "collapsed" ] && [ "$gateway_posts" -eq 0 ]; then
  echo "$MARKER ZERO turns reached the gateway. CHECK GATEWAY LIVENESS FIRST — do not read this as a"
  echo "$MARKER client-side collapse until you have ruled the stack out. An 'Up' container can be dead:"
  echo "$MARKER   docker exec mcm-bff-service-nonsecure wget -qO- http://movie-assistant-gateway:8000/health"
  echo "$MARKER   docker logs --tail 5 -t movie-assistant-gateway   # has it stopped logging?"
  echo "$MARKER If /health answers and the log is current, THEN this is the #173 client-side signature."
elif [ "$verdict" = "collapsed" ]; then
  echo "$MARKER COLLAPSE SIGNATURE — the client is not SENDING turns. Do NOT re-run this as a reflex."
  echo "$MARKER A healthy run drives ~88-95 posts per 100 tests; this run drove ${posts_per_100}."
  echo "$MARKER Already ruled out by #173, so do not re-derive them: worker/session contention"
  echo "$MARKER (refresh_429=0 in every collapsed run), stack bring-up, assistant_not_configured"
  echo "$MARKER short-circuits, and the known @expo/server closed-stream drop."
  echo "$MARKER Read the client-side capture in the bundle — that is the channel #173 never had."
elif [ "$verdict" = "healthy" ]; then
  echo "$MARKER turns were dispatched at the usual rate — a FAILURE in this run is about the tests,"
  echo "$MARKER not about the collapse. (A healthy verdict is not evidence the run was correct.)"
fi

exit 0
