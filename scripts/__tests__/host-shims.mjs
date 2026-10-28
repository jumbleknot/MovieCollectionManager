// A fake prod host for suites that run the backup scripts (spec 084 T003).
//
// NOT named `*.test.mjs`, for the reason shell-probe.mjs gives: the guardrails glob would collect it.
//
// The scripts under infrastructure-as-code/backup/ drive docker, restic, curl and systemctl on a
// host no test can reach. Each of those becomes a shim first on PATH that appends its argv to
// `calls.jsonl` and answers from a fixture, so a suite asserts on WHAT the script asked the host
// to do, and every failure path can be induced. Anything not shimmed (bash, python3, tar, gzip,
// stat…) is the real tool, so format checks run against real files.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SHIMS = ['docker', 'restic', 'curl', 'systemctl'];

// Runs inside each shim. A fixture matches when every `match` string occurs in the space-joined
// argv; the first match answers. An `@file` argument is captured as data unless it follows -H /
// --header: that is how a token reaches curl, and recording it would put the secret in the log.
// An absolute directory argument is captured with its file sizes (and any dump-manifest.tsv, and the
// listing of any *.tar), because backup.sh deletes its staging dir on exit: what restic was handed
// is otherwise gone.
const RUNNER = String.raw`
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [cmd, ...argv] = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync(process.env.SHIM_FIXTURES, 'utf8'));
const dataFiles = {};
const dirs = {};
const manifests = {};
const tars = {};
argv.forEach((a, i) => {
  if (a.startsWith('/') && existsSync(a) && statSync(a).isDirectory()) {
    dirs[a] = Object.fromEntries(readdirSync(a).map((f) => [f, statSync(join(a, f)).size]));
    if (existsSync(join(a, 'dump-manifest.tsv'))) manifests[a] = readFileSync(join(a, 'dump-manifest.tsv'), 'utf8');
    for (const f of readdirSync(a).filter((f) => f.endsWith('.tar'))) {
      try {
        tars[join(a, f)] = execFileSync('tar', ['-tf', join(a, f)], { encoding: 'utf8' }).split('\n').filter(Boolean);
      } catch {
        tars[join(a, f)] = null;
      }
    }
  }
  if (!a.startsWith('@') || ['-H', '--header'].includes(argv[i - 1])) return;
  const p = a.slice(1);
  if (existsSync(p)) dataFiles[p] = readFileSync(p, 'utf8');
});
appendFileSync(process.env.SHIM_CALLS, JSON.stringify({ cmd, argv, dataFiles, dirs, manifests, tars }) + '\n');
const joined = argv.join(' ');
const f = fixtures.find((x) => x.cmd === cmd && (x.match ?? []).every((m) => joined.includes(m))) ?? {};
if (f.stdoutFile) process.stdout.write(readFileSync(f.stdoutFile));
if (f.stdout) process.stdout.write(f.stdout);
if (f.stderr) process.stderr.write(f.stderr);
process.exitCode = f.exit ?? 0;
`;

/**
 * @param {{ fixtures?: object[], shims?: string[] }} [opts]
 * @returns {{ root: string, home: string, bin: string, env: object,
 *   run: (script: string, args?: string[], extraEnv?: object) => import('node:child_process').SpawnSyncReturns<string>,
 *   calls: () => {cmd: string, argv: string[], dataFiles: object, dirs: object, manifests: object, tars: object}[], rawCalls: () => string,
 *   setFixtures: (fixtures: object[]) => void }}
 */
export function makeShimEnv({ fixtures = [], shims = DEFAULT_SHIMS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'host-shims-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const d of [bin, join(home, 'backup/state'), join(home, '.config/systemd/user')]) {
    mkdirSync(d, { recursive: true });
  }
  const runner = join(root, 'shim-runner.mjs');
  const fixturesFile = join(root, 'fixtures.json');
  const callsFile = join(root, 'calls.jsonl');
  writeFileSync(runner, RUNNER);
  writeFileSync(callsFile, '');
  const setFixtures = (f) => writeFileSync(fixturesFile, JSON.stringify(f));
  setFixtures(fixtures);
  for (const name of shims) {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\nexec "${process.execPath}" "${runner}" "${name}" "$@"\n`);
    chmodSync(p, 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    SHIM_FIXTURES: fixturesFile,
    SHIM_CALLS: callsFile,
  };
  const rawCalls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '');
  return {
    root,
    home,
    bin,
    env,
    setFixtures,
    rawCalls,
    calls: () => rawCalls().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    run: (script, args = [], extraEnv = {}) =>
      spawnSync('bash', [script, ...args], { cwd: home, env: { ...env, ...extraEnv }, encoding: 'utf8' }),
  };
}
