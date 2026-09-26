#!/usr/bin/env node
// One argument-rejection mechanism, shared by every script whose default action MUTATES something.
//
// WHY THIS IS A SHARED MODULE RATHER THAN A PATTERN TO COPY. It was copied once — `agent-stack.mjs`
// grew a `resolveCommand()` in PR #497 — and item #500's audit then found the same defect live in
// two more scripts. A third and fourth hand-rolled parser would drift in the one place drift is
// expensive: the ERROR PATH, which by definition nobody exercises until the day it matters.
//
// THE DEFECT THIS EXISTS TO END (item #500, and #497 before it). An argument the tool does not
// recognise and does not REJECT silently leaves the DEFAULT action running:
//
//   agent-stack.mjs --help          built and deployed the whole stack (measured 2026-09-19)
//   renovate-health.mjs --dryrun    posted a public comment to item #311
//   prune-bff-runtime-modules.mjs --dry_run   deleted files for real
//
// In each case the typo'd run's exit code was indistinguishable from the intended one's.
//
// THE RULE IS REJECT, NOT GUESS. An unknown argument raises. It is never a silently-ignored token
// that leaves the default action running, and "did you mean" guessing is deliberately absent: a
// parser that repairs its input is a parser that acts on something the caller did not type.
//
// SCOPE. Flags here are VALUELESS — `--foo bar` is a flag plus a positional, never a flag with a
// value. Both current callers are that shape. A value-taking flag needs an explicit extension, not
// a clever inference, because `--target --apply` would otherwise silently swallow the second flag.

/** Raised for any argument contract violation. Callers turn this into a usage error, never a default. */
export class ArgvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgvError';
  }
}

/**
 * Does this argv ask what the script does? Checked BEFORE anything else, everywhere.
 *
 * Someone asking what a script does must never trigger what it does. That is not a nicety: `--help`
 * is the reflex used to find out, and on agent-stack.mjs it was the one input that made it act.
 */
export function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Split argv into recognised flags and positionals, REJECTING anything unrecognised.
 *
 * Rejection happens BEFORE any dispatch, so `--down --typo` fails loudly rather than tearing down
 * and leaving the caller believing the typo meant something.
 *
 * A token is a flag if it starts with `-`. That is what catches the near-miss spellings the item
 * measured — `-dry-run`, `--dry_run`, `--dryrun` are all flags, all unrecognised, all refused —
 * whereas treating only `--` as a flag prefix would let `-dry-run` through as a positional.
 *
 * @param {string[]} argv
 * @param {{accepted: string[], maxPositionals?: number, usage?: string}} spec
 * @returns {{flags: Set<string>, positionals: string[]}}
 * @throws {ArgvError} on an unrecognised flag or a surplus positional
 */
export function partitionArgs(argv, { accepted, maxPositionals = 0, usage = '' }) {
  const args = (argv ?? []).filter((a) => a !== '');
  const flags = args.filter((a) => a.startsWith('-'));
  const positionals = args.filter((a) => !a.startsWith('-'));

  const unknown = flags.filter((f) => !accepted.includes(f));
  if (unknown.length) {
    throw new ArgvError(
      `unrecognised argument(s): ${unknown.join(', ')}\n` +
        `accepted: ${accepted.join(', ')}\n\n${usage}`,
    );
  }
  if (positionals.length > maxPositionals) {
    throw new ArgvError(
      `unexpected positional argument(s): ${positionals.slice(maxPositionals).join(', ')}\n` +
        `this script takes at most ${maxPositionals} positional argument(s)\n\n${usage}`,
    );
  }
  return { flags: new Set(flags), positionals };
}

/**
 * Split argv where some flags TAKE A VALUE, still rejecting anything unrecognised.
 *
 * THE EXTENSION THE SCOPE NOTE ABOVE ASKED FOR (feature 077). `partitionArgs` treats every flag as
 * valueless on purpose, because inferring values would let `--target --apply` swallow the second
 * flag. Two read-only gates then needed real values (`--dist <dir>`, `--budget <bytes>`), and the
 * alternative was a third hand-rolled parser — which is the exact drift this module exists to end.
 * So the value case is declared, not inferred: a flag takes a value only by being named in
 * `withValues`, and everything else about the contract is unchanged.
 *
 * Both spellings are accepted (`--dist /tmp/x` and `--dist=/tmp/x`) because both are what people
 * type. Three things are REFUSED rather than guessed:
 *
 *   - an unrecognised flag, as always;
 *   - a value-taking flag with nothing after it — `--budget` at the end of argv is a typo, and
 *     defaulting it would run the gate against a number the caller never chose;
 *   - a value that is itself flag-shaped — `--budget --json` means the caller lost a value, and
 *     silently reading `--json` as the budget is how a gate ends up asserting `NaN`.
 *
 * @param {string[]} argv
 * @param {{accepted?: string[], withValues?: string[], maxPositionals?: number, usage?: string}} spec
 * @returns {{flags: Set<string>, values: Map<string, string>, positionals: string[]}}
 * @throws {ArgvError}
 */
export function partitionArgsWithValues(argv, { accepted = [], withValues = [], maxPositionals = 0, usage = '' } = {}) {
  const all = [...accepted, ...withValues];
  const args = (argv ?? []).filter((a) => a !== '');
  const flags = new Set();
  const values = new Map();
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok.startsWith('-')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok : tok.slice(0, eq);
    if (!all.includes(name)) {
      throw new ArgvError(
        `unrecognised argument(s): ${tok}\naccepted: ${all.join(', ')}\n\n${usage}`,
      );
    }
    if (!withValues.includes(name)) {
      if (eq !== -1) {
        throw new ArgvError(`${name} does not take a value\n\n${usage}`);
      }
      flags.add(name);
      continue;
    }
    if (eq !== -1) {
      const v = tok.slice(eq + 1);
      if (v === '') throw new ArgvError(`${name} needs a value\n\n${usage}`);
      values.set(name, v);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('-')) {
      throw new ArgvError(`${name} needs a value\n\n${usage}`);
    }
    values.set(name, next);
    i++;
  }

  if (positionals.length > maxPositionals) {
    throw new ArgvError(
      `unexpected positional argument(s): ${positionals.slice(maxPositionals).join(', ')}\n` +
        `this script takes at most ${maxPositionals} positional argument(s)\n\n${usage}`,
    );
  }
  return { flags, values, positionals };
}

/**
 * Which accepted flags the usage text fails to mention — `[]` when the help cannot mislead.
 *
 * Used by the guards rather than at runtime. A usage string that omits a real flag is the NEXT
 * version of this same bug: the reader trusts it, types something else, and finds out what the
 * default action is. Asserting the two agree is what stops help drifting from the parser.
 */
export function usageNamesEveryFlag(usage, accepted) {
  return accepted.filter((flag) => !String(usage ?? '').includes(flag));
}

/**
 * Print `usage` and exit 2 for an ArgvError; rethrow anything else.
 *
 * Exit 2, not 1: a caller who mistyped a flag has made a DIFFERENT kind of error from the one the
 * script exists to report, and renovate-health.mjs in particular always exits 0 by design (a weekly
 * red trains people to ignore it). Laundering a typo through that discipline would make the typo
 * invisible, which is the whole defect.
 *
 * `hard: false` sets `process.exitCode` and RETURNS instead of calling `process.exit()`. The caller
 * must then not proceed to its default action. Use it where the script's output must not be
 * truncated: `process.exit()` discards writes still queued on stdout/stderr, and a pipe — which is
 * exactly what a CI log capture is — makes those writes asynchronous. ci-failure-digest.mjs (item
 * #504) is the case that needed it, and is also the file where that trap is documented, so a hard
 * exit there would contradict its own lesson.
 */
export function dieOnArgvError(err, { log = console.error, hard = true } = {}) {
  if (!(err instanceof ArgvError)) throw err;
  log(err.message);
  if (hard) process.exit(2);
  process.exitCode = 2;
}
