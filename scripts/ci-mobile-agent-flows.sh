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
    echo "=== logcat: ReactNativeJS only (our console.error/logs live here) ==="
    adb logcat -d -v time ReactNativeJS:V '*:S' 2>&1 || true
    echo "=== logcat: OAuth redirect handoff (does mcm-app:// intent ever fire back to the app?) ==="
    adb logcat -d -v time 2>&1 | grep -iE "mcm-app://|native-auth-callback|com.grumpyrobot.mcmapp|ActivityTaskManager.*(VIEW|mcm-app|localhost:8099)|ERR_UNKNOWN_URL_SCHEME|RedirectUriReceiver|webview_shell|net::ERR" 2>&1 || true
    echo "=== logcat: network/auth/login keywords ==="
    adb logcat -d -v time 2>&1 | grep -iE "login|ECONNRESET|ECONNREFUSED|ERR_NETWORK|ECONNABORTED|SocketException|broken pipe|reset by peer|okhttp|timeout|:8082|:8099" 2>&1 || true
  } > "$LOGCAT_OUT" 2>&1 || true
  # Full unfiltered buffer too — the filtered greps above can miss the decisive line.
  adb logcat -d -v time > "$HOME/ci-mobile-logcat-full.txt" 2>&1 || true
  return $rc
}
trap dump_logcat EXIT

# Complete Chrome's First Run Experience ONCE before any login (google_apis_playstore image).
# Chrome's "Welcome to Chrome" FRE otherwise sits on top of the OAuth Custom Tab and hides the
# Keycloak form, so the credential step is skipped and login never completes. Best-effort — the
# helper is fully guarded/optional, so a missing/already-done FRE is a no-op. (feature 023.)
# Complete Chrome's FRE (best-effort). Retried a few times because the "Use without an account"
# button can render as not-yet-visible on the first launch (logcat: visible:false) — a relaunch
# usually settles it. Each attempt is a no-op once FRE is already done.
echo "=== pre-step: complete Chrome FRE ==="
for _ in 1 2 3; do
  maestro test frontend/mcm-app/tests/e2e/mobile/_chrome-skip-fre.yaml && break || true
done

flows=(
  assistant-config-gating
  assistant-config-enable-anthropic
  agent-search
  agent-card-navigate
  agent-disambiguation
  agent-navigate-movie
  # 040 — navigate-to-collection reliability (US1) + TMDB-add ownership & detail nav (US4).
  # agent-add-ownership needs a unique COLLECTION_NAME per run (create-if-missing), passed via
  # MAESTRO_-prefixed env by maestro-run.sh — never on argv (feature 027).
  agent-navigate-collection
  agent-add-ownership
  assistant-config-disable
)

# Each flow starts with `launchApp clearState: true` and logs in via the real Keycloak SSO Custom
# Tab. That CCT is flaky on a headless emulator (Chrome renderer can crash mid-load — logcat
# "CustomTabActivity app died"), and a crash fails the flow at login BEFORE any server-state change.
# Retry each flow up to 3 attempts so a transient CCT crash / slow form doesn't fail the suite. A
# real (deterministic) failure still fails all attempts and exits non-zero.
run_flow() {
  # Feature 027: secrets go to Maestro via the MAESTRO_-prefixed process env (the wrapper reads them
  # from THIS job env), NOT via `--env <secret>=` on the argv where `ps` would leak them. The job
  # env still supplies E2E_TEST_USER/E2E_TEST_PASSWORD/ANTHROPIC_API_KEY/TMDB_API_KEY.
  # Invoked via `bash` so a checkout that lost the wrapper's execute bit (e.g. authored on Windows)
  # still runs — the file is also committed mode 0755.
  #
  # Non-secret per-flow `--env` pairs are fine on argv (the argv rule is about CREDENTIALS).
  # 040 US4: agent-add-ownership adds via create-if-missing, so it needs a UNIQUE collection per
  # ATTEMPT — a retry against the same name would re-add the same movie, mc-service 409s, and the
  # approval assertion fails for a reason unrelated to the code under test.
  local extra=()
  if [ "$1" = "agent-add-ownership" ]; then
    extra=(--env "COLLECTION_NAME=t040own-$(date +%s)-${RANDOM}")
  fi
  bash scripts/maestro-run.sh "frontend/mcm-app/tests/e2e/mobile/$1.yaml" ${extra[@]+"${extra[@]}"}
}

for flow in "${flows[@]}"; do
  echo "=== flow: $flow ==="
  attempt=1; max=3
  until run_flow "$flow"; do
    if [ "$attempt" -ge "$max" ]; then
      echo "::error::flow $flow failed after $max attempts"
      exit 1
    fi
    echo "flow $flow failed (attempt $attempt/$max) — retrying"
    attempt=$((attempt + 1))
  done
done
