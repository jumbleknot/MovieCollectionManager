/**
 * Tamagui moves as ONE version — feature 081 US10 (T072, FR-019, research R12).
 *
 * Why this exists. Tamagui publishes several patches a day (19 stable 3.0.x patches in six days) and
 * its packages must all be the same version: guide §1 says to leave no duplicate `@tamagui/core`,
 * `@tamagui/web` or `tamagui` in the lock, and `@tamagui/static` itself runs a version-consistency
 * check. Before US10 the set was held together by luck: `^2.3.0` ranges in two manifests, and an open
 * `@tamagui/font-inter >=2.0.0` devDependency that a lock regeneration (d79a994e, 2026-10-16) silently
 * resolved to 3.0.13 — dragging `@tamagui/core@3.0.13` and 20 v3 internals in beside 2.7.7 with no
 * Renovate PR and no review. That is the failure this guard pins shut:
 *
 *   (a) every `tamagui` / `@tamagui/*` specifier in the two workspace manifests is one EXACT version,
 *       and both manifests agree — a range lets a partial lock refresh split the set;
 *   (b) the lock holds exactly one version of `@tamagui/core` and `@tamagui/web`, and at most one of
 *       `tamagui` (none once it is not declared anywhere);
 *   (c) the removed v2 Babel compiler plugin is named by neither manifest nor babel.config.js — v3 has
 *       no 3.x of it, so a leftover entry would keep a v2 compiler running over v3 sources;
 *   (d) resolved through the SAME Renovate model renovate-workflow.guard.test.mjs uses, every
 *       `tamagui` / `@tamagui/*` update — major, minor and patch — lands in ONE `tamagui` group, so
 *       the bot cannot propose half of the set (the nx half-bump lesson, items #194/#204).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvedGroupName } from '../lib/renovate-package-rules.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const MANIFESTS = ['frontend/mcm-app/package.json', 'packages/design-system/package.json'];
const isTamagui = (name) => name === 'tamagui' || name.startsWith('@tamagui/');
const EXACT = /^\d+\.\d+\.\d+$/;
const BABEL_PLUGIN = '@tamagui/babel-plugin';

/** Every tamagui specifier in one manifest, as [section, name, spec]. */
function tamaguiSpecifiers(rel) {
  const pkg = JSON.parse(read(rel));
  const out = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (isTamagui(name)) out.push({ manifest: rel, section, name, spec });
    }
  }
  return out;
}

const specifiers = MANIFESTS.flatMap(tamaguiSpecifiers);
const installed = specifiers.filter((s) => s.section !== 'peerDependencies');

test('(a) every tamagui / @tamagui/* dependency in both manifests is one EXACT version, and they agree', () => {
  assert.ok(installed.length > 0, 'no tamagui dependency found in either manifest — the guard is reading the wrong files');
  const shown = installed.map((s) => `    ${s.manifest} ${s.section}.${s.name} = ${JSON.stringify(s.spec)}`).join('\n');

  const ranged = installed.filter((s) => !EXACT.test(s.spec));
  assert.deepEqual(
    ranged.map((s) => `${s.manifest} ${s.section}.${s.name} = ${s.spec}`),
    [],
    `tamagui specifiers must be EXACT versions (no ^, ~, >=, *):\n${shown}\n` +
      '  A range lets a partial lock refresh resolve part of the set to a newer patch (or major) —\n' +
      '  the open `@tamagui/font-inter >=2.0.0` range is how 3.0.13 entered the lock beside 2.7.7.',
  );

  const versions = [...new Set(installed.map((s) => s.spec))];
  assert.equal(versions.length, 1, `the tamagui set is split across ${versions.length} versions:\n${shown}`);
});

test('(a) a tamagui PEER range, if declared, is bounded to the installed major', () => {
  const peers = specifiers.filter((s) => s.section === 'peerDependencies');
  const version = installed.find((s) => EXACT.test(s.spec))?.spec;
  for (const peer of peers) {
    const major = Number(version?.split('.')[0]);
    assert.equal(
      peer.spec,
      `>=${major}.0.0 <${major + 1}`,
      `${peer.manifest} peerDependencies.${peer.name} = ${JSON.stringify(peer.spec)} — an open peer range admits the ` +
        `next major without review; bound it to the installed major (>=${major}.0.0 <${major + 1}) or drop it with the dependency.`,
    );
  }
});

/** name -> Set(version), from every `name@version` key in pnpm-lock.yaml's packages and snapshots. */
function lockVersions() {
  const versions = new Map();
  const key = /^ {2}'?((?:@tamagui\/[^@'\s]+)|tamagui)@(\d[^('\s:]*)/gm;
  for (const m of read('pnpm-lock.yaml').matchAll(key)) {
    if (!versions.has(m[1])) versions.set(m[1], new Set());
    versions.get(m[1]).add(m[2]);
  }
  return versions;
}

test('(b) pnpm-lock.yaml holds exactly one @tamagui/core, one @tamagui/web, and at most one tamagui', () => {
  const versions = lockVersions();
  const show = (name) => [...(versions.get(name) ?? [])].sort().join(', ') || '(none)';
  for (const name of ['@tamagui/core', '@tamagui/web']) {
    assert.equal(
      versions.get(name)?.size ?? 0,
      1,
      `pnpm-lock.yaml has ${name} at: ${show(name)}. Exactly ONE copy is required (Tamagui guide §1) — two cores ` +
        'means two style registries and a theme the second copy never sees.',
    );
  }
  const declared = installed.some((s) => s.name === 'tamagui');
  assert.equal(
    versions.get('tamagui')?.size ?? 0,
    declared ? 1 : 0,
    `pnpm-lock.yaml has tamagui at: ${show('tamagui')}, and a manifest ${declared ? 'declares' : 'does NOT declare'} it.`,
  );
});

test('(b) every @tamagui/* package in the lock sits at the manifests\' one version', () => {
  const version = installed.find((s) => EXACT.test(s.spec))?.spec;
  const stray = [];
  for (const [name, set] of lockVersions()) {
    for (const v of set) if (v !== version) stray.push(`${name}@${v}`);
  }
  assert.deepEqual(stray.sort(), [], `lock entries not at the manifests' version ${version}`);
});

test('(c) the removed v2 Babel compiler plugin is gone from both manifests and babel.config.js', () => {
  const offenders = [];
  for (const rel of MANIFESTS) {
    if (installed.some((s) => s.manifest === rel && s.name === BABEL_PLUGIN)) offenders.push(rel);
  }
  if (read('frontend/mcm-app/babel.config.js').includes(BABEL_PLUGIN)) offenders.push('frontend/mcm-app/babel.config.js');
  assert.deepEqual(
    offenders,
    [],
    `${BABEL_PLUGIN} has no 3.x (Tamagui guide §1, removed package); v3 compiles through @tamagui/metro-plugin in ` +
      'metro.config.js. Still named in:',
  );
});

test('(d) every tamagui / @tamagui/* update resolves to ONE `tamagui` group on every update type', () => {
  const packageRules = JSON.parse(read('renovate.json')).packageRules ?? [];
  const names = [...new Set(installed.map((s) => s.name))].sort();
  const rows = [];
  for (const updateType of ['patch', 'minor', 'major']) {
    for (const s of installed) {
      rows.push({
        label: `${s.manifest} ${s.name} (${updateType})`,
        group: resolvedGroupName(packageRules, {
          manager: 'npm',
          datasource: 'npm',
          packageFile: s.manifest,
          depName: s.name,
          updateType,
        }),
      });
    }
  }
  const shown = rows.map((r) => `    ${r.label.padEnd(70)} group=${JSON.stringify(r.group)}`).join('\n');
  assert.ok(names.length > 0);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.group))],
    ['tamagui'],
    `Tamagui updates do not all resolve to the \`tamagui\` group:\n${shown}\n` +
      '  The rule must sit AFTER `js patch/minor` and `js majors` (last matching groupName wins), or those pull\n' +
      '  part of the set back onto its own branch.',
  );

  // Control: an unrelated npm package still lands in the broad groups, so the rule is not a catch-all.
  const control = (updateType) =>
    resolvedGroupName(packageRules, {
      manager: 'npm',
      datasource: 'npm',
      packageFile: 'frontend/mcm-app/package.json',
      depName: 'axios',
      updateType,
    });
  assert.equal(control('patch'), 'js patch/minor');
  assert.equal(control('major'), 'js majors (review individually)');
});
