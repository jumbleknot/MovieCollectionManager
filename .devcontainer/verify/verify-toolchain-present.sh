#!/usr/bin/env bash
# verify-toolchain-present.sh — feature 038 (full dev-container toolchain)
#
# Governing success criteria: SC-001 (every team tool on PATH at container start, each reports a
# version) and SC-002 (all three language layers + the SDD CLI run in-container, no host fallback).
# Governing requirements:     FR-001 (full toolchain present), FR-002 (non-root).
#
# Asserts, from INSIDE the dev container, that every tool the team workflow needs resolves on PATH
# and prints a version — Rust + the cargo-utility set the repo's quality/security gates invoke
# (033/034/035 + tarpaulin coverage), the Python/uv + Specify SDD toolchain, Node/pnpm/Nx, gh, and
# the baked Android SDK + emulator that make mobile E2E runnable in-container.
#
# RED-first: run against the 037 baseline image (Node+pnpm only) this FAILS immediately — rustc,
# uv, gh, specify, and the cargo utilities are all "command not found". GREEN after the US1
# toolchain layers land in toolchain.Dockerfile.
#
# The Android section (added 2026-07-25) closes a measured hole: it lives in a LATER
# toolchain.Dockerfile layer, so a container rebuilt on an older MCM_DEVCONTAINER_IMAGE came up
# fully green here while silently missing the whole SDK. Everything the image bakes belongs in this
# script — if a layer is not asserted, its absence is invisible.
# Exit 0 = full toolchain present; non-zero = a required tool is missing.

set -uo pipefail

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "[verify-toolchain-present] SC-001 / SC-002"

# Non-fabrication guard: the proof is only meaningful inside the container.
if [ "${MCM_DEVCONTAINER:-}" != "1" ]; then
  echo "  ✗ MCM_DEVCONTAINER != 1 — not running inside the dev container (RED / run in-container)" >&2
  echo "[verify-toolchain-present] FAIL (not in container)"; exit 1
fi

# check_tool <command> [version-args...]
# Asserts the command resolves on PATH AND exits 0 for a version probe (proves it actually runs,
# not just a dangling name). Default probe is `--version`.
check_tool() {
  local cmd="$1"; shift
  local -a vargs=("$@")
  [ "${#vargs[@]}" -eq 0 ] && vargs=(--version)
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd — not found on PATH"
    return
  fi
  if "$cmd" "${vargs[@]}" >/dev/null 2>&1; then
    ok "$cmd present ($(command -v "$cmd"))"
  else
    err "$cmd on PATH but '$cmd ${vargs[*]}' failed — not runnable"
  fi
}

echo "  — Rust core"
check_tool rustc
check_tool cargo
check_tool rustfmt
check_tool rust-analyzer --version
# clippy is invoked as `cargo clippy`; the driver binary is clippy-driver.
check_tool clippy-driver --version
if cargo clippy --version >/dev/null 2>&1; then ok "cargo clippy runs"; else err "cargo clippy — not runnable"; fi

echo "  — cargo utilities (repo quality/security gates: 033/034/035 + coverage)"
# Cargo subcommand plugins must be probed THROUGH cargo (`cargo <sub> --version`). Some
# (cargo-outdated / cargo-bloat / cargo-mutants) reject a direct `cargo-<sub> --version` because
# they expect cargo to pass the subcommand name as argv[1] — a direct probe misreports them as
# broken even though they are installed and runnable. Probe via cargo, fall back to the binary.
check_cargo_sub() {
  local bin="$1" sub="${1#cargo-}"
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "$bin — not found on PATH"
    return
  fi
  if cargo "$sub" --version >/dev/null 2>&1 || "$bin" --version >/dev/null 2>&1; then
    ok "$bin present ($(command -v "$bin"))"
  else
    err "$bin on PATH but neither 'cargo $sub --version' nor '$bin --version' runs"
  fi
}
for t in cargo-audit cargo-deny cargo-outdated cargo-machete cargo-semver-checks \
         cargo-geiger cargo-expand cargo-bloat cargo-mutants cargo-tarpaulin; do
  check_cargo_sub "$t"
done

echo "  — Android SDK + emulator (mobile E2E in-container; feat devcontainer-android-emulator)"
# WHY this section exists: the Android SDK is baked into a LATER layer of toolchain.Dockerfile than
# the rest of the toolchain. A dev container rebuilt on a BASE_IMAGE (MCM_DEVCONTAINER_IMAGE) that
# predates that layer comes up with everything above green and NO Android SDK — and
# scripts/devcontainer-android.sh no-ops *cleanly* by design, so the rebuild looks successful.
# Measured 2026-07-25: exactly that happened, silently. This probe is the loud failure.
# Remedy on FAIL: repin MCM_DEVCONTAINER_IMAGE to a digest built after the Android layer landed
# (or rebuild locally with scripts/build-devcontainer-image.mjs), then rebuild the container.
# See docs/runbooks/devcontainer.md → "Mobile E2E (Android emulator) in the dev container".
ANDROID_API="${MCM_ANDROID_API:-34}"

# check_android_tool <command> <probe-args...> — like check_tool, but tolerant of the Android CLIs'
# inconsistent version flags (emulator uses single-dash `-version`; avdmanager has no version flag
# at all and is probed via `list avd`). Falls back to `-h` so a flag change never misreports an
# installed tool as broken — presence on PATH plus SOME successful invocation is the assertion.
check_android_tool() {
  local cmd="$1"; shift
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd — not found on PATH (Android SDK layer missing from the base image?)"
    return
  fi
  if "$cmd" "$@" >/dev/null 2>&1 || "$cmd" -h >/dev/null 2>&1; then
    ok "$cmd present ($(command -v "$cmd"))"
  else
    err "$cmd on PATH but '$cmd $*' failed — not runnable"
  fi
}

if [ -z "${ANDROID_HOME:-}" ]; then
  err "ANDROID_HOME unset — the baked Android SDK layer is ABSENT from this image (repin MCM_DEVCONTAINER_IMAGE)"
elif [ ! -d "${ANDROID_HOME}" ]; then
  err "ANDROID_HOME=${ANDROID_HOME} does not exist"
else
  ok "ANDROID_HOME=${ANDROID_HOME}"
  # The emulator writes lock/temp files under $ANDROID_HOME as the runtime user (the image chowns
  # the tree to `coder`); a root-owned SDK boots nothing.
  if [ -w "${ANDROID_HOME}" ]; then
    ok "ANDROID_HOME writable by $(id -un)"
  else
    err "ANDROID_HOME not writable by $(id -un) — emulator cannot write its lock/temp files"
  fi
  # sdkmanager package payloads (the ~5 GB the image pre-downloads so nothing fetches per-open,
  # which matters because the runtime egress firewall does not allow dl.google.com).
  for d in "platform-tools" "emulator" "platforms/android-${ANDROID_API}" \
           "system-images/android-${ANDROID_API}/google_apis/x86_64"; do
    if [ -d "${ANDROID_HOME}/${d}" ]; then
      ok "sdk package present (${d})"
    else
      err "sdk package MISSING (${ANDROID_HOME}/${d}) — image predates the Android layer, or sdkmanager install was incomplete"
    fi
  done
fi
# sdkmanager/avdmanager are Java tools — the image ships openjdk-17-jre-headless (a JRE suffices).
check_android_tool java -version
check_android_tool sdkmanager --version
check_android_tool avdmanager list avd
check_android_tool adb --version
check_android_tool emulator -version
# /dev/kvm is HOST-provided (the privileged DinD container passes it through), NOT image content —
# so its absence is a capability note, never a toolchain failure. Without it the emulator would run
# unaccelerated (unusably slow) and devcontainer-android.sh no-ops on purpose; mobile E2E → CI.
if [ -e /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  ok "/dev/kvm present and rw — hardware-accelerated emulator available"
elif [ -e /dev/kvm ]; then
  echo "  • /dev/kvm present but not rw for $(id -un) — run: scripts/devcontainer-android.sh prepare"
else
  echo "  • /dev/kvm absent (host has no nested KVM) — emulator would be unaccelerated; run mobile E2E in CI"
fi

echo "  — Python / SDD toolchain"
check_tool uv
check_tool uvx --version
check_tool specify --help

echo "  — Node / JS toolchain"
check_tool node
check_tool pnpm
check_tool gh --version
# Nx is driven via `pnpm nx` (no global). Prove it resolves in the workspace.
if command -v pnpm >/dev/null 2>&1 && pnpm nx --version >/dev/null 2>&1; then
  ok "pnpm nx resolves ($(pnpm nx --version 2>/dev/null | head -1))"
else
  err "pnpm nx — not resolvable (run from the workspace root)"
fi

if [ "$fail" -eq 0 ]; then
  echo "[verify-toolchain-present] PASS (SC-001 / SC-002)"; exit 0
else
  echo "[verify-toolchain-present] FAIL — a required tool is missing (SC-001 / SC-002)"; exit 1
fi
