// Guard (item #1146): a job on the shared host runner (`runs-on: kvm`) keeps its tools out of $HOME.
//
// That runner runs as the `ci` user, and so does another project's runner (BELAY), so the two share
// $HOME: ~/.local/bin, ~/.cache/*, ~/.cache/act/tool_cache. A tool one project installs there is the
// tool the other project's next job runs, and a version bump on either side swaps it, even mid-job.
// Measured 2026-11-25 with pnpm (item #1144): BELAY's global pnpm 12.22.0 failed our
// check-pnpm-version 22 s later and skipped a deploy. Trivy had the same shape: both projects
// installed it into ~/.local/bin and kept its DB in ~/.cache/trivy, safe only while both pinned 0.76.2.
//
// The pnpm half of this rule lives in renovate-workflow.guard.test.mjs (pnpmInstallFindings). This
// file holds the rest: no $HOME directory on PATH, no install into ~/.local/bin, and Trivy's binary
// and DB cache job-private and removed when the job ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.forgejo/workflows');
const HOST_RUNNERS = new Set(['kvm']);
const JOB_PRIVATE = /^\$\{\{\s*runner\.temp\s*\}\}\//;
const HOME_PATH = /(\$HOME|\$\{HOME\}|~)\//;

// Deliberate exemptions from the "no $HOME directory on PATH" rule. Each names the item that removes
// it; the list must only shrink. Keyed `<file> › <job>` → the PATH entry, verbatim.
const HOME_PATH_EXEMPT = new Map([
  // Maestro installs itself into ~/.maestro; BELAY does not use it (hygiene, not a live collision).
  ['app-ci.yml › app-e2e', { entry: '$HOME/.maestro/bin', item: '#1147' }],
]);

export function sharedStateFindings(dir = WORKFLOW_DIR) {
  const findings = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = parseYaml(readFileSync(resolve(dir, file), 'utf8'));
    for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
      if (!HOST_RUNNERS.has(String(def?.['runs-on'] ?? ''))) continue;
      const where = `${file} › ${job}`;
      const steps = def?.steps ?? [];
      const at = (i) => `${where} › step ${i + 1}${steps[i]?.name ? ` (${steps[i].name})` : ''}`;
      const envOf = (step) => ({ ...(doc?.env ?? {}), ...(def?.env ?? {}), ...(step?.env ?? {}) });
      let trivyDirVar = null;
      steps.forEach((step, i) => {
        const run = String(step?.run ?? '');
        for (const line of run.split('\n')) {
          if (/^\s*#/.test(line)) continue; // a shell comment is prose, not a write
          const m = line.match(/echo\s+"?([^">]+?)"?\s*>>\s*"?\$GITHUB_PATH/);
          if (m && HOME_PATH.test(m[1])) {
            const ex = HOME_PATH_EXEMPT.get(where);
            if (!(ex && ex.entry === m[1].trim())) findings.push(`${at(i)} puts a $HOME directory on PATH: ${m[1].trim()}`);
          }
          if (/(\$HOME|\$\{HOME\}|~)\/\.local\/bin/.test(line)) findings.push(`${at(i)} installs into the shared ~/.local/bin: ${line.trim()}`);
        }
        const install = run.match(/ci-install-trivy\.sh\s+"?\$([A-Z_]+)\/bin"?/);
        if (/ci-install-trivy\.sh/.test(run)) {
          const value = install ? String(envOf(step)[install[1]] ?? '') : '';
          if (!install || !JOB_PRIVATE.test(value)) {
            findings.push(`${at(i)} installs Trivy outside a job-private dir — use ci-install-trivy.sh "$<VAR>/bin" with <VAR> under \${{ runner.temp }}`);
          } else {
            trivyDirVar = install[1];
            if (!new RegExp(`TRIVY_CACHE_DIR=\\$${install[1]}/`).test(run) || !/>>\s*"?\$GITHUB_ENV/.test(run)) {
              findings.push(`${at(i)} leaves Trivy's DB cache at its shared default (~/.cache/trivy) — write TRIVY_CACHE_DIR=$${install[1]}/cache to $GITHUB_ENV`);
            }
          }
        }
      });
      if (trivyDirVar) {
        const cleanup = steps.find((s) => new RegExp(`rm -rf "\\$${trivyDirVar}"`).test(String(s?.run ?? '')));
        if (!cleanup) findings.push(`${where}: no step removes "$${trivyDirVar}" (the job-private Trivy)`);
        else {
          if (!/always\(\)/.test(String(cleanup.if ?? ''))) findings.push(`${where}: the Trivy cleanup must be \`if: always()\``);
          if (!JOB_PRIVATE.test(String(envOf(cleanup)[trivyDirVar] ?? ''))) findings.push(`${where}: the Trivy cleanup removes something other than the job-private dir`);
        }
      }
    }
  }
  return findings;
}

test('no host-runner job writes a tool into, or puts on PATH, the shared $HOME; Trivy is job-private', () => {
  const findings = sharedStateFindings();
  assert.deepEqual(findings, [], `host-runner shared-state violations:\n  ${findings.join('\n  ')}`);
});

test('the scan finds the host-runner Trivy installs it guards (not vacuous)', () => {
  for (const f of ['app-ci.yml', 'cd-deploy.yml']) {
    assert.match(readFileSync(resolve(WORKFLOW_DIR, f), 'utf8'), /ci-install-trivy\.sh "\$MCM_TRIVY_DIR\/bin"/, `${f} no longer installs Trivy the guarded way`);
  }
});

test('every PATH exemption names the item that removes it, and still exists (the list only shrinks)', () => {
  for (const [where, { entry, item }] of HOME_PATH_EXEMPT) {
    assert.match(item, /^#\d+$/, `${where}: exemption without an item number`);
    const [file] = where.split(' › ');
    assert.ok(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8').includes(entry), `${where}: exempt entry ${entry} is gone — delete the exemption`);
  }
});

test('the shared-state rule rejects each wrong shape (control)', () => {
  const d = mkdtempSync(resolve(tmpdir(), 'host-shared-state-'));
  const ENV = '        env:\n          MCM_TRIVY_DIR: ${{ runner.temp }}/mcm-trivy\n';
  const GOOD_INSTALL =
    '      - name: Install Trivy\n' + ENV + '        run: |\n' +
    '          bash scripts/ci-install-trivy.sh "$MCM_TRIVY_DIR/bin"\n' +
    '          echo "$MCM_TRIVY_DIR/bin" >> "$GITHUB_PATH"\n' +
    '          echo "TRIVY_CACHE_DIR=$MCM_TRIVY_DIR/cache" >> "$GITHUB_ENV"\n';
  const CLEAN = '      - if: always()\n' + ENV + '        run: rm -rf "$MCM_TRIVY_DIR"\n';
  const job = (runsOn, body) => `jobs:\n  j:\n    runs-on: ${runsOn}\n    steps:\n${body}`;
  const cases = [
    ['host + private Trivy + cleanup', job('kvm', GOOD_INSTALL + CLEAN), 0],
    ['container job may use $HOME freely', job('ubuntu-latest', '      - run: |\n          bash scripts/ci-install-trivy.sh "$HOME/.local/bin"\n          echo "$HOME/.local/bin" >> "$GITHUB_PATH"\n'), 0],
    ['host + Trivy into ~/.local/bin', job('kvm', '      - run: |\n          bash scripts/ci-install-trivy.sh "$HOME/.local/bin"\n          echo "$HOME/.local/bin" >> "$GITHUB_PATH"\n'), 1],
    ['host + private binary, shared DB cache', job('kvm', GOOD_INSTALL.replace(/.*TRIVY_CACHE_DIR.*\n/, '') + CLEAN), 1],
    ['host + private Trivy, no cleanup', job('kvm', GOOD_INSTALL), 1],
    ['host + cleanup only on success', job('kvm', GOOD_INSTALL + CLEAN.replace('      - if: always()\n', '      - name: c\n')), 1],
    ['host + Trivy dir var outside runner.temp', job('kvm', GOOD_INSTALL.replace('${{ runner.temp }}/mcm-trivy', '/home/ci/trivy') + CLEAN), 1],
    ['host + any $HOME dir on PATH', job('kvm', '      - run: echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"\n'), 1],
  ];
  for (const [label, yml, expected] of cases) {
    for (const f of readdirSync(d)) writeFileSync(resolve(d, f), '');
    writeFileSync(resolve(d, 'w.yml'), yml);
    const n = sharedStateFindings(d).length;
    assert.equal(Math.min(n, 1), expected, `${label}: ${JSON.stringify(sharedStateFindings(d))}`);
  }
});
