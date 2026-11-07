// Feature 087 (FR-010, FR-020; contracts/android.md "Release shrinking guard").
//
// The release APK must build with R8 shrinking OFF until item #937 turns it on deliberately. SDK 58's
// template turns `enableMinifyInReleaseBuilds` ON by default, so an ABSENT setting is as wrong as `true`:
// both would ship a shrunk binary nobody has tested, and R8 strips classes reached only by reflection,
// which shows up as a crash on a device rather than a build error.
//
// The check reads `frontend/mcm-app/app.json` itself, and each failure is proven on a synthetic input so
// the guard cannot pass by reading nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_JSON = resolve(REPO, 'frontend/mcm-app/app.json');
const ITEM = 'Turning release shrinking on is a separate change: item #937.';

/** Returns null when release shrinking is explicitly off, otherwise the reason it is not. */
function shrinkingProblem(appJson) {
  const plugins = appJson?.expo?.plugins;
  if (!Array.isArray(plugins)) return `app.json has no expo.plugins array. ${ITEM}`;
  const entry = plugins.find((p) => p === 'expo-build-properties' || (Array.isArray(p) && p[0] === 'expo-build-properties'));
  if (!entry) {
    return `expo-build-properties is absent from app.json, so SDK 58's default (shrinking ON) applies. ${ITEM}`;
  }
  const value = Array.isArray(entry) ? entry[1]?.android?.enableMinifyInReleaseBuilds : undefined;
  if (value !== false) {
    return `expo-build-properties sets android.enableMinifyInReleaseBuilds to ${JSON.stringify(value)}, not false. ${ITEM}`;
  }
  return null;
}

const withPlugins = (plugins) => ({ expo: { plugins } });

test('(087) the app ships its release APK with R8 shrinking explicitly OFF', () => {
  const problem = shrinkingProblem(JSON.parse(readFileSync(APP_JSON, 'utf8')));
  assert.equal(problem, null, problem ?? '');
});

test('(087) control: an ABSENT expo-build-properties fails, because the SDK 58 default is on', () => {
  const problem = shrinkingProblem(withPlugins(['expo-router']));
  assert.match(problem ?? '', /absent/);
  assert.match(problem ?? '', /item #937/);
});

test('(087) control: enableMinifyInReleaseBuilds true fails', () => {
  const problem = shrinkingProblem(withPlugins([['expo-build-properties', { android: { enableMinifyInReleaseBuilds: true } }]]));
  assert.match(problem ?? '', /true/);
  assert.match(problem ?? '', /item #937/);
});

test('(087) control: the plugin listed without options fails, since nothing sets the value', () => {
  assert.notEqual(shrinkingProblem(withPlugins(['expo-build-properties'])), null);
});

test('(087) control: enableMinifyInReleaseBuilds false passes', () => {
  assert.equal(shrinkingProblem(withPlugins([['expo-build-properties', { android: { enableMinifyInReleaseBuilds: false } }]])), null);
});
