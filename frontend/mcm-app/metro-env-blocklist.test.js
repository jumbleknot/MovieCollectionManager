'use strict';

/**
 * Unit test (RED→GREEN) for the Metro dotenv blockList (item #242).
 *
 * The oracle is @expo/metro-config's own transform-worker, which dotenv-parses exactly six file
 * names and Babel-parses everything else the `.env` require.context drags in. This test pins the
 * boundary between those two sets, because getting it wrong in either direction is a silent
 * breakage: too narrow and `pnpm web` dies on a SyntaxError again; too wide and Expo's real
 * `.env.local` stops reaching the client bundle.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { unparseableDotenvBlockList } = require('./metro-env-blocklist');

const ROOT = '/workspaces/mcm/frontend/mcm-app';
const at = (name) => path.posix.join(ROOT, name);

describe('unparseableDotenvBlockList', () => {
  const blocked = (p) => unparseableDotenvBlockList(ROOT).test(p);

  it('blocks .env.e2e.local — the file that broke the web bundle (item #242)', () => {
    expect(blocked(at('.env.e2e.local'))).toBe(true);
  });

  it.each([
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
    '.env.production',
    '.env.production.local',
  ])('does NOT block %s — @expo/metro-config parses this one itself', (name) => {
    expect(blocked(at(name))).toBe(false);
  });

  it.each(['.env.ci.local', '.env.docker', '.env.staging', '.env.e2e'])(
    'blocks the unknown variant %s — Babel would parse it as JavaScript',
    (name) => {
      expect(blocked(at(name))).toBe(true);
    },
  );

  it.each(['src/app/index.tsx', 'metro.config.js', 'src/config/environment.ts'])(
    'leaves ordinary source file %s alone',
    (name) => {
      expect(blocked(at(name))).toBe(false);
    },
  );

  it('is scoped to the project root — a .env.e2e.local elsewhere is not its business', () => {
    expect(blocked(path.posix.join(ROOT, 'src', '.env.e2e.local'))).toBe(false);
    expect(blocked('/workspaces/mcm/backend/.env.e2e.local')).toBe(false);
  });
});

describe('metro.config.js wiring', () => {
  // In a CHILD NODE PROCESS, not in-band: metro.config.js pulls in the whole Metro toolchain,
  // whose dependencies ship ESM that jest-expo's CommonJS transform cannot parse ("Cannot use
  // import statement outside a module" from yaml/browser/index.js). A plain `node -e` is also the
  // faithful oracle here — it is exactly how Metro itself loads this file.
  it('registers the blockList entry, so the regex is actually applied', () => {
    const probe = `
      const config = require('./metro.config.js');
      const path = require('path');
      const list = [].concat(config.resolver.blockList);
      process.stdout.write(JSON.stringify({
        blocksE2e: list.some((re) => re.test(path.join(process.cwd(), '.env.e2e.local'))),
        blocksLocal: list.some((re) => re.test(path.join(process.cwd(), '.env.local'))),
      }));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: __dirname,
      encoding: 'utf8',
    });

    expect(JSON.parse(out)).toEqual({ blocksE2e: true, blocksLocal: false });
  });
});
