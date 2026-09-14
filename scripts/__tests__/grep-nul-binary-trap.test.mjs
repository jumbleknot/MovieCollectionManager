// Item #448 — a NUL byte in a text file turns every `grep` over it into a silent false negative.
//
// The trap, measured 2026-09-14 on scripts/sast-scan.mjs (2 NUL bytes at line 654):
//
//   $ grep -n "pip" scripts/sast-scan.mjs        # ← nothing, exit 1
//   $ grep -c "pip" scripts/sast-scan.mjs        # ← 28
//
// GNU grep classifies any file containing a NUL as BINARY. It then suppresses the matching lines
// and writes `<file>: binary file matches` to STDERR, exiting 0. Two things make that lethal here:
//
//   1. The notice is on stderr, so a `grep … | head` or a stdout-only reader sees an empty result.
//   2. RTK (the CLI proxy this repo runs `grep` through) drops the stderr notice AND reports exit 1
//      — byte-for-byte indistinguishable from a genuine "no matches". RTK is a third-party binary
//      and is NOT fixable from here, which is why the guard below removes the TRIGGER instead.
//
// A negative grep is load-bearing: it is how you conclude a stale reference is gone or a forbidden
// API is not called. It bit live during feature 071 ("pip-audit is not invoked here" — it appears
// 28 times). So the invariant this file pins is that no tracked TEXT file carries a NUL byte.
//
// The fix at the two call sites was to write the sentinel as the escape `\u0000` rather than as a
// raw byte — identical string value at runtime, but the SOURCE stays greppable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// The real grep, never the proxy — this suite's whole point is to compare the two.
const SYSTEM_GREP = ['/usr/bin/grep', '/bin/grep'].find((p) => existsSync(p)) ?? null;
const needsGrep = { skip: SYSTEM_GREP ? false : 'no system grep at /usr/bin/grep or /bin/grep' };

// `rtk` is the proxy. It is present in the dev container and absent in CI, so the fidelity case
// below skips WITH a reason there rather than reading as a silent pass.
const rtkProbe = spawnSync('rtk', ['--version'], { encoding: 'utf8' });
const needsRtk = {
  skip: rtkProbe.status === 0 ? false : `rtk not runnable here — ${rtkProbe.error?.code ?? `exit ${rtkProbe.status}`}`,
};

// Extensions whose files are legitimately binary; everything else tracked is text and must not
// carry a NUL. Kept as a deny-list so a NEW text extension is guarded by default.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.jar', '.apk', '.aab',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.mov', '.webm', '.ogg',
  '.keystore', '.jks', '.p12', '.der', '.wasm', '.so', '.dylib', '.dll', '.class', '.bin',
]);

function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'grep-nul-'));
  // Same shape as the real defect: a NUL used as an in-string separator, matches on either side.
  writeFileSync(join(dir, 'nul.txt'), 'alpha pip\nbeta\x00gamma pip\ndelta pip\n');
  writeFileSync(join(dir, 'plain.txt'), 'alpha pip\nbeta pip\ndelta pip\n');
  // An em-dash: valid UTF-8 under a POSIX locale, and NOT a binary trigger. Pinned because the
  // locale here is POSIX and "multi-byte char made it binary" is the tempting wrong diagnosis.
  writeFileSync(join(dir, 'emdash.txt'), 'alpha — pip\nbeta pip\ndelta pip\n');
  return dir;
}

function greptool(bin, args, extra = []) {
  return spawnSync(bin, [...extra, ...args], { encoding: 'utf8' });
}

// ── 1. The mechanism, proven rather than asserted from memory ────────────────
test('a NUL byte makes grep suppress matching LINES while -c still counts them', needsGrep, () => {
  const dir = corpus();
  try {
    const file = join(dir, 'nul.txt');

    const lines = greptool(SYSTEM_GREP, ['-n', 'pip', file]);
    assert.equal(lines.stdout, '', 'grep -n printed lines for a NUL-bearing file — trap no longer reproduces');
    assert.match(lines.stderr, /binary file matches/i, 'the only signal of the match is this stderr notice');
    assert.equal(lines.status, 0, 'grep exits 0 (matched) even though stdout is empty — the false negative');

    const counted = greptool(SYSTEM_GREP, ['-c', 'pip', file]);
    assert.equal(counted.stdout.trim(), '3', '-c reports the true count the -n form hid');

    // Control: the identical corpus without the NUL prints its lines normally.
    const control = greptool(SYSTEM_GREP, ['-n', 'pip', join(dir, 'plain.txt')]);
    assert.equal(control.stdout.trim().split('\n').length, 3);
    assert.equal(control.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a multi-byte UTF-8 char is NOT a binary trigger — only the NUL is', needsGrep, () => {
  const dir = corpus();
  try {
    const r = greptool(SYSTEM_GREP, ['-n', 'pip', join(dir, 'emdash.txt')]);
    assert.equal(r.stderr, '', 'an em-dash was treated as binary; the diagnosis in this file is wrong');
    assert.equal(r.stdout.trim().split('\n').length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. The repo guard: remove the trigger, since the proxy cannot be fixed ────
test('no tracked TEXT file contains a NUL byte', () => {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(ls.status, 0, `git ls-files failed: ${ls.stderr}`);

  const offenders = [];
  for (const rel of ls.stdout.toString('utf8').split('\0')) {
    if (!rel) continue;
    if (BINARY_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue; // a submodule entry or a file deleted in the working tree
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue; // a directory entry (submodule)
    }
    const idx = buf.indexOf(0);
    if (idx !== -1) {
      const line = buf.subarray(0, idx).toString('utf8').split('\n').length;
      const total = buf.reduce((n, b) => (b === 0 ? n + 1 : n), 0);
      offenders.push(`${rel} (first at line ${line}, ${total} NUL byte(s))`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These tracked text files contain a NUL byte, so every grep over them is a silent false ' +
      'negative (item #448). Write the byte as the escape \\u0000 instead of embedding it raw:\n  ' +
      offenders.join('\n  '),
  );
});

// ── 3. Proxy fidelity: rtk must not change a match COUNT ─────────────────────
test('proxied grep and system grep agree on match count for a known corpus', needsRtk, () => {
  if (!SYSTEM_GREP) return; // needsGrep covers the reason; keep this case honest rather than false-green
  const dir = corpus();
  try {
    for (const name of ['nul.txt', 'plain.txt', 'emdash.txt']) {
      const file = join(dir, name);
      const system = greptool(SYSTEM_GREP, ['-c', 'pip', file]).stdout.trim();
      const proxied = greptool('rtk', ['grep', '-c', 'pip', file]).stdout.trim();
      assert.equal(proxied, system, `rtk grep -c disagreed with ${SYSTEM_GREP} -c on ${name}`);
      assert.equal(system, '3', `corpus ${name} should hold 3 matches`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
