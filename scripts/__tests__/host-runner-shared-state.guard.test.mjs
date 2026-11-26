// Guard (items #1146, #1147): a job on the shared host runner (`runs-on: kvm`) keeps its tools out of $HOME.
//
// That runner runs as the `ci` user, and so does another project's runner (BELAY), so the two share
// $HOME: ~/.local/bin, ~/.cache/*, ~/.cache/act/tool_cache, ~/.docker. A tool one project installs there
// is the tool the other project's next job runs, and a version bump on either side swaps it, even mid-job.
// Measured 2026-11-25 with pnpm (item #1144): BELAY's global pnpm 12.22.0 failed our
// check-pnpm-version 22 s later and skipped a deploy. Trivy had the same shape: both projects
// installed it into ~/.local/bin and kept its DB in ~/.cache/trivy, safe only while both pinned 0.76.2.
//
// Item #1147 added three more shapes, all found on the host on 2026-11-26:
//   - Docker CLI state. Four jobs curl'd the newest Docker Compose into ~/.docker/cli-plugins, which
//     every `ci` process loads (it shadowed the system plugin in /usr/libexec/docker/cli-plugins), and
//     two jobs' `docker login` wrote the registry token into the shared ~/.docker/config.json. Docker
//     reads BOTH from $DOCKER_CONFIG, so one fix covers both: every host job that runs the Docker CLI
//     points DOCKER_CONFIG at a job-private dir before its first docker call, installs the pinned
//     Compose into it if it uses Compose (scripts/ci-install-compose.sh), and removes it at the end.
//   - Maestro's vendor installer (get.maestro.mobile.dev) installs into ~/.maestro AND appends an
//     `export PATH=...` line to ~/.bashrc and ~/.zshrc on every run — 644 copies in each by then. It
//     is replaced by scripts/ci-install-maestro.sh into a job-private dir.
//
// The pnpm half of this rule lives in renovate-workflow.guard.test.mjs (pnpmInstallFindings). This
// file holds the rest: no $HOME directory on PATH, nothing written into ~/.local/bin or ~/.docker, the
// Docker config private, and Trivy, Compose and Maestro job-private and removed when the job ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.forgejo/workflows');
const HOST_RUNNERS = new Set(['kvm']);
const JOB_PRIVATE = /^\$\{\{\s*runner\.temp\s*\}\}\//;
const HOME_PATH = /(\$HOME|\$\{HOME\}|~)\//;
const HOME_DOCKER = /(\$HOME|\$\{HOME\}|~)\/\.docker\b/;
// A Docker CLI invocation (`docker info`, `docker compose …`), not prose such as DOCKER_HOST or a
// docker.sock path. In a .mjs script the CLI is spawned by name: spawnSync('docker', …).
const DOCKER_CALL = /(^|[\s;&|(`])docker\s+[a-z]/;
const DOCKER_SPAWN = /['"`]docker['"`]/;
const COMPOSE_CALL = /(^|[\s;&|(`])docker\s+compose\b/;

// Deliberate exemptions from the "no $HOME directory on PATH" rule. Each names the item that removes
// it; the list must only shrink. Keyed `<file> › <job>` → the PATH entry, verbatim. Empty since item
// #1147 moved Maestro under runner.temp.
const HOME_PATH_EXEMPT = new Map();

const executable = (text) => text.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)); // prose is not a call

/** What a step runs, plus the repository scripts it invokes (one level deep). */
function stepText(step, root) {
  const run = String(step?.run ?? '');
  const scripts = [...run.matchAll(/\bscripts\/[\w./-]+\.(?:sh|mjs)\b/g)].map((m) => m[0]);
  const bodies = [...new Set(scripts)]
    .map((p) => resolve(root, p))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'));
  return { run, all: [run, ...bodies].join('\n') };
}

// A quoted string is an argument, not a command: `echo "… docker compose …"` (scripts/cd/scan-push.sh)
// is a message, while `echo "$T" | docker login …` still reads as a call once the quotes are emptied.
const unquoted = (l) => l.replace(/"[^"]*"|'[^']*'/g, '""');
const usesDocker = (text) => executable(text).some((l) => DOCKER_CALL.test(unquoted(l)) || DOCKER_SPAWN.test(l));
const usesCompose = (text) => executable(text).some((l) => COMPOSE_CALL.test(unquoted(l)));

export function sharedStateFindings(dir = WORKFLOW_DIR, root = REPO_ROOT) {
  const findings = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = parseYaml(readFileSync(resolve(dir, file), 'utf8'));
    for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
      if (!HOST_RUNNERS.has(String(def?.['runs-on'] ?? ''))) continue;
      const where = `${file} › ${job}`;
      const steps = def?.steps ?? [];
      const at = (i) => `${where} › step ${i + 1}${steps[i]?.name ? ` (${steps[i].name})` : ''}`;
      const envOf = (step) => ({ ...(doc?.env ?? {}), ...(def?.env ?? {}), ...(step?.env ?? {}) });
      const privateVar = (step, name) => JOB_PRIVATE.test(String(envOf(step)[name] ?? ''));
      const texts = steps.map((s) => stepText(s, root));

      // A job-private dir must be removed by an `if: always()` step that runs after `last` (the last
      // step that still needs it), and that step must see the same job-private value.
      const requireCleanup = (varName, label, last = -1) => {
        const i = steps.findIndex((s) => new RegExp(`rm -rf "\\$${varName}"`).test(String(s?.run ?? '')));
        if (i < 0) return findings.push(`${where}: no step removes "$${varName}" (the job-private ${label})`);
        if (!/always\(\)/.test(String(steps[i].if ?? ''))) findings.push(`${where}: the ${label} cleanup must be \`if: always()\``);
        if (!privateVar(steps[i], varName)) findings.push(`${where}: the ${label} cleanup removes something other than the job-private dir`);
        if (i < last) findings.push(`${at(i)} removes the job-private ${label} before step ${last + 1}, which still uses it`);
      };

      let trivyDirVar = null;
      steps.forEach((step, i) => {
        const { run } = texts[i];
        for (const line of executable(run)) {
          const m = line.match(/echo\s+"?([^">]+?)"?\s*>>\s*"?\$GITHUB_PATH/);
          if (m && HOME_PATH.test(m[1])) {
            const ex = HOME_PATH_EXEMPT.get(where);
            if (!(ex && ex.entry === m[1].trim())) findings.push(`${at(i)} puts a $HOME directory on PATH: ${m[1].trim()}`);
          }
          if (/(\$HOME|\$\{HOME\}|~)\/\.local\/bin/.test(line)) findings.push(`${at(i)} installs into the shared ~/.local/bin: ${line.trim()}`);
          if (HOME_DOCKER.test(line)) findings.push(`${at(i)} uses the shared ~/.docker (CLI plugins, registry logins): ${line.trim()}`);
          if (/get\.maestro\.mobile\.dev/.test(line)) {
            findings.push(`${at(i)} runs Maestro's vendor installer, which installs into ~/.maestro and appends to ~/.bashrc and ~/.zshrc — use ci-install-maestro.sh "$<VAR>"`);
          }
        }
        const install = run.match(/ci-install-trivy\.sh\s+"?\$([A-Z_]+)\/bin"?/);
        if (/ci-install-trivy\.sh/.test(run)) {
          if (!install || !privateVar(step, install[1])) {
            findings.push(`${at(i)} installs Trivy outside a job-private dir — use ci-install-trivy.sh "$<VAR>/bin" with <VAR> under \${{ runner.temp }}`);
          } else {
            trivyDirVar = install[1];
            if (!new RegExp(`TRIVY_CACHE_DIR=\\$${install[1]}/`).test(run) || !/>>\s*"?\$GITHUB_ENV/.test(run)) {
              findings.push(`${at(i)} leaves Trivy's DB cache at its shared default (~/.cache/trivy) — write TRIVY_CACHE_DIR=$${install[1]}/cache to $GITHUB_ENV`);
            }
          }
        }
      });
      if (trivyDirVar) requireCleanup(trivyDirVar, 'Trivy');

      // ── Docker CLI state: DOCKER_CONFIG private from before the first docker call to after the last ──
      const dockerSteps = texts.map((t, i) => (usesDocker(t.all) ? i : -1)).filter((i) => i >= 0);
      const composeSteps = texts.map((t, i) => (usesCompose(t.all) ? i : -1)).filter((i) => i >= 0);
      if (dockerSteps.length) {
        const first = dockerSteps[0];
        const last = dockerSteps[dockerSteps.length - 1];
        const setAt = steps.findIndex((s) => /DOCKER_CONFIG=\$[A-Z_]+"?\s*>>\s*"?\$GITHUB_ENV/.test(String(s?.run ?? '')));
        const cfgVar = setAt >= 0 ? String(steps[setAt].run).match(/DOCKER_CONFIG=\$([A-Z_]+)/)[1] : null;
        if (setAt < 0) {
          findings.push(`${where}: runs the Docker CLI (step ${first + 1}) against the shared ~/.docker — write DOCKER_CONFIG=$<VAR> to $GITHUB_ENV, <VAR> under \${{ runner.temp }}`);
        } else {
          if (!privateVar(steps[setAt], cfgVar)) findings.push(`${at(setAt)} sets DOCKER_CONFIG to something other than a job-private dir`);
          // A docker call in the SAME step as the export still sees the old value: $GITHUB_ENV applies from the next step.
          if (setAt >= first) findings.push(`${at(first)} runs the Docker CLI before DOCKER_CONFIG is private (set in step ${setAt + 1})`);
          requireCleanup(cfgVar, 'Docker config', last);
        }
        if (composeSteps.length) {
          const ci = steps.findIndex((s) => /ci-install-compose\.sh/.test(String(s?.run ?? '')));
          const arg = ci >= 0 ? String(steps[ci].run).match(/ci-install-compose\.sh\s+"?\$([A-Z_]+)"?/)?.[1] : null;
          if (ci < 0) findings.push(`${where}: runs \`docker compose\` (step ${composeSteps[0] + 1}) without the pinned plugin — install it with ci-install-compose.sh "$<DOCKER_CONFIG var>"`);
          else if (!arg || arg !== cfgVar) findings.push(`${at(ci)} installs Compose somewhere other than the job's private DOCKER_CONFIG ($${cfgVar ?? '<unset>'})`);
          else if (ci > composeSteps[0]) findings.push(`${at(composeSteps[0])} runs \`docker compose\` before the pinned plugin is installed (step ${ci + 1})`);
        }
      }

      // ── Maestro: job-private, removed when the job ends ──
      const mi = steps.findIndex((s) => /ci-install-maestro\.sh/.test(String(s?.run ?? '')));
      if (mi >= 0) {
        const mVar = String(steps[mi].run).match(/ci-install-maestro\.sh\s+"?\$([A-Z_]+)"?/)?.[1];
        if (!mVar || !privateVar(steps[mi], mVar)) findings.push(`${at(mi)} installs Maestro outside a job-private dir — use ci-install-maestro.sh "$<VAR>" with <VAR> under \${{ runner.temp }}`);
        else requireCleanup(mVar, 'Maestro');
      }
    }
  }
  return findings;
}

test('no host-runner job writes a tool into, or puts on PATH, the shared $HOME; Trivy, Compose, Maestro and DOCKER_CONFIG are job-private', () => {
  const findings = sharedStateFindings();
  assert.deepEqual(findings, [], `host-runner shared-state violations:\n  ${findings.join('\n  ')}`);
});

test('the scan finds the host-runner installs it guards (not vacuous)', () => {
  for (const f of ['app-ci.yml', 'cd-deploy.yml']) {
    assert.match(readFileSync(resolve(WORKFLOW_DIR, f), 'utf8'), /ci-install-trivy\.sh "\$MCM_TRIVY_DIR\/bin"/, `${f} no longer installs Trivy the guarded way`);
  }
  const appCi = readFileSync(resolve(WORKFLOW_DIR, 'app-ci.yml'), 'utf8');
  assert.equal([...appCi.matchAll(/ci-install-compose\.sh "\$MCM_DOCKER_CONFIG"/g)].length, 4, 'app-ci.yml: expected the pinned Compose in its four compose jobs');
  assert.match(appCi, /ci-install-maestro\.sh "\$MCM_MAESTRO_DIR"/, 'app-ci.yml no longer installs Maestro the guarded way');
  // Every host job that runs the Docker CLI, including the two that `docker login` (build-deploy via
  // scripts/cd/scan-push.sh, build-publish inline). If this count drops, a job lost its private config
  // or stopped using Docker — find out which before changing the number.
  let jobs = 0;
  for (const f of readdirSync(WORKFLOW_DIR).filter((x) => /\.ya?ml$/.test(x))) {
    jobs += [...readFileSync(resolve(WORKFLOW_DIR, f), 'utf8').matchAll(/DOCKER_CONFIG=\$MCM_DOCKER_CONFIG" >> "\$GITHUB_ENV"/g)].length;
  }
  assert.equal(jobs, 7, 'expected a private DOCKER_CONFIG in the 7 host jobs that run the Docker CLI');
});

test('every PATH exemption names the item that removes it, and still exists (the list only shrinks)', () => {
  for (const [where, { entry, item }] of HOME_PATH_EXEMPT) {
    assert.match(item, /^#\d+$/, `${where}: exemption without an item number`);
    const [file] = where.split(' › ');
    assert.ok(readFileSync(resolve(WORKFLOW_DIR, file), 'utf8').includes(entry), `${where}: exempt entry ${entry} is gone — delete the exemption`);
  }
  assert.equal(HOME_PATH_EXEMPT.size, 0, 'item #1147 emptied the exemption list; a new entry needs an item that removes it');
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

  const DENV = '        env:\n          MCM_DOCKER_CONFIG: ${{ runner.temp }}/mcm-docker\n';
  const DCFG =
    '      - name: Private Docker config\n' + DENV + '        run: |\n' +
    '          mkdir -p "$MCM_DOCKER_CONFIG"\n' +
    '          echo "DOCKER_CONFIG=$MCM_DOCKER_CONFIG" >> "$GITHUB_ENV"\n';
  const DCOMPOSE =
    '      - name: Private Docker config + pinned Compose\n' + DENV + '        run: |\n' +
    '          bash scripts/ci-install-compose.sh "$MCM_DOCKER_CONFIG"\n' +
    '          echo "DOCKER_CONFIG=$MCM_DOCKER_CONFIG" >> "$GITHUB_ENV"\n';
  const DUSE = '      - run: docker info\n';
  const DLOGIN = '      - run: echo "$T" | docker login r.example -u u --password-stdin\n';
  const DUP = '      - run: docker compose -p x up -d\n';
  const DCLEAN = '      - if: always()\n' + DENV + '        run: rm -rf "$MCM_DOCKER_CONFIG"\n';

  const MENV = '        env:\n          MCM_MAESTRO_DIR: ${{ runner.temp }}/mcm-maestro\n';
  const MINSTALL =
    '      - name: Install Maestro\n' + MENV + '        run: |\n' +
    '          bash scripts/ci-install-maestro.sh "$MCM_MAESTRO_DIR"\n' +
    '          echo "$MCM_MAESTRO_DIR/bin" >> "$GITHUB_PATH"\n';
  const MCLEAN = '      - if: always()\n' + MENV + '        run: rm -rf "$MCM_MAESTRO_DIR"\n';

  const job = (runsOn, body) => `jobs:\n  j:\n    runs-on: ${runsOn}\n    steps:\n${body}`;
  const cases = [
    ['host + private Trivy + cleanup', job('kvm', GOOD_INSTALL + CLEAN), 0],
    ['container job may use $HOME freely', job('ubuntu-latest', '      - run: |\n          bash scripts/ci-install-trivy.sh "$HOME/.local/bin"\n          echo "$HOME/.local/bin" >> "$GITHUB_PATH"\n          docker compose up -d\n          curl -Ls https://get.maestro.mobile.dev | bash\n'), 0],
    ['host + Trivy into ~/.local/bin', job('kvm', '      - run: |\n          bash scripts/ci-install-trivy.sh "$HOME/.local/bin"\n          echo "$HOME/.local/bin" >> "$GITHUB_PATH"\n'), 1],
    ['host + private binary, shared DB cache', job('kvm', GOOD_INSTALL.replace(/.*TRIVY_CACHE_DIR.*\n/, '') + CLEAN), 1],
    ['host + private Trivy, no cleanup', job('kvm', GOOD_INSTALL), 1],
    ['host + cleanup only on success', job('kvm', GOOD_INSTALL + CLEAN.replace('      - if: always()\n', '      - name: c\n')), 1],
    ['host + Trivy dir var outside runner.temp', job('kvm', GOOD_INSTALL.replace('${{ runner.temp }}/mcm-trivy', '/home/ci/trivy') + CLEAN), 1],
    ['host + any $HOME dir on PATH', job('kvm', '      - run: echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"\n'), 1],

    // Docker config (item #1147)
    ['host + docker with a private config + cleanup', job('kvm', DCFG + DUSE + DLOGIN + DCLEAN), 0],
    ['host + compose with the pinned plugin in the private config + cleanup', job('kvm', DCOMPOSE + DUSE + DUP + DCLEAN), 0],
    ['host + docker against the shared ~/.docker (no DOCKER_CONFIG)', job('kvm', DUSE), 1],
    ['host + docker login against the shared ~/.docker', job('kvm', DLOGIN), 1],
    ['host + DOCKER_CONFIG outside runner.temp', job('kvm', DCFG.replace('${{ runner.temp }}/mcm-docker', '/home/ci/.docker') + DUSE + DCLEAN.replace('${{ runner.temp }}/mcm-docker', '/home/ci/.docker')), 1],
    ['host + docker call BEFORE DOCKER_CONFIG is set', job('kvm', DUSE + DCFG + DCLEAN), 1],
    ['host + private config, no cleanup', job('kvm', DCFG + DUSE), 1],
    ['host + config cleanup only on success', job('kvm', DCFG + DUSE + DCLEAN.replace('      - if: always()\n', '      - name: c\n')), 1],
    ['host + config removed before a later docker step', job('kvm', DCFG + DCLEAN + DUSE), 1],
    ['host + compose plugin written into ~/.docker/cli-plugins', job('kvm', DCFG + '      - run: curl -fsSL https://x/docker-compose -o ~/.docker/cli-plugins/docker-compose\n' + DUP + DCLEAN), 1],
    ['host + docker compose with no pinned plugin', job('kvm', DCFG + DUP + DCLEAN), 1],
    ['host + pinned plugin outside the private config', job('kvm', DCFG + DCOMPOSE.replace('ci-install-compose.sh "$MCM_DOCKER_CONFIG"', 'ci-install-compose.sh "$OTHER_DIR"').replace(/.*DOCKER_CONFIG=.*\n/, '') + DUP + DCLEAN), 1],
    ['host + docker compose before the plugin is installed', job('kvm', DCFG + DUP + '      - env:\n          MCM_DOCKER_CONFIG: ${{ runner.temp }}/mcm-docker\n        run: bash scripts/ci-install-compose.sh "$MCM_DOCKER_CONFIG"\n' + DCLEAN), 1],

    // Maestro (item #1147)
    ['host + private Maestro + cleanup', job('kvm', MINSTALL + MCLEAN), 0],
    ['host + Maestro vendor installer (~/.maestro, ~/.bashrc)', job('kvm', '      - run: |\n          export MAESTRO_DIR="$RUNNER_TEMP/m"\n          curl -Ls https://get.maestro.mobile.dev | bash\n'), 1],
    ['host + Maestro into a dir outside runner.temp', job('kvm', MINSTALL.replace('${{ runner.temp }}/mcm-maestro', '/home/ci/.maestro') + MCLEAN), 1],
    ['host + private Maestro, no cleanup', job('kvm', MINSTALL), 1],
    ['host + Maestro on PATH from $HOME', job('kvm', '      - run: echo "$HOME/.maestro/bin" >> "$GITHUB_PATH"\n'), 1],
  ];
  for (const [label, yml, expected] of cases) {
    for (const f of readdirSync(d)) writeFileSync(resolve(d, f), '');
    writeFileSync(resolve(d, 'w.yml'), yml);
    const n = sharedStateFindings(d).length;
    assert.equal(Math.min(n, 1), expected, `${label}: ${JSON.stringify(sharedStateFindings(d))}`);
  }
});
