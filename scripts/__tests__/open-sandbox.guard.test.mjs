// Static guard for scripts/open-sandbox.ps1. The launcher runs only on a Windows host against a live
// Docker Sandbox, so its status logic cannot be exercised in CI; these assertions pin the parts whose
// regression reads as a working launcher pointed at the wrong state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const code = () =>
  readFileSync(fileURLToPath(new URL('../open-sandbox.ps1', import.meta.url)), 'utf8');

test('the sbx ls JSON array is unrolled before filtering by name', () => {
  // Windows PowerShell 5.1's ConvertFrom-Json emits a JSON array as ONE pipeline object. Filtering
  // that by name matches the whole array, `.status` becomes every sandbox's status, and
  // `-eq 'running'` is truthy when ANY sandbox runs. Reproduced 2026-11-23 on 5.1.26100.9818 with
  // `belay` stopped and `mcm` running: the old form read belay's status as "stopped running".
  const c = code();
  assert.match(
    c,
    /ConvertFrom-Json\)\s*\|\s*ForEach-Object\s*\{\s*\$_\s*\}/,
    'unroll the parsed array with ForEach-Object { $_ }',
  );
  assert.match(c, /Where-Object \{ \$_\.name -eq \$Sandbox \}/);
  assert.match(c, /\$entry\.status -eq 'running'/);
});

test('restarts with sbx run --name and reads sbx ls as JSON, never sbx start', () => {
  const c = code();
  assert.match(c, /'run', '--name', \$Sandbox, '-d'/);
  assert.match(c, /'ls', '--format', 'json'/);
  // `sbx start` does not exist; the help block says so, so check executable lines only.
  const executable = c.replace(/<#[\s\S]*?#>/g, '').replace(/#.*$/gm, '');
  assert.doesNotMatch(executable, /\bsbx start\b|'start'/);
});
