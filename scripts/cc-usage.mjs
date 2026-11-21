#!/usr/bin/env node
// Claude Code token usage capture and analysis (feature 105; contracts/cli.md).
//
// Zero runtime dependencies: Node built-ins and the global fetch. Arguments go through
// scripts/lib/argv-contract.mjs, so an unknown flag is exit 2, never a silently-ignored token.
//
//   node scripts/cc-usage.mjs oracle-check [--fixtures <dir>]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';
import { sessionTotals } from './lib/cc-usage/transcript-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = join(HERE, '__tests__', 'fixtures', 'cc-usage');

export const USAGE = `usage: node scripts/cc-usage.mjs <command> [flags]

commands:
  oracle-check [--fixtures <dir>]   compare parser totals on the fixtures with the committed ccusage oracle; exit 1 on any mismatch
`;

const COMMANDS = {
  'oracle-check': { withValues: ['--fixtures'], run: oracleCheck },
};

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

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      if (err instanceof ArgvError) dieOnArgvError(err, { hard: false });
      else { console.error(err?.message ?? err); process.exitCode = 1; }
    },
  );
}
