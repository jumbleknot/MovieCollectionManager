#!/usr/bin/env node
// Refresh a derived openwiki page after its source changed — the coding session's tool (feature 098,
// contracts/wiki-refresh-cli.md, skill `.claude/skills/wiki-refresh/SKILL.md`).
//
// Offline, model-free, credential-less. `--stale` and the OKF gate's V17 call the same function
// (staleDerivedPages), so the tool and the required check cannot disagree (FR-009). Unknown
// arguments are REJECTED through scripts/lib/argv-contract.mjs: a mis-typed flag must never turn
// into a write.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { partitionArgs, wantsHelp, dieOnArgvError, ArgvError } from './lib/argv-contract.mjs';
import {
  FINGERPRINT_FIELD,
  fingerprintBytes,
  derivedPages,
  readDerivedPage,
  recordSourceFingerprint,
  staleDerivedPages,
  staleReason,
} from './openwiki-fingerprint.mjs';
import { conceptStamp } from './openwiki-stamp.mjs';
import { sourceCommitAfterStamp } from './openwiki-drift.mjs';

const USAGE = `Usage: node scripts/wiki-refresh.mjs <command>

  --stale [--json]            list every derived page that is not fresh (exit 1 if any)
  --diff <page>               the source's change since the page was last recorded
  --record <page> [<page>…]   record the page's source fingerprint (front matter only)
  --record --all-fresh        cut-over only: record every page whose stamp is newer than its
                              source's last commit; refuses if any is not
  --help                      this text

<page> is a path from the repository root (openwiki/runbooks/x.md) or from openwiki/ (runbooks/x.md).
Procedure: --stale, then per page --diff, edit only what the diff invalidates, then --record.`;

const ACCEPTED = ['--stale', '--json', '--diff', '--record', '--all-fresh', '--help', '-h'];

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

class UsageError extends Error {}

function parse(argv) {
  const { flags, positionals } = partitionArgs(argv, { accepted: ACCEPTED, maxPositionals: Infinity, usage: USAGE });
  const commands = ['--stale', '--diff', '--record'].filter((f) => flags.has(f));
  if (commands.length !== 1) throw new ArgvError(`exactly one of --stale, --diff, --record is required\n\n${USAGE}`);
  const [command] = commands;
  if (flags.has('--json') && command !== '--stale') throw new ArgvError(`--json applies only to --stale\n\n${USAGE}`);
  if (flags.has('--all-fresh') && command !== '--record') throw new ArgvError(`--all-fresh applies only to --record\n\n${USAGE}`);
  if (command === '--stale' && positionals.length) throw new ArgvError(`--stale takes no page\n\n${USAGE}`);
  if (command === '--diff' && positionals.length !== 1) throw new ArgvError(`--diff takes exactly one page\n\n${USAGE}`);
  if (command === '--record') {
    if (flags.has('--all-fresh') && positionals.length) throw new ArgvError(`--all-fresh takes no page\n\n${USAGE}`);
    if (!flags.has('--all-fresh') && positionals.length === 0) throw new ArgvError(`--record needs a page (or --all-fresh)\n\n${USAGE}`);
  }
  return { command, json: flags.has('--json'), allFresh: flags.has('--all-fresh'), pages: positionals };
}

/** Resolve a page argument to a derived page, or throw a UsageError (exit 2). */
function resolvePage(root, arg) {
  const candidates = isAbsolute(arg) ? [arg] : [resolve(root, arg), resolve(root, 'openwiki', arg)];
  const abs = candidates.find((c) => existsSync(c));
  if (!abs) throw new UsageError(`${arg}: no such page`);
  const p = readDerivedPage(abs, { root });
  if (p === null) throw new UsageError(`${arg}: not a derived page (no file \`resource\`) — canonical pages are hand-maintained and carry no fingerprint`);
  return p;
}

// ── --stale ─────────────────────────────────────────────────────────────────────

function cmdStale(root, json) {
  const stale = staleDerivedPages({ root });
  if (json) console.log(JSON.stringify({ stale }));
  else for (const s of stale) console.log(`${s.page} ← ${s.resource}  (${s.reason})`);
  return stale.length > 0 ? 1 : 0;
}

// ── --diff ──────────────────────────────────────────────────────────────────────

/** `[{commit, path}]` newest first, following renames of the resource. */
function resourceHistory(root, resource, extra = []) {
  const r = git(root, ['log', '--follow', '--format=%x00%H', '--name-only', ...extra, '--', resource]);
  if (r.status !== 0) return [];
  return r.stdout.toString('utf8').split('\0').filter(Boolean).map((chunk) => {
    const [commit, ...rest] = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    return { commit, path: rest[rest.length - 1] ?? resource };
  });
}

function blobAt(root, { commit, path }) {
  const r = git(root, ['show', `${commit}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

function findBase(root, p) {
  const recorded = p.fields[FINGERPRINT_FIELD];
  if (typeof recorded === 'string' && /^[0-9a-f]{64}$/.test(recorded)) {
    for (const entry of resourceHistory(root, p.resource)) {
      const bytes = blobAt(root, entry);
      if (bytes !== null && fingerprintBytes(bytes) === recorded) {
        return { ...entry, bytes, label: `${entry.commit.slice(0, 10)} (matches the recorded resource-sha256)` };
      }
    }
  }
  const stamp = conceptStamp(p.fields);
  if (stamp !== null && !Number.isNaN(Date.parse(stamp.value))) {
    const [entry] = resourceHistory(root, p.resource, ['-1', `--before=${stamp.value}`]);
    if (entry) {
      const bytes = blobAt(root, entry);
      if (bytes !== null) return { ...entry, bytes, label: `commit at page stamp ${stamp.value} (${entry.commit.slice(0, 10)})` };
    }
  }
  return null;
}

function cmdDiff(root, pageArg) {
  const p = resolvePage(root, pageArg);
  console.log(`page: ${p.page}`);
  console.log(`resource: ${p.resource}`);
  if (!existsSync(p.resourceAbs)) {
    console.log(`the resource no longer exists — re-point \`resource\` at the file that now holds this subject, or retire the page`);
    return 0;
  }
  const base = findBase(root, p);
  if (base === null) {
    console.log('base: none — no commit matches the recorded fingerprint and none precedes the page stamp; the whole file follows');
    console.log('');
    process.stdout.write(readFileSync(p.resourceAbs, 'utf8'));
    return 0;
  }
  console.log(`base: ${base.label}`);
  const tmp = mkdtempSync(join(tmpdir(), 'wiki-refresh-'));
  try {
    const before = join(tmp, 'base');
    writeFileSync(before, base.bytes);
    const r = git(root, ['diff', '--no-index', '--no-color', '--ignore-cr-at-eol', '--', before, p.resourceAbs]);
    const out = r.stdout.toString('utf8');
    if (out.trim() === '') {
      console.log('no change since the base — a fingerprint-only --record is correct if the page is otherwise current');
    } else {
      // Relabel the temp-file header with the base it stands for.
      // git prints `a` + the absolute path, so the replacement keeps the leading `/`: `a/<path>@<base>`.
      process.stdout.write(out.split(before).join(`/${base.path}@${base.commit.slice(0, 10)}`).split(p.resourceAbs).join(`/${p.resource}`));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return 0;
}

// ── --record ────────────────────────────────────────────────────────────────────

function cmdRecord(root, pageArgs) {
  // Resolve EVERY page before writing ANY, so one bad argument cannot leave a half-recorded set.
  const pages = pageArgs.map((a) => resolvePage(root, a));
  for (const p of pages) {
    if (!existsSync(p.resourceAbs)) throw new UsageError(`${p.page}: resource missing — ${p.resource} does not exist; re-point \`resource\` or retire the page`);
  }
  for (const p of pages) {
    const r = recordSourceFingerprint(p.pageAbs, { root });
    console.log(`recorded ${r.page} ${r.fingerprint.slice(0, 12)}`);
  }
  return 0;
}

// Cut-over only (research R8): before fingerprints exist, "stamp newer than the source's last
// commit" is the best available evidence that a page is current. Removed once the cut-over lands.
function cmdRecordAllFresh(root) {
  const todo = [];
  const refused = [];
  for (const p of derivedPages({ root })) {
    if (staleReason(p) === null) continue; // already recorded and fresh
    const judged = sourceCommitAfterStamp({ root, fields: p.fields });
    if (judged === null || judged.unstampable || judged.stale) {
      const why = judged === null ? 'cannot judge (missing or untracked source)' : judged.unstampable ? 'no usable stamp' : 'source committed after the page stamp';
      refused.push(`${p.page} ← ${p.resource}  (${why})`);
    } else {
      todo.push(p);
    }
  }
  if (refused.length) {
    console.error(`[wiki-refresh] refusing --all-fresh: ${refused.length} page(s) need a real refresh first (--diff, edit, --record):`);
    for (const r of refused) console.error(`  ${r}`);
    return 1;
  }
  for (const p of todo) {
    const r = recordSourceFingerprint(p.pageAbs, { root });
    console.log(`recorded ${r.page} ${r.fingerprint.slice(0, 12)}`);
  }
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────────

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return 2;
  }
  const root = repoRoot();
  try {
    if (opts.command === '--stale') return cmdStale(root, opts.json);
    if (opts.command === '--diff') return cmdDiff(root, opts.pages[0]);
    return opts.allFresh ? cmdRecordAllFresh(root) : cmdRecord(root, opts.pages);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`[wiki-refresh] ${err.message}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
