#!/usr/bin/env bash
# Tests for scripts/dast-leak-scan.sh — 048 US5 (T035/T036/T038/T039).
#
# The DAST secret-leak check blocks publication of ZAP reports. Every per-secret scan in it is
# guarded by `if [ -n "$VAR" ] && grep …`, so an EMPTY variable skips that scan and the step still
# exits 0: it reports "no leaks" having looked for nothing. That is fail-OPEN, and a security
# control whose failure mode is "quietly scan nothing, report green" is the same defect class the
# rest of 048 removes.
#
# Modes:
#   (none)      T035/T036 — each guarded secret blank in turn: the scan must FAIL, not exit 0
#   --canary    T038      — a planted value matching each guarded secret must be DETECTED
#   --empty-dir T039      — a missing/empty reports dir must fail, not pass by grep-missing
#   --all       run everything
#
# Run: bash scripts/__tests__/dast-leak-scan.test.sh [--canary|--empty-dir|--all]
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/dast-leak-scan.sh"
[ -x "$SCRIPT" ] || [ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT not found (T034 must land first)"; exit 2; }

pass=0; fail=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# The three secrets the step guards, with a plausible value for each.
SECRETS=(E2E_TEST_PASSWORD E2E_ROPC_CLIENT_SECRET ANTHROPIC_API_KEY)
VALUES=(Sup3rSecretPassw0rd ropc-client-secret-abc123 sk-ant-api03-CANARYVALUE0123456789)

# Run the scan in a clean environment with the three secrets set, minus any we blank, against
# $1 = reports dir. Extra `KEY=VALUE` args override. Echoes the exit code.
run_scan() {
  local dir="$1"; shift
  local -a env_args=(
    "E2E_TEST_PASSWORD=${VALUES[0]}"
    "E2E_ROPC_CLIENT_SECRET=${VALUES[1]}"
    "ANTHROPIC_API_KEY=${VALUES[2]}"
    "MODEL_PROVIDER=anthropic"
  )
  env -i PATH="$PATH" HOME="$HOME" "${env_args[@]}" "$@" bash "$SCRIPT" "$dir"
}

# A reports dir with a benign report in it — nothing that should trip any scan.
make_clean_reports() {
  local dir; dir="$(mktemp -d)"
  cat > "$dir/report.json" <<'JSON'
{"@version":"2.16.1","site":[{"@name":"http://mcm-bff:8082","alerts":[]}]}
JSON
  echo "$dir"
}

# ── T035 / T036: a blank guarded secret must FAIL, never silently skip its scan ─────────────────
test_fail_closed() {
  echo "── T035/T036: each guarded secret blank in turn must FAIL (fail-closed) ──"
  local dir; dir="$(make_clean_reports)"
  local i name
  for i in 0 1 2; do
    name="${SECRETS[$i]}"
    # Blank this one secret; the other two stay set, so only the emptiness is under test.
    run_scan "$dir" "${name}=" >/dev/null 2>&1
    local rc=$?
    if [ "$rc" -ne 0 ]; then
      ok "$name empty → exit $rc (scan refuses to run blind)"
    else
      bad "$name empty → exit 0 — the scan skipped silently and reported success"
    fi
  done
  rm -rf "$dir"

  # US5-AC3 / FR-019: the documented non-Anthropic provider override must keep working. An empty
  # ANTHROPIC_API_KEY is LEGITIMATE there, and over-tightening would break app-ci's provider input.
  echo "── T037: MODEL_PROVIDER=ollama + empty ANTHROPIC_API_KEY must PASS (no over-tightening) ──"
  dir="$(make_clean_reports)"
  run_scan "$dir" "ANTHROPIC_API_KEY=" "MODEL_PROVIDER=ollama" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "MODEL_PROVIDER=ollama with an empty Anthropic key → exit 0 (override path intact)"
  else
    bad "MODEL_PROVIDER=ollama with an empty Anthropic key → exit $rc — over-tightened, this breaks the documented provider override"
  fi
  rm -rf "$dir"
}

# ── T038: the canary — a planted secret must actually be caught ─────────────────────────────────
# A fail-closed assertion nobody has watched fire is the same unverified control in a new shape.
test_canary() {
  echo "── T038: a planted value matching each guarded secret must be DETECTED ──"
  local i name value dir rc
  for i in 0 1 2; do
    name="${SECRETS[$i]}"; value="${VALUES[$i]}"
    dir="$(make_clean_reports)"
    # Plant the secret inside a report exactly as a leak would appear.
    printf '{"request":{"header":"Authorization: Basic %s"}}\n' "$value" > "$dir/leaked.json"
    run_scan "$dir" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
      ok "$name planted in a report → exit $rc (publication blocked)"
    else
      bad "$name planted in a report → exit 0 — the leak was NOT detected"
    fi
    rm -rf "$dir"
  done

  # The JWT scan takes no variable and was never fail-open; assert it still fires.
  dir="$(make_clean_reports)"
  echo '{"h":"Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0dXNlciJ9.c2lnbmF0dXJlLXZhbHVl"}' > "$dir/jwt.json"
  run_scan "$dir" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "JWT planted in a report → exit $rc"; else bad "JWT planted → exit 0"; fi
  rm -rf "$dir"

  # And the negative control: without a canary the same harness must pass, or every "PASS" above
  # would be meaningless (a script that always failed would score 4/4).
  dir="$(make_clean_reports)"
  run_scan "$dir" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "negative control: clean reports → exit 0 (the scan is not simply always-failing)"
  else
    bad "negative control: clean reports → exit $rc — the scan fails even with nothing planted"
  fi
  rm -rf "$dir"
}

# ── T039: a missing or empty reports directory must not pass by grep-missing ────────────────────
test_empty_dir() {
  echo "── T039: a missing or empty reports directory must FAIL, not pass by grep miss ──"
  local dir rc
  dir="$(mktemp -d)"; rmdir "$dir"          # a path that does not exist
  run_scan "$dir" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "missing reports dir → exit $rc"
  else
    bad "missing reports dir → exit 0 — cannot tell 'nothing leaked' from 'nothing scanned'"
  fi

  dir="$(mktemp -d)"                         # exists but is empty
  run_scan "$dir" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "empty reports dir → exit $rc"
  else
    bad "empty reports dir → exit 0 — cannot tell 'nothing leaked' from 'nothing scanned'"
  fi
  rm -rf "$dir"
}

case "${1:---default}" in
  --canary)    test_canary ;;
  --empty-dir) test_empty_dir ;;
  --all)       test_fail_closed; test_canary; test_empty_dir ;;
  *)           test_fail_closed ;;
esac

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
