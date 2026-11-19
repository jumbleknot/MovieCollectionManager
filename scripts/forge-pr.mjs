#!/usr/bin/env node
// Open, merge and dispatch on the forge, with the write credential read from origin (item #1072).
//
// This replaces the `git credential fill | curl` recipes that sessions used to type by hand. One copy
// with `protocol=https` hard-coded against an `http://` origin cost a session a wrong diagnosis on
// 2026-11-19 (the full story is in lib/forge-credential.mjs). It is a SCRIPT, not a skill, so Codex,
// OpenCode, CI and the operator's shell all get the same mechanics.
//
// WHAT THIS DOES NOT DECIDE. Whether to merge is the operator's call (AGENTS.md). This script only
// refuses to merge something other than what the caller looked at. `merge` acts only when all of
// these hold:
//   - the PR head is exactly `--expect-head` (so a push that landed after you read CI can't be merged
//     on a verdict that was about a different commit), and the forge enforces the same thing again
//     through `head_commit_id`;
//   - `ci-status status --sha <head>` exits 0, which by its contract means mergeable;
//   - the forge itself reports the PR open, unmerged and mergeable;
//   - the head is a real branch, not an AGit `refs/pull/N/head` that ran without Actions secrets.
//
// ARGUMENTS go through lib/argv-contract.mjs. An unknown or mistyped flag is REJECTED (exit 2) and
// never falls through to an action. `--help` and a bare call print usage and do nothing.
//
// Tests: scripts/__tests__/forge-pr.test.mjs.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { ForgeCredentialError, forgeWriteToken, parseOrigin, readOrigin } from './lib/forge-credential.mjs';
import { isMain } from './lib/is-main.mjs';

export class ForgePrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForgePrError';
  }
}

export const USAGE = `Usage:
  node scripts/forge-pr.mjs open --head <branch> --title <title> --body-file <path> [--base main]
  node scripts/forge-pr.mjs merge <pr-number> --expect-head <full-40-hex-sha>
  node scripts/forge-pr.mjs dispatch <workflow.yml> --ref <branch> [--input <key>=<value>]

open      Opens a PR whose head is a REAL branch on the forge. Push it first with
          \`git push origin HEAD:<branch>\`. AGit (refs/for/…) heads are refused, because they run
          WITHOUT Actions secrets. Prints the PR number and URL.
merge     Merges only if the PR head equals --expect-head, \`ci-status status --sha\` reports
          mergeable for it (needs MCM_FORGE_TOKEN), and the forge reports it mergeable. Deletes the
          branch after merging and prints the merge commit sha.
dispatch  Runs a workflow_dispatch on a branch (verifying a branch without a PR). --input may be
          given once, e.g. \`--input provider=anthropic\` for app-ci.yml. A dispatched run posts NO
          commit status, so read /actions/tasks rather than ci-status.

The write credential comes from \`git credential fill\` for the scheme and host of
\`git remote get-url origin\`. Nobody types it.

Exit: 0 done · 1 refused or failed · 2 bad arguments.`;

const FULL_SHA = /^[0-9a-f]{40}$/;
const AGIT_HEAD = /^refs\//;

/** Parse argv into one command object, or throw ArgvError. Never acts. */
export function resolveCommand(argv) {
  const args = argv ?? [];
  if (!args.length || wantsHelp(args)) return { command: 'help' };
  const [command, ...rest] = args;

  if (command === 'open') {
    const { values } = partitionArgsWithValues(rest, {
      withValues: ['--head', '--base', '--title', '--body-file'],
      usage: USAGE,
    });
    for (const req of ['--head', '--title', '--body-file']) {
      if (!values.has(req)) throw new ArgvError(`open needs ${req}\n\n${USAGE}`);
    }
    return {
      command: 'open',
      head: values.get('--head'),
      base: values.get('--base') ?? 'main',
      title: values.get('--title'),
      bodyFile: values.get('--body-file'),
    };
  }

  if (command === 'merge') {
    const { values, positionals } = partitionArgsWithValues(rest, {
      withValues: ['--expect-head'],
      maxPositionals: 1,
      usage: USAGE,
    });
    if (!/^[1-9]\d*$/.test(positionals[0] ?? '')) {
      throw new ArgvError(`merge needs a PR number as its argument\n\n${USAGE}`);
    }
    const expectHead = values.get('--expect-head');
    if (!expectHead) {
      throw new ArgvError(`merge needs --expect-head <sha>: the head you checked CI for\n\n${USAGE}`);
    }
    if (!FULL_SHA.test(expectHead)) {
      throw new ArgvError(`--expect-head must be a full 40-hex sha, got ${JSON.stringify(expectHead)}\n\n${USAGE}`);
    }
    return { command: 'merge', pr: Number(positionals[0]), expectHead };
  }

  if (command === 'dispatch') {
    // partitionArgsWithValues keeps the LAST value of a repeated flag, which would quietly drop an
    // input. Refuse the repeat instead of losing it.
    if (rest.filter((a) => a === '--input' || a.startsWith('--input=')).length > 1) {
      throw new ArgvError(`--input may be given at most once\n\n${USAGE}`);
    }
    const { values, positionals } = partitionArgsWithValues(rest, {
      withValues: ['--ref', '--input'],
      maxPositionals: 1,
      usage: USAGE,
    });
    const workflow = positionals[0];
    if (!workflow || !/^[\w.-]+\.ya?ml$/.test(workflow)) {
      throw new ArgvError(`dispatch needs a workflow file name, e.g. app-ci.yml\n\n${USAGE}`);
    }
    if (!values.has('--ref')) throw new ArgvError(`dispatch needs --ref <branch>\n\n${USAGE}`);
    const out = { command: 'dispatch', workflow, ref: values.get('--ref') };
    if (values.has('--input')) {
      const kv = values.get('--input');
      const eq = kv.indexOf('=');
      if (eq < 1) throw new ArgvError(`--input must be <key>=<value>, got ${JSON.stringify(kv)}\n\n${USAGE}`);
      out.inputs = { [kv.slice(0, eq)]: kv.slice(eq + 1) };
    }
    return out;
  }

  throw new ArgvError(`unrecognised command: ${command}\n\n${USAGE}`);
}

// ── the forge client ──────────────────────────────────────────────────────────────────────────────

/** A minimal client: `request(method, path, body) -> {status, data}`. Never throws on a status. */
export function forgeClient({ apiBase, token, fetchImpl = fetch, timeoutMs = 30000 }) {
  return {
    async request(method, path, body) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${apiBase}${path}`, {
          method,
          headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { message: text.slice(0, 300) };
        }
        return { status: res.status, data };
      } catch (err) {
        if (err?.name === 'AbortError') throw new ForgePrError(`${method} ${path} timed out after ${timeoutMs}ms`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function describe(status, data) {
  return `${status}${data?.message ? ` ${data.message}` : ''}`;
}

function encodeBranch(name) {
  return name.split('/').map(encodeURIComponent).join('/');
}

// ── subcommands ───────────────────────────────────────────────────────────────────────────────────

export async function cmdOpen({ head, base, title, body }, { forge, repoPath = '', log = console.log }) {
  if (AGIT_HEAD.test(head)) {
    throw new ForgePrError(
      `--head ${head} is not a branch. An AGit head runs WITHOUT Actions secrets; push a real branch ` +
        `(git push origin HEAD:<branch>) and pass its name.`,
    );
  }
  const branch = await forge.request('GET', `${repoPath}/branches/${encodeBranch(head)}`);
  if (branch.status === 404) {
    throw new ForgePrError(`branch ${head} does not exist on the forge. Push it first: git push origin HEAD:${head}`);
  }
  if (branch.status !== 200) throw new ForgePrError(`could not check branch ${head}: ${describe(branch.status, branch.data)}`);

  const res = await forge.request('POST', `${repoPath}/pulls`, { head, base, title, body });
  if (res.status !== 201) {
    throw new ForgePrError(
      `POST /pulls answered ${describe(res.status, res.data)}` +
        (res.status === 403 ? ' (the credential lacks write:repository; it must be the git credential, not MCM_FORGE_TOKEN)' : ''),
    );
  }
  log(`opened PR #${res.data.number}: ${res.data.html_url}`);
  return { number: res.data.number, url: res.data.html_url };
}

/** Run `ci-status status --sha <sha>`, letting its verdict print. Returns its exit code. */
function runCiStatus(sha) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'ci-status.mjs');
  const r = spawnSync(process.execPath, [script, 'status', '--sha', sha], { stdio: ['ignore', 'inherit', 'inherit'] });
  return r.status ?? 1; // killed by a signal is not a verdict
}

export async function cmdMerge({ pr, expectHead }, { forge, repoPath = '', ciStatus = runCiStatus, log = console.log }) {
  const got = await forge.request('GET', `${repoPath}/pulls/${pr}`);
  if (got.status !== 200) throw new ForgePrError(`could not read PR #${pr}: ${describe(got.status, got.data)}`);
  const p = got.data;

  if (p.merged) throw new ForgePrError(`PR #${pr} is already merged (${p.merge_commit_sha ?? 'unknown sha'})`);
  if (p.state !== 'open') throw new ForgePrError(`PR #${pr} is ${p.state}, not open`);
  if (p.head?.sha !== expectHead) {
    throw new ForgePrError(
      `PR #${pr} head is ${p.head?.sha}, not --expect-head ${expectHead}. Something was pushed after ` +
        `you checked. Re-read CI for the new head; this script will not merge a commit nobody looked at.`,
    );
  }
  if (AGIT_HEAD.test(p.head?.ref ?? '')) {
    throw new ForgePrError(
      `PR #${pr} head is ${p.head.ref}, an AGit head and not a branch. Its CI ran without Actions ` +
        `secrets, so its verdict is not trustworthy. Reopen it from a real branch.`,
    );
  }
  if (p.mergeable !== true) {
    throw new ForgePrError(`the forge reports PR #${pr} as NOT mergeable (conflicts, or protection not satisfied)`);
  }

  log(`ci-status for ${expectHead}:`);
  const code = ciStatus(expectHead);
  if (code !== 0) {
    throw new ForgePrError(
      `ci-status did not report mergeable for ${expectHead} (exit ${code}: 1 failed · 2 bad args/auth · 3 still waiting)`,
    );
  }

  const res = await forge.request('POST', `${repoPath}/pulls/${pr}/merge`, {
    Do: 'merge',
    delete_branch_after_merge: true,
    head_commit_id: expectHead,
  });
  if (res.status !== 200 && res.status !== 204) {
    throw new ForgePrError(`merge of PR #${pr} refused by the forge: ${describe(res.status, res.data)}`);
  }
  const after = await forge.request('GET', `${repoPath}/pulls/${pr}`);
  if (after.status !== 200 || !after.data?.merged) {
    throw new ForgePrError(`the forge accepted the merge of PR #${pr} but does not report it merged; check the web UI`);
  }
  log(`merged PR #${pr}: ${after.data.merge_commit_sha}`);
  return { mergeCommit: after.data.merge_commit_sha };
}

export async function cmdDispatch({ workflow, ref, inputs }, { forge, repoPath = '', log = console.log }) {
  const body = inputs ? { ref, inputs } : { ref };
  const res = await forge.request('POST', `${repoPath}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, body);
  if (res.status !== 204) throw new ForgePrError(`dispatch of ${workflow} on ${ref} answered ${describe(res.status, res.data)}`);
  log(
    `dispatched ${workflow} on ${ref}. It posts NO commit status: follow it in /actions/tasks ` +
      `(see docs/runbooks/ci-diagnostics.md, "Verifying a branch WITHOUT opening a pull request").`,
  );
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  let cmd;
  try {
    cmd = resolveCommand(argv);
  } catch (err) {
    if (err instanceof ArgvError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  if (cmd.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  try {
    const origin = readOrigin();
    const { apiBase, owner, repo } = parseOrigin(origin);
    const forge = forgeClient({ apiBase, token: forgeWriteToken({ origin }) });
    const ctx = { forge, repoPath: `/repos/${owner}/${repo}` };
    if (cmd.command === 'open') {
      await cmdOpen({ ...cmd, body: readFileSync(cmd.bodyFile, 'utf8') }, ctx);
    } else if (cmd.command === 'merge') {
      await cmdMerge(cmd, ctx);
    } else {
      await cmdDispatch(cmd, ctx);
    }
    return 0;
  } catch (err) {
    if (err instanceof ForgePrError || err instanceof ForgeCredentialError) {
      console.error(`✗ ${err.message}`);
      return 1;
    }
    throw err;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`✗ ${err?.stack ?? err}`); process.exitCode = 1; },
  );
}
