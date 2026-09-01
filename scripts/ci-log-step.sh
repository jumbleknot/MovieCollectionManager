#!/usr/bin/env bash
# Run a CI step, mirroring its combined output to a per-step log the failure digest collects
# (feature 042, T041).
#
# WHY: the forge API exposes no job logs, and the digest collector only ever saw container logs and
# health JSON. So for a TEST failure — which is most failures — the digest said "no log output was
# captured for this job" and a human still had to paste the log. Three consecutive `app-e2e`
# failures were diagnosed that way (TMDB drift, then a provider 529) before this existed.
#
# CRITICAL — `set -o pipefail` is load-bearing, not hygiene. `cmd | tee` returns TEE's exit status,
# so without pipefail a FAILING step would report SUCCESS and CI would go silently green. That is
# strictly worse than the problem this solves. scripts/__tests__/ci-log-step.test.mjs pins it.
#
# Usage:  bash scripts/ci-log-step.sh <log-name> <command> [args...]
# Example: bash scripts/ci-log-step.sh agent-integration pnpm nx test:integration movie-assistant

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: ci-log-step.sh <log-name> <command> [args...]" >&2
  exit 2
fi

name="$1"
shift

# Scoped by run id so a PERSISTENT runner (this one is) cannot leak a previous run's output into
# this run's digest. Falls back to `local` off-CI.
#
# And by JOB (item #180). `app-e2e` and `dast` run on the SAME self-hosted runner and share $HOME, so
# a run-scoped directory was ONE directory shared by both: whichever job failed first wrote
# `_failed-step`, and the other read it and published it as its own. MEASURED on app-ci run #1683 —
# the `app-e2e` digest reported `dast-install-latest-docker`, a step in the dast job. The same
# sharing put each job's step logs into the other's digest as `step:` excerpts, which is why the
# whole directory is scoped here and not just the marker file.
#
# There is deliberately NO run-scoped fallback on the reader side: a fallback would let the defect
# survive behind it on exactly the runs where the two jobs overlap.
root="${CI_STEP_LOG_ROOT:-$HOME/mcm-ci-step-logs}"
dir="$root/${GITHUB_RUN_ID:-local}/${GITHUB_JOB:-local}"
mkdir -p "$dir"

# Best-effort prune of old runs; never allowed to fail the step.
find "$root" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true

# Combined stdout+stderr: a stack trace on stderr is exactly what makes a failure diagnosable.
# `set -e` is dropped from here so a failing command does not abort before the marker is written and
# the real exit code is re-raised. pipefail is preserved (see below) — that is the load-bearing part.
set +e
# OPTIONAL PER-STEP CEILING (item #326). `always()` does NOT survive a job kill: when the runner
# enforces the job's `timeout-minutes`, the digest step never runs, so a HANG — the one failure
# class with no other evidence trail — produces no digest at all. Measured on PR #322, app-e2e task
# 8317: 75.1 min against a 75 min ceiling, and `ci-status failure` could only say "the job may have
# died before the digest step ran".
#
# Enforcing the ceiling HERE, below the job's, converts that hang from a job kill into a STEP
# failure: the job survives, the marker below is written, and the digest runs and can name what was
# hanging. Opt-in per call site via CI_STEP_TIMEOUT_SECONDS.
timeout_seconds="${CI_STEP_TIMEOUT_SECONDS:-}"
if [ -n "$timeout_seconds" ] && ! command -v timeout >/dev/null 2>&1; then
  # Never silently drop the protection — an absent guard that reports nothing is this repository's
  # most expensive failure shape. Warn into the step log, which the digest publishes.
  echo "[ci-log-step] WARNING: CI_STEP_TIMEOUT_SECONDS=$timeout_seconds requested but \`timeout\` is not on PATH — running UNBOUNDED." >&2
  timeout_seconds=""
fi

if [ -n "$timeout_seconds" ]; then
  # TERM first so the command can flush; SIGKILL only if it ignores that. 124 = timed out (TERM),
  # 137 = 128+9, killed after --kill-after.
  timeout --signal=TERM --kill-after=30s "$timeout_seconds" "$@" 2>&1 | tee -a "$dir/${name}.log"
else
  "$@" 2>&1 | tee -a "$dir/${name}.log"
fi
# PIPESTATUS is only valid IMMEDIATELY after the pipe — any command in between (even an assignment)
# clobbers it, and `set -u` then trips on the missing index. Capture the whole array in one go.
pipe_status=("${PIPESTATUS[@]}")
cmd_rc="${pipe_status[0]}"
tee_rc="${pipe_status[1]:-0}"

# Record which step failed, so the digest can name it instead of "_not reported_" (T046). Only the
# first failing wrapped step is recorded — `set -e` in the job stops at the first failure, so that is
# the one that actually broke the build. Best-effort; never allowed to change the outcome.
if [ "$cmd_rc" -ne 0 ] && [ ! -s "$dir/_failed-step" ]; then
  printf '%s\n' "$name" > "$dir/_failed-step" 2>/dev/null || true
  # A TIMEOUT is not an ordinary failure and must not read like one: there is no assertion to go
  # looking for, and the log tail ends mid-work rather than at an error. Recorded separately so the
  # digest can say so (item #326, criterion 2).
  if [ -n "$timeout_seconds" ] && { [ "$cmd_rc" -eq 124 ] || [ "$cmd_rc" -eq 137 ]; }; then
    printf 'timeout after %ss (step ceiling, not the job ceiling)\n' "$timeout_seconds" \
      > "$dir/_failed-step-reason" 2>/dev/null || true
  fi
fi

# Exit with the COMMAND's status when it failed (pipefail semantics: the command's failure is what
# must fail the job); otherwise surface a tee failure so a broken mirror never silently hides output.
[ "$cmd_rc" -ne 0 ] && exit "$cmd_rc"
exit "$tee_rc"
