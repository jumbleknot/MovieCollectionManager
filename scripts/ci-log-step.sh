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
root="${CI_STEP_LOG_ROOT:-$HOME/mcm-ci-step-logs}"
dir="$root/${GITHUB_RUN_ID:-local}"
mkdir -p "$dir"

# Best-effort prune of old runs; never allowed to fail the step.
find "$root" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true

# Combined stdout+stderr: a stack trace on stderr is exactly what makes a failure diagnosable.
# `set -e` is dropped from here so a failing command does not abort before the marker is written and
# the real exit code is re-raised. pipefail is preserved (see below) — that is the load-bearing part.
set +e
"$@" 2>&1 | tee -a "$dir/${name}.log"
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
fi

# Exit with the COMMAND's status when it failed (pipefail semantics: the command's failure is what
# must fail the job); otherwise surface a tee failure so a broken mirror never silently hides output.
[ "$cmd_rc" -ne 0 ] && exit "$cmd_rc"
exit "$tee_rc"
