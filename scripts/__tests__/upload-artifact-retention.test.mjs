// Every `actions/upload-artifact` step sets a deliberate retention (spec 084 FR-019c, research R9).
//
// Measured 2026-10-26: the forge's `actions_artifacts` held 21.8 G, every artifact kept for the
// server's 90-day default, mostly `maestro-debug` uploads that each carried every earlier run's
// output. PR #864 fixed the accumulation; this pins how long any upload may stay:
//   - diagnostics (maestro-debug, *-logs, *-report, *scan*): 14 days at most;
//   - the release APK artifact: 7, because the APK also lives in the mcm-app-android package;
//   - anything else: 30, the server default the runbook sets as the backstop.
//
// Unit tier: parses the workflow YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = join(REPO_ROOT, '.forgejo/workflows');
const RUNBOOK = join(REPO_ROOT, 'docs/runbooks/Server-Setup-Runbook.md');

/** { where, name, days } for every upload-artifact step in every workflow. */
function uploadSteps() {
  const out = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parseYaml(readFileSync(join(WORKFLOWS, file), 'utf8'));
    for (const [job, def] of Object.entries(wf?.jobs ?? {})) {
      for (const step of def?.steps ?? []) {
        if (!String(step?.uses ?? '').startsWith('actions/upload-artifact@')) continue;
        out.push({
          where: `${file} ${job} "${step.name ?? step.with?.name}"`,
          name: String(step.with?.name ?? ''),
          days: step.with?.['retention-days'],
        });
      }
    }
  }
  return out;
}

const ceilingFor = (name) => {
  if (/release/i.test(name)) return 7;
  if (/^maestro-debug$|-logs$|-report$|scan/.test(name)) return 14;
  return 30;
};

test('the parse finds the uploads it guards (an empty walk would pass everything)', () => {
  const names = uploadSteps().map((s) => s.name);
  for (const known of ['maestro-debug', 'playwright-report', 'sast-report']) assert.ok(names.includes(known), `${known} not found in ${names}`);
});

test('every upload-artifact step sets retention-days, as a whole number of days', () => {
  const missing = uploadSteps().filter((s) => !Number.isInteger(s.days) || s.days < 1);
  assert.deepEqual(missing.map((s) => `${s.where}: retention-days=${s.days}`), []);
});

test('no upload is kept longer than its class allows: diagnostics 14, the release APK 7, anything else 30', () => {
  const over = uploadSteps().filter((s) => Number.isInteger(s.days) && s.days > ceilingFor(s.name));
  assert.deepEqual(over.map((s) => `${s.where}: ${s.days} > ${ceilingFor(s.name)}`), []);
});

test("the forge's server default is 30 days, the backstop for any workflow outside this repository", () => {
  assert.match(readFileSync(RUNBOOK, 'utf8'), /^\s*- FORGEJO__actions__ARTIFACT_RETENTION_DAYS=30\s*$/m);
});
