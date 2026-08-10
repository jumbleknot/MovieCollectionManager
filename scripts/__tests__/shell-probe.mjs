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

/**
 * @returns {{usable: boolean, reason: string|null}} — `reason` always NAMES the unmet condition,
 * because a reasonless skip is the false green this whole check exists to prevent.
 */
export function shellCanRunScript(shell, script) {
  const r = spawnSync(shell, ['-c', `test -r "${script}"`], { encoding: 'utf8' });
  if (r.error) {
    return { usable: false, reason: `\`${shell}\` could not be started (${r.error.code ?? r.error.message})` };
  }
  if (r.status !== 0) {
    return {
      usable: false,
      reason:
        `\`${shell}\` starts but cannot read ${script} — it is a shell from a different filesystem `
        + 'namespace (typically the WSL bash on PATH for a Windows checkout). Put a shell that can '
        + 'see this working tree on PATH, e.g. Git Bash, and re-run.',
    };
  }
  return { usable: true, reason: null };
}

/** Convenience wrapper: a node:test options object that skips WITH the reason. */
export function needsShell(shell, script) {
  const probe = shellCanRunScript(shell, script);
  return { skip: probe.usable ? false : probe.reason };
}
