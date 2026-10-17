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
// CLI:  node scripts/mobile-flows.mjs ci-full   → one flow basename (no .yaml) per line, in run order.
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
  if (cmd !== 'ci-full' || rest.length > 0) {
    // Reject rather than guess (CLAUDE.md: an argument a tool does not recognise must not be ignored).
    console.error('usage: node scripts/mobile-flows.mjs ci-full');
    process.exit(2);
  }
  process.stdout.write(`${ciFullFlows().join('\n')}\n`);
}
