// Guards scripts/prune-bff-runtime-modules.mjs — the closure walk that shrinks the shipped BFF
// runtime tree (item #249). The failure mode this protects against is silent: a walk that returns
// too little prunes a package the runtime lazily requires, and the symptom is one route 500ing in
// production rather than a red build. So the fixture is a real pnpm-shaped symlink tree, including
// the scoped-package and dangling-optional-link shapes the deployed tree actually contains.
import { strict as assert } from 'node:assert';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DYNAMIC_ROOTS,
  KNOWN_DYNAMIC_SPECIFIERS,
  STATIC_ROOTS,
  checkBundle,
  computeClosure,
  depsRootOf,
  extractDynamicSpecifiers,
  packageNameOf,
  packageNamesIn,
  planPrune,
  pnpmEntryOf,
  prune,
} from '../prune-bff-runtime-modules.mjs';

let root;
let nmDir;

/** Build a pnpm-isolated-layout fixture: `.pnpm/<entry>/node_modules/<name>` + dep symlinks. */
function makePackage(entry, name) {
  const dir = join(nmDir, '.pnpm', entry, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  return dir;
}

function linkDep(fromEntry, fromName, depName, toEntry) {
  const depsRoot = join(nmDir, '.pnpm', fromEntry, 'node_modules');
  const linkPath = join(depsRoot, depName);
  mkdirSync(join(linkPath, '..'), { recursive: true });
  const up = depName.includes('/') ? '../../..' : '../..';
  symlinkSync(`${up}/${toEntry}/node_modules/${depName}`, linkPath);
}

function linkTopLevel(name, entry) {
  const linkPath = join(nmDir, name);
  mkdirSync(join(linkPath, '..'), { recursive: true });
  const prefix = name.includes('/') ? '../.pnpm' : '.pnpm';
  symlinkSync(`${prefix}/${entry}/node_modules/${name}`, linkPath);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-bff-'));
  nmDir = join(root, 'node_modules');
  mkdirSync(join(nmDir, '.pnpm'), { recursive: true });

  makePackage('express@4.22.2_supports-color@8.1.1', 'express');
  makePackage('ms@2.1.3', 'ms');
  makePackage('@expo+server@0.5.3_supports-color@8.1.1', '@expo/server');
  makePackage('undici@6.28.0', 'undici');
  makePackage('mermaid@11.17.2', 'mermaid');
  makePackage('lucide-react@0.542.0_react@19.2.3', 'lucide-react');
  makePackage('openai@6.49.0', 'openai');

  linkDep('express@4.22.2_supports-color@8.1.1', 'express', 'ms', 'ms@2.1.3');
  // @expo/server -> undici is the reach that keeps the AI SDK's lazy `createRequire(...)("undici")`
  // working after the prune; it is a scoped package's dep, so it exercises the `../../..` depth.
  linkDep('@expo+server@0.5.3_supports-color@8.1.1', '@expo/server', 'undici', 'undici@6.28.0');
  // A dangling optional-dependency link must not abort the walk.
  symlinkSync(
    '../../lightningcss-linux-x64-musl@1.33.0/node_modules/lightningcss-linux-x64-musl',
    join(nmDir, '.pnpm', 'express@4.22.2_supports-color@8.1.1', 'node_modules', 'lightningcss-linux-x64-musl')
  );

  linkTopLevel('express', 'express@4.22.2_supports-color@8.1.1');
  linkTopLevel('@expo/server', '@expo+server@0.5.3_supports-color@8.1.1');
  linkTopLevel('mermaid', 'mermaid@11.17.2');
  // openai is a DYNAMIC root: nothing links to it, only a string inside the agent-run bundle.
  linkTopLevel('openai', 'openai@6.49.0');

  // .bin shims: one belonging to a kept package, one to a package about to be removed. The second
  // is what would otherwise survive as a DANGLING symlink.
  mkdirSync(join(nmDir, '.bin'), { recursive: true });
  symlinkSync('../.pnpm/mermaid@11.17.2/node_modules/mermaid/bin/mmdc', join(nmDir, '.bin', 'mmdc'));
  symlinkSync(
    '../.pnpm/@expo+server@0.5.3_supports-color@8.1.1/node_modules/@expo/server/bin/cli',
    join(nmDir, '.bin', 'expo-server')
  );
  // A real directory at top level (an injected workspace package) must survive untouched.
  mkdirSync(join(nmDir, '@mcm', 'design-system'), { recursive: true });
  writeFileSync(join(nmDir, '@mcm', 'design-system', 'package.json'), '{}');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('path helpers', () => {
  it('reads the .pnpm entry out of a resolved package path', () => {
    assert.equal(pnpmEntryOf('/app/runtime/node_modules/.pnpm/undici@6.28.0/node_modules/undici'), 'undici@6.28.0');
    assert.equal(pnpmEntryOf('/app/runtime/node_modules/@mcm/design-system'), null);
  });

  it('finds the node_modules a package resolves its own deps from', () => {
    assert.equal(
      depsRootOf('/app/runtime/node_modules/.pnpm/@expo+server@0.5.3/node_modules/@expo/server'),
      '/app/runtime/node_modules/.pnpm/@expo+server@0.5.3/node_modules'
    );
  });

  it('expands @scope one level and skips dotfiles', () => {
    const names = packageNamesIn(nmDir);
    assert.ok(names.includes('@expo/server'));
    assert.ok(names.includes('@mcm/design-system'));
    assert.ok(!names.some((n) => n.startsWith('.')));
  });
});

describe('computeClosure', () => {
  it('keeps the roots and everything they reach, and nothing else', () => {
    const keep = computeClosure(nmDir);
    assert.deepEqual(
      [...keep].sort(),
      [
        '@expo+server@0.5.3_supports-color@8.1.1',
        'express@4.22.2_supports-color@8.1.1',
        'ms@2.1.3',
        'openai@6.49.0',
        'undici@6.28.0',
      ]
    );
    assert.ok(!keep.has('mermaid@11.17.2'));
    assert.ok(!keep.has('lucide-react@0.542.0_react@19.2.3'));
  });

  it('keeps a dynamic root nothing links to — the lazy `__require("openai")` reach', () => {
    assert.ok(DYNAMIC_ROOTS.includes('openai'));
    assert.ok(computeClosure(nmDir).has('openai@6.49.0'));
    assert.ok(!computeClosure(nmDir, STATIC_ROOTS, []).has('openai@6.49.0'));
  });

  it('refuses to prune when a REQUIRED root is missing rather than emptying the tree', () => {
    assert.throws(() => computeClosure(nmDir, ['express', 'not-installed']), /not-installed/);
  });

  it('tolerates a missing OPTIONAL root — it already does not resolve, so nothing is kept for it', () => {
    assert.doesNotThrow(() => computeClosure(nmDir, STATIC_ROOTS, ['not-installed']));
  });
});

describe('planPrune', () => {
  it('removes the .bin shim of a pruned package but keeps a kept one', () => {
    const { binDelete } = planPrune(nmDir, computeClosure(nmDir));
    assert.deepEqual(binDelete, [join(nmDir, '.bin', 'mmdc')]);
  });

  it('removes unreachable entries and the top-level links into them', () => {
    const keep = computeClosure(nmDir);
    const { pnpmDelete, topDelete } = planPrune(nmDir, keep);
    assert.ok(pnpmDelete.some((p) => p.endsWith('mermaid@11.17.2')));
    assert.ok(pnpmDelete.some((p) => p.endsWith('lucide-react@0.542.0_react@19.2.3')));
    assert.ok(!pnpmDelete.some((p) => p.endsWith('undici@6.28.0')));
    assert.deepEqual(topDelete, [join(nmDir, 'mermaid')]);
  });

  it('leaves a real top-level directory alone', () => {
    const keep = computeClosure(nmDir);
    const { topDelete } = planPrune(nmDir, keep);
    assert.ok(!topDelete.some((p) => p.includes('design-system')));
  });
});

describe('prune', () => {
  it('deletes the unreachable tree and leaves the reachable one intact', () => {
    const result = prune({ runtime: root, log: () => {} });
    assert.equal(result.after.packages, 5);
    assert.ok(result.after.bytes < result.before.bytes);
    assert.ok(existsSync(join(nmDir, '.pnpm', 'undici@6.28.0', 'node_modules', 'undici', 'package.json')));
    assert.ok(existsSync(join(nmDir, 'express')));
    assert.ok(existsSync(join(nmDir, 'openai')));
    assert.ok(existsSync(join(nmDir, '@mcm', 'design-system', 'package.json')));
    assert.ok(!existsSync(join(nmDir, '.pnpm', 'mermaid@11.17.2')));
    assert.ok(!existsSync(join(nmDir, 'mermaid')));
    // No dangling symlink is left behind — lstat, because existsSync follows the link and a
    // dangling one would answer "false" whether it was removed or merely broken.
    assert.throws(() => lstatSync(join(nmDir, '.bin', 'mmdc')));
    assert.ok(lstatSync(join(nmDir, '.bin', 'expo-server')).isSymbolicLink());
  });

  it('refuses a tree that is not a pnpm deploy output', () => {
    assert.throws(() => prune({ runtime: join(root, 'nope'), log: () => {} }), /not a pnpm deploy output/);
  });
});

describe('bundle guard', () => {
  // The `.` before `__require` is the whole reason this is a guard and not a comment: the obvious
  // pattern matches the plain `require("ajv/...")` strings and silently misses every LangChain
  // adapter, which is how a scan can report "nothing dynamic here" about a bundle full of it.
  it('finds ALL THREE require shapes, including the esbuild shim and Metro\'s escape hatch', () => {
    const specs = extractDynamicSpecifiers(
      'var x=(0,n.__require)("openai"),y=require("ajv/dist/runtime/uri"),z=require("./local"),' +
        'w=require("node:fs"),v=$$require_external("node:zlib"),u=$$require_external("some-native-thing");'
    );
    assert.deepEqual([...specs].sort(), ['ajv/dist/runtime/uri', 'openai', 'some-native-thing']);
  });

  // The first real build of this gate failed on exactly this: `fs`, not `node:fs`. A prefix test
  // reads the bare spelling as a package name and turns a builtin into a red build.
  it('excludes a builtin spelled WITHOUT the node: prefix', () => {
    const specs = extractDynamicSpecifiers('require("fs");require("path");$$require_external("worker_threads");');
    assert.deepEqual([...specs], []);
  });

  it('maps a deep specifier back to its package', () => {
    assert.equal(packageNameOf('@langchain/core/messages'), '@langchain/core');
    assert.equal(packageNameOf('ajv/dist/runtime/uri'), 'ajv');
    assert.equal(packageNameOf('openai'), 'openai');
  });

  it('accounts for every specifier it knows, and fails on one it does not', () => {
    const dist = join(root, 'dist-server');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'a+api.js'), 'var a=(0,n.__require)("openai"),b=(0,n.__require)("@langchain/core/messages");');
    assert.equal(checkBundle(dist, () => {}).size, 2);

    writeFileSync(join(dist, 'b+api.js'), 'var c=(0,n.__require)("brand-new-provider-sdk");');
    assert.throws(() => checkBundle(dist, () => {}), /brand-new-provider-sdk/);
  });

  it('every DYNAMIC_ROOT is recorded as a root in the specifier ledger', () => {
    for (const r of DYNAMIC_ROOTS) assert.equal(KNOWN_DYNAMIC_SPECIFIERS[r], 'root');
  });
});
