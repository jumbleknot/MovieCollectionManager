#!/usr/bin/env sh
# Idempotency test for mongo-entrypoint.sh (feature 028, US2).
#
# Provenance: FR-004 (restart over a leftover 0400 keyfile must succeed), FR-005 (fresh-run behaviour
# unchanged), INV-5..INV-9 (data-model.md). The prod Mongo entrypoint writes the replica-set keyfile at
# 0400; on a plain container RESTART the prior run's read-only file persists and the redirect `>` cannot
# reopen it for write (EACCES) → crash-loop. This drives the REAL script (no mocks) with a no-op exec
# target (`true`) and asserts the four cases below.
#
# Run: bash infrastructure-as-code/docker/mc-service/mongo-entrypoint.test.sh
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENTRY="$HERE/mongo-entrypoint.sh"
TMPDIR_T="$(mktemp -d)"
KEYFILE="$TMPDIR_T/mongo-keyfile"
trap 'rm -rf "$TMPDIR_T"' EXIT

fail() { echo "  FAIL: $1"; exit 1; }
pass() { echo "  PASS: $1"; }

# mode of a file, portable-ish (GNU stat then BSD stat).
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

echo "==> Case 1: fresh run creates a 0400 keyfile and execs (exit 0)"
rm -f "$KEYFILE"
if MONGO_MC_KEYFILE=testcontent MONGO_KEYFILE_PATH="$KEYFILE" sh "$ENTRY" true; then
  [ -f "$KEYFILE" ] || fail "keyfile not created"
  [ "$(mode_of "$KEYFILE")" = "400" ] || fail "keyfile mode is $(mode_of "$KEYFILE"), expected 400"
  [ "$(cat "$KEYFILE")" = "testcontent" ] || fail "keyfile content mismatch"
  pass "fresh run"
else
  fail "fresh run exited non-zero"
fi

echo "==> Case 2 (the bug): restart over a pre-existing 0400 keyfile succeeds (exit 0)"
# Simulate a prior run's leftover: a read-only keyfile the wrapper must overwrite. rm -f first because
# Case 1 already left a 0400 file that this (non-root) test user could not otherwise re-plant over.
rm -f "$KEYFILE"; printf 'stale' > "$KEYFILE"; chmod 0400 "$KEYFILE"
if MONGO_MC_KEYFILE=freshcontent MONGO_KEYFILE_PATH="$KEYFILE" sh "$ENTRY" true; then
  [ "$(cat "$KEYFILE")" = "freshcontent" ] || fail "keyfile not overwritten on restart"
  [ "$(mode_of "$KEYFILE")" = "400" ] || fail "keyfile mode is $(mode_of "$KEYFILE") after restart, expected 400"
  pass "restart over leftover 0400 keyfile"
else
  fail "restart over a leftover 0400 keyfile exited non-zero (Permission denied) — entrypoint is not idempotent"
fi

echo "==> Case 3: two consecutive runs both exit 0 (idempotency)"
MONGO_MC_KEYFILE=a MONGO_KEYFILE_PATH="$KEYFILE" sh "$ENTRY" true || fail "consecutive run #1 failed"
MONGO_MC_KEYFILE=b MONGO_KEYFILE_PATH="$KEYFILE" sh "$ENTRY" true || fail "consecutive run #2 failed"
pass "two consecutive runs"

echo "==> Case 4: unset MONGO_MC_KEYFILE still fails fast (non-zero)"
rm -f "$KEYFILE"
if env -u MONGO_MC_KEYFILE MONGO_KEYFILE_PATH="$KEYFILE" sh "$ENTRY" true 2>/dev/null; then
  fail "unset MONGO_MC_KEYFILE unexpectedly succeeded — fail-fast guard lost"
else
  pass "unset MONGO_MC_KEYFILE fails fast"
fi

echo "OK"
