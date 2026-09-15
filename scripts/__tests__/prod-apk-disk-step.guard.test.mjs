// Item #457 — the `prod-apk` disk step, pinned so the no-op cannot come back and the
// obvious-looking "fix" for it cannot land either.
//
// What stood here was a "Free disk space" step copied from a GitHub-hosted-runner recipe:
//
//     sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/.ghcup /usr/share/swift \
//       /usr/local/share/powershell /usr/local/lib/node_modules || true
//     df -h /
//
// It freed nothing on any run it ever made, and the step still went green — `sudo` is not installed
// in the job container, the blanket `|| true` swallowed the non-zero exit, and `df -h /` printed a
// healthy line straight afterwards. The only output it has ever produced is the digest for run 3409:
// `/dev/stdin: line 1: sudo: command not found`.
//
// Two facts make this worth a test rather than a comment, and they pull in OPPOSITE directions:
//
//   1. `runs-on: ubuntu-latest` on this forge is `--label ubuntu-latest:docker://node:22-bookworm`
//      (docs/runbooks/Server-Setup-Runbook.md:588) — a plain Node image running as root. `sudo` is
//      absent from it and from every other runner here (the kvm runner executes as the unprivileged
//      `ci` user, which has no sudo either). So no workflow step may invoke it, anywhere.
//
//   2. Dropping `sudo` — the reflex fix, and the one a reader who only knows fact 1 will reach for —
//      is WORSE than the no-op. Measured 2026-09-15 with `docker run --rm node:22-bookworm`: five of
//      the six paths do not exist in the image, and the sixth, /usr/local/lib/node_modules (19 MB),
//      holds `corepack` and `npm`. `pnpm/action-setup` runs two steps later and resolves pnpm through
//      corepack, so a working `rm -rf` would break the job — to reclaim 19 MB of a 914 GB disk, and
//      not even that, since deleting files from an image's lower layers writes whiteouts to the
//      container layer and host usage goes UP.
//
// Fact 2 is the one that is invisible from the diff, so it is asserted here explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.forgejo/workflows');

const load = (rel) => parseYaml(readFileSync(join(WORKFLOW_DIR, rel), 'utf8'));
const runText = (step) => (typeof step?.run === 'string' ? step.run : '');
const workflowFiles = () => readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

/** Every `run:` block in a workflow, paired with enough context to name it in a failure. */
function* allRunSteps(file) {
  const wf = load(file);
  for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      const run = runText(step);
      if (run) yield { file, job: jobName, name: step.name ?? '(unnamed)', run };
    }
  }
}

const prodApkDiskStep = () => {
  const steps = (load('cd-deploy.yml')?.jobs?.['prod-apk']?.steps ?? []).filter((s) =>
    runText(s).includes('df -h'),
  );
  assert.equal(steps.length, 1, 'expected exactly one disk-reporting step in the prod-apk job');
  return steps[0];
};

test('no workflow step invokes sudo — no runner here provides it (item #457, AC5)', () => {
  const offenders = [];
  for (const file of workflowFiles()) {
    for (const step of allRunSteps(file)) {
      // Word-boundary match so a path or a prose mention inside an echo is not a false positive;
      // what this catches is `sudo` in command position.
      if (/(^|[\n;&|(]\s*)sudo\s/.test(step.run)) {
        offenders.push(`${step.file} :: ${step.job} :: ${step.name}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `sudo is not installed on any runner used here — the step dies on its first word and, if it is\n` +
      `\`|| true\`-guarded, does so silently. Offending steps:\n  ${offenders.join('\n  ')}`,
  );
});

test('the prod-apk disk step never deletes /usr/local/lib/node_modules (item #457)', () => {
  const step = prodApkDiskStep();
  assert.ok(
    !/rm\s+-[a-z]*r[a-z]*f?[^\n]*\/usr\/local\/lib\/node_modules/.test(step.run),
    'That directory holds corepack and npm in node:22-bookworm, and pnpm/action-setup resolves ' +
      'pnpm through corepack two steps later. Removing it breaks the job to reclaim 19 MB of a ' +
      '914 GB disk — and writes whiteouts to the container layer, so host usage rises.',
  );
});

test('the prod-apk disk step does not reclaim at all, and does not swallow a failure (item #457)', () => {
  const step = prodApkDiskStep();

  // AC1: it either frees space or it is honest about not doing so. It does not sit there as a no-op.
  assert.ok(
    !/\brm\s+-/.test(step.run),
    'this step reports only; it must not attempt a reclamation it cannot perform in node:22-bookworm',
  );

  // AC3: the blanket `|| true` is what turned "sudo: command not found" into a green tick.
  assert.ok(
    !/\|\|\s*true/.test(step.run),
    'no `|| true` here — a failing df must fail the step rather than print reassurance',
  );

  // AC4: a reader of the digest must be told, in words, that nothing was reclaimed.
  assert.match(
    step.run,
    /No reclamation is attempted here/,
    'the step must state plainly in its own output that there was nothing to reclaim',
  );
  assert.match(step.name ?? '', /nothing to reclaim/i, 'the step NAME must not promise a reclamation');
});
