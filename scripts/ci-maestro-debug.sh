#!/usr/bin/env bash
# app-e2e — stage THIS run's Maestro output for the `maestro-debug` artifact (spec 084 FR-019b).
#
# app-e2e runs ON the ci host (`runs-on: kvm`), so `~/.maestro/tests` is the ci user's persistent
# home directory and Maestro only prunes it at ~14 days. Uploading it whole re-shipped every earlier
# run on each failure: 330,497 rows / 11 GB of artifacts by 2026-10-26, half of the nightly backup.
#
#   start    — (Install Maestro step) reset the staging dir and mark the run's start
#   collect  — (failure, before the upload) copy only the Maestro runs newer than the mark
#
# Staging dir: ./maestro-debug (the upload reads maestro-debug/tests/**). A diagnostic must never
# change the job's outcome, so `collect` exits 0 on every path; only a bad invocation exits 2.
# Pinned by scripts/__tests__/ci-maestro-debug.test.mjs.
set -euo pipefail

STAGE=maestro-debug
MARK="$STAGE/.run-start"
SRC="$HOME/.maestro/tests"

usage() { echo "usage: $0 start|collect" >&2; exit 2; }
[ "$#" -eq 1 ] || usage

case "$1" in
  start)
    rm -rf "$STAGE"
    mkdir -p "$STAGE/tests"
    touch "$MARK"
    echo "maestro-debug: start mark set"
    ;;
  collect)
    mkdir -p "$STAGE/tests"
    if [ ! -f "$MARK" ]; then
      echo "maestro-debug: no start mark — staging nothing rather than the whole host history"
      exit 0
    fi
    n=0
    if [ -d "$SRC" ]; then
      while IFS= read -r -d '' d; do
        cp -r "$d" "$STAGE/tests/" && n=$((n + 1)) || true
      done < <(find "$SRC" -mindepth 1 -maxdepth 1 -type d -newer "$MARK" -print0)
    fi
    echo "maestro-debug: staged $n Maestro run(s) from this job"
    ;;
  *) usage ;;
esac
