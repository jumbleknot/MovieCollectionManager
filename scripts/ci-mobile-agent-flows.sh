#!/usr/bin/env bash
# Feature 023 — mobile agent E2E flows on the CI emulator.
#
# Kept in a script (not inline in the workflow's android-emulator-runner `script:`) because that
# block is executed LINE-BY-LINE in separate shells, which breaks multi-line constructs like a for
# loop with backslash continuations ("Syntax error: end of file unexpected"). A single
# `bash scripts/ci-mobile-agent-flows.sh` invocation parses normally.
#
# Flows run PER-FILE (the parallel suite trips the per-user rate-limit + ~5-min token expiry —
# CLAUDE.md). CI uses the ANTHROPIC provider (no local Ollama): the enable flow is the -anthropic
# variant and the agent turns run through the anthropic gateway. The Ollama-specific
# `assistant-config-test-connection` flow is intentionally NOT run here (its assertions probe an
# Ollama status row); config-UI behavior is covered by the web suite.
#
# Order (018): gating asserts the no-dock/disabled state on a clean user → enable-anthropic seeds a
# runnable config → the 4 agent flows drive the dock → disable tears down (so the next run starts
# disabled for the gating assertion). cwd is the repo root.
#
# Env (from the job): E2E_TEST_USER, E2E_TEST_PASSWORD, ANTHROPIC_API_KEY, TMDB_API_KEY.
set -euo pipefail

# Diagnostic (feature 023 CI mobile-login): capture the emulator logcat so a login
# failure ("Cannot pipe to a closed or destroyed stream" on the BFF) can be diagnosed
# from the CLIENT side. Clear the buffer now; on ANY exit dump it to a persistent path
# on the (non-ephemeral) runner — SSH-readable post-mortem, since this Forgejo's API
# does not expose workflow logs/artifacts. Filtered to RN/JS + networking + crashes.
LOGCAT_OUT="$HOME/ci-mobile-logcat.txt"
adb logcat -c 2>/dev/null || true
dump_logcat() {
  rc=$?
  { echo "=== ci-mobile-agent-flows exit rc=$rc ==="
    echo "=== adb reverse --list ==="; adb reverse --list 2>&1 || true
    echo "=== logcat: ReactNativeJS only (our console.error lives here) ==="
    adb logcat -d -v time ReactNativeJS:V '*:S' 2>&1 || true
    echo "=== logcat: full buffer grepped for network/auth/login keywords ==="
    adb logcat -d -v time 2>&1 | grep -iE "native-auth-callback|login|ECONNRESET|ECONNREFUSED|ERR_NETWORK|ECONNABORTED|SocketException|broken pipe|reset by peer|okhttp|timeout|8082|localhost|AndroidRuntime" 2>&1 || true
  } > "$LOGCAT_OUT" 2>&1 || true
  return $rc
}
trap dump_logcat EXIT

flows=(
  assistant-config-gating
  assistant-config-enable-anthropic
  agent-search
  agent-card-navigate
  agent-disambiguation
  agent-navigate-movie
  assistant-config-disable
)

for flow in "${flows[@]}"; do
  echo "=== flow: $flow ==="
  maestro test "frontend/mcm-app/tests/e2e/mobile/$flow.yaml" \
    --env E2E_TEST_USER="$E2E_TEST_USER" \
    --env E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD" \
    --env ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    --env TMDB_API_KEY="${TMDB_API_KEY:-}"
done
