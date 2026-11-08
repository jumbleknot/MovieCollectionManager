// Spec 095 — the constitution's formatters stay enforced.
//
// WHAT WENT WRONG. .specify/memory/constitution.md says, per stack, "`cargo fmt` enforced in CI/CD",
// "Prettier enforced in CI/CD" and "`ruff format` (or Black) enforced in CI/CD". Until 2026-11-08 none
// of them was: no workflow and no lint target ran a formatter, Prettier was not even a dependency, and
// drift had piled up (6 Rust files, 83 Python, 415 TypeScript). The rustfmt gotcha had turned the drift
// into a convention — "format only what you touch" — so a rule that read as enforced cost every change
// a review of noise. Nothing failed, because nothing checked the claim.
//
// WHAT THIS PINS. Each formatter runs inside its project's existing `lint` target, which is how it
// reaches CI (`nx affected -t lint` in app-ci; `pnpm nx lint mc-service` in mc-service-checks). If a
// check is removed from a lint command, this fails and names the constitution line it would falsify.
// It does not assert the tree is formatted; the lint targets do that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

function lintCommand(projectDir) {
  const command = JSON.parse(read(`${projectDir}/project.json`))?.targets?.lint?.options?.command;
  assert.equal(typeof command, 'string', `${projectDir} has no \`lint\` command — the check below would pass vacuously`);
  return command;
}

const CONSTITUTION = read('.specify/memory/constitution.md');

const CASES = [
  {
    stack: 'Rust',
    claim: '`cargo fmt` enforced in CI/CD',
    check: /cargo fmt\b[^&|;]*--check/,
    projects: ['backend/mc-service'],
  },
  {
    stack: 'Python',
    claim: '`ruff format` (or Black) enforced in CI/CD',
    check: /ruff format --check/,
    projects: [
      'agents/movie-assistant',
      'mcp-servers/movie-mcp',
      'mcp-servers/web-api-mcp',
      'mcp-servers/spreadsheet-mcp',
    ],
  },
  {
    stack: 'TypeScript',
    claim: 'Prettier enforced in CI/CD',
    check: /prettier --check --ignore-path \.\.\/\.\.\/\.prettierignore/,
    projects: ['frontend/mcm-app', 'packages/design-system'],
  },
];

for (const { stack, claim, check, projects } of CASES) {
  test(`${stack}: the constitution still claims "${claim}"`, () => {
    // If the claim is reworded, this guard's premise changed: update it at the cause, do not delete it.
    assert.ok(CONSTITUTION.includes(claim), `constitution no longer says "${claim}"; revisit this guard`);
  });
  for (const project of projects) {
    test(`${stack}: ${project} lint runs the formatter check`, () => {
      assert.match(
        lintCommand(project),
        check,
        `${project} lint no longer runs its formatter check, which makes the constitution's "${claim}" false (spec 095)`,
      );
    });
  }
}

test('Prettier is pinned exactly, so a formatter release cannot fail CI on untouched code', () => {
  const version = JSON.parse(read('package.json')).devDependencies?.prettier;
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, `root prettier must be an exact version, got ${version}`);
});
