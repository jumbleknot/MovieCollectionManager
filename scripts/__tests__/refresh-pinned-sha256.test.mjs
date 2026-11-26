// Item #1127 — scripts/refresh-pinned-sha256.mjs, offline: the publisher is a stub.
//
// What this pins: --check fails on a stale *_SHA256_FOR and on a pinned hash the publisher does not
// state; --write takes a checksum only when the DOWNLOAD hashes to what the publisher states, and
// rewrites nothing else in the installer; and the committed installers carry every pin it expects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS, readPin, setVar, checksumFileEntry, checkPin, refreshPin, resolveCommand } from '../refresh-pinned-sha256.mjs';
import { ArgvError } from '../lib/argv-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const trivy = PINS.find((p) => p.name === 'trivy');
const rustup = PINS.find((p) => p.name === 'rustup-init');
const audit = PINS.find((p) => p.name === 'cargo-audit');
const compose = PINS.find((p) => p.name === 'docker-compose');
const maestro = PINS.find((p) => p.name === 'maestro');

const TRIVY_TEXT = (version, shaFor, a64, arm) =>
  `#!/usr/bin/env bash\nset -euo pipefail\n\nTRIVY_VERSION=${version}\nTRIVY_SHA256_FOR=${shaFor}\nTRIVY_SHA256_LINUX_64BIT=${a64}\nTRIVY_SHA256_LINUX_ARM64=${arm}\n\necho rest-of-script\n`;

/** A publisher whose artifacts are the given bytes, keyed by URL; checksums are derived unless overridden. */
function stubIo(artifacts, { checksumsOverride = {} } = {}) {
  return {
    async bytes(url) {
      if (!(url in artifacts)) throw new Error(`GET ${url} → 404`);
      return Buffer.from(artifacts[url]);
    },
    async text(url) {
      const m = /\/(v[\d.]+)\/trivy_([\d.]+)_checksums\.txt$/.exec(url);
      if (m) {
        return trivy
          .assets(m[1])
          .map((a) => `${checksumsOverride[a.name] ?? sha(artifacts[a.url] ?? '')}  ${a.name}`)
          .join('\n');
      }
      if (url.endsWith('rustup-init.sha256')) return `${sha(artifacts[url.slice(0, -'.sha256'.length)])}  *rustup-init\n`;
      const c = /\/docker\/compose\/releases\/download\/(v[\d.]+)\/checksums\.txt$/.exec(url);
      if (c) return compose.assets(c[1]).map((a) => `${checksumsOverride[a.name] ?? sha(artifacts[a.url] ?? '')} *${a.name}`).join('\n');
      const mz = /\/cli-([\d.]+)\/checksums_sha256\.txt$/.exec(url);
      if (mz) return maestro.assets(mz[1]).map((a) => `${checksumsOverride[a.name] ?? sha(artifacts[a.url] ?? '')}  ${a.name}`).join('\n');
      throw new Error(`GET ${url} → 404`);
    },
    async json(url) {
      const v = /cargo-audit%2Fv([\d.]+)$/.exec(url)?.[1];
      const [a] = audit.assets(v);
      return { assets: [{ name: a.name, digest: `sha256:${checksumsOverride[a.name] ?? sha(artifacts[a.url])}` }] };
    },
  };
}

const trivyArtifacts = (v) => Object.fromEntries(trivy.assets(v).map((a) => [a.url, `bytes of ${a.name}`]));

test('--check passes when every pinned hash is the one the publisher states', async () => {
  const art = trivyArtifacts('v1.2.3');
  const [a64, arm] = trivy.assets('v1.2.3').map((a) => sha(art[a.url]));
  assert.deepEqual(await checkPin(trivy, TRIVY_TEXT('v1.2.3', 'v1.2.3', a64, arm), stubIo(art)), []);
});

test('--check fails a version bumped without its checksums, and names the command that fixes it', async () => {
  const problems = await checkPin(trivy, TRIVY_TEXT('v1.2.4', 'v1.2.3', 'a'.repeat(64), 'b'.repeat(64)), stubIo({}));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TRIVY_VERSION is v1\.2\.4 but its checksums were taken for v1\.2\.3 — run: node scripts\/refresh-pinned-sha256\.mjs --write/);
});

test('--check fails a pinned hash the publisher does not state', async () => {
  const art = trivyArtifacts('v1.2.3');
  const [a64] = trivy.assets('v1.2.3').map((a) => sha(art[a.url]));
  const problems = await checkPin(trivy, TRIVY_TEXT('v1.2.3', 'v1.2.3', a64, 'c'.repeat(64)), stubIo(art));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TRIVY_SHA256_LINUX_ARM64 is c{64} but the publisher states [0-9a-f]{64}/);
});

test('--write refreshes a stale pin from the download, and touches nothing else in the file', async () => {
  const art = trivyArtifacts('v1.2.4');
  const before = TRIVY_TEXT('v1.2.4', 'v1.2.3', 'a'.repeat(64), 'b'.repeat(64));
  const after = await refreshPin(trivy, before, stubIo(art));
  const [a64, arm] = trivy.assets('v1.2.4').map((a) => sha(art[a.url]));
  assert.equal(after, TRIVY_TEXT('v1.2.4', 'v1.2.4', a64, arm));
});

test('--write takes NOTHING when the download disagrees with the publisher', async () => {
  const art = trivyArtifacts('v1.2.4');
  const [first] = trivy.assets('v1.2.4');
  const io = stubIo(art, { checksumsOverride: { [first.name]: 'd'.repeat(64) } });
  await assert.rejects(
    refreshPin(trivy, TRIVY_TEXT('v1.2.4', 'v1.2.3', 'a'.repeat(64), 'b'.repeat(64)), io),
    /downloaded trivy_1\.2\.4_Linux-64bit\.tar\.gz hashes to [0-9a-f]{64}, but the publisher states d{64} — nothing written/,
  );
});

test('--write leaves an up-to-date pin alone unless --all', async () => {
  const art = trivyArtifacts('v1.2.3');
  const [a64, arm] = trivy.assets('v1.2.3').map((a) => sha(art[a.url]));
  const text = TRIVY_TEXT('v1.2.3', 'v1.2.3', a64, arm);
  assert.equal(await refreshPin(trivy, text, stubIo(art)), null);
  assert.equal(await refreshPin(trivy, text, stubIo(art), { all: true }), text);
});

test('rustup-init and cargo-audit refresh through their own publishers', async () => {
  const [r] = rustup.assets('1.30.0');
  const rText = 'RUSTUP_VERSION=1.30.0\nRUSTUP_INIT_SHA256_FOR=1.29.3\nRUSTUP_INIT_SHA256=' + '0'.repeat(64) + '\n';
  const rOut = await refreshPin(rustup, rText, stubIo({ [r.url]: 'rustup bytes' }));
  assert.equal(readPin(rustup, rOut).hashes.RUSTUP_INIT_SHA256, sha('rustup bytes'));
  assert.equal(readPin(rustup, rOut).shaFor, '1.30.0');

  const [c] = audit.assets('0.24.0');
  const cText = 'CARGO_AUDIT_VERSION=0.24.0\nCARGO_AUDIT_SHA256_FOR=0.23.0\nCARGO_AUDIT_SHA256=' + '0'.repeat(64) + '\n';
  const cOut = await refreshPin(audit, cText, stubIo({ [c.url]: 'audit bytes' }));
  assert.equal(readPin(audit, cOut).hashes.CARGO_AUDIT_SHA256, sha('audit bytes'));
});

test('docker-compose and maestro (item #1147) refresh through their own publishers, and a disagreeing download writes nothing', async () => {
  const cArt = Object.fromEntries(compose.assets('v9.9.9').map((a) => [a.url, `bytes of ${a.name}`]));
  const cText = `COMPOSE_VERSION=v9.9.9\nCOMPOSE_SHA256_FOR=v9.9.8\nCOMPOSE_SHA256_LINUX_X86_64=${'0'.repeat(64)}\nCOMPOSE_SHA256_LINUX_AARCH64=${'0'.repeat(64)}\n`;
  const cOut = await refreshPin(compose, cText, stubIo(cArt));
  assert.equal(readPin(compose, cOut).hashes.COMPOSE_SHA256_LINUX_X86_64, sha('bytes of docker-compose-linux-x86_64'));
  assert.equal(readPin(compose, cOut).hashes.COMPOSE_SHA256_LINUX_AARCH64, sha('bytes of docker-compose-linux-aarch64'));
  assert.deepEqual(await checkPin(compose, cOut, stubIo(cArt)), []);
  await assert.rejects(
    refreshPin(compose, cText, stubIo(cArt, { checksumsOverride: { 'docker-compose-linux-x86_64': 'e'.repeat(64) } })),
    /nothing written/,
  );

  const [m] = maestro.assets('9.9.9');
  const mText = `MAESTRO_VERSION=9.9.9\nMAESTRO_SHA256_FOR=9.9.8\nMAESTRO_SHA256=${'0'.repeat(64)}\n`;
  const mOut = await refreshPin(maestro, mText, stubIo({ [m.url]: 'maestro zip' }));
  assert.equal(readPin(maestro, mOut).hashes.MAESTRO_SHA256, sha('maestro zip'));
  assert.equal(readPin(maestro, mOut).shaFor, '9.9.9');
});

test('a checksums file with zero or two entries for the asset is refused, never guessed', () => {
  assert.throws(() => checksumFileEntry(`${'a'.repeat(64)}  other.tgz\n`, 'x.tgz'), /0 entries for x\.tgz/);
  assert.throws(() => checksumFileEntry(`${'a'.repeat(64)}  x.tgz\n${'b'.repeat(64)}  x.tgz\n`, 'x.tgz'), /2 entries/);
});

test('setVar refuses a variable that is absent or duplicated', () => {
  assert.throws(() => setVar('A=1\n', 'B', '2'), /exactly one B= line, found 0/);
  assert.throws(() => setVar('A=1\nA=2\n', 'A', '3'), /found 2/);
});

test('every committed installer carries the pin this script expects, with checksums taken for its version', () => {
  for (const pin of PINS) {
    const cur = readPin(pin, readFileSync(resolve(ROOT, pin.file), 'utf8'));
    assert.equal(cur.shaFor, cur.version, `${pin.file}: checksums taken for ${cur.shaFor}, version is ${cur.version}`);
    for (const [variable, value] of Object.entries(cur.hashes)) {
      assert.match(String(value), /^[0-9a-f]{64}$/, `${pin.file}: ${variable} is not a sha256`);
    }
  }
});

test('exactly one of --check / --write; --all only with --write; a bare call does nothing', () => {
  assert.deepEqual(resolveCommand(['--check']), { command: 'check', all: false });
  assert.deepEqual(resolveCommand(['--write', '--all']), { command: 'write', all: true });
  assert.equal(resolveCommand(['--help', '--write']).command, 'help');
  assert.throws(() => resolveCommand([]), ArgvError);
  assert.throws(() => resolveCommand(['--check', '--write']), ArgvError);
  assert.throws(() => resolveCommand(['--check', '--all']), ArgvError);
  assert.throws(() => resolveCommand(['--chek']), ArgvError);
});
