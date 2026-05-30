import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(dir, '..', '.env.e2e.local');

// Env vars read from .env.e2e.local (required unless already in process.env)
const envVars = {
  E2E_TEST_USER: process.env.E2E_TEST_USER,
  E2E_TEST_PASSWORD: process.env.E2E_TEST_PASSWORD,
  E2E_MOVIE_TITLE: process.env.E2E_MOVIE_TITLE,
  E2E_COLLECTION_NAME: process.env.E2E_COLLECTION_NAME,
};

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    if (key in envVars && !envVars[key]) envVars[key] = m[2].trim();
  }
}

if (!envVars.E2E_TEST_USER || !envVars.E2E_TEST_PASSWORD) {
  console.error('E2E_TEST_USER and E2E_TEST_PASSWORD must be set in .env.e2e.local');
  process.exit(1);
}

// Flows that require a non-default Metro env config (e.g. a short absolute-timeout
// override) and must be run in isolation with Metro restarted. See each file for
// manual invocation instructions.
// Flows that require Metro to be restarted with a non-default env config.
// Run them via: pnpm nx e2e:mobile:session-timeout mcm-app  (see scripts/maestro-session-timeout.mjs)
const MANUAL_FLOWS = new Set(['session-timeout.yaml', 'session-timeout-absolute.yaml']);

const flowsDir = resolve(dir, '..', 'tests/e2e/mobile');
const flows = readdirSync(flowsDir)
  .filter(f => f.endsWith('.yaml') && !f.startsWith('_') && !MANUAL_FLOWS.has(f))
  .sort()
  .map(f => resolve(flowsDir, f));

// Build --env args for all non-empty vars.
// Values with spaces must be quoted so the shell (shell: true) passes them
// as a single argument to maestro, e.g.: --env "KEY=value with spaces"
const envArgs = Object.entries(envVars)
  .filter(([, v]) => v)
  .flatMap(([k, v]) => {
    const arg = v.includes(' ') ? `"${k}=${v}"` : `${k}=${v}`;
    return ['--env', arg];
  });

const APP_ID = 'com.jumbleknot.mcmapp';
const cwd = resolve(dir, '..');

/**
 * Run an adb shell command synchronously, ignore errors.
 */
function adb(...args) {
  spawnSync('adb', ['shell', ...args], { stdio: 'inherit', shell: false });
}

/**
 * Sleep for N milliseconds using a blocking Windows ping.
 */
function sleep(ms) {
  const secs = Math.ceil(ms / 1000);
  // ping 127.0.0.1 -n (secs+1) pauses for ~secs seconds on Windows
  spawnSync('ping', ['127.0.0.1', '-n', String(secs + 1)], {
    stdio: 'ignore',
    shell: true,
  });
}

/**
 * Dismiss any ANR dialog that may be blocking the accessibility tree.
 *
 * On Android 15 / HyperV, several ANR dialog types can block Maestro:
 *
 *   1. "Process system isn't responding" — triggered by pm clear's heavy I/O
 *      stressing system_server on an already-loaded emulator.
 *   2. "mcm-app isn't responding" — triggered when the React Native JS engine
 *      takes >5 s to execute the Metro bundle after a fresh app launch (the UI
 *      thread is blocked during bundle evaluation).
 *   3. Other app ANRs (e.g., "Messages isn't responding") — unrelated apps
 *      that ANR under system load. Tapping "Wait" is always safe.
 *
 * The "Wait" button sits at approximately (540, 1367) on the Pixel 7 emulator
 * (1080×2400). Confirmed by `uiautomator dump` — button bounds [70,1304][1010,1430],
 * center = (540, 1367).
 *
 * If no ANR dialog is visible the tap lands in the lower portion of the login
 * screen (below the buttons) and is harmless.
 *
 * The 3-second sleep before tapping gives the ANR dialog time to appear:
 * Android's ANR threshold is 5 s, but HyperV emulators under load can show the
 * dialog within 2–3 s of heavy I/O or a blocked UI thread.
 */
function dismissAnrDialog() {
  sleep(3000); // give ANR dialog time to appear if it's going to
  adb('input', 'tap', '540', '1367');
  sleep(1000);
}

/**
 * Write the ReactNativeDevServerPreferences.xml SharedPref file directly into
 * the app's data directory so React Native uses `localhost:8081` (reachable via
 * the `adb reverse tcp:8081 tcp:8081` tunnel) instead of the default
 * `10.0.2.2:8081` (QEMU gateway, unreachable on this Windows 11/HyperV machine).
 *
 * Why this is necessary:
 *   `pm clear` wipes all SharedPreferences, including `debug_http_host`. Without
 *   this preference, React Native falls back to 10.0.2.2:8081 on every launch and
 *   the double-launch workaround does NOT help — both launches use the QEMU
 *   address. Direct write is the only reliable fix on HyperV.
 *
 * Mechanism:
 *   1. Write the XML locally (UTF-8, no BOM — Node.js default) to a host temp file.
 *   2. Push via `adb push` to /data/local/tmp/ (world-readable, app can't write here).
 *   3. Copy into the app's private shared_prefs/ via `run-as` (executes as the app's
 *      UID so SELinux allows the write).
 *
 * This must be called AFTER `pm clear` (which would wipe the file) and BEFORE
 * the app is launched.
 */
function writeMetroSharedPref() {
  const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="debug_http_host">localhost:8081</string>\n</map>\n`;
  const tmpFile = resolve(tmpdir(), 'rn_metro_pref.xml');
  writeFileSync(tmpFile, xml, { encoding: 'utf8' }); // utf8 = no BOM

  // Push to a world-readable staging location, then copy as the app user.
  spawnSync('adb', ['push', tmpFile, '/data/local/tmp/rn_metro_pref.xml'], {
    stdio: 'inherit',
    shell: false,
  });
  spawnSync(
    'adb',
    [
      'shell',
      `run-as ${APP_ID} sh -c 'mkdir -p /data/data/${APP_ID}/shared_prefs && cp /data/local/tmp/rn_metro_pref.xml /data/data/${APP_ID}/shared_prefs/ReactNativeDevServerPreferences.xml'`,
    ],
    { stdio: 'inherit', shell: false },
  );
}

/**
 * Dismiss ANR dialogs every 5 s for 35 s after app launch.
 *
 * Why NOT use `uiautomator dump` or logcat parsing to detect readiness:
 *   `uiautomator dump` takes over the accessibility service and evicts the
 *   Maestro driver process (tcp:7001), causing UNAVAILABLE gRPC errors on
 *   Maestro's first UI assertion.  Instead we use a fixed-time tap loop that
 *   dismisses any ANR (tap is harmless when no dialog is showing) and ensures
 *   the 10–20 s JS-engine ANR window is fully covered before returning.
 *
 * Timing:
 *   7 rounds × (3 s sleep + tap + 2 s sleep) = 35 s total.
 *   Metro warm-cache cold-start takes ~15 s → ~20 s of surplus coverage.
 *   Each tap at (540, 1367) dismisses the Wait button on any ANR dialog; if
 *   no dialog is visible the tap lands below the login-screen buttons and is
 *   harmless.
 */
function waitForLoginScreen() {
  const rounds = 7; // 7 × 5 s ≈ 35 s — covers JS engine ANR window on HyperV
  for (let i = 0; i < rounds; i++) {
    sleep(3000);
    adb('input', 'tap', '540', '1367'); // dismiss ANR if present, harmless otherwise
    sleep(2000);
  }
}

/**
 * Prepare the app for a fresh test flow:
 *
 * 0. Dismiss any lingering ANR from the previous flow. OAuth auth-callback
 *    processing or other heavy work in the prior flow can leave a "Process
 *    system isn't responding" dialog that would block pm clear's adb commands
 *    from being visible to Maestro in the next flow.
 * 1. Kill Pixel Launcher BEFORE pm clear. pm clear's heavy I/O freezes
 *    com.google.android.apps.nexuslauncher on Android 15/HyperV, producing an
 *    ANR dialog. hide_error_dialogs does NOT suppress it on Android 15. Killing
 *    the launcher first prevents the freeze; the system restarts it automatically
 *    after pm clear completes.
 * 2. Stop the app and clear all its state (pm clear).
 * 3. Write ReactNativeDevServerPreferences.xml IMMEDIATELY after pm clear and
 *    BEFORE any tap — so if dismissAnrDialog() below causes the app to resume
 *    early it already has the correct Metro host (localhost:8081, not the
 *    default unreachable QEMU 10.0.2.2). The double-launch workaround does NOT
 *    work on this HyperV machine — both launches always use the QEMU address.
 * 4. Dismiss system ANR that pm clear may have triggered (tap after pref write).
 * 5. Launch the app; tap (540,1367) every 5 s for 35 s to dismiss ANRs that
 *    appear during Metro bundle download + JS engine cold-start (10–20 s on
 *    HyperV).  Taps on an empty screen area are harmless.
 *
 * After this function returns the app is running and showing the login screen.
 * Maestro flows MUST therefore use `clearState: false` — state was already cleared
 * here; a second `pm clear` would wipe the SharedPref we just wrote.
 */
function prepareApp() {
  console.log(`[maestro-e2e] Preparing app for fresh test...`);

  // Step 0: dismiss any lingering ANR from the previous flow before touching
  // the launcher or running pm clear.
  dismissAnrDialog();

  // Step 1: kill Pixel Launcher before pm clear to prevent launcher ANR.
  adb('am', 'force-stop', 'com.google.android.apps.nexuslauncher');
  sleep(500);

  // Step 2: clear app state.
  adb('am', 'force-stop', APP_ID);
  sleep(500);
  adb('pm', 'clear', APP_ID);

  // Step 3: write the Metro host SharedPref BEFORE any tap that could resume
  // the app.  If pm clear stressed the system and an ANR dialog is showing for
  // com.jumbleknot.mcmapp itself, the dismissAnrDialog() tap below would make
  // the app resume.  Writing the pref first ensures that even if the app
  // resumes early it will connect to localhost:8081 (not the default QEMU
  // 10.0.2.2 which pm clear wiped the pref for).
  writeMetroSharedPref();

  // Step 4: dismiss system ANR if pm clear stressed system_server.
  // This tap is safe to call now that the SharedPref is already written.
  dismissAnrDialog();

  // Step 5: launch and tap every 5 s for 35 s to dismiss any ANR dialogs that
  // appear while Metro downloads and the JS engine evaluates the bundle.
  adb('am', 'start', '-n', `${APP_ID}/.MainActivity`);
  waitForLoginScreen();

  console.log(`[maestro-e2e] App ready.`);
}

// Run each flow individually so we can prepare the app between flows.
const failures = [];

for (const flow of flows) {
  const name = basename(flow, '.yaml');
  console.log(`\n[maestro-e2e] ── Running flow: ${name} ──`);

  prepareApp();

  const result = spawnSync(
    'maestro',
    ['test', flow, ...envArgs],
    { stdio: 'inherit', cwd, shell: true },
  );

  if (result.status !== 0) {
    failures.push(name);
    console.error(`[maestro-e2e] FAILED: ${name}`);
  } else {
    console.log(`[maestro-e2e] PASSED: ${name}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[maestro-e2e] ${failures.length} flow(s) failed: ${failures.join(', ')}`);
  process.exit(1);
} else {
  console.log(`\n[maestro-e2e] All ${flows.length} flows passed.`);
  process.exit(0);
}
