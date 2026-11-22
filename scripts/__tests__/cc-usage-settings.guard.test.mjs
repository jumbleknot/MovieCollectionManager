// Guard (feature 105; US1-AC1, FR-001): the committed .claude/settings.json carries exactly the three
// capture hooks of contracts/hooks-and-skill.md (key spellings confirmed by T001, research "Spike
// results" (b)), and the plugin keys are exactly the intended set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
const COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/cc-usage.mjs" hook';

test('exactly three hook events, each one command hook running cc-usage.mjs hook', () => {
  assert.ok(settings.hooks?.SessionStart, 'missing hooks.SessionStart');
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop']);
  assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', async: true, command: COMMAND }] }]);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', async: true, command: COMMAND }] }]);
  assert.deepEqual(settings.hooks.SessionEnd, [{ hooks: [{ type: 'command', timeout: 10, command: COMMAND }] }]);
});

test('no statusline is committed (the usage statusline is opt-in, research R14)', () => {
  assert.equal(settings.statusLine, undefined);
});

test('the plugin keys are exactly the intended set', () => {
  // Snapshot of origin/main's values when feature 105 added the hooks block (2026-11-21), minus the
  // Nx plugin, removed 2026-11-22: an unpinned third-party marketplace with zero calls across 73
  // measured sessions (host + dev container). A plugin added or removed here must update this list
  // in the same change, so no marketplace slips into every contributor's session unreviewed.
  assert.deepEqual(settings.extraKnownMarketplaces, {
    'callstack-agent-skills': { source: { source: 'github', repo: 'callstackincubator/agent-skills' } },
  });
  assert.deepEqual(settings.enabledPlugins, {
    'building-react-native-apps@callstack-agent-skills': true,
  });
  assert.deepEqual(Object.keys(settings).sort(), ['enabledPlugins', 'extraKnownMarketplaces', 'hooks']);
});
