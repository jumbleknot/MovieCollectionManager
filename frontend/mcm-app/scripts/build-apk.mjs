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
 * Optional env: APK_ABI (e.g. `x86_64`) restricts ABIs for a faster emulator build;
 * unset builds all ABIs (universal artifact).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(process.cwd()); // Nx sets cwd to projectRoot (frontend/mcm-app)
const androidDir = join(appRoot, 'android');
const isWin = process.platform === 'win32';

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}   (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`\n[build-apk] FAILED: ${cmd} ${args.join(' ')} (exit ${r.status ?? 'signal ' + r.signal})`);
    process.exit(r.status ?? 1);
  }
}

run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean'], appRoot);

const gradlew = isWin ? 'gradlew.bat' : './gradlew';
const gradleArgs = [':app:assembleDebug'];
if (process.env.APK_ABI) gradleArgs.push(`-PreactNativeArchitectures=${process.env.APK_ABI}`);
run(gradlew, gradleArgs, androidDir);

const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
console.log(
  existsSync(apk)
    ? `\n[build-apk] OK -> ${apk}`
    : `\n[build-apk] WARN: expected APK not found at ${apk}`,
);
