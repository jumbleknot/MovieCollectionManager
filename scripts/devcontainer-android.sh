#!/usr/bin/env bash
# Dev-container Android emulator bootstrap (feat devcontainer-android-emulator).
#
# WHY: mobile E2E used to be Windows-host-only (the Android SDK/emulator were not in the dev
# container). The full SDK + an x86_64 system image are now BAKED into the toolchain image
# (.devcontainer/toolchain.Dockerfile), and the privileged DinD dev container already exposes the
# host /dev/kvm — so a headless emulator boots HERE with hardware accel. Proven live 2026-07-22
# (API-34 google_apis x86_64, boot_completed=1). Per the runbook decision rule, AGENT mobile flows
# still prefer CI (local Metro OOM-crashes after ~1-2 /run calls); this local emulator is for
# non-agent flows + the rare local agent-flow debug. See docs/runbooks/android-emulator.md.
#
# Subcommands:
#   prepare  (default) — grant KVM access + ensure the AVD exists. Cheap/idempotent; run from
#                        postStartCommand. Never blocks or fails container start (best-effort).
#   boot                — boot the emulator headless, wait for boot_completed, and adb-reverse the
#                        dev BFF (8082) + Keycloak (8099) ports (10.0.2.2 is unreliable under
#                        nested-DinD, same as CI). Run this before `pnpm nx e2e:mobile`.
#   status              — `adb devices`.
#   stop                — kill the running emulator.

set -uo pipefail

AVD="${MCM_ANDROID_AVD:-mcm_dev}"
API="${MCM_ANDROID_API:-34}"
IMG="system-images;android-${API};google_apis;x86_64"
DEVICE="${MCM_ANDROID_DEVICE:-pixel_6}"

have() { command -v "$1" >/dev/null 2>&1; }

if [ -z "${ANDROID_HOME:-}" ] || ! have emulator || ! have adb; then
  echo "devcontainer-android: Android SDK not on PATH (ANDROID_HOME unset / emulator|adb missing) — is this the baked toolchain image? Skipping."
  exit 0
fi

grant_kvm() {
  if [ ! -e /dev/kvm ]; then
    echo "devcontainer-android: /dev/kvm not present — this host has no nested KVM. Emulator would be unusably slow; skipping (mobile agent flows run in CI)."
    return 1
  fi
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then return 0; fi
  # coder has NOPASSWD sudo (toolchain.Dockerfile). Give the runtime user rw via group ownership
  # rather than world-writable 666. ipset/firewall aside, this is the only device perm we touch.
  sudo chown root:"$(id -gn)" /dev/kvm 2>/dev/null && sudo chmod 660 /dev/kvm 2>/dev/null
  [ -r /dev/kvm ] && [ -w /dev/kvm ]
}

ensure_avd() {
  if avdmanager list avd 2>/dev/null | grep -q "Name: ${AVD}$"; then return 0; fi
  echo "devcontainer-android: creating AVD '${AVD}' (${IMG}, ${DEVICE})..."
  echo "no" | avdmanager create avd -n "${AVD}" -k "${IMG}" -d "${DEVICE}" --force >/dev/null 2>&1 \
    || { echo "devcontainer-android: avdmanager create failed — 'avdmanager create avd -n ${AVD} -k \"${IMG}\" -d ${DEVICE}' to see why."; return 1; }
}

cmd="${1:-prepare}"
case "$cmd" in
  prepare)
    grant_kvm || exit 0
    ensure_avd || exit 0
    echo "devcontainer-android: ready (KVM + AVD '${AVD}'). Boot it with: scripts/devcontainer-android.sh boot"
    exit 0
    ;;

  boot)
    grant_kvm || exit 1
    ensure_avd || exit 1
    if adb devices 2>/dev/null | grep -qE "^emulator-[0-9]+\s+device"; then
      echo "devcontainer-android: an emulator is already booted."
    else
      echo "devcontainer-android: booting '${AVD}' headless with KVM..."
      # CI's emulator-options (reactivecircus/android-emulator-runner) — headless + swiftshader.
      nohup emulator -avd "${AVD}" -no-snapshot -no-window -gpu swiftshader_indirect \
        -noaudio -no-boot-anim -memory 4096 -accel on >/tmp/mcm-emulator.log 2>&1 &
      adb start-server >/dev/null 2>&1
      booted=0
      for _ in $(seq 1 72); do
        if adb shell getprop sys.boot_completed 2>/dev/null | grep -q 1; then booted=1; break; fi
        sleep 5
      done
      if [ "$booted" != 1 ]; then
        echo "devcontainer-android: emulator did NOT reach boot_completed in ~6 min. Tail: tail -40 /tmp/mcm-emulator.log"
        exit 1
      fi
    fi
    # 10.0.2.2 is unreliable under nested-DinD (same as CI) — tunnel the dev BFF + Keycloak so the
    # app inside the emulator reaches them on localhost. Re-run after every emulator (re)start.
    adb reverse tcp:8082 tcp:8082 >/dev/null 2>&1 || true
    adb reverse tcp:8099 tcp:8099 >/dev/null 2>&1 || true
    echo "devcontainer-android: '${AVD}' booted (API ${API}); adb-reversed 8082 (dev BFF) + 8099 (Keycloak). Run: pnpm nx e2e:mobile mcm-app"
    exit 0
    ;;

  status)
    adb devices
    exit 0
    ;;

  stop)
    adb emu kill >/dev/null 2>&1 || pkill -f "emulator .*-avd ${AVD}" 2>/dev/null || true
    echo "devcontainer-android: stopped '${AVD}' (if running)."
    exit 0
    ;;

  *)
    echo "usage: devcontainer-android.sh [prepare|boot|status|stop]" >&2
    exit 2
    ;;
esac
