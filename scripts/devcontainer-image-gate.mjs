#!/usr/bin/env node
// Decide whether a `devcontainer-image` run must build, or can stop after checkout.
//
// WHY THIS EXISTS. toolchain.Dockerfile installs pnpm at the root package.json `packageManager`
// (scripts/install-pnpm.sh). The workflow's `paths:` filter listed only the Dockerfiles and itself,
// so a Renovate pnpm bump — which edits package.json and nothing else that filter names — published
// no new image. The image kept the OLD pnpm until the Friday cron, and anything asking pnpm for its
// version outside the workspace saw the mismatch: 2026-11-20 17:43 bumped 12.20.0 → 12.21.0, 11 h
// AFTER that Friday's 06:00 build, and check-pnpm-version's "installed pnpm is the root pin" test
// failed in the sandbox dev container for the following week.
//
// WHY A GATE AND NOT JUST `paths: package.json`. package.json changes on most dependency bumps, and
// this is a 60-minute build on the capacity-1 runner. Path filters cannot look inside a file, so the
// workflow triggers on package.json and this script lets it build only when the `packageManager`
// line itself moved. Every other trigger (dispatch, the cron, an image input changing) builds.
//
// FAIL-SAFE: anything this script cannot establish — no `before` sha (a new branch pushes the zero
// sha), a `before` not in the clone, a package.json that does not parse — decides BUILD. A spurious
// build costs an hour of runner time; a missed one ships a stale toolchain for a week.
//
// Usage (in the workflow; reads GITHUB_EVENT_NAME, GATE_BEFORE, GITHUB_SHA, writes GITHUB_OUTPUT):
//   node scripts/devcontainer-image-gate.mjs
// Exit: 0 decided (build=true|false written), 2 usage error.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE = `Usage: node scripts/devcontainer-image-gate.mjs

Writes build=true|false to $GITHUB_OUTPUT. Reads GITHUB_EVENT_NAME, GATE_BEFORE (the push's
\`before\` sha) and GITHUB_SHA. Builds on any non-push event, on a change to an image input, or when
the root package.json \`packageManager\` value differs between GATE_BEFORE and GITHUB_SHA.`;

/** Files whose change always means the image is different. Mirror of the workflow's `paths:`. */
export const IMAGE_INPUTS = [
  '.devcontainer/toolchain.Dockerfile',
  '.devcontainer/Dockerfile',
  '.forgejo/workflows/devcontainer-image.yml',
  'scripts/install-pnpm.sh',
  'scripts/devcontainer-image-gate.mjs',
];

const ZERO_SHA = /^0+$/;

/**
 * Pure decision. `changedFiles` / `pmBefore` / `pmAfter` may be `undefined` when they could not be
 * read; an unknown is a reason to build, never a reason to skip.
 * @returns {{build: boolean, reason: string}}
 */
export function decide({ event, before, changedFiles, pmBefore, pmAfter }) {
  if (event !== 'push') return { build: true, reason: `event is ${event || 'unknown'}, not push` };
  if (!before || ZERO_SHA.test(before)) return { build: true, reason: 'no previous commit to compare (new branch?)' };
  if (!changedFiles) return { build: true, reason: `could not diff against ${before}` };
  const input = changedFiles.find((f) => IMAGE_INPUTS.includes(f));
  if (input) return { build: true, reason: `image input changed: ${input}` };
  if (!changedFiles.includes('package.json')) return { build: false, reason: 'no image input and no package.json change' };
  if (pmBefore === undefined || pmAfter === undefined) return { build: true, reason: 'could not read packageManager on both sides' };
  if (pmBefore !== pmAfter) return { build: true, reason: `packageManager moved: ${pmBefore || '(none)'} -> ${pmAfter || '(none)'}` };
  return { build: false, reason: `package.json changed but packageManager is unchanged (${pmAfter})` };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** packageManager of the root package.json at `rev`, '' if absent, undefined if unreadable. */
export function packageManagerAt(rev, read = git) {
  try {
    return JSON.parse(read(['show', `${rev}:package.json`])).packageManager ?? '';
  } catch {
    return undefined;
  }
}

function gather(env) {
  const event = env.GITHUB_EVENT_NAME ?? '';
  const before = env.GATE_BEFORE ?? '';
  const after = env.GITHUB_SHA || 'HEAD';
  let changedFiles;
  if (event === 'push' && before && !ZERO_SHA.test(before)) {
    try {
      changedFiles = git(['diff', '--name-only', before, after]).split('\n').filter(Boolean);
    } catch {
      changedFiles = undefined;
    }
  }
  const needPm = changedFiles?.includes('package.json');
  return {
    event,
    before,
    changedFiles,
    pmBefore: needPm ? packageManagerAt(before) : undefined,
    pmAfter: needPm ? packageManagerAt(after) : undefined,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  try {
    partitionArgs(argv, { accepted: [], usage: USAGE });
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return 2;
  }
  const { build, reason } = decide(gather(env));
  console.log(`devcontainer-image-gate: build=${build} — ${reason}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `build=${build}\n`);
  if (!build) console.log('::notice::devcontainer-image skipped — nothing the image is built from changed');
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
