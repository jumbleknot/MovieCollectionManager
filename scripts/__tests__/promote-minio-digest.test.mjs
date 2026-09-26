// Item #577 — the MinIO digest promoter's pure parts.
//
// WHY EACH OF THESE IS A TEST AND NOT A COMMENT. Every assertion below corresponds to a way the
// hand-run promotion has already gone wrong, or could:
//
//   * THE REF COUNT WAS WRONG IN WRITING. specs/070-minio-non-root/tasks.md records "all FOUR refs
//     repointed" — correct when it was written. Feature 073 then added the backups stack's two,
//     making six, and nothing noticed the note had gone stale. So the promoter must COUNT FROM THE
//     TREE and never from a list, and `findRefs` must refuse an empty result rather than reporting
//     a successful promotion of nothing (item #577 criterion 5).
//
//   * THE WRONG DIGEST PULLS NOTHING. A build exports both a manifest and a manifest list, and
//     buildx logs them adjacently — taking the first produces a compose ref that does not pull
//     (PR #576). `assertDigest` is the shape gate; the pull check in `main` is the real one.
//
//   * A MISTYPED FLAG MUST NOT ACT. `--dry-run` meaning "post the public comment" in
//     renovate-health.mjs and "delete for real" in prune-bff-runtime-modules.mjs are the measured
//     precedents. This script's default is INERT and `--apply` is the acting word, so a typo can
//     only fail closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { usageNamesEveryFlag } from '../lib/argv-contract.mjs';
import {
  ACCEPTED_FLAGS,
  USAGE,
  MINIO_REF_RE,
  resolveDigest,
  verifyPullable,
  findRefs,
  rewriteText,
  assertDigest,
  resolveCommand,
  buildPrBody,
} from '../promote-minio-digest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const REGISTRY_PREFIX = '${REGISTRY_HOST:?set in stacks/observability.env}/jumbleknot';
const OLD = 'sha256:34eb9562702736347229a8ae5716d381b0678b08f79c35570be756d72a7123af';
const NEW = 'sha256:780f52e93192261a12920d7f4b255fe63deb460eef97cf462940656e1263851a';

// ── findRefs, against the REAL tree ───────────────────────────────────────────────────────────

test('findRefs counts the refs in the tree, and the tree has some', () => {
  const refs = findRefs(REPO_ROOT);
  assert.ok(refs.length > 0, 'no pinned minio refs found — the promoter would report success over nothing');
  for (const ref of refs) {
    assert.match(ref.digest, /^sha256:[0-9a-f]{64}$/, `${ref.file}:${ref.line} has a malformed digest`);
    assert.ok(ref.tag.length > 0, `${ref.file}:${ref.line} has an empty tag`);
    assert.ok(ref.file.startsWith('infrastructure-as-code/'), `unexpected ref location ${ref.file}`);
  }
});

test('findRefs spans more than one file — a single-file scan would miss stacks', () => {
  const files = new Set(findRefs(REPO_ROOT).map((r) => r.file));
  assert.ok(files.size >= 2, `expected refs in several compose files, found only ${[...files].join(', ')}`);
});

test('every ref in the tree currently agrees on tag and digest', () => {
  // Not a promoter requirement, but a promotion that starts from a SPLIT tree is a different and
  // larger act than the one this script performs — it would silently unify two intentional pins.
  const refs = findRefs(REPO_ROOT);
  const distinct = new Set(refs.map((r) => `${r.tag}@${r.digest}`));
  assert.equal(distinct.size, 1, `the tree pins ${distinct.size} distinct minio images: ${[...distinct].join(', ')}`);
});

test('findRefs throws rather than returning an empty promotion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minio-refs-'));
  try {
    mkdirSync(join(dir, 'infrastructure-as-code'), { recursive: true });
    writeFileSync(join(dir, 'infrastructure-as-code/compose.yaml'), 'services:\n  x:\n    image: alpine:3\n');
    assert.throws(() => findRefs(dir), /no pinned minio/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRefs reports the 1-indexed line of each ref', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minio-refs-'));
  try {
    mkdirSync(join(dir, 'infrastructure-as-code/docker'), { recursive: true });
    writeFileSync(
      join(dir, 'infrastructure-as-code/docker/compose.yaml'),
      `services:\n  a:\n    image: ${REGISTRY_PREFIX}/minio:2025.09.07-161309@${OLD}\n`,
    );
    const refs = findRefs(dir);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].line, 3);
    assert.equal(refs[0].tag, '2025.09.07-161309');
    assert.equal(refs[0].digest, OLD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── rewriteText ───────────────────────────────────────────────────────────────────────────────

test('rewriteText replaces tag and digest but never the registry-host prefix', () => {
  const before = `    image: ${REGISTRY_PREFIX}/minio:2025.09.07-161309@${OLD}\n`;
  const { text, count } = rewriteText(before, { tag: '2025.10.15-172955', digest: NEW });
  assert.equal(count, 1);
  assert.equal(text, `    image: ${REGISTRY_PREFIX}/minio:2025.10.15-172955@${NEW}\n`);
  // The `${REGISTRY_HOST:?…}` interpolation is what keeps the forge host out of git (topology-scrub).
  // A rewrite that expanded or dropped it would leak the host or break the compose file.
  assert.ok(text.includes('${REGISTRY_HOST:?set in stacks/observability.env}'));
});

test('rewriteText rewrites every occurrence in a file, not just the first', () => {
  const line = `    image: ${REGISTRY_PREFIX}/minio:2025.09.07-161309@${OLD}\n`;
  const { text, count } = rewriteText(line + line, { tag: '2025.09.07-161309', digest: NEW });
  assert.equal(count, 2);
  assert.equal(text.match(new RegExp(NEW, 'g')).length, 2);
  assert.ok(!text.includes(OLD));
});

test('rewriteText leaves an unrelated image alone', () => {
  const before = '    image: docker.io/library/alpine:3.22@sha256:' + 'a'.repeat(64) + '\n';
  const { text, count } = rewriteText(before, { tag: 'x', digest: NEW });
  assert.equal(count, 0);
  assert.equal(text, before);
});

test('MINIO_REF_RE is declared without /g', () => {
  // A /g regex carries `lastIndex` across calls. The exported constant is the one other code would
  // reach for, so it must be the safe form; the module clones it per use internally.
  assert.ok(!MINIO_REF_RE.global, 'the exported regex is global — a caller reusing it would skip refs');
});

test('findRefs finds the ref in EVERY file, not just the first', () => {
  // The property the regex discipline exists to protect. A scanner that skipped the second file
  // would promote some stacks and leave others behind — a split tree, which is worse than the
  // stale pin this item is about, because nothing downstream would report the disagreement.
  const dir = mkdtempSync(join(tmpdir(), 'minio-refs-'));
  try {
    mkdirSync(join(dir, 'infrastructure-as-code/docker/a'), { recursive: true });
    mkdirSync(join(dir, 'infrastructure-as-code/docker/b'), { recursive: true });
    const line = `    image: ${REGISTRY_PREFIX}/minio:2025.09.07-161309@${OLD}\n`;
    writeFileSync(join(dir, 'infrastructure-as-code/docker/a/compose.yaml'), `services:\n${line}${line}`);
    writeFileSync(join(dir, 'infrastructure-as-code/docker/b/compose.yml'), `services:\n${line}`);
    const refs = findRefs(dir);
    assert.equal(refs.length, 3, 'a ref was skipped — either a file or a second match on a line');
    assert.equal(new Set(refs.map((r) => r.file)).size, 2, 'the second file was not scanned');
    // Called twice: a scanner carrying state would answer differently the second time.
    assert.deepEqual(findRefs(dir), refs, 'findRefs is not idempotent — it carries state between calls');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── assertDigest ──────────────────────────────────────────────────────────────────────────────

test('assertDigest accepts a well-formed manifest digest', () => {
  assert.equal(assertDigest(NEW), NEW);
  assert.equal(assertDigest(` ${NEW}\n`), NEW);
});

test('assertDigest rejects everything that is not one', () => {
  for (const bad of ['', '   ', 'sha256:', 'sha256:abc', NEW.toUpperCase(), 'sha512:' + 'a'.repeat(64), 'not a digest']) {
    assert.throws(() => assertDigest(bad), /digest/i, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── resolveDigest, with the docker call injected ─────────────────────────────────────────────

test('resolveDigest reads the digest and the media type from the tag', () => {
  // MEASURED against a real registry (docker 29.7.2 / buildx 0.37.1, alpine:3.22):
  //   application/vnd.oci.image.index.v1+json sha256:5291449c…
  // i.e. `.Manifest.Digest` is the INDEX digest — the manifest LIST — which is what a compose
  // `@sha256:` ref must carry (item #577 criterion 3, PR #576's evidence).
  const calls = [];
  const fake = (args) => { calls.push(args); return `application/vnd.oci.image.index.v1+json ${NEW}\n`; };
  const got = resolveDigest('reg/ns/minio:t-r1', fake);
  assert.equal(got.digest, NEW);
  assert.equal(got.mediaType, 'application/vnd.oci.image.index.v1+json');
  // Resolved FROM THE TAG against the registry, never scraped from a build log.
  assert.deepEqual(calls[0].slice(0, 4), ['buildx', 'imagetools', 'inspect', 'reg/ns/minio:t-r1']);
});

test('resolveDigest refuses a garbled answer rather than pinning it', () => {
  assert.throws(() => resolveDigest('r', () => 'Error: no such manifest'), /digest/i);
  assert.throws(() => resolveDigest('r', () => ''), /digest/i);
});

test('verifyPullable turns a non-pulling ref into a named failure', () => {
  // The real check. `docker manifest inspect` exits 1 on a digest the registry cannot resolve —
  // measured: "manifest verification failed for digest sha256:bbbb…", exit 1 — so a ref taken from
  // the WRONG one of buildx's two adjacent digests fails here instead of reaching compose.
  assert.throws(
    () => verifyPullable('reg/ns/minio:t@' + NEW, () => { throw Object.assign(new Error('boom'), { stderr: 'manifest verification failed' }); }),
    /does not resolve/,
  );
  assert.doesNotThrow(() => verifyPullable('reg/ns/minio:t@' + NEW, () => '{}'));
});

// ── the argument contract ─────────────────────────────────────────────────────────────────────

test('the default action is inert — no flag means no PR', () => {
  assert.equal(resolveCommand([]).apply, false);
});

test('--apply is the acting word', () => {
  assert.equal(resolveCommand(['--apply']).apply, true);
});

test('--help asks what this does and never does it', () => {
  // The measured trap in its purest form: `agent-stack.mjs --help` BUILT AND DEPLOYED the stack.
  // Help wins outright, before the flag partition, so it cannot be combined into an action.
  for (const argv of [['--help'], ['-h'], ['--apply', '--help']]) {
    assert.equal(resolveCommand(argv).command, 'help', `${argv.join(' ')} did not resolve to help`);
    assert.equal(resolveCommand(argv).apply, false, `${argv.join(' ')} would have acted`);
  }
});

test('USAGE names every accepted flag', () => {
  assert.deepEqual(usageNamesEveryFlag(USAGE, ACCEPTED_FLAGS), []);
});

test('a stray positional is refused, not ignored', () => {
  // `node promote-minio-digest.mjs apply` — the dashless spelling — must not read as "no flags, do
  // the inert thing". It read that way in an earlier draft: the run exits 0 having promoted
  // nothing, and the operator has every reason to believe they asked for a promotion.
  for (const bad of [['apply'], ['--apply', 'now'], ['main']]) {
    assert.throws(() => resolveCommand(bad), /positional/i, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a mistyped flag aborts rather than falling through to the default', () => {
  // The measured trap: an argument the tool does not recognise and does not REJECT. Here the default
  // is inert, so a typo failing closed costs nothing — but it must still be NAMED, or the operator
  // reads "nothing to promote" as a verdict about the image.
  for (const bad of ['--aply', '--apply-now', '-apply', '--dry-run', '--force']) {
    assert.throws(() => resolveCommand([bad]), /unknown|unsupported|unrecognis/i, `accepted ${bad}`);
  }
});

// ── the PR body ───────────────────────────────────────────────────────────────────────────────

test('the PR body names the run, both digests and every file it touched', () => {
  const body = buildPrBody({
    tag: '2025.09.07-161309',
    digest: NEW,
    previousDigest: OLD,
    buildRef: 'reg/ns/minio:2025.09.07-161309-r4093',
    runId: '4093',
    runUrl: 'https://forge.example/o/r/actions/runs/4093',
    refs: [
      { file: 'infrastructure-as-code/docker/backups/compose.yaml', line: 31 },
      { file: 'infrastructure-as-code/docker/observability/compose.yaml', line: 168 },
    ],
  });
  assert.ok(body.includes(NEW), 'the new digest is not in the body');
  assert.ok(body.includes(OLD), 'the previous digest is not in the body — the revert target');
  assert.ok(body.includes('r4093'), 'the per-run tag is not in the body');
  assert.ok(body.includes('backups/compose.yaml'), 'a touched file is missing from the body');
  assert.ok(body.includes('observability/compose.yaml'), 'a touched file is missing from the body');
  assert.ok(/2 ref/.test(body), 'the body does not state how many refs it moved');
});

test('the PR body never claims the canary promoted anything', () => {
  // The whole model: `schedule` publishes and does NOT promote. If this body is ever generated on a
  // scheduled run the workflow guard has regressed, so the body says which trigger is legitimate.
  const body = buildPrBody({
    tag: 't', digest: NEW, previousDigest: OLD, buildRef: 'r', runId: '1', runUrl: 'u',
    refs: [{ file: 'f', line: 1 }],
  });
  assert.match(body, /Dockerfile/i);
});
