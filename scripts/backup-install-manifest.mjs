#!/usr/bin/env node
// Regenerate or verify infrastructure-as-code/backup/INSTALLED.sha256 — the list the operator
// checks the prod host's installed backup against with `sha256sum -c` (spec 084 FR-004, R6).
//
// The host has no checkout of this repository, so a committed checksum list is the one artefact
// both sides can compute with coreutils. Each line is `<sha256>  <path relative to $HOME>`, the
// path the README's install block puts the file at, so the operator's check is a one-liner.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(REPO_ROOT, 'infrastructure-as-code/backup');
const MANIFEST = 'INSTALLED.sha256';

const USAGE = `usage: node scripts/backup-install-manifest.mjs --check | --write [--dir <backup-dir>]
  --check   exit 1, naming each file, if ${MANIFEST} disagrees with the directory
  --write   regenerate ${MANIFEST}
  --dir     the backup directory (default: infrastructure-as-code/backup)`;

/** Where the README's install block puts a file, relative to the prod user's $HOME. */
export function installPath(file) {
  if (/\.(service|timer)$/.test(file)) return `.config/systemd/user/${file}`;
  if (/\.(sh|sql)$/.test(file)) return `backup/${file}`;
  return null;
}

/** The manifest text the directory's installable files produce, sorted by install path. */
export function buildManifest(dir) {
  return readdirSync(dir)
    .map((f) => [f, installPath(f)])
    .filter(([, p]) => p)
    .map(([f, p]) => [createHash('sha256').update(readFileSync(join(dir, f))).digest('hex'), p])
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([h, p]) => `${h}  ${p}\n`)
    .join('');
}

/** Lines present on only one side, each prefixed `-` (committed only) or `+` (directory only). */
export function manifestDrift(committed, expected) {
  const a = new Set(committed.split('\n').filter(Boolean));
  const b = new Set(expected.split('\n').filter(Boolean));
  return [...[...a].filter((l) => !b.has(l)).map((l) => `- ${l}`), ...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l}`)];
}

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  const { flags, values } = partitionArgsWithValues(argv, {
    accepted: ['--check', '--write'],
    withValues: ['--dir'],
    usage: USAGE,
  });
  if (flags.size !== 1) throw new ArgvError(`exactly one of --check / --write is required\n\n${USAGE}`);
  const dir = values.get('--dir') ?? DEFAULT_DIR;
  const file = join(dir, MANIFEST);
  const expected = buildManifest(dir);

  if (flags.has('--write')) {
    writeFileSync(file, expected);
    console.log(`wrote ${file}`);
    return 0;
  }
  const committed = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const drift = manifestDrift(committed, expected);
  if (drift.length === 0) {
    console.log(`${MANIFEST} matches ${dir}`);
    return 0;
  }
  console.error(`${MANIFEST} is stale (- listed, + actual). Regenerate with --write:\n${drift.join('\n')}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    dieOnArgvError(err);
  }
}
