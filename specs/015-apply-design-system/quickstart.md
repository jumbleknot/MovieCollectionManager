# Quickstart: Apply MCM Cinema Design System

How to wire in the design system and verify each user story on web + Android. Shell is PowerShell;
all task running is Nx-first. **This is a UI-only re-skin — no backend/BFF changes.**

## 0. One-time wiring (the integration foundation — US1 prerequisite)

1. **Add the package to the workspace** — `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - 'frontend/*'
     - 'packages/*'      # ADD
   ```
2. **Add deps to `frontend/mcm-app/package.json`** and install (pnpm only):
   ```powershell
   cd frontend/mcm-app
   npx expo install tamagui @tamagui/core @tamagui/config react-native-svg `
     expo-font @expo-google-fonts/outfit @expo-google-fonts/inter `
     @react-native-async-storage/async-storage
   # add "@mcm/design-system": "workspace:*" to dependencies, then from repo root:
   cd ../.. ; pnpm install
   ```
3. **Root `tamagui.config.ts`** in `frontend/mcm-app/` re-exporting the package config:
   ```ts
   export { default } from '@mcm/design-system/tamagui.config'
   ```
4. **Wrap the app** in `frontend/mcm-app/src/app/_layout.tsx`: keep `@/assistant-polyfills` first,
   then gate on `useFonts({ Outfit…, Inter… })`, then
   `<TamaguiProvider config defaultTheme={theme}>` (driven by the `use-theme` hook) as the outermost
   wrapper around the existing `SafeAreaProvider/AuthProvider/UiState/AssistantDataSync/Stack`.
   **Do NOT add the Tamagui babel/metro plugins** (runtime-only — research R1).
5. **Register the package with Nx** — `packages/design-system/project.json` with `lint` + `test`
   targets; verify:
   ```powershell
   pnpm nx lint design-system
   pnpm nx test design-system
   ```

## 1. Run the app

```powershell
# Web (fast inner loop)
cd frontend/mcm-app ; pnpm start     # press w

# Android (emulator ritual — adb reverse required on this machine)
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Pixel_7-35 -no-snapshot-load -gpu swiftshader_indirect
adb reverse tcp:8081 tcp:8081
cd frontend/mcm-app ; pnpm exec expo start --port 8081
adb shell am start -n com.grumpyrobot.mcmapp/.MainActivity
```

> **APK rebuild needed for mobile (research R4):** `react-native-svg` + `async-storage` are native
> modules → the embedded-bundle APK must be rebuilt before Maestro runs. Prefer CI
> `gh workflow run android-apk.yml --ref 015-apply-design-system`; install with `adb install -r`.
> Web needs no rebuild.

## 2. Verify by user story

### US1 — Cinematic browse foundation (P1)
- Log in; confirm **dark theme by default**, Outfit titles / Inter body, Cinematic-Blue app bar.
- Home: collections render as DS cards. Open a collection.
- **Web**: movie list is the DS data table — count + orange "Add movie" toolbar, Outfit uppercase
  headers with a primary bottom-border, hover row highlight; a media↔quality mismatch row shows an
  orange badge while matching rows stay neutral.
- **Android**: same data as DS card/row list (no wide table).
- Behaviour gate: sort / filter / column-visibility / open-movie still work.

### US2 — Forms, inputs, controls (P2)
- Create-collection, add-movie, edit-movie, login, register: DS `TextField` (floating label,
  supporting/error), DS `Button` variants, DS `SearchBar`/`Chip`/`Switch`, DS `Dialog` for
  delete/logout. Validation outcomes unchanged.

### US3 — Grumpy Robot assistant (P3)
- Open the dock: Grumpy Robot `AssistantAvatar` (thinking animation), DS chat bubbles, `ApprovalBubble`
  for HITL, `Snackbar` result, restyled composer. Agent run + approval behaviour unchanged.

### US4 — Dark/light theming (P4)
- First launch = dark. Toggle to light (AppBar/profile control); every screen renders correctly in
  light. Reload (web) / relaunch (mobile) → choice persists (`mcm.theme`).

## 3. Test gates (run via Nx)

```powershell
pnpm nx lint design-system ; pnpm nx test design-system      # hardened DS package (FR-021)
pnpm nx lint mcm-app
pnpm nx test mcm-app                                          # unit ≥70%
pnpm exec tsc --noEmit                                        # types (from frontend/mcm-app)
pnpm nx e2e mcm-app                                           # web E2E — MUST stay green (SC-002)
pnpm nx e2e:mobile mcm-app                                    # mobile E2E — MUST stay green
```

Final web E2E against the dev BFF container (deterministic baseline, ~54 s) after rebuilding the
image, per the project protocol:

```powershell
pnpm nx docker-build mcm-app
docker compose --profile bff-dev up -d
$env:E2E_BFF_TARGET="dev-container" ; pnpm nx e2e mcm-app
```

Visual acceptance: manual review / screenshots at each story checkpoint (no pixel-snapshot infra —
clarified). Confirm the orange-accent budget (≤3–4 sanctioned elements/screen) on each screen.

## 4. Watch-outs (from research + repo history)

- **Selectors are a contract** — never rename a `testID`; DS components must forward
  `testID`/`accessibilityLabel` (see contracts/ui-contracts.md). A removed selector = red E2E.
- **Runtime-only Tamagui** — don't add the babel/metro plugins (protects the fragile Windows Android
  build + existing segment shim / worklets plugin).
- **No flash-of-wrong-theme** — dark is the default initial render; only a stored `light` corrects
  after async read.
- **Diagnose E2E flakes by evidence, not "the machine"** — use the dev-container deterministic
  baseline to decide flaky-vs-broken before blaming Metro/emulator.
- **Rebuild the BFF image before the container E2E**, and the APK before mobile E2E — a stale image
  validates nothing.
