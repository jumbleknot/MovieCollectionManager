// The Python images' /app (virtualenv + source) must not be writable by the user the server runs as.
//
// HISTORY. Feature 034 made the four Python images run as a non-root `app` user and commented them
// "read-only .venv + source at runtime" — while copying /app with `--chown=app:app`, which handed the
// runtime user ownership of both. The comment, and the wiki summary that repeated it, claimed a
// defense-in-depth property the image did not have (item #604). The fix copies /app root-owned; the
// servers bind a port and read code, and write nothing to disk.
//
// WHY A GUARD. Nothing at runtime notices a writable /app, so a revert or a copy-pasted new server
// would silently drop the property again. This fails it before CI builds anything.

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

test('every Python image runs as a non-root user and copies /app without giving it to that user', () => {
  const offenders = [];
  for (const f of pythonDockerfiles()) {
    const stage = finalStage(f.text);
    const user = stage.match(/^USER\s+(\S+)/m)?.[1];
    if (!user || user === 'root' || user === '0') {
      offenders.push(`${f.path}: the final stage has no non-root USER`);
      continue;
    }
    // Any ownership hand-over of /app to the runtime user: COPY --chown, or a chown/chmod RUN.
    if (/^COPY\b[^\n]*--chown=[^\n]*\s\/app\s*$/m.test(stage)) offenders.push(`${f.path}: COPY --chown on /app`);
    if (/^RUN\b[^\n]*\bch(own|mod)\b[^\n]*\/app\b/m.test(stage)) offenders.push(`${f.path}: chown/chmod of /app`);
  }
  assert.deepEqual(
    offenders,
    [],
    'Python image(s) whose /app is writable by the runtime user (item #604). Copy it root-owned — ' +
      '`COPY --from=build /app /app` — and point any genuine runtime write at /tmp instead:\n' +
      offenders.map((o) => `  ${o}`).join('\n'),
  );
});
