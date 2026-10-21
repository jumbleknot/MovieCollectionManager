// No Python image may ship pip in its runtime stage (GHSA-6q48-6c7w-9gw2).
//
// HISTORY. On 2026-10-21 cd-deploy run 5745 stopped at `scan-push` on a fixable Critical in certifi
// 2026.6.17 in agent-gateway — not the app's certifi (already 2026.10.19), but the copy pip VENDORS at
// pip/_vendor/certifi. There were TWO such pips: the python base's own system pip, and pip 26.2.1 in
// /app/.venv, which guardrails-ai declares as a dependency for its hub CLI. Nothing at runtime uses
// either, so the fix removes both rather than chasing each vendored copy with a base bump or an
// allowlist entry.
//
// WHY A GUARD. PR CI never runs cd-deploy's scan on the built app images, so a Dockerfile that loses
// the uninstall (a revert, a copy-pasted new server) fails only AFTER merge — and scan-push fails fast
// in a fixed order, naming one image while several are affected. This names all of them, before CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const pythonDockerfiles = () =>
  globSync('{agents,mcp-servers,backend,frontend}/**/Dockerfile', { cwd: REPO_ROOT })
    .map((p) => ({ path: p, text: readFileSync(resolve(REPO_ROOT, p), 'utf8') }))
    .filter((f) => /^FROM\s+python:/m.test(f.text));

/** The text of the LAST stage — the one that becomes the image. */
const finalStage = (text) => {
  const starts = [...text.matchAll(/^FROM\s/gm)].map((m) => m.index);
  return text.slice(starts.at(-1));
};

test('the glob still finds the four Python images, so the assertions below are not vacuous', () => {
  const found = pythonDockerfiles().map((f) => f.path);
  assert.ok(found.length >= 4, `expected movie-assistant + three MCP servers, found ${found.length}: ${found.join(', ')}`);
});

test('every Python image uninstalls the system pip in its final stage', () => {
  const offenders = pythonDockerfiles()
    .filter((f) => !/^RUN\s+python -m pip uninstall\b[^\n]*\bpip\s*$/m.test(finalStage(f.text)))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(
    offenders,
    [],
    "Dockerfile(s) whose runtime stage keeps the python base's pip, which vendors its own certifi " +
      '(GHSA-6q48-6c7w-9gw2 blocked cd-deploy run 5745). Add `RUN python -m pip uninstall --yes ' +
      '--root-user-action=ignore pip` to the final stage:\n' +
      offenders.map((p) => `  ${p}`).join('\n'),
  );
});

test('a uv sync whose lock carries pip excludes it from the venv', () => {
  // Keyed to the LOCK, not to a project name: whichever project's lock gains pip next is covered.
  const offenders = pythonDockerfiles()
    .filter((f) => {
      const lock = f.text.match(/^COPY\s+(\S+\/)pyproject\.toml\s+\S*uv\.lock/m);
      if (!lock) return false;
      const lockText = readFileSync(resolve(REPO_ROOT, lock[1], 'uv.lock'), 'utf8');
      if (!/^name = "pip"$/m.test(lockText)) return false;
      return !/^RUN\s+uv sync\b[^\n]*--no-install-package pip\b/m.test(f.text);
    })
    .map((f) => f.path)
    .sort();
  assert.deepEqual(
    offenders,
    [],
    'Dockerfile(s) whose uv.lock includes pip (a transitive dependency) but whose `uv sync` installs it ' +
      'into /app/.venv, shipping its vendored certifi. Add `--no-install-package pip`:\n' +
      offenders.map((p) => `  ${p}`).join('\n'),
  );
});
