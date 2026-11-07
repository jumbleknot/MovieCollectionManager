#!/usr/bin/env node
// Feature 087 (US4 scenario 7) — publish the Android launch check's result as a commit status.
//
// WHY THIS EXISTS. tasks.md must quote launch results with run numbers, and a pass has no other channel:
// failure digests publish only on failure, and this forge has no log or artifact API. So the only
// source for "it launched" would be a person reading a log page.
//
// WHY A FILE. The check runs inside the emulator action's `script:`, which cannot export step outputs,
// so scripts/android-launch-smoke.sh writes `$HOME/android-launch-$GITHUB_RUN_ID.json`. The run ID in the
// name means a persistent runner cannot serve a stale result, and this script deletes the file once read.
//
// WHY A SCRIPT RATHER THAN INLINE SHELL: the mapping below is a decision, and a decision in inline
// shell can only be tested by a regexp over the workflow (the lesson in publish-sweep-verdict.mjs).
//
// THIS STATUS CANNOT GATE ANYTHING. It is not a required context, and the check's own exit code is
// what blocks. So this always exits 0 when its arguments are valid: a bookkeeping POST must never mask
// or replace the real result.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ArgvError, dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';

/** The context this publishes under. */
export const CONTEXT = 'app-ci / android-launch';

const USAGE = [
  'usage: node scripts/publish-android-launch.mjs',
  '',
  '  Reads $HOME/android-launch-$GITHUB_RUN_ID.json and posts the commit status app-ci / android-launch.',
  '  --help   print this and exit',
].join('\n');

/** Where the launch check wrote its result. */
export function resultFilePath(env) {
  return join(env.HOME ?? '', `android-launch-${env.GITHUB_RUN_ID ?? 'local'}.json`);
}

const NOT_RUN = {
  state: 'failure',
  description: 'launch=not-run login-screen=absent fatal=unknown',
};

/**
 * Map a parsed result file to the status to publish.
 *
 * Success requires all three checks, spelled exactly. Absent or malformed means the emulator step never
 * finished the check, which is a failure and a different fact from "the checks failed". Only known
 * values reach the description, so nothing from the file is ever published.
 *
 * @param {unknown} result the parsed file, or null when it was absent or unreadable
 * @returns {{state:'success'|'failure', description:string}}
 */
export function launchStatusFor(result) {
  if (result === null || typeof result !== 'object') return NOT_RUN;
  const { launch, loginScreen, fatal } = result;
  const knownValues =
    (launch === 'ok' || launch === 'failed') &&
    (loginScreen === 'visible' || loginScreen === 'absent') &&
    Number.isInteger(fatal) &&
    fatal >= 0;
  if (!knownValues) return NOT_RUN;
  const passed = launch === 'ok' && loginScreen === 'visible' && fatal === 0;
  return {
    state: passed ? 'success' : 'failure',
    description: `launch=${launch} login-screen=${loginScreen} fatal=${fatal}`,
  };
}

/** Read and delete the result file. Null when it is absent or is not JSON. */
function takeResult(path) {
  if (!existsSync(path)) return null;
  let result = null;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    result = null;
  }
  rmSync(path, { force: true });
  return result;
}

async function main(env) {
  // A superseded run is not a failed launch. The job status is the only way to tell them apart here,
  // because a cancelled emulator step also leaves no result file.
  if (env.MEASURED_JOB_STATUS === 'cancelled') {
    console.log('[android-launch] job.status=cancelled — superseded run. Publishing nothing.');
    return;
  }
  const status = launchStatusFor(takeResult(resultFilePath(env)));
  console.log(`[android-launch] state=${status.state} ${status.description}`);

  const server = (env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '');
  const repository = env.GITHUB_REPOSITORY ?? '';
  const sha = env.GITHUB_SHA ?? '';
  const token = env.GITHUB_TOKEN ?? '';
  if (!server || !repository || !sha || !token) {
    console.error('[android-launch] missing GITHUB_SERVER_URL/REPOSITORY/SHA/TOKEN — publishing nothing.');
    return;
  }
  const res = await fetch(`${server}/api/v1/repos/${repository}/statuses/${sha}`, {
    method: 'POST',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: CONTEXT, state: status.state, description: status.description }),
    signal: AbortSignal.timeout(Number(env.CI_HTTP_TIMEOUT_MS) || 30000),
  });
  if (!res.ok) {
    console.error(`[android-launch] POST → ${res.status}; the status was not published.`);
    return;
  }
  console.log(`[android-launch] published ${CONTEXT} = ${status.state}`);
}

/** What this invocation asks for. An unrecognised argument throws, before anything is read or posted. */
export function resolveCommand(argv) {
  if (wantsHelp(argv)) return 'help';
  partitionArgs(argv, { accepted: [], usage: USAGE });
  return 'publish';
}

if ((process.argv[1] ?? '').endsWith('publish-android-launch.mjs')) {
  let command;
  try {
    command = resolveCommand(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgvError)) throw err;
    dieOnArgvError(err, { hard: false });
    process.exit(2);
  }
  if (command === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  main(process.env).catch((err) => console.error(`[android-launch] FAILED: ${err.message}`));
}
