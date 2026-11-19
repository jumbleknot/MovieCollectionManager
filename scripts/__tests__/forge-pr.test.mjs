// Item #1072: open, merge and dispatch through a script instead of a hand-typed credential recipe.
//
// THE INCIDENT THIS PINS (2026-11-19, merging PR #1070). A session re-typed `git credential fill`
// with `protocol=https` hard-coded. Origin is `http://`, and the forge on :3000 speaks only HTTP. The
// helper returned an empty password, the host's GCM reported a TLS handshake failure, and the
// session told the operator their credential helper was broken. The scheme it had typed was the
// actual fault. These tests make sure the scheme is always READ from origin, and that an empty
// password fails right away, naming what was asked for, instead of turning into a 401 three calls later.
//
// Pure-function tests: no network, no git, no forge. Every side effect is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOrigin,
  credentialQuery,
  forgeWriteToken,
  ForgeCredentialError,
} from '../lib/forge-credential.mjs';
import { resolveCommand, cmdMerge, cmdOpen, ForgePrError, USAGE } from '../forge-pr.mjs';
import { usageNamesEveryFlag } from '../lib/argv-contract.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// ── the shared credential module ─────────────────────────────────────────────────────────────────

test('(#1072) parseOrigin reads scheme and host from an http:// origin, and never assumes https', () => {
  const o = parseOrigin('http://forge.example:3000/jumbleknot/mcm.git');
  assert.equal(o.scheme, 'http');
  assert.equal(o.host, 'forge.example:3000');
  assert.equal(o.apiBase, 'http://forge.example:3000/api/v1');
  assert.equal(o.owner, 'jumbleknot');
  assert.equal(o.repo, 'mcm');
  assert.match(credentialQuery(o), /^protocol=http\nhost=forge\.example:3000\n\n$/);
});

test('(#1072) parseOrigin reads an https:// origin as https', () => {
  const o = parseOrigin('https://git.example.org/owner/repo');
  assert.equal(o.scheme, 'https');
  assert.equal(o.host, 'git.example.org');
  assert.equal(o.apiBase, 'https://git.example.org/api/v1');
  assert.match(credentialQuery(o), /^protocol=https\nhost=git\.example\.org\n\n$/);
});

test('(#1072) parseOrigin drops embedded userinfo from the host it asks the helper about', () => {
  const o = parseOrigin('http://someone@forge.example:3000/owner/repo.git');
  assert.equal(o.host, 'forge.example:3000');
  assert.doesNotMatch(o.apiBase, /someone/);
});

test('(#1072) parseOrigin refuses an origin it cannot use rather than guessing a scheme', () => {
  for (const bad of ['git@forge.example:owner/repo.git', 'ssh://git@forge/owner/repo', 'forge/owner/repo', '']) {
    assert.throws(() => parseOrigin(bad), ForgeCredentialError, `accepted ${JSON.stringify(bad)}`);
  }
});

test('(#1072) forgeWriteToken returns the password the helper gives for the origin scheme', () => {
  const asked = [];
  const tok = forgeWriteToken({
    origin: 'http://forge.example:3000/owner/repo.git',
    fill: (input) => { asked.push(input); return 'protocol=http\nhost=forge.example:3000\nusername=u\npassword=s3cret\n'; },
  });
  assert.equal(tok, 's3cret');
  assert.deepEqual(asked, ['protocol=http\nhost=forge.example:3000\n\n']);
});

test('(#1072) an EMPTY password fails right away, naming the scheme and host it asked for', () => {
  for (const reply of ['', 'protocol=http\nhost=forge.example:3000\n', 'username=u\npassword=\n']) {
    assert.throws(
      () => forgeWriteToken({ origin: 'http://forge.example:3000/owner/repo.git', fill: () => reply }),
      (err) =>
        err instanceof ForgeCredentialError &&
        /protocol=http/.test(err.message) &&
        /forge\.example:3000/.test(err.message),
      `reply ${JSON.stringify(reply)} must fail naming protocol=http and the host`,
    );
  }
});

test('(#1072) a helper that EXITS non-zero is reported the same way, never as an empty token', () => {
  assert.throws(
    () => forgeWriteToken({
      origin: 'https://git.example.org/owner/repo',
      fill: () => { throw new Error('fatal: could not read Username: terminal prompts disabled'); },
    }),
    (err) => err instanceof ForgeCredentialError && /protocol=https/.test(err.message) && /git\.example\.org/.test(err.message),
  );
});

// ── argv: an unknown or mistyped flag never reaches a merge ─────────────────────────────────────

test('(#1072) an unknown or mistyped flag is REJECTED, so a typo never falls through to a merge', () => {
  for (const argv of [
    ['merge', '7', '--expect-head', SHA, '--force'],
    ['merge', '7', '--expect_head', SHA],
    ['merge', '7', '--expecthead', SHA],
    ['merge', '7', '-expect-head', SHA],
    ['open', '--head', 'b', '--title', 't', '--body-file', 'f', '--draft'],
  ]) {
    assert.throws(() => resolveCommand(argv), /unrecognised/, `accepted ${argv.join(' ')}`);
  }
});

test('(#1072) merge without --expect-head, or with a short sha, is refused before anything runs', () => {
  assert.throws(() => resolveCommand(['merge', '7']), /--expect-head/);
  assert.throws(() => resolveCommand(['merge', '7', '--expect-head', 'abc1234']), /40-hex|full/);
  assert.throws(() => resolveCommand(['merge', 'seven', '--expect-head', SHA]), /PR number/);
});

test('(#1072) --help and a bare invocation answer with usage and never act', () => {
  for (const argv of [[], ['--help'], ['-h'], ['merge', '--help'], ['open', '-h']]) {
    assert.equal(resolveCommand(argv).command, 'help', argv.join(' '));
  }
});

test('(#1072) the CONTROL: every documented invocation parses', () => {
  assert.deepEqual(resolveCommand(['merge', '7', '--expect-head', SHA]), { command: 'merge', pr: 7, expectHead: SHA });
  const open = resolveCommand(['open', '--head', 'feat/x', '--title', 'T', '--body-file', '/tmp/b.md']);
  assert.equal(open.command, 'open');
  assert.equal(open.head, 'feat/x');
  assert.equal(open.base, 'main');
  const d = resolveCommand(['dispatch', 'app-ci.yml', '--ref', 'feat/x', '--input', 'provider=anthropic']);
  assert.deepEqual(d, { command: 'dispatch', workflow: 'app-ci.yml', ref: 'feat/x', inputs: { provider: 'anthropic' } });
});

test('(#1072) the usage text names every flag the parser accepts', () => {
  assert.deepEqual(usageNamesEveryFlag(USAGE, ['--head', '--base', '--title', '--body-file', '--expect-head', '--ref', '--input']), []);
});

// ── merge: three independent conditions, each refused on its own ────────────────────────────────

/** A fake forge for merge. `pull` is what GET /pulls/N answers; `merged` is set by the POST. */
function fakeForge({ pull, mergeStatus = 200, after = { merged: true, merge_commit_sha: 'c'.repeat(40) } }) {
  const calls = [];
  return {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === 'GET' && /\/pulls\/\d+$/.test(path)) {
        const merged = calls.some((c) => c.method === 'POST');
        return { status: 200, data: merged ? { ...pull, ...after } : pull };
      }
      if (method === 'POST' && /\/pulls\/\d+\/merge$/.test(path)) return { status: mergeStatus, data: null };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const OPEN_PULL = { number: 7, state: 'open', mergeable: true, merged: false, head: { sha: SHA, ref: 'feat/x' } };

test('(#1072) merge is REFUSED when the PR head is not --expect-head, and nothing is posted', async () => {
  const forge = fakeForge({ pull: { ...OPEN_PULL, head: { sha: OTHER, ref: 'feat/x' } } });
  let ciRan = false;
  await assert.rejects(
    cmdMerge({ pr: 7, expectHead: SHA }, { forge, ciStatus: () => { ciRan = true; return 0; }, log: () => {} }),
    (err) => err instanceof ForgePrError && /head/.test(err.message) && err.message.includes(OTHER),
  );
  assert.equal(forge.calls.filter((c) => c.method === 'POST').length, 0, 'a mismatched head must never be merged');
  assert.equal(ciRan, false, 'no point asking CI about a sha we are not going to merge');
});

test('(#1072) merge is REFUSED when ci-status does not report mergeable for that head', async () => {
  for (const code of [1, 2, 3, 4]) {
    const forge = fakeForge({ pull: OPEN_PULL });
    const asked = [];
    await assert.rejects(
      cmdMerge({ pr: 7, expectHead: SHA }, { forge, ciStatus: (sha) => { asked.push(sha); return code; }, log: () => {} }),
      (err) => err instanceof ForgePrError && /ci-status/.test(err.message),
      `ci-status exit ${code} must refuse the merge`,
    );
    assert.deepEqual(asked, [SHA], 'ci-status must be asked about the EXPECTED head');
    assert.equal(forge.calls.filter((c) => c.method === 'POST').length, 0);
  }
});

test('(#1072) merge is REFUSED when the forge says the PR is not mergeable', async () => {
  for (const pull of [{ ...OPEN_PULL, mergeable: false }, { ...OPEN_PULL, state: 'closed' }, { ...OPEN_PULL, merged: true }]) {
    const forge = fakeForge({ pull });
    await assert.rejects(
      cmdMerge({ pr: 7, expectHead: SHA }, { forge, ciStatus: () => 0, log: () => {} }),
      ForgePrError,
    );
    assert.equal(forge.calls.filter((c) => c.method === 'POST').length, 0);
  }
});

test('(#1072) merge is REFUSED for a detached (AGit) head even when everything else is green', async () => {
  const forge = fakeForge({ pull: { ...OPEN_PULL, head: { sha: SHA, ref: 'refs/pull/7/head' } } });
  await assert.rejects(cmdMerge({ pr: 7, expectHead: SHA }, { forge, ciStatus: () => 0, log: () => {} }), /AGit|branch/);
});

test('(#1072) the CONTROL: all three hold → one merge POST with the pinned head, and the merge sha printed', async () => {
  const forge = fakeForge({ pull: OPEN_PULL });
  const out = [];
  const res = await cmdMerge({ pr: 7, expectHead: SHA }, { forge, ciStatus: () => 0, log: (l) => out.push(l) });
  const posts = forge.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { Do: 'merge', delete_branch_after_merge: true, head_commit_id: SHA });
  assert.equal(res.mergeCommit, 'c'.repeat(40));
  assert.ok(out.join('\n').includes('c'.repeat(40)));
});

test('(#1072) a merge POST the forge rejects is an error, never a reported success', async () => {
  const forge = fakeForge({ pull: OPEN_PULL, mergeStatus: 409 });
  await assert.rejects(cmdMerge({ pr: 7, expectHead: SHA }, { forge, ciStatus: () => 0, log: () => {} }), /409/);
});

// ── open: the head must be a real branch ─────────────────────────────────────────────────────────

test('(#1072) open refuses a head that is not a branch on the forge, and points at git push', async () => {
  const forge = {
    calls: [],
    async request(method, path) {
      this.calls.push({ method, path });
      if (method === 'GET' && path.includes('/branches/')) return { status: 404, data: null };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  await assert.rejects(
    cmdOpen({ head: 'feat/x', base: 'main', title: 'T', body: 'B' }, { forge, log: () => {} }),
    /git push origin HEAD:feat\/x/,
  );
  assert.equal(forge.calls.filter((c) => c.method === 'POST').length, 0);
});

test('(#1072) open refuses an AGit-shaped head outright', async () => {
  await assert.rejects(
    cmdOpen({ head: 'refs/for/main', base: 'main', title: 'T', body: 'B' }, { forge: { request: async () => { throw new Error('no'); } }, log: () => {} }),
    /AGit|branch/,
  );
});

test('(#1072) open: the CONTROL — an existing branch gets a PR, and its number and URL are printed', async () => {
  const forge = {
    calls: [],
    async request(method, path, body) {
      this.calls.push({ method, path, body });
      if (method === 'GET') return { status: 200, data: { name: 'feat/x' } };
      return { status: 201, data: { number: 1099, html_url: 'http://forge/o/r/pulls/1099' } };
    },
  };
  const out = [];
  const res = await cmdOpen({ head: 'feat/x', base: 'main', title: 'T', body: 'B' }, { forge, log: (l) => out.push(l) });
  assert.equal(res.number, 1099);
  assert.deepEqual(forge.calls.at(-1).body, { head: 'feat/x', base: 'main', title: 'T', body: 'B' });
  assert.match(out.join('\n'), /1099/);
  assert.match(out.join('\n'), /pulls\/1099/);
});
