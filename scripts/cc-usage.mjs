#!/usr/bin/env node
// Claude Code token usage capture and analysis (feature 105; contracts/cli.md).
//
// Zero runtime dependencies: Node built-ins and the global fetch. Arguments go through
// scripts/lib/argv-contract.mjs, so an unknown flag is exit 2, never a silently-ignored token.
//
//   node scripts/cc-usage.mjs hook                       (Claude Code only; event JSON on stdin)
//   node scripts/cc-usage.mjs doctor
//   node scripts/cc-usage.mjs oracle-check [--fixtures <dir>]
//   node scripts/cc-usage.mjs now|sessions|trend|compare|sync|tag …   (US2; the `usage` skill)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';
import { doctorLines, runHook } from './lib/cc-usage/capture.mjs';
import { sessionTotals } from './lib/cc-usage/transcript-files.mjs';
import * as query from './lib/cc-usage/query.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = join(HERE, '__tests__', 'fixtures', 'cc-usage');

export const USAGE = `usage: node scripts/cc-usage.mjs <command> [flags]

commands:
  hook                              invoked by Claude Code's SessionStart / Stop / SessionEnd hooks; always exit 0, prints nothing
  doctor                            capture health: configured, last ship, spool, back-off, token state, unshipped transcripts
  oracle-check [--fixtures <dir>]   compare parser totals on the fixtures with the committed ccusage oracle; exit 1 on any mismatch
  now --session <id>                this session so far: tokens by type, context now, top tool outputs, subagent share (works offline)
  sessions [--since 7d] [--branch b] [--area x]
                                    one row per session from the store
  trend --by week|area [--since 8w] one row per bucket
  compare <a> <b>                   side by side; a/b are session ids or YYYY-MM-DD..YYYY-MM-DD
  sync --session <id>               ship this session now, ignoring the 15-minute interval
  tag --session <id> <label>        set the session's manual tag

  --json on now/sessions/trend/compare prints every row as JSON. Output is capped at 10 rows otherwise.
`;

const COMMANDS = {
  hook: { run: hook },
  doctor: { run: (_p, io) => { io.out(doctorLines().join('\n')); return 0; } },
  'oracle-check': { withValues: ['--fixtures'], run: oracleCheck },
  now: { withValues: ['--session'], accepted: ['--json'], run: interactive((p) => query.now(p.cfg, { session: need(p, '--session'), json: p.json }), { history: false }) },
  sessions: { withValues: ['--since', '--branch', '--area'], accepted: ['--json'], run: interactive((p) => query.sessions(p.cfg, { since: p.values.get('--since'), branch: p.values.get('--branch'), area: p.values.get('--area'), json: p.json })) },
  trend: { withValues: ['--by', '--since'], accepted: ['--json'], run: interactive(trendCmd) },
  compare: { accepted: ['--json'], maxPositionals: 2, run: interactive((p) => query.compare(p.cfg, { a: p.positionals[0], b: p.positionals[1], json: p.json })) },
  sync: { withValues: ['--session'], run: interactive((p) => query.sync(p.cfg, { session: need(p, '--session') }), { history: false }) },
  tag: { withValues: ['--session'], maxPositionals: 1, run: interactive((p) => query.tag(p.cfg, { session: need(p, '--session'), label: p.positionals[0] })) },
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A required flag; a missing or malformed --session is a usage error (exit 2, FR-019). */
function need(p, flag) {
  const v = p.values.get(flag);
  if (!v) throw new ArgvError(`cc-usage.mjs: ${flag} is required (the skill passes \${CLAUDE_SESSION_ID})\n\n${USAGE}`);
  if (flag === '--session' && !SESSION_ID.test(v)) throw new ArgvError(`cc-usage.mjs: --session expects a session id, got ${v}\n\n${USAGE}`);
  return v;
}

function trendCmd(p) {
  const by = p.values.get('--by');
  if (!['week', 'area'].includes(by ?? '')) throw new ArgvError(`cc-usage.mjs: trend --by expects week or area\n\n${USAGE}`);
  return query.trend(p.cfg, { by, since: p.values.get('--since') ?? '8w', json: p.json });
}

/**
 * Wrap an interactive command: config, --json, and the store-unreachable rule (contracts/cli.md: a
 * history command prints exactly `usage history: store unreachable (spooled N)` and exits 0).
 */
function interactive(fn, { history = true } = {}) {
  return async (parsed, io) => {
    const cfg = query.loadConfig();
    const p = { ...parsed, cfg, json: parsed.flags.has('--json') };
    let r;
    try {
      r = await fn(p);
    } catch (e) {
      if (e instanceof query.Unreachable) {
        io.out(query.unreachableLine(cfg));
        return 0;
      }
      if (e instanceof RangeError) throw new ArgvError(`cc-usage.mjs: ${e.message}\n\n${USAGE}`);
      throw e;
    }
    if (r.err) io.err(r.err);
    if (r.out) io.out(r.out);
    void history;
    return r.code;
  };
}

/** Exit 0 and print nothing on EVERY path — a hook must never disturb the session (contracts/cli.md). */
async function hook() {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch { /* no stdin */ }
  await runHook(stdin);
  return 0;
}

function oracleCheck({ values }, io) {
  const dir = values.get('--fixtures') ?? DEFAULT_FIXTURES;
  const oracle = JSON.parse(readFileSync(join(DEFAULT_FIXTURES, 'ccusage-oracle.json'), 'utf8'));
  const actual = sessionTotals(dir);
  const mismatches = [];
  for (const [id, expected] of Object.entries(oracle.sessions)) {
    for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
      const got = actual[id]?.[k];
      if (got !== expected[k]) mismatches.push(`${id} ${k}: parser ${got ?? 'missing'} ≠ ${oracle.tool} ${expected[k]}`);
    }
  }
  for (const id of Object.keys(actual)) if (!oracle.sessions[id]) mismatches.push(`${id}: not in the oracle`);
  if (mismatches.length) {
    io.out(`oracle-check: ${mismatches.length} mismatch(es)\n${mismatches.join('\n')}`);
    return 1;
  }
  io.out(`oracle-check: ${Object.keys(oracle.sessions).length} sessions match ${oracle.tool}`);
  return 0;
}

/** Dispatch; returns the exit code. Throws ArgvError for usage errors. */
export async function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  if (argv.length === 0 || wantsHelp(argv)) {
    io.out(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const [name, ...rest] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) throw new ArgvError(`cc-usage.mjs: no such command ${name}\n\n${USAGE}`);
  const parsed = partitionArgsWithValues(rest, {
    accepted: cmd.accepted ?? [],
    withValues: cmd.withValues ?? [],
    maxPositionals: cmd.maxPositionals ?? 0,
    usage: USAGE,
  });
  return cmd.run(parsed, io);
}

if (isMain(import.meta.url) && process.argv[2] === 'hook') {
  // The hook path bypasses argument checking and every error report: nothing may reach stdout/stderr.
  hook().catch(() => {}).finally(() => { process.exitCode = 0; });
} else if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      if (err instanceof ArgvError) dieOnArgvError(err, { hard: false });
      else { console.error(err?.message ?? err); process.exitCode = 1; }
    },
  );
}
