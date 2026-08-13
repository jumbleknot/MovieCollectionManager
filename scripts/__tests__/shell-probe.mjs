// Shared host-capability probe for suites that shell out to a bash script.
//
// NOT named `*.test.mjs` on purpose: `node --test scripts/__tests__/*.test.mjs` would otherwise
// collect it, and importing a test file from another test file double-registers its cases.
//
// WHY THIS IS SHARED RATHER THAN COPIED. Feature 051 (US5) replaced a probe that asked "does a shell
// called bash start?" with one that asks the question actually needed — "can that shell READ the
// script under test?". On a Windows host `bash` on PATH is the WSL shim: it starts perfectly and then
// cannot see `E:\…`, so the old probe reported it usable and every case failed with status 127 —
// red tests saying nothing about the code.
//
// It was then REINTRODUCED, in `e2e-contention-tally.test.mjs`, by a later feature that copied the
// old `spawnSync('bash', [SCRIPT, …])` shape. Measured on Windows 2026-08-10: 11 failures, all
// `127 !== 0`. A fix that lives in one file is a fix the next author does not inherit, so it lives
// here now.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * @returns {{usable: boolean, reason: string|null}} — `reason` always NAMES the unmet condition,
 * because a reasonless skip is the false green this whole check exists to prevent.
 *
 * THREE conditions, checked in this order. The middle one was missing until feature 054 (backlog
 * item #178), and its absence turned RED tests into silent skips.
 */
export function shellCanRunScript(shell, script) {
  const r = spawnSync(shell, ['-c', `test -r "${script}"`], { encoding: 'utf8' });
  if (r.error) {
    return { usable: false, reason: `\`${shell}\` could not be started (${r.error.code ?? r.error.message})` };
  }
  if (r.status === 0) return { usable: true, reason: null };

  // THE SCRIPT SIMPLY IS NOT THERE — which is not a shell-capability problem, and must NOT skip.
  //
  // `test -r` is false for an ABSENT file exactly as it is for an UNREACHABLE one, and until this
  // check existed both returned the namespace diagnosis below. Measured 2026-08-11 on Linux with a
  // working bash: writing a test file before its script left 12 of 15 cases SKIPPED, blaming WSL for
  // a file that had not been created yet. A skip reads as a pass, so the RED half of a RED→GREEN pair
  // vanished — and it vanished precisely when the discipline was being followed, because
  // test-before-implementation is the only order in which the script is missing.
  //
  // Reporting a missing script as USABLE is deliberate and is the fix: the cases then fail honestly
  // (a 127, or an assertion about output that was never produced), which is true and legible, where
  // the skip was false and invisible.
  //
  // `existsSync` is the right predicate BECAUSE it runs in node rather than in the shell. Conflating
  // those two views is the entire defect: on a Windows host with the WSL bash on PATH, node sees
  // `E:\…` and the shell does not, which is exactly the discrimination needed here.
  if (!existsSync(script)) return { usable: true, reason: null };

  return {
    usable: false,
    reason:
      `\`${shell}\` starts but cannot read ${script} — it is a shell from a different filesystem `
      + 'namespace (typically the WSL bash on PATH for a Windows checkout). Put a shell that can '
      + 'see this working tree on PATH, e.g. Git Bash, and re-run.',
  };
}

/** Convenience wrapper: a node:test options object that skips WITH the reason. */
export function needsShell(shell, script) {
  const probe = shellCanRunScript(shell, script);
  return { skip: probe.usable ? false : probe.reason };
}
