// Feature 089: the assistant raises no blocked `eval` probes. Each zod 4 engine in the assistant chunk
// probes once, unless it is the app's copy with `jitless` set. These two facts keep that true, and each
// would fail silently otherwise: the app works either way, and the browser just logs another violation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The browser's entry into the AG-UI stack. @copilotkit/runtime is the BFF's, and is not followed. */
export const BROWSER_ENTRY = '@copilotkit/react-native';

const unquote = (s) => s.trim().replace(/^'(.*)'$/, '$1');

/**
 * The lock file's snapshot graph: `name@version(peers)` → its dependencies, as `name@version(peers)`
 * keys. Also returns the version each importer resolved for each of its direct dependencies.
 */
export function snapshotGraph(lockText) {
  const graph = new Map();
  const importers = new Map();
  let section = '';
  let current = null;
  let importer = null;
  let directName = null;
  let inDeps = false;
  for (const line of lockText.split('\n')) {
    if (/^[a-zA-Z]/.test(line)) {
      section = line.replace(/:.*$/, '');
      continue;
    }
    if (section === 'snapshots') {
      const entry = /^ {2}(\S.*):$/.exec(line);
      if (entry) {
        current = unquote(entry[1]);
        graph.set(current, []);
        inDeps = false;
      } else if (/^ {4}\S/.test(line)) {
        inDeps = /^ {4}(dependencies|optionalDependencies):$/.test(line);
      } else if (current && inDeps) {
        const dep = /^ {6}('[^']+'|[^:\s]+): (.+)$/.exec(line);
        if (dep) graph.get(current).push(`${unquote(dep[1])}@${dep[2].trim()}`);
      }
    } else if (section === 'importers') {
      const imp = /^ {2}(\S.*):$/.exec(line);
      if (imp) {
        importer = unquote(imp[1]);
        importers.set(importer, new Map());
        continue;
      }
      const name = /^ {6}('[^']+'|[^:\s]+):$/.exec(line);
      if (name) directName = unquote(name[1]);
      const version = /^ {8}version: (.+)$/.exec(line);
      if (importer && directName && version) importers.get(importer).set(directName, version[1].trim());
    }
  }
  return { graph, importers };
}

/** The @ag-ui/core copies that the @ag-ui/client snapshots REACHABLE from `rootKey` depend on. */
export function agUiCoreOfReachableClient(graph, rootKey) {
  const found = [];
  const seen = new Set();
  const queue = [rootKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key) || !graph.has(key)) continue;
    seen.add(key);
    for (const dep of graph.get(key)) {
      if (key.startsWith('@ag-ui/client@') && dep.startsWith('@ag-ui/core@')) {
        found.push(dep.slice('@ag-ui/core@'.length));
      }
      queue.push(dep);
    }
  }
  return found;
}

test('agUiCoreOfReachableClient follows the browser entry, not the BFF-only copies', () => {
  const lock = [
    'importers:',
    '  frontend/mcm-app:',
    '    dependencies:',
    "      '@copilotkit/react-native':",
    '        specifier: 1.87.1',
    '        version: 1.87.1(abc)',
    'packages:',
    "  '@ag-ui/client@1.0.2':",
    "      '@ag-ui/core': 0.0.0",
    'snapshots:',
    "  '@copilotkit/react-native@1.87.1(abc)':",
    '    dependencies:',
    "      '@ag-ui/client': 1.0.2",
    "  '@ag-ui/client@1.0.2':",
    '    dependencies:',
    "      '@ag-ui/core': 1.0.2(zod@4.6.7)",
    "  '@ag-ui/core@1.0.2(zod@4.6.7)':",
    '    dependencies:',
    '      zod: 4.6.7',
    "  '@copilotkit/core@1.89.0':",
    '    dependencies:',
    "      '@ag-ui/client': 1.0.5(zod@3.25.76)",
    "  '@ag-ui/client@1.0.5(zod@3.25.76)':",
    '    dependencies:',
    "      '@ag-ui/core': 1.0.5(zod@3.25.76)",
  ].join('\n');
  const { graph, importers } = snapshotGraph(lock);
  const version = importers.get('frontend/mcm-app').get(BROWSER_ENTRY);
  assert.equal(version, '1.87.1(abc)');
  assert.deepEqual(agUiCoreOfReachableClient(graph, `${BROWSER_ENTRY}@${version}`), ['1.0.2(zod@4.6.7)']);
  // The same zod 3 copy, once the browser entry reaches it, is caught.
  graph.get(`${BROWSER_ENTRY}@1.87.1(abc)`).push('@copilotkit/core@1.89.0');
  assert.deepEqual(agUiCoreOfReachableClient(graph, `${BROWSER_ENTRY}@1.87.1(abc)`), [
    '1.0.2(zod@4.6.7)',
    '1.0.5(zod@3.25.76)',
  ]);
});

// @copilotkit/runtime keeps a zod 3 copy of @ag-ui/core on purpose: it runs only in the BFF. Since
// 2026-11-20 its @copilotkit/channels-* dependencies also pull a zod 3 copy of @ag-ui/client (through
// @copilotkit/core 1.89), so the guard follows the browser's entry rather than every client snapshot.
test('@ag-ui/client uses the zod 4 copy of @ag-ui/core, so the browser has one probing engine', () => {
  const { graph, importers } = snapshotGraph(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'));
  const version = importers.get('frontend/mcm-app')?.get(BROWSER_ENTRY);
  assert.ok(version, `frontend/mcm-app has no ${BROWSER_ENTRY} in the lock file: this guard is reading the wrong thing`);
  const copies = agUiCoreOfReachableClient(graph, `${BROWSER_ENTRY}@${version}`);
  assert.ok(copies.length > 0, `no @ag-ui/client reachable from ${BROWSER_ENTRY}: this guard is reading the wrong thing`);
  assert.deepEqual(
    copies.filter((copy) => !copy.includes('(zod@4')),
    [],
    'see the @ag-ui overrides in pnpm-workspace.yaml',
  );
});

test('the assistant chunk sets jitless before anything else it imports', () => {
  const panel = readFileSync(
    join(ROOT, 'frontend/mcm-app/src/components/agent/assistant-panel.tsx'),
    'utf8',
  );
  const firstImport = panel.split('\n').find((line) => line.startsWith('import '));
  assert.equal(firstImport, "import '@/utils/zod-jitless';");
});
