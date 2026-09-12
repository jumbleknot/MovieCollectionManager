// Guard: every REQUIRED variable a prod compose declares must be supplied to that stack.
//
// WHY THIS EXISTS (feature 069, PR #422 → prod-observability deploy failure):
//
//   error while interpolating services.langfuse-minio.image:
//     required variable REGISTRY_HOST is missing a value: set in observability/.env.prod
//
// Feature 069 repointed observability's MinIO refs from the public `minio/minio` to
// `${REGISTRY_HOST}/jumbleknot/minio`. That made the observability stack the FOURTH consumer of
// REGISTRY_HOST — but `komodo/stacks.toml` only declared it for the other three. Komodo writes each
// stack's `environment` block into its `env_file_path`, so a variable absent there is absent at
// `docker compose config` time and the `:?` guard fires. Nothing in CI could see it: the compose
// files are valid, the image exists, and the local stack works because `stacks/observability.env`
// supplies REGISTRY_HOST for the DEV compose. The break is only visible on a real Komodo deploy.
//
// The failure is structural, not a typo: adding a `${VAR:?}` to a prod compose is a change to that
// stack's REQUIRED INPUTS, and the only place those inputs are declared is stacks.toml. This guard
// makes that coupling mechanical instead of remembered.
//
// Deliberately scoped to the `${VAR:?...}` form only. An optional `${VAR}` or `${VAR:-default}` is
// by definition allowed to be absent, and gating those would flag every tunable in the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TOML = 'infrastructure-as-code/komodo/stacks.toml';

/** Parse stacks.toml into { name, runDir, files[], provided:Set } per `[[stack]]`. */
export function parseStacks(toml) {
  return toml
    .split(/^\[\[stack\]\]/m)
    .slice(1)
    .map((b) => {
      const pick = (re) => (b.match(re) || [])[1];
      const envBlock = pick(/^environment\s*=\s*"""([\s\S]*?)"""/m) ?? '';
      const fileList = pick(/^file_paths\s*=\s*\[([^\]]*)\]/m) ?? '';
      const extraList = pick(/^additional_env_files\s*=\s*\[([^\]]*)\]/m) ?? '';
      const split = (s) =>
        s
          .split(',')
          .map((x) => x.trim().replace(/"/g, ''))
          .filter(Boolean);
      return {
        name: pick(/^name\s*=\s*"([^"]+)"/m),
        runDir: pick(/^run_directory\s*=\s*"([^"]+)"/m),
        files: split(fileList),
        additionalEnvFiles: split(extraList),
        provided: new Set([...envBlock.matchAll(/^([A-Z0-9_]+)\s*=/gm)].map((m) => m[1])),
      };
    })
    .filter((s) => s.name && s.runDir);
}

/**
 * Required variables in a compose file: the `${VAR:?...}` form ONLY.
 *
 * Comment lines are stripped first. stacks.toml and the compose files both document the pattern in
 * prose (`image: ${REGISTRY_HOST}/jumbleknot/<svc>@${<SVC>_DIGEST}`), and counting a documentation
 * example as a real requirement produces a finding for a variable named `VAR` that nothing supplies
 * — which is exactly the false positive this comment exists to stop someone re-deriving.
 */
export function requiredVars(composeText) {
  const code = composeText
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  return new Set([...code.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]));
}

/** Variables a stack receives from committed `additional_env_files` (e.g. cd-deploy's .env.deploy). */
function varsFromAdditionalEnvFiles(stack) {
  const out = new Set();
  for (const rel of stack.additionalEnvFiles) {
    const p = join(stack.runDir, rel);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/^([A-Z0-9_]+)\s*=/gm)) out.add(m[1]);
  }
  return out;
}

test('every required variable in a prod compose is supplied by its Komodo stack', () => {
  const stacks = parseStacks(readFileSync(TOML, 'utf8'));
  assert.ok(stacks.length > 0, 'parsed no stacks from stacks.toml — the parser or the file shape changed');

  const gaps = [];
  for (const stack of stacks) {
    const fromDeploy = varsFromAdditionalEnvFiles(stack);
    for (const file of stack.files) {
      const path = join(stack.runDir, file);
      if (!existsSync(path)) continue;
      for (const v of requiredVars(readFileSync(path, 'utf8'))) {
        if (stack.provided.has(v) || fromDeploy.has(v)) continue;
        gaps.push(`${stack.name}: ${path} requires \${${v}:?…} but neither its environment block nor its additional_env_files supply it`);
      }
    }
  }

  assert.deepEqual(gaps, [], `\n${gaps.join('\n')}\n`);
});

test('the guard detects a removed variable (it is not vacuously green)', () => {
  // Instrument check. A guard that passes because it parsed nothing is the failure mode this whole
  // test file was written about, so prove it fails on the exact state that broke prod.
  const toml = readFileSync(TOML, 'utf8');
  const broken = toml.replace('REGISTRY_HOST=[[REGISTRY_HOST]]\nLANGFUSE_SALT=', 'LANGFUSE_SALT=');
  assert.notEqual(broken, toml, 'fixture did not change — the prod-observability env block moved');

  const stack = parseStacks(broken).find((s) => s.name === 'prod-observability');
  assert.ok(stack, 'prod-observability not found in stacks.toml');
  assert.equal(stack.provided.has('REGISTRY_HOST'), false, 'fixture still supplies REGISTRY_HOST');

  const compose = readFileSync(join(stack.runDir, 'compose.prod.yaml'), 'utf8');
  assert.equal(requiredVars(compose).has('REGISTRY_HOST'), true, 'compose.prod.yaml no longer requires REGISTRY_HOST');
});

test('a documentation example is not counted as a requirement', () => {
  // The `VAR` false positive: a commented pattern must not become a finding.
  assert.equal(requiredVars('# image: ${VAR:?example}\nfoo: bar\n').size, 0);
  assert.equal(requiredVars('image: ${REAL:?set it}\n').has('REAL'), true);
});
