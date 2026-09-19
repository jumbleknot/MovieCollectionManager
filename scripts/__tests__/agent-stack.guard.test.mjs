// Feature 041 — stale-agent-image guard.
//
// `app-e2e` runs on a PERSISTENT runner whose reset step removes containers + volumes but NOT images.
// agent-stack.mjs used to skip the build whenever the tag existed, so every run silently exercised
// leftover `agent-gateway`/`*-mcp` images instead of the agent/MCP source in the checkout — a
// false-green for the whole agent layer (it hid a committed TMDB-key redaction fix). Building is now
// the default and `--no-build` is refused under CI. Pure-function test — no Docker, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildMode, resolveCommand, USAGE } from '../agent-stack.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('builds by default — a bare invocation never reuses a leftover image', () => {
  assert.equal(resolveBuildMode([], {}), true);
});

test('--build stays accepted and still means build', () => {
  assert.equal(resolveBuildMode(['--build'], {}), true);
});

test('--no-build opts out locally', () => {
  assert.equal(resolveBuildMode(['--no-build'], {}), false);
});

test('--no-build is refused under CI (a gate must test the checkout)', () => {
  assert.throws(
    () => resolveBuildMode(['--no-build'], { CI: 'true' }),
    /CI/,
    'CI must not be allowed to deploy stale agent images',
  );
});

test('no CI workflow deploys the agent stack with --no-build', () => {
  for (const wf of ['app-ci.yml', 'guardrails.yml', 'cd-deploy.yml']) {
    const text = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows', wf), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('up-agents-prod') || line.includes('agent-stack.mjs')) {
        assert.ok(!line.includes('--no-build'), `${wf}: agent stack brought up with --no-build: ${line.trim()}`);
      }
    }
  }
});

// ── The argument contract — an unrecognised flag must NOT deploy ─────────────────────────────────
//
// `node scripts/agent-stack.mjs --help` used to BUILD AND DEPLOY the stack. The dispatcher matched
// `--down` and `--status` and let everything else fall through to `deploy()`, and `resolveBuildMode`
// only looks for `--no-build`, so an unrecognised flag resolved to build = true: the fall-through did
// not merely start containers, it rebuilt the images first.
//
// Measured 2026-09-19 — `--help` began building movie-mcp:latest within a second, during a session
// whose entire purpose was tearing things DOWN, and was caught only because the call happened to
// carry a `timeout`. The reflex used to find out what a script does was the one input that made it
// act, and a typo (`--staus`, `--donw`) did the same thing.
//
// These pin the contract. The rule is REJECT, not guess: an unknown flag is an error, never a
// silently-ignored token that leaves the default action running.

test('(#footgun) --help asks for usage and deploys NOTHING', () => {
  for (const flag of ['--help', '-h']) {
    const cmd = resolveCommand([flag]);
    assert.equal(cmd.command, 'help', `${flag} must resolve to help, not to the deploy default`);
    assert.notEqual(cmd.command, 'deploy');
  }
});

test('(#footgun) an UNRECOGNISED flag is an error, never a silent deploy', () => {
  // The typo cases that used to build and start the stack. `--dry-run` is in here deliberately:
  // this script has no such flag, and a caller who assumes it does is asking for the most dangerous
  // possible misunderstanding.
  for (const flag of ['--staus', '--donw', '--dry-run', '--force', '-x']) {
    assert.throws(
      () => resolveCommand([flag]),
      /unrecognised|unrecognized|unknown/i,
      `${flag} must be REJECTED — falling through to deploy is how a query became a deployment`,
    );
  }
});

test('(#footgun) the error names the offending flag and points at usage', () => {
  // An error that does not say WHICH argument was wrong sends the reader back to guessing, which is
  // the state this whole change exists to end.
  try {
    resolveCommand(['--staus']);
    assert.fail('expected a throw');
  } catch (err) {
    assert.match(err.message, /--staus/, 'the message must quote the flag that was not understood');
    assert.match(err.message, /--status/, 'and should suggest the real one it was probably meant to be');
  }
});

test('(#footgun) every documented flag still resolves exactly as before', () => {
  // The control. Without it the assertions above are satisfied by a parser that rejects EVERYTHING,
  // which would break every caller including CI.
  //
  // EVERY case that can reach resolveBuildMode passes an EXPLICIT env. The first draft did not, and
  // CI caught it: `resolveCommand(['--no-build'])` read `process.env`, and under `CI=true` the
  // feature-041 guard correctly refuses --no-build ("a gate must test the code in the checkout").
  // Locally CI is unset, so it passed here and failed in `guardrails / naming` — a test that
  // asserts about argument parsing must not also depend on the ambient environment.
  const LOCAL = { CI: '' };
  assert.equal(resolveCommand([], LOCAL).command, 'deploy', 'a bare invocation still deploys — that is the documented default');
  assert.equal(resolveCommand(['--down'], LOCAL).command, 'down');
  assert.equal(resolveCommand(['--status'], LOCAL).command, 'status');
  assert.equal(resolveCommand(['--build'], LOCAL).command, 'deploy');
  assert.equal(resolveCommand(['--no-build'], LOCAL).command, 'deploy');
  // And the build mode still rides along, so the feature-041 default (build unless told otherwise)
  // is unchanged by the parsing rewrite.
  assert.equal(resolveCommand([], LOCAL).build, true);
  assert.equal(resolveCommand(['--no-build'], LOCAL).build, false);

  // The CI refusal itself is NOT weakened by the rewrite — resolveCommand delegates to
  // resolveBuildMode, so --no-build under CI still raises rather than quietly deploying a stale image.
  assert.throws(
    () => resolveCommand(['--no-build'], { CI: 'true' }),
    /refused under CI/,
    'resolveCommand must not launder the feature-041 refusal',
  );
});

test('(#footgun) --down and --status still win over build flags, as they did', () => {
  // Order of precedence was `--down` then `--status` then deploy. Pinned so the rewrite did not
  // quietly reorder it.
  assert.equal(resolveCommand(['--down', '--no-build']).command, 'down');
  assert.equal(resolveCommand(['--status', '--build']).command, 'status');
});

test('(#footgun) USAGE names every accepted flag, so the help cannot drift from the parser', () => {
  // A usage string that omits a real flag is the next version of this same bug: the reader trusts it,
  // types something else, and finds out what the default action is.
  for (const flag of ['--down', '--status', '--build', '--no-build', '--help']) {
    assert.ok(USAGE.includes(flag), `USAGE does not mention ${flag}`);
  }
  // And it must say what a BARE invocation does, that being the one the trap turned on.
  assert.match(USAGE, /deploy/i, 'USAGE must state that the default action deploys');
});
