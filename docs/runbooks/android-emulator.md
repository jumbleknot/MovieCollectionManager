# Runbook: Android Emulator & APK Builds (Mobile E2E)

> Procedures for mobile E2E on this Windows 11 machine. Loaded on demand — referenced from CLAUDE.md. For the flakiness-diagnosis protocol and the BFF-container E2E modes, see [e2e-testing.md](e2e-testing.md).

## Mobile E2E approach — prefer CI for AGENT flows; local emulator for non-agent

**Decision rule (read this before running any mobile E2E):**

| Mobile flows | Where to run | Why |
|---|---|---|
| **Agent flows** (`agent-*.yaml`, `assistant-*.yaml` — anything that drives the dock → `/bff-api/agent/run`) | **CI: `android-e2e.yml`** (`gh workflow run android-e2e.yml`) | The local Windows path runs them against the **Metro dev server, which OOM-crashes after ~1–2 agent `/run` calls** (V8 heap dump in Metro's log → the app then shows a black screen / `status 0` "RN networking issue"). That instability — not the app — has burned entire sessions. The CI job removes Metro and Windows entirely. |
| **Non-agent flows** (login, collection/movie CRUD, sort, browse — no `/run`) | **Local emulator** (the ritual below) | These don't hit the agent route, don't hammer Metro, and iterate fast locally. |

**The CI job (`.github/workflows/android-e2e.yml`) is the supported harness for mobile agent E2E.**
It is **Metro-less**: it builds a **standalone embedded-bundle APK** (`APK_VARIANT=release` →
`pnpm nx run mcm-app:build-apk`, JS baked in, `EXPO_PUBLIC_BFF_NATIVE_URL=10.0.2.2:8082` inlined),
runs it against the **containerized dev BFF (:8082) + containerized production gateway + MCP**, on a
**Linux KVM emulator** (where `10.0.2.2` works — no `adb reverse`), and seeds fixtures by reusing
the web `global-setup`. Trigger: `gh workflow run android-e2e.yml --ref <branch>` (needs repo
secrets `ANTHROPIC_API_KEY`, `E2E_TEST_USER`, `E2E_TEST_PASSWORD`). Watch: `gh run watch <id>
--exit-status`; on failure it uploads the `maestro-debug` artifact (screenshots + hierarchy).
> Status: the workflow is committed but must go green once via `workflow_dispatch` before the
> `pull_request` trigger is uncommented (it has not yet had a successful CI run).

**If you must run an agent mobile flow locally (debugging the flow itself, not the app):** point the
app at the **dev-container BFF (:8082)** instead of Metro's BFF so the OOM-prone server is the
*container*, not Metro (Metro then only serves JS). And per the durable note below: **confirm Metro
`:8081`=200 AND restart Metro between agent-run batches** — a black screen or `status 0` almost
always means Metro died, not a code bug.

## Android emulator in the dev container (Linux KVM — feat devcontainer-android-emulator)

**The dev container now runs the emulator natively — no Windows host needed.** The full Android SDK
+ an `android-34` `google_apis` `x86_64` system image are **baked into the toolchain image**
(`.devcontainer/toolchain.Dockerfile`), so nothing downloads per-open (build-time fetch, before the
egress firewall exists — no `dl.google.com` allowlist entry, same model as the Rust/uv toolchains).
The privileged DinD dev container already exposes the host `/dev/kvm`, so the emulator boots with
hardware accel. Proven live 2026-07-22 (headless, `boot_completed=1`, API 34).

```bash
scripts/devcontainer-android.sh boot     # grant /dev/kvm + ensure AVD + headless boot + adb-reverse 8082/8099
pnpm nx e2e:mobile mcm-app               # or: scripts/maestro-run.sh tests/e2e/mobile/<flow>.yaml
scripts/devcontainer-android.sh status   # adb devices
scripts/devcontainer-android.sh stop     # kill the emulator
```

`postStartCommand` runs `devcontainer-android.sh` (no arg = **prepare**: grants `/dev/kvm` access +
creates the AVD) on every start — cheap and idempotent. The ~4 GB **boot** is on-demand (the `boot`
subcommand), not automatic, so a normal session pays nothing. On a host without nested KVM the
script no-ops cleanly (the emulator would be unusably slow — use CI).

**`adb reverse`, not `10.0.2.2`:** `boot` tunnels the dev BFF (`:8082`) + Keycloak (`:8099`) via
`adb reverse` because `10.0.2.2` is unreliable under nested-DinD (the same choice CI makes). Point
the app at the **containerized dev BFF (`:8082`)**, not Metro — see [e2e-testing.md](e2e-testing.md).

**Agent flows still prefer CI.** The [decision rule](#mobile-e2e-approach--prefer-ci-for-agent-flows-local-emulator-for-non-agent)
above is unchanged: the local emulator is for **non-agent** flows + the rare local agent-flow debug;
agent flows run in the `app-ci.yml` `app-e2e` job (local Metro OOM-crashes after ~1-2 `/run` calls).

## Android (Emulator) — Windows host

Use Maestro CLI for all Android UI testing. **(For agent flows, prefer the CI job above — this
local ritual is for non-agent flows and for the rare local agent-flow debug.)**

### Why `adb reverse` is required (not optional)

QEMU networking (10.0.2.2) is broken on this Windows 11/HyperV machine — the emulator cannot reach the host via the standard Android gateway. `adb reverse tcp:8081 tcp:8081` tunnels Metro through the ADB connection so `localhost:8081` inside the emulator routes to Metro on the host. This must be re-run after every emulator (re)start.

### Session startup ritual (mandatory order)

```powershell
# 1. Start emulator — -no-snapshot-load is critical; without it ADB sometimes
#    can't connect after a Windows reboot.
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Pixel_7-35 -no-snapshot-load
# Wait for the emulator to fully boot (home screen visible before continuing).

# 2. Establish ADB reverse tunnel (must repeat after every emulator start)
adb reverse tcp:8081 tcp:8081

# 3. Start Metro from frontend/mcm-app — NOT from repo root.
#    Starting from the repo root produces doubled-path errors:
#    e:\E:\Programming\VSCode\... — always cd first.
cd frontend/mcm-app
pnpm exec expo start --port 8081
# Add --reset-cache when the bundle is stale or after code changes.

# 4. Launch the app (triggers first Metro bundle compilation ~1-2 min)
adb shell am start -n com.grumpyrobot.mcmapp/.MainActivity
```

### Rebuilding the Android APK after a native change (RN/SDK upgrade, new native module)

**FIRST — do you even need to rebuild? (feature 012 lesson.)** The APK only needs rebuilding when the **native layer** changes: a native dependency in `frontend/mcm-app/package.json` (a module with android/iOS code or an `expo-module.config.json`), anything under `frontend/mcm-app/android/`, `app.json`, or an `expo prebuild`. **Pure JS/Metro changes never need a rebuild** — Metro serves the new JS bundle to the *installed* APK (TS, React/RN components, BFF routes, even a new pure-JS dep). A JS-only dep can still be checked: if its package ships no `android/`/`ios/` dir and no `expo-module.config.json`, autolinking adds nothing native. (012's CopilotKit was pure-JS at the app's usage — the whole integration was Metro-config + polyfills, see `specs/012-multi-agent-mvp/HANDOFF.md`.)

So before triggering a ~20 min CI build, check whether the **last successful CI APK is already native-compatible with HEAD**:

```bash
gh run list --workflow=android-apk.yml -L 5            # find the latest successful run-id + its commit
SHA=$(gh run view <run-id> --json headSha -q .headSha)
git diff "$SHA" HEAD -- frontend/mcm-app/package.json frontend/mcm-app/android frontend/mcm-app/app.json
#   EMPTY diff  → that artifact is native-identical to HEAD; SKIP the rebuild. Just download + install:
gh run download <run-id> -n app-debug-apk -D <dir>     # → app-debug.apk
adb install -r app-debug.apk
#   NON-EMPTY (native deps / android / app.json changed) → rebuild via one of the paths below.
```

**Supported build paths (feature 006) — when a rebuild IS needed:**

- **CI (recommended — use this for APKs):** the `android-apk` GitHub Actions workflow (`.github/workflows/android-apk.yml`) builds the APK on an `ubuntu-latest` runner (~20 min) and publishes it as the `app-debug-apk` artifact (universal/all-ABI debug APK, ~75 MB). A Linux runner has no Windows `CMAKE_OBJECT_PATH_MAX` wall, so it needs none of the workarounds below. **When:** after any native-layer change (Expo SDK/RN bump, new native module, `expo prebuild`) when you need an installable APK — and as the default over the local Windows build. **CI builds the APK only — it runs no test suites.**
  - **Trigger:** `gh workflow run android-apk.yml --ref <branch>` (or `workflow_dispatch` in the Actions UI), or it auto-runs on pushes touching `frontend/mcm-app/android/**`, `app.json`, `package.json`, `frontend/mcm-app/scripts/build-apk.mjs`, or the workflow file.
  - **Watch / download:** `gh run watch <run-id> --exit-status`; then `gh run download <run-id> -n app-debug-apk` → `app-debug.apk`. Install with `adb install -r app-debug.apk`.
  - **Disk-free step is REQUIRED, do not remove it:** the workflow frees ~10–15 GB of preinstalled toolchains before building. Without it the RN 0.85 C++ build (worklets/screens) + SDK/NDK + Gradle caches exhaust the runner disk and the build is **killed mid-compile** (no clean error, step stuck `in_progress`, job fails ~39 min in). This was hit and fixed during feature 006.
- **Local (Nx target):** `pnpm nx run mcm-app:build-apk` wraps `expo prebuild --platform android --clean` + `gradlew :app:assembleDebug` (cross-platform via `frontend/mcm-app/scripts/build-apk.mjs`; set `APK_ABI=x86_64` for an emulator-only build). On Windows this still hits the path wall below — use the wrapper next.
- **Local on Windows (path-wall wrapper — fragile fallback):** `scripts/build-apk-short-path.ps1` sets up the short-root + flat-`node_modules` recipe, invokes the Nx target, then **always reverts** (`-Install` also `adb install`s). This automates the manual recipe documented below. **Prefer CI** — this local path is slow and has hung mid-run; if you do run it, capture output to a file (not a buffered `Select-Object`) so a failure is visible, and verify `.npmrc`/node_modules are restored afterward (`git status .npmrc`; `pnpm install`).

Maestro launches the **installed APK** via `am start` — it does NOT rebuild. After anything that changes the native layer (an Expo SDK / React Native bump, adding a native module, `expo prebuild`), you MUST rebuild and reinstall the APK, or the old native binary runs against the new JS bundle and crashes at startup (e.g. SDK 55→56 produced a RedBox `ReferenceError: Property 'MessageQueue' doesn't exist` — old RN 0.83 bridge vs new RN 0.85 bridgeless JS). `expo prebuild --clean` + `gradlew clean` regenerate/clean native *source* but do not build or install — the build+install step is separate.

**Windows `CMAKE_OBJECT_PATH_MAX` (250) wall** — building RN ≥0.85 C++ modules (`react-native-worklets` via reanimated 4, `react-native-screens`) fails here with `ninja: error: manifest 'build.ninja' still dirty after 100 tries`. The real cause (visible higher in the log) is `CMake Warning … object file directory has NNN characters; maximum full path is 250`. CMake replicates the **full absolute source path** under the object dir, and this repo's path (`E:\Programming\VSCode\MovieCollectionManager`) + the deep pnpm layout (`node_modules/.pnpm/<pkg>@<ver>_<32-char-hash>/node_modules/<pkg>/Common/cpp/…`) overflows 250 (worst measured: 381 chars). Windows `LongPathsEnabled=1` does NOT help — the 250 cap is internal to CMake. Things that do NOT work: Metro `--reset-cache`, deleting `.cxx`, `-PreactNativeArchitectures=x86_64`, `pnpm virtual-store-dir-max-length` (only trimmed to ~293, and shortened store names break Metro/jest resolution).

**The build-only recipe that works** (short root + flat node_modules → object path 381 → ~187):

```powershell
# 1. Short build root via junction (no copy, no admin)
cmd /c 'mklink /J C:\m "E:\Programming\VSCode\MovieCollectionManager"'

# 2. Flat node_modules (no .pnpm/<hash>/node_modules doubling) — BUILD ONLY.
#    Add to root .npmrc, then install from the short root:
#      node-linker=hoisted
cd C:\m
pnpm install

# 3. Prebuild + build x86_64 (emulator ABI). With hoisted, invoke the root-hoisted
#    expo CLI explicitly (the per-project .bin/expo shim mis-resolves under hoisting):
cd C:\m\frontend\mcm-app
node C:\m\node_modules\expo\bin\cli prebuild --platform android --clean
cd android
./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64

# 4. Install on the running emulator
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 5. REVERT: remove `node-linker=hoisted` from .npmrc and reinstall from E:\ —
#    hoisted breaks Metro/jest module resolution (all unit suites fail to load).
cd E:\Programming\VSCode\MovieCollectionManager
pnpm install
```

After install, run Metro from `frontend/mcm-app` (default layout) and Maestro as usual. The `.npmrc` carries an abbreviated copy of this recipe.

> **`@expo/dom-webview` version pin (SDK 56):** a stale lockfile kept `@expo/dom-webview@55.0.6` even though `expo@56.0.8` declares `~56.0.5`. The SDK-55 native module crashes at launch under SDK-56 `expo-modules-core` with `java.lang.NoClassDefFoundError: expo/modules/kotlin/types/AnyTypeProvider` at `expo.modules.webview.DomWebViewModule`. Fix: a pnpm `overrides` entry `"@expo/dom-webview": "^56.0.5"` **plus deleting `pnpm-lock.yaml` and regenerating** (the override alone won't repropagate a poisoned transitive pin). This is harmless for web/JS (which is why web E2E stays green) but fatal for the native Android build.

### After `pm clear` / `clearState: true` in Maestro

`clearState: true` wipes the app's SharedPreferences, including the `debug_http_host` entry that tells React Native where Metro is. The app will fall back to QEMU 10.0.2.2 (unreachable) and show "open debugger to view warnings". Fix:

```powershell
adb shell am force-stop com.grumpyrobot.mcmapp
adb shell am start -n com.grumpyrobot.mcmapp/.MainActivity
```

On the next launch RN resolves `localhost:8081` correctly through the `adb reverse` tunnel — no Metro restart needed. The APK itself is unaffected; only SharedPreferences is cleared.

### Metro cache reset (if Metro was started from wrong directory)

```powershell
Get-Process -Name "node" | Stop-Process -Force
cd frontend/mcm-app
pnpm exec expo start --reset-cache --port 8081
```

Do **not** use `CI=1` with Expo CLI — `getenv.boolish()` requires `true`/`false`, not `1`/`0`.

### Running Maestro flows

- Flows live in `tests/e2e/mobile/` as `.yaml` files
- Run via Nx (preferred): `pnpm nx e2e:mobile mcm-app`
- Run a single flow: `scripts/maestro-run.sh tests/e2e/mobile/flow_name.yaml` (feature 027 — the wrapper hands the secrets to Maestro via `MAESTRO_`-prefixed env, sourced from `.env.e2e.local`, so no credential lands on the command line; add non-secret `--env COLLECTION_NAME=…` args after the flow path)
- Take a screenshot: `maestro screenshot`
- View device interactively: `maestro studio`
- Credentials for login flows: `frontend/mcm-app/.env.e2e.local` (gitignored)

Files prefixed with `_` (e.g., `_login-helper.yaml`) are reusable sub-flows. They are not standalone tests and will fail if run directly.

### MANUAL_FLOWS (session-timeout)

**MANUAL_FLOWS** (`session-timeout.yaml`, `session-timeout-absolute.yaml`) are excluded from the normal `e2e:mobile` run because they require Metro to be started with a special env var (`EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS`). Use the dedicated target:

```powershell
# 1. Enable the override in .env.local (uncomment the line)
# 2. Restart Metro with the override active
cd frontend/mcm-app && pnpm exec expo start --port 8081
# 3. Run the isolated target (validates .env.local before executing)
pnpm nx e2e:mobile:session-timeout mcm-app
# 4. Re-comment the line in .env.local and restart Metro
```

The web session-timeout tests (`tests/e2e/web/session-timeout.spec.ts`) use Playwright's fake clock (`page.clock.fastForward`) and do **not** need the env override — they run in the normal `pnpm nx e2e mcm-app` suite.
