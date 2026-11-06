// Feature 089: the assistant raises no blocked `eval` probes. Each zod 4 engine in the assistant chunk
// probes once, unless it is the app's copy with `jitless` set. These two facts keep that true, and each
// would fail silently otherwise: the app works either way, and the browser just logs another violation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The @ag-ui/core copy that the lock file's @ag-ui/client snapshots depend on. */
export function agUiCoreOfClient(lockText) {
  const found = [];
  let inSnapshots = false;
  let inClient = false;
  for (const line of lockText.split('\n')) {
    if (/^[a-zA-Z]/.test(line)) inSnapshots = line.startsWith('snapshots:');
    if (/^ {2}\S/.test(line)) inClient = inSnapshots && /^ {2}'@ag-ui\/client@/.test(line);
    const core = inClient && /^ {6}'@ag-ui\/core': (.+)$/.exec(line);
    if (core) found.push(core[1]);
  }
  return found;
}

test('agUiCoreOfClient reads only the client snapshots', () => {
  const lock = [
    'packages:',
    "  '@ag-ui/client@1.0.2':",
    "      '@ag-ui/core': 0.0.0",
    'snapshots:',
    "  '@ag-ui/client@1.0.2':",
    '    dependencies:',
    "      '@ag-ui/core': 1.0.2(zod@4.6.7)",
    "  '@copilotkit/runtime@1.79.1':",
    '    dependencies:',
    "      '@ag-ui/core': 1.0.2(zod@3.25.76)",
  ].join('\n');
  assert.deepEqual(agUiCoreOfClient(lock), ['1.0.2(zod@4.6.7)']);
});

// @copilotkit/runtime keeps a zod 3 copy of @ag-ui/core on purpose: it runs only in the BFF.
test('@ag-ui/client uses the zod 4 copy of @ag-ui/core, so the browser has one probing engine', () => {
  const copies = agUiCoreOfClient(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'));
  assert.ok(copies.length > 0, 'no @ag-ui/client snapshot found: this guard is reading the wrong thing');
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
