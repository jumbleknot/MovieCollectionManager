#!/usr/bin/env node
/**
 * Builds the Android debug APK: `expo prebuild` (regenerate native project for the
 * current RN/SDK) then Gradle `:app:assembleDebug`. Invoked via the Nx target
 * `mcm-app:build-apk` (constitution: all build ops run through Nx).
 *
 * Cross-platform: win32 uses `gradlew.bat`, otherwise `./gradlew`.
 *
 * On Windows this hits the CMAKE_OBJECT_PATH_MAX (250) wall unless run from a short
 * build root — use `scripts/build-apk-short-path.ps1` (repo root) which sets that up,
 * calls this target, then reverts. On a Linux CI runner it builds directly (the 250
 * cap is Windows-only and the runner path is short).
 *
 * Optional env:
 *   APK_ABI       (e.g. `x86_64`) restricts ABIs for a faster emulator build; unset = all ABIs.
 *   APK_VARIANT   `debug` (default) | `release`. The DEBUG apk loads JS from Metro at runtime —
 *                 fine for interactive dev. The RELEASE apk EMBEDS the JS bundle (gradle runs
 *                 `bundleReleaseJsAndAssets`), so it is STANDALONE — no Metro — which is what the
 *                 android-e2e CI job needs (it talks to the containerized BFF, not Metro). Expo's
 *                 prebuild points the release signingConfig at the debug keystore, so the release
 *                 APK is signed + installable for testing without any extra secrets. `EXPO_PUBLIC_*`
 *                 env vars (BFF/Keycloak native URLs) are inlined into the bundle at THIS step, so
 *                 the caller must export them before invoking when targeting a non-default backend.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const appRoot = resolve(process.cwd()); // Nx sets cwd to projectRoot (frontend/mcm-app)
const androidDir = join(appRoot, 'android');
const isWin = process.platform === 'win32';

// `babel-preset-expo` inlines `process.env.EXPO_PUBLIC_*` into the bundle at TRANSFORM time, but the
// inlined VALUE is not part of Metro's transform-cache key — so on a persistent runner Metro keeps
// serving a stale transform (e.g. the 10.0.2.2 fallback that was inlined before the localhost env was
// added), silently baking the wrong backend URL into the release APK. `expo prebuild --clean` only
// cleans the native dirs, NOT this JS cache. Wipe the Metro caches so the CURRENT EXPO_PUBLIC_* env is
// re-inlined. (feature 023 CI mobile-login root cause — the login POST went to the 10.0.2.2 fallback.)
function clearMetroCaches() {
  const tmp = tmpdir();
  const cleared = [];
  try {
    for (const name of readdirSync(tmp)) {
      if (
        name === 'metro-cache' ||
        name.startsWith('metro-file-map') ||
        name.startsWith('metro-symbolicate') ||
        name.startsWith('haste-map')
      ) {
        rmSync(join(tmp, name), { recursive: true, force: true });
        cleared.push(name);
      }
    }
  } catch {
    /* best-effort — a missing/locked cache entry must not fail the build */
  }
  console.log(`[build-apk] cleared Metro caches in ${tmp}: ${cleared.length ? cleared.join(', ') : '(none found)'}`);
}

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}   (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`\n[build-apk] FAILED: ${cmd} ${args.join(' ')} (exit ${r.status ?? 'signal ' + r.signal})`);
    process.exit(r.status ?? 1);
  }
}

const variant = (process.env.APK_VARIANT || 'debug').toLowerCase();
if (variant !== 'debug' && variant !== 'release') {
  console.error(`[build-apk] invalid APK_VARIANT='${variant}' (expected 'debug' or 'release')`);
  process.exit(1);
}
const gradleTask = variant === 'release' ? ':app:assembleRelease' : ':app:assembleDebug';

if (variant === 'release') {
  // Release EMBEDS the bundle (bakes EXPO_PUBLIC_* URLs) — log what we're baking and defeat the
  // stale-cache trap. Debug loads JS live from Metro, so neither applies.
  console.log(
    `[build-apk] baking EXPO_PUBLIC_BFF_NATIVE_URL=${process.env.EXPO_PUBLIC_BFF_NATIVE_URL ?? '(unset)'} ` +
      `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=${process.env.EXPO_PUBLIC_KEYCLOAK_NATIVE_URL ?? '(unset)'}`,
  );
  clearMetroCaches();
}

run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean'], appRoot);

const gradlew = isWin ? 'gradlew.bat' : './gradlew';
const gradleArgs = [gradleTask];
if (process.env.APK_ABI) gradleArgs.push(`-PreactNativeArchitectures=${process.env.APK_ABI}`);
run(gradlew, gradleArgs, androidDir);

const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
if (!existsSync(apk)) {
  console.error(`\n[build-apk] WARN: expected APK not found at ${apk}`);
  process.exit(0);
}

// Copy to a human-friendly, traceable name alongside Gradle's app-<variant>.apk (which is KEPT so
// local installers / the maestro runner that expect it still work):
//   MovieCollectionManager-<version>-<variant>-<sha7>.apk
// version ← app.json; sha ← GITHUB_SHA (CI) else `git rev-parse --short` else 'local'.
function shortSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: appRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'local';
}
const version = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')).expo.version;
const friendly = `MovieCollectionManager-${version}-${variant}-${shortSha()}.apk`;
const friendlyPath = join(dirname(apk), friendly);
copyFileSync(apk, friendlyPath);
console.log(`\n[build-apk] OK (${variant}) -> ${apk}\n[build-apk] named copy -> ${friendlyPath}`);
