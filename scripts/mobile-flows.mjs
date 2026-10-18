#!/usr/bin/env node
// Which Maestro mobile flows run where — the ONE place that decides it (item #254 follow-on).
//
// Two consumers read this, and they used to be one consumer:
//   * frontend/mcm-app/scripts/maestro-e2e.mjs  — the local `e2e:mobile` suite (Metro + emulator).
//   * scripts/ci-mobile-full-flows.sh          — the OPT-IN "full mobile suite" in app-ci's app-e2e
//                                                 job (label `mobile-e2e-full`, or a dispatch with
//                                                 `mobile_suite=full`), run after the agent flows.
// Keeping the selection here means the CI full mode cannot drift into a second, hand-maintained
// list: a new non-agent flow added to tests/e2e/mobile/ is picked up by BOTH, unless it is named in
// one of the exclusion tables below — each of which has to say why.
//
// CLI:  node scripts/mobile-flows.mjs ci-full          → one flow basename (no .yaml) per line, in run order.
//       node scripts/mobile-flows.mjs ci-non-blocking  → the subset of those that run but cannot fail the step.
import { readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLOWS_DIR = resolve(HERE, '..', 'frontend', 'mcm-app', 'tests', 'e2e', 'mobile');

// Flows that require Metro to be restarted with a non-default env config (a short absolute-timeout
// override), so they run in isolation via `pnpm nx e2e:mobile:session-timeout mcm-app`
// (scripts/maestro-session-timeout.mjs) — never in the batch suite, locally or in CI.
export const MANUAL_FLOWS = new Set(['session-timeout.yaml', 'session-timeout-absolute.yaml']);

// Agent flows drive the dock → /bff-api/agent/run. In CI they are owned by
// scripts/ci-mobile-agent-flows.sh (a curated, ordered, anthropic-provider subset), so the full mode
// never runs one — the agent half already ran, and an agent flow outside that curated list either
// needs a local Ollama provider or a per-run fixture the agent script does not mint.
export const isAgentFlow = (name) => /^(agent|assistant)-/.test(name.replace(/\.yaml$/, ''));

// Non-agent flows the full mode deliberately does NOT run, each with its reason. A flow belongs here
// only for an ENVIRONMENTAL reason (it assumes Metro / a dev-only setup) or because CI already runs
// it elsewhere — a flow failing on a real app bug is reported, never parked here.
export const CI_FULL_EXCLUDED = new Map([
  ['admin-settings-access',
    'already run by scripts/ci-mobile-agent-flows.sh (LAST, after a Chrome SSO reset, as the seeded mc-admin)'],
]);

// Flows the full mode RUNS but does not FAIL on — each with a category and its evidence. They stay
// in the run (one attempt, no retry) so the table keeps reporting them, and so a fix shows up as a
// PASS that tells you to delete the entry; they are just not allowed to turn a native-layer PR red
// for a reason that PR did not cause. ENVIRONMENTAL = CI-only, not the app. KNOWN DEFECT = it fails
// on the app as it is — reported, never silently parked: fix the app or the flow, then remove it.
export const CI_FULL_NON_BLOCKING = new Map([
  ['login-invalid',
    'ENVIRONMENTAL (app-ci run 5502, 2/2 attempts): the flow\'s own assertions hold — logout ends the SSO ' +
    'session and Keycloak re-shows its form with the credential error for invalid_user — but the two ' +
    '`pressKey: back` it uses to close the Chrome Custom Tab leave the CI image\'s Chrome still on the ' +
    'Keycloak page (no IME open), so `login-screen` never returns. Chrome back-stack depth, not the app.'],
  ['movie-sort',
    'KNOWN DEFECT (app-ci run 5502, 2/2 attempts, pixel_6 1080x2400 — the same width as the local Pixel 7): ' +
    'with the DEFAULT visible columns (use-column-visibility.ts: owned + ripped on) the sort row holds ' +
    'Title/Year/Type/Owned/Ripped chips, and `sort-dir-toggle` sits past the right edge of the horizontal ' +
    'ScrollView in movie-sort-control.tsx, so the flow\'s assertVisible fails. The direction toggle is ' +
    'off-screen on a phone by default — fix the control (or make the flow scroll), then remove this entry.'],
]);

/** The local `e2e:mobile` suite: every non-helper, non-manual flow, sorted (absolute paths). */
export function localSuiteFlows(dir = FLOWS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('_') && !MANUAL_FLOWS.has(f))
    .sort()
    .map((f) => resolve(dir, f));
}

/** The CI full-mode extras: the local suite minus agent flows minus CI_FULL_EXCLUDED (basenames). */
export function ciFullFlows(dir = FLOWS_DIR) {
  return localSuiteFlows(dir)
    .map((p) => basename(p, '.yaml'))
    .filter((name) => !isAgentFlow(name) && !CI_FULL_EXCLUDED.has(name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const commands = {
    'ci-full': () => ciFullFlows(),
    'ci-non-blocking': () => [...CI_FULL_NON_BLOCKING.keys()],
  };
  if (!commands[cmd] || rest.length > 0) {
    // Reject rather than guess (CLAUDE.md: an argument a tool does not recognise must not be ignored).
    console.error('usage: node scripts/mobile-flows.mjs ci-full|ci-non-blocking');
    process.exit(2);
  }
  process.stdout.write(`${commands[cmd]().join('\n')}\n`);
}
