#!/usr/bin/env bash
# Feature 087 (FR-020 to FR-022): does a release APK actually launch?
#
# WHY THIS EXISTS. An SDK move can build a release APK that crashes at launch, and until now the first
# sign would be every Maestro flow failing at once with a message about a missing element. This checks
# launch directly, says which of three things failed, and costs seconds because the job has already
# built an APK and booted an emulator.
#
# Runs with the APK installed and a booted emulator. CI calls it from the emulator step, between
# `adb install` and the agent flows. That step runs line by line, which is why this is a script.
#
#   bash scripts/android-launch-smoke.sh              run the three checks. Exit 0 if all pass, else 1
#   bash scripts/android-launch-smoke.sh --selftest   test the log classifier; needs no device
#
# Anything else exits 2. The result file is written on failure as well as on success, so
# scripts/publish-android-launch.mjs can tell "the checks failed" from "the checks never ran".
#
# THE LOG CLASSIFIER IS A SEPARATE FUNCTION WITH A SELFTEST because a grep that matches nothing looks
# identical to a clean launch.
set -uo pipefail

readonly APP_ID='com.grumpyrobot.mcmapp'
readonly ACTIVITY="${APP_ID}/.MainActivity"
readonly LOGIN_SCREEN_ID='login-screen'
# Cold start of a release bundle on a software-rendered emulator. The step's ceiling bounds it anyway.
readonly LOGIN_SCREEN_BOUND_SECONDS="${ANDROID_LAUNCH_LOGIN_BOUND_SECONDS:-120}"

usage() {
  echo 'usage: bash scripts/android-launch-smoke.sh [--selftest]' >&2
}

# Read `adb logcat -v threadtime` on stdin. Print the lines showing a fatal error in THIS app's
# process, and nothing else. A Chrome crash on the same device is not this app failing to launch.
#
# Which process a line belongs to comes from the PID column. The app's PIDs come from the log itself,
# because a process that crashed has no PID left to ask for.
classify_log() {
  awk -v app="$APP_ID" '
    { lines[NR] = $0 }
    # threadtime format: date time pid tid level tag: message
    index($0, "Start proc ") && index($0, ":" app "/") {
      if (match($0, /Start proc [0-9]+:/)) { pid = substr($0, RSTART + 11, RLENGTH - 12); app_pids[pid] = 1 }
    }
    index($0, "Process: " app ", PID: ") { app_pids[$3] = 1 }
    END {
      for (i = 1; i <= NR; i++) {
        if (lines[i] !~ /FATAL EXCEPTION|ClassNotFoundException|NoSuchMethodException/) continue
        split(lines[i], columns, " ")
        if (columns[3] in app_pids) print lines[i]
      }
    }
  '
}

# Lines to print from a device log, through the same redaction CI digests use. If redaction cannot
# run, nothing is printed: a missing excerpt is better than an unredacted one.
print_redacted() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REDACT_MODULE="$script_dir/ci-digest-redact.mjs" node --input-type=module -e '
    const { redactForPublication } = await import(process.env.REDACT_MODULE);
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    process.stdout.write(redactForPublication(text));
  ' || echo '(matched lines withheld: redaction did not run)'
}

selftest() {
  local failed=0
  local tail_lines=" I ActivityManager: Start proc 4242:${APP_ID}/u0a190 for top-activity"
  expect_found() {
    local label="$1" sample="$2"
    if [ -z "$(printf '%s\n%s\n' "11-05 12:00:00.000  1000  1100$tail_lines" "$sample" | classify_log)" ]; then
      echo "selftest FAILED: $label was not detected" >&2
      failed=1
    fi
  }
  expect_clean() {
    local label="$1" sample="$2"
    if [ -n "$(printf '%s\n%s\n' "11-05 12:00:00.000  1000  1100$tail_lines" "$sample" | classify_log)" ]; then
      echo "selftest FAILED: $label was reported as a fatal error" >&2
      failed=1
    fi
  }

  expect_found 'FATAL EXCEPTION' \
    '11-05 12:00:01.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main'
  expect_found 'ClassNotFoundException' \
    '11-05 12:00:01.000  4242  4242 E ReactNativeJS: java.lang.ClassNotFoundException: expo.modules.Gone'
  expect_found 'NoSuchMethodException' \
    '11-05 12:00:01.000  4242  4242 W System.err: java.lang.NoSuchMethodException: a.b.c()'
  expect_found 'a crash whose PID is named only by its own Process line' \
    "$(printf '%s\n%s' \
      '11-05 12:00:01.000  5555  5555 E AndroidRuntime: FATAL EXCEPTION: main' \
      "11-05 12:00:01.000  5555  5555 E AndroidRuntime: Process: ${APP_ID}, PID: 5555")"

  expect_clean 'a clean log' \
    '11-05 12:00:01.000  4242  4242 I ReactNativeJS: Running "main"'
  expect_clean "another process's FATAL EXCEPTION" \
    "$(printf '%s\n%s' \
      '11-05 12:00:01.000  7777  7777 E AndroidRuntime: FATAL EXCEPTION: main' \
      '11-05 12:00:01.000  7777  7777 E AndroidRuntime: Process: com.android.chrome, PID: 7777')"
  expect_clean "another process's ClassNotFoundException" \
    '11-05 12:00:01.000  7777  7777 W Finsky: java.lang.ClassNotFoundException: x.y.Z'

  if [ "$failed" -ne 0 ]; then return 1; fi
  echo 'selftest ok: FATAL EXCEPTION, ClassNotFoundException and NoSuchMethodException in the app process are detected; a clean log and another process are not'
}

write_result() {
  local launch="$1" login="$2" fatal="$3"
  printf '{"launch":"%s","loginScreen":"%s","fatal":%s}\n' "$launch" "$login" "$fatal" \
    > "$HOME/android-launch-${GITHUB_RUN_ID:-local}.json"
}

run_checks() {
  local launch='failed' login='absent' fatal=0 start_output total_time waited=0 started matched

  adb logcat -c 2>/dev/null || true

  start_output="$(adb shell am start -W -n "$ACTIVITY" 2>&1)"
  if printf '%s' "$start_output" | grep -q 'Status: ok'; then
    launch='ok'
    total_time="$(printf '%s' "$start_output" | sed -n 's/^TotalTime: *//p' | tr -d '\r')"
    echo "launch=ok totalTime=${total_time:-unknown}"
  else
    echo 'launch=failed'
    printf '%s\n' "$start_output" | print_redacted
  fi

  started="$(date +%s)"
  while [ "$waited" -lt "$LOGIN_SCREEN_BOUND_SECONDS" ]; do
    if adb shell uiautomator dump /sdcard/mcm-launch-window.xml >/dev/null 2>&1 \
      && adb exec-out cat /sdcard/mcm-launch-window.xml 2>/dev/null | grep -q "resource-id=\"[^\"]*${LOGIN_SCREEN_ID}\""; then
      login='visible'
      break
    fi
    sleep 2
    waited=$(( $(date +%s) - started ))
  done
  if [ "$login" = 'visible' ]; then
    echo "login-screen=visible after=$(( $(date +%s) - started ))"
  else
    echo "login-screen=absent after=${waited}"
  fi

  matched="$(adb logcat -d -v threadtime 2>/dev/null | classify_log)"
  if [ -n "$matched" ]; then
    fatal="$(printf '%s\n' "$matched" | wc -l | tr -d ' ')"
  fi
  echo "fatal=${fatal}"
  if [ "$fatal" -ne 0 ]; then
    printf '%s\n' "$matched" | print_redacted
  fi

  # So the flows that follow start cold, rather than from whatever this left on screen.
  adb shell am force-stop "$APP_ID" >/dev/null 2>&1 || true

  write_result "$launch" "$login" "$fatal"
  [ "$launch" = 'ok' ] && [ "$login" = 'visible' ] && [ "$fatal" -eq 0 ]
}

if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi
case "${1:-}" in
  '') run_checks ;;
  --selftest) selftest ;;
  *)
    usage
    exit 2
    ;;
esac
