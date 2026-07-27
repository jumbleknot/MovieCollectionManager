---
type: Runbook
title: Android emulator & APK builds (mobile E2E)
description: The decision rule for where to run mobile E2E flows (CI for agent flows, local emulator for everything else), the devcontainer-native Linux KVM emulator, and the Windows CMAKE_OBJECT_PATH_MAX build wall that blocks a native rebuild on this workstation.
resource: docs/runbooks/android-emulator.md
tags: [android, mobile, emulator, apk, ci, runbook]
timestamp: 2026-07-22T03:09:25+00:00
---

# Android emulator & APK builds (mobile E2E)

Mobile E2E has a hard split by flow type. **Agent flows** (anything driving the assistant dock)
must run in CI (`android-e2e.yml`) against a Metro-less, standalone embedded-bundle APK — the local
Windows path runs them against the Metro dev server, which OOM-crashes after only a handful of agent
`/run` calls and produces a misleading black-screen/`status 0` failure that looks like an app bug.
**Non-agent flows** (login, CRUD, sort, browse) run fine on the local emulator ritual below. The dev
container now also runs the Android emulator natively via Linux KVM, with the SDK and a system image
baked into the toolchain image — see [Containerized dev environment](/openwiki/runbooks/devcontainer.md).

## Gotchas

- **Agent flows still prefer CI even inside the dev container** — the decision rule above is
  unchanged regardless of where the emulator runs; only the *transport* to reach the OOM-prone Metro
  server differs (tunnel vs. `10.0.2.2`).
- **`adb reverse`, not `10.0.2.2`, is required on this workstation.** QEMU's standard Android gateway
  networking is broken here, so the tunnel must be re-established after every emulator restart — this
  is a hard requirement, not an optional convenience.
- **Before rebuilding the APK, check whether the last successful CI artifact is already
  native-compatible with HEAD.** A pure JS/Metro change (including a new pure-JS dependency with no
  native module) never needs a rebuild — diff the native-relevant paths against the last green CI
  commit first; an empty diff means download-and-install, skipping a ~20-minute build.
- **CI is the recommended APK build path, not the local Windows build.** A Linux CI runner has no
  Windows path-length wall; the disk-free step in that workflow is required, not cosmetic — without
  it the native C++ build exhausts runner disk and dies mid-compile with no clean error.
- **Windows hits a hard `CMAKE_OBJECT_PATH_MAX` (250-char) wall building RN ≥0.85 native modules.**
  The real cause is CMake replicating the full absolute source path under the object directory; this
  repo's path plus the deep pnpm layout overflows the cap. `LongPathsEnabled` does NOT fix this — the
  limit is internal to CMake, not Windows. A short-root + flattened-node_modules wrapper script is
  the documented (fragile) local fallback; CI is strongly preferred.
- **Running Maestro against a stale native binary crashes at startup**, not at test time — any native
  layer change (Expo SDK/RN bump, new native module, `expo prebuild`) requires a rebuild-and-reinstall
  before Maestro will produce a meaningful result; `expo prebuild --clean` alone does not rebuild or
  install.

For the BFF-container modes an agent/non-agent flow runs against once launched, see
[E2E testing](/openwiki/runbooks/e2e-testing.md). Full session-startup ritual, the CI trigger/watch
commands, and the complete Windows build-wall workaround recipe: `docs/runbooks/android-emulator.md`.
