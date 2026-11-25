#!/usr/bin/env node
// Fail when the pnpm on PATH is not the version the root package.json `packageManager` names
// (item #1025).
//
// WHY THIS IS NEEDED. Since Node 26 removed corepack (item #992), pnpm 12 switches to the
// `packageManager` of the WORKSPACE IT OPERATES ON. A nested workspace (its own
// pnpm-workspace.yaml, such as tools/openwiki-generator) declares none, so `pnpm --dir <ws> …` runs
// on whichever pnpm is INSTALLED. The sast audit and the openwiki generator install both run that
// way. Measured 2026-11-15 on node:26.13.1-alpine3.23, with 12.17.0 installed and a root pin of
// 12.18.0: 12.18.0 at the repo root, 12.17.0 with `--dir tools/openwiki-generator`.
//
// WHY pnpm IS ASKED FROM A FRESH TEMP DIRECTORY. Asked inside the repository, pnpm self-switches to
// the pin and prints the PIN, so the check would pass no matter what is installed. That would be a
// check that cannot fail. An empty directory under the OS temp dir has no package.json above it, so
// pnpm reports its own version.
//
// Usage:
//   node scripts/check-pnpm-version.mjs                  # check against the root package.json
//   node scripts/check-pnpm-version.mjs path/to/package.json
// Exit: 0 match, 1 mismatch or no pnpm on PATH, 2 usage error (bad argument or packageManager).
// Runs after every install in scripts/install-pnpm.sh, and as its own CI step after that install.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/check-pnpm-version.mjs [path/to/package.json]

Fails (exit 1, with an ::error:: line) when \`pnpm --version\`, run outside any workspace, differs
from the packageManager version in the given package.json (default: the repository root's).
Inside the repository pnpm self-switches to the pin, so the check runs it from an empty temp dir.`;

/** The version in `packageManager: "pnpm@<version>"`, or throws with the reason. */
export function pinnedVersion(manifestPath) {
  const spec = JSON.parse(readFileSync(manifestPath, 'utf8')).packageManager ?? '';
  const m = /^pnpm@(\d+\.\d+\.\d+[^+\s]*)(\+.*)?$/.exec(spec);
  if (!m) throw new Error(`packageManager must be "pnpm@<version>", got "${spec}" in ${manifestPath}`);
  return m[1];
}

/** `pnpm --version` from a fresh empty directory, or null when no pnpm answers. */
export function installedVersion() {
  const dir = mkdtempSync(join(tmpdir(), 'pnpm-version-probe-'));
  try {
    const r = spawnSync('pnpm', ['--version'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim().split('\n').pop().trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  let positionals;
  try {
    ({ positionals } = partitionArgs(argv, { accepted: [], maxPositionals: 1, usage: USAGE }));
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return 2;
  }
  const manifest = resolve(positionals[0] ?? join(REPO_ROOT, 'package.json'));
  let pin;
  try {
    pin = pinnedVersion(manifest);
  } catch (err) {
    console.error(`check-pnpm-version: ${err.message}`);
    return 2;
  }
  const installed = installedVersion();
  if (installed === null) {
    console.log(`::error::no pnpm on PATH; packageManager pins pnpm ${pin}. Install it: sh scripts/install-pnpm.sh`);
    return 1;
  }
  if (installed !== pin) {
    console.log(
      `::error::pnpm on PATH is ${installed}, but packageManager pins ${pin}. ` +
        `Nested workspaces (pnpm --dir tools/openwiki-generator, the sast audit) would run on ${installed}. ` +
        'Reinstall: sh scripts/install-pnpm.sh',
    );
    return 1;
  }
  console.log(`check-pnpm-version: pnpm on PATH is ${installed}, matching packageManager`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
