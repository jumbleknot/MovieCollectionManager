#!/usr/bin/env node
// Item #577 — promote a freshly published MinIO image into the compose refs that actually run.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
//
// `minio-image.yml` PUBLISHED and nothing PROMOTED. The compose refs moved only when a human
// remembered, so a green publish could change nothing that runs — and did. PR #559 bumped the
// builder `golang:1.25-alpine → 1.27-alpine` as a security bump; it merged, the image rebuilt, and
// all six compose refs still pinned the pre-#559 digest three weeks later:
//
//     exporting manifest list  sha256:b57b2ec9…   <- run 3960 built this (golang 1.27)
//     compose pinned           sha256:34eb9562…   <- all six refs, the PRE-#559 image
//
// Feature 069's central claim — that choosing our own builder makes a Go stdlib CVE a build input
// rather than a suppression — is true of the image AS BUILT. Between publish and promotion it says
// nothing about the image AS DEPLOYED. This script is the mechanism that closes that distance.
//
// ── WHY ONLY ON A DOCKERFILE CHANGE ──────────────────────────────────────────────────────────────
//
// The workflow gates this step on `github.event_name == 'push' || inputs.promote == true`, never on
// `schedule`, and that discriminator is the whole design. The two automatic triggers do different
// jobs, as minio-image.yml's own header says:
//
//   * a PUSH build means the image's INPUTS changed — a Renovate base bump, or a MINIO_TAG bump.
//     That publish MUST reach the stacks or the bump bought nothing. #559 was exactly this.
//   * the WEEKLY CANARY proves the build still works. Its digest changes every Friday regardless,
//     because the `apk` installs resolve against Alpine's live index — measured, runs 3115 and 3117
//     built identical source and produced sha256:7038b9e9… and sha256:1e981fa1…. Promoting that
//     would open a pull request a week whose only content is float, and spend ~35 minutes of
//     app-e2e on it. Worse than the cost: it trains a reader to merge these without looking, and
//     the next one is a real bump.
//
// The rejected alternatives are recorded in docs/runbooks/infra-image-scanning.md.
//
// ── WHY A PULL REQUEST, NOT A PUSH TO MAIN ───────────────────────────────────────────────────────
//
// cd-deploy promotes by pushing `[skip ci]` straight to main, and that is right for an image the
// same run just built, scanned and deployed behind a health probe. This one is different on both
// counts: feature 069 deliberately kept a human between a new MinIO and production, and the ref
// change must RUN app-e2e (`infrastructure-as-code/docker/**` is in app-ci's `app` filter, which
// scripts/__tests__/minio-promote.guard.test.mjs pins). So: an always-current pull request, the
// wiki-maintain shape — opened or updated on each qualifying build, never auto-merged. An unmerged
// PR sitting in the list is also the stale-pin signal; there is deliberately no second mechanism.
//
// ── THE TWO WAYS A PROMOTION GOES WRONG, AND WHAT CATCHES EACH ───────────────────────────────────
//
//   1. THE WRONG DIGEST. A build exports both a manifest and a manifest list and buildx logs them
//      adjacently; the first does not pull. So the digest is RESOLVED FROM THE TAG against the
//      registry (`docker buildx imagetools inspect`, which reports the top-level descriptor — what
//      the tag actually resolves to) and never scraped from a log. Then the exact ref that will be
//      written into compose is PULLED before anything is written. That second check is the real one:
//      it tests the property we care about instead of a proxy for it.
//
//   2. THE WRONG REF COUNT. specs/070-minio-non-root/tasks.md records "all FOUR refs repointed",
//      correct when written; feature 073 added the backups stack's two, making six, and the note
//      went stale with nothing noticing. So the refs are COUNTED FROM THE TREE on every run, and an
//      empty result is a hard failure rather than a successful promotion of nothing.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArgvError, dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where compose files live. Nothing outside this subtree pins an image. */
const SCAN_ROOT = 'infrastructure-as-code';

/** The promotion branch. One branch, reused — that is what makes the pull request always-current. */
export const BRANCH = 'chore/minio-promote';

export const USAGE = `
usage: node scripts/promote-minio-digest.mjs [--apply]

Repoints every pinned MinIO compose ref in the tree at the image this run published, and opens (or
updates) a pull request carrying the change.

  --apply    push the branch and open/update the pull request.
             WITHOUT IT THIS SCRIPT ONLY REPORTS. The default is inert on purpose: the acting word
             is the one you have to type, so a mistyped flag can only fail closed.

Inputs come from the environment, never from arguments — a token in argv reaches the process
listing on a shared host:

  BUILD_REF          the per-run image ref this run pushed (<registry>/<ns>/minio:<tag>-r<run id>).
                     Resolved rather than TAG because the release tag is re-pointed by the next
                     build; the per-run tag names THIS image for ever.
  FORGE_TOKEN        write-scoped repository credential (secrets.CD_PUSH_TOKEN).
  FORGE_API_BASE     the forge API root, e.g. https://<forge>/api/v1.
  GITHUB_REPOSITORY  owner/repo.
  GITHUB_RUN_ID      the publishing run, named in the pull request.
  GITHUB_SERVER_URL  used to build the run's URL in the pull-request body.
`;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Finding the refs — from the tree, never from a list
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Matches `minio:<tag>@sha256:<64 hex>` preceded by a `/`.
 *
 * NS-AGNOSTIC BY CONSTRUCTION. The refs in git read
 * `${REGISTRY_HOST:?…}/jumbleknot/minio:<tag>@<digest>` — the host is a compose interpolation that
 * keeps the forge host out of git (topology-scrub), and the namespace is a literal. Matching only
 * from `minio:` onwards means the rewrite cannot touch either, so neither a host leak nor a broken
 * interpolation is reachable from here.
 *
 * Declared WITHOUT /g and cloned per use. MEASURED, not assumed: `matchAll` and `replace` both
 * leave `lastIndex` at 0, so sharing one global regex between the two readers below would in fact
 * be safe today. `exec` and `test` do NOT — they advance it — so a later change to either reader
 * would start skipping refs in the second file, promoting some stacks and leaving others behind.
 * The clone costs nothing and makes that whole class unreachable rather than merely absent.
 */
export const MINIO_REF_RE = /(?<=\/)minio:(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*)@(?<digest>sha256:[0-9a-f]{64})/;

const globalRefRe = () => new RegExp(MINIO_REF_RE.source, 'g');

function* walkYaml(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkYaml(full);
    else if (/\.ya?ml$/.test(entry.name) && statSync(full).isFile()) yield full;
  }
}

/**
 * Every pinned MinIO ref in the tree, with the file and 1-indexed line of each.
 *
 * @param {string} root repository root
 * @returns {{file: string, line: number, tag: string, digest: string}[]}
 * @throws when the tree pins none — see the header: a promotion of nothing must never report success.
 */
export function findRefs(root = REPO_ROOT) {
  const refs = [];
  const scanDir = resolve(root, SCAN_ROOT);
  let files = [];
  try {
    files = [...walkYaml(scanDir)];
  } catch (err) {
    throw new Error(`cannot scan ${SCAN_ROOT}/ under ${root}: ${err.message}`);
  }
  for (const file of files.sort()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(globalRefRe())) {
        refs.push({
          file: relative(root, file).split(sep).join('/'),
          line: i + 1,
          tag: m.groups.tag,
          digest: m.groups.digest,
        });
      }
    });
  }
  if (refs.length === 0) {
    throw new Error(
      `no pinned minio refs found under ${SCAN_ROOT}/ — refusing to report a promotion of nothing.\n` +
        'Either the compose files moved, or the ref format changed. Fix MINIO_REF_RE at the cause;\n' +
        'a promoter that silently matches zero refs is indistinguishable from one that worked.',
    );
  }
  return refs;
}

/**
 * Repoint every ref in one file's text.
 *
 * @returns {{text: string, count: number}} the rewritten text and how many refs moved
 */
export function rewriteText(text, { tag, digest }) {
  let count = 0;
  const out = text.replace(globalRefRe(), () => {
    count += 1;
    return `minio:${tag}@${digest}`;
  });
  return { text: out, count };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The digest — resolved from the tag, then PROVED by pulling it
// ════════════════════════════════════════════════════════════════════════════════════════════════

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Accept a digest only in the one shape a compose ref can carry.
 *
 * Lowercase hex is required rather than normalised: an uppercase digest is not something this
 * pipeline produces, so seeing one means the value came from somewhere unexpected and the right
 * response is to stop, not to tidy it up.
 */
export function assertDigest(value) {
  const trimmed = String(value ?? '').trim();
  if (!DIGEST_RE.test(trimmed)) {
    throw new Error(
      `not a manifest digest: ${JSON.stringify(String(value ?? '').slice(0, 120))}\n` +
        'expected sha256: followed by 64 lowercase hex characters.',
    );
  }
  return trimmed;
}

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * What does this tag resolve to in the registry?
 *
 * `imagetools inspect` asks the REGISTRY, by tag, and reports the top-level descriptor — the
 * manifest list where there is one. That is what a `@sha256:` compose ref must carry. The
 * alternative, reading the digest off buildx's `exporting manifest` / `exporting manifest list`
 * log lines, is a coin flip between a ref that pulls and one that does not (PR #576).
 */
export function resolveDigest(ref, run = docker) {
  const out = run([
    'buildx', 'imagetools', 'inspect', ref,
    '--format', '{{.Manifest.MediaType}} {{.Manifest.Digest}}',
  ]);
  const [mediaType, digest] = String(out).trim().split(/\s+/);
  // The media type is REPORTED, not asserted. Measured with docker 29.7.2 / buildx 0.37.1 against a
  // public multi-arch image: `.Manifest.MediaType` came back
  // `application/vnd.oci.image.index.v1+json` — the index, which is what criterion 3 is about. But
  // a single-platform build legitimately resolves to a plain manifest, and that is also a correct
  // pin, so refusing one here would reject a valid promotion. What the ref must actually DO is
  // pull, and verifyPullable() below tests exactly that rather than a proxy for it.
  return { digest: assertDigest(digest), mediaType: mediaType ?? 'unknown' };
}

/**
 * Prove the ref we are about to WRITE can be pulled.
 *
 * The shape check above says the digest looks right; this says the exact string that lands in
 * compose resolves to an image. It is the only check that tests the property we actually care
 * about, so it runs even on a dry run — a dry run that skipped it would validate nothing.
 */
export function verifyPullable(ref, run = docker) {
  try {
    run(['manifest', 'inspect', ref]);
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim().slice(-400);
    throw new Error(
      `the ref this promotion would write does not resolve: ${ref}\n${detail}\n\n` +
        'A build exports both a manifest and a manifest list; only the list is what a tag resolves\n' +
        'to. If this failed, the digest came from the wrong one of the two.',
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The pull request
// ════════════════════════════════════════════════════════════════════════════════════════════════

export function buildPrBody({ tag, digest, previousDigest, buildRef, runId, runUrl, refs }) {
  const files = [...new Set(refs.map((r) => r.file))].sort();
  const byFile = files.map((f) => `- \`${f}\` — ${refs.filter((r) => r.file === f).length} ref(s)`);
  return [
    `Repoints **${refs.length} ref(s)** across ${files.length} file(s) at the MinIO image published by`,
    `[run ${runId}](${runUrl}).`,
    '',
    'Opened automatically because the build was triggered by a **Dockerfile change** — a Renovate',
    'base bump or a `MINIO_TAG` bump — which means the image\'s inputs moved and the publish has to',
    'reach the stacks to be worth anything. The weekly canary deliberately does **not** open one of',
    'these: its digest changes every Friday because the `apk` installs float, so promoting it would',
    'be a pull request a week with no input having changed. See item #577.',
    '',
    '```',
    `per-run tag : ${buildRef}`,
    `new digest  : ${digest}`,
    `was         : ${previousDigest}`,
    '```',
    '',
    '**The previous image stays pullable.** Every build is also tagged `<tag>-r<run id>`, so the',
    'digest this replaces keeps a reference and this change is revertible. That mechanism exists',
    'because this registry drops a manifest the moment nothing tags it (measured 2026-09-12: a',
    're-push left the previous digest returning 404, not merely superseded).',
    '',
    '### Files',
    ...byFile,
    '',
    '### Before merging',
    '',
    `\`app-e2e\` runs on this pull request — \`infrastructure-as-code/docker/**\` is in app-ci's \`app\``,
    'paths filter, which is what makes an automated ref change safe to propose. If it reports',
    '`skipped`, that filter has been narrowed and this change is unexercised: do not merge it.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

export function buildPrTitle({ tag, runId }) {
  return `chore(minio): promote the r${runId} image digest (${tag}) into the compose refs`;
}

/**
 * The Forgejo REST client, the wiki-maintain shape. Reads its token from the environment — never
 * from an argument, so it cannot reach a process listing or a log.
 */
export function forgejoClient({
  base = process.env.FORGE_API_BASE,
  owner,
  repo,
  token = process.env.FORGE_TOKEN,
} = {}) {
  if (!base || !owner || !repo || !token) {
    throw new Error('the forge client needs FORGE_API_BASE, GITHUB_REPOSITORY and FORGE_TOKEN');
  }
  const url = (suffix) => `${base.replace(/\/$/, '')}/repos/${owner}/${repo}${suffix}`;
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, suffix, payload) => {
    const res = await fetch(url(suffix), {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!res.ok) throw new Error(`forge ${method} ${suffix} → ${res.status}`);
    return res.json();
  };
  return {
    listPulls: () => call('GET', '/pulls?state=open&limit=50'),
    createPull: (payload) => call('POST', '/pulls', payload),
    updatePull: (number, payload) => call('PATCH', `/pulls/${number}`, payload),
  };
}

/**
 * Open the promotion pull request, or bring the open one up to date.
 *
 * ONE BRANCH, REUSED. A second Dockerfile bump landing before the first is merged must not leave two
 * competing promotions open — the later image supersedes the earlier one, and the reader needs one
 * current proposal rather than a queue to reason about.
 */
export async function openOrUpdatePull(client, { title, body, base = 'main' }) {
  const open = await client.listPulls();
  const existing = open.find((p) => p?.head?.ref === BRANCH);
  if (existing) {
    await client.updatePull(existing.number, { title, body });
    return { number: existing.number, action: 'updated' };
  }
  const created = await client.createPull({ head: BRANCH, base, title, body });
  return { number: created.number, action: 'created' };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `--apply` is the only word, and it is the ACTING one.
 *
 * Deliberately not `--dry-run`. A script whose default acts and whose safety depends on spelling a
 * flag correctly is the measured trap: `--dry-run` meant "post the public comment" in
 * renovate-health.mjs and check-lockfile-refresh.mjs, and "delete for real" in
 * prune-bff-runtime-modules.mjs, because a near-miss spelling was accepted as a positional. Here a
 * typo cannot act — and it is still REJECTED rather than ignored, so "nothing was promoted" is
 * never mistaken for a verdict about the image.
 */
export const ACCEPTED_FLAGS = ['--apply'];

export function resolveCommand(argv = []) {
  const args = (argv ?? []).filter((a) => a !== '');
  // Help wins outright: someone asking what this does must never trigger what it does.
  if (wantsHelp(args)) return { command: 'help', apply: false };
  const { flags } = partitionArgs(args, {
    accepted: ACCEPTED_FLAGS,
    maxPositionals: 0,
    usage: USAGE,
  });
  return { command: 'promote', apply: flags.has('--apply') };
}

async function main(argv) {
  let command;
  let apply;
  try {
    ({ command, apply } = resolveCommand(argv));
  } catch (err) {
    dieOnArgvError(err);
    return 2;
  }
  if (command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const buildRef = process.env.BUILD_REF;
  if (!buildRef) throw new Error('BUILD_REF is unset — the per-run ref of the image this run published');
  const m = /^(?<repoRef>.+\/minio):(?<buildTag>.+)$/.exec(buildRef);
  if (!m) throw new Error(`BUILD_REF does not look like a minio image ref: ${buildRef}`);
  const { repoRef, buildTag } = m.groups;
  // The RELEASE tag is the per-run tag with its `-r<run id>` suffix removed. Derived here rather
  // than passed separately so the two can never disagree about which image this is.
  const tag = buildTag.replace(/-r\d+$/, '');
  if (tag === buildTag) throw new Error(`BUILD_REF carries no -r<run id> suffix: ${buildRef}`);

  const { digest, mediaType } = resolveDigest(buildRef);
  const composeRef = `${repoRef}:${tag}@${digest}`;
  verifyPullable(composeRef);

  const refs = findRefs(REPO_ROOT);
  const previousDigest = refs[0].digest;
  console.log(`resolved ${buildRef}`);
  console.log(`       -> ${digest}`);
  console.log(`          ${mediaType} — and the compose ref was verified pullable`);
  console.log(`found ${refs.length} ref(s) in ${new Set(refs.map((r) => r.file)).size} file(s):`);
  for (const r of refs) console.log(`  ${r.file}:${r.line}  ${r.tag}@${r.digest.slice(0, 19)}…`);

  if (refs.every((r) => r.digest === digest && r.tag === tag)) {
    console.log('\nevery ref already pins this image — nothing to promote.');
    return 0;
  }

  let moved = 0;
  for (const file of [...new Set(refs.map((r) => r.file))]) {
    const abs = resolve(REPO_ROOT, file);
    const { text, count } = rewriteText(readFileSync(abs, 'utf8'), { tag, digest });
    writeFileSync(abs, text);
    moved += count;
  }
  console.log(`\nrewrote ${moved} ref(s).`);

  if (!apply) {
    console.log('\nDRY RUN — nothing pushed, no pull request opened. Re-run with --apply to propose it.');
    console.log('(the working tree now holds the rewrite; `git checkout -- .` to discard it)');
    return 0;
  }

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? '').split('/');
  const runId = process.env.GITHUB_RUN_ID ?? 'unknown';
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? ''}/${owner}/${repo}/actions/runs/${runId}`;
  const title = buildPrTitle({ tag, runId });
  const body = buildPrBody({ tag, digest, previousDigest, buildRef, runId, runUrl, refs });

  const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['config', 'user.name', 'minio-image[bot]']);
  git(['config', 'user.email', 'minio-image@users.noreply.localhost']);
  git(['checkout', '-B', BRANCH]);
  git(['add', ...new Set(refs.map((r) => r.file))]);
  // NO `[skip ci]`. The ref change must run app-e2e — that is what makes proposing it automatically
  // safe, and cd-deploy's `[skip ci]` promote is a different case (it deploys behind a health probe).
  git(['commit', '-m', title, '-m', `Published by run ${runId} from ${buildRef}.`]);
  // A REAL BRANCH, force-updated. Never an AGit push (`HEAD:refs/heads/${BRANCH}`): that yields a
  // refs/pull/N/head whose Actions run gets NO secrets, so every `${{ secrets.* }}` is empty and the
  // nx cache reports `Misconfigured remote cache endpoint` — two sessions lost to it on #126.
  git(['push', '--force', 'origin', `HEAD:refs/heads/${BRANCH}`]);

  const client = forgejoClient({ owner, repo });
  const { number, action } = await openOrUpdatePull(client, { title, body });
  console.log(`pull request #${number} ${action}: ${title}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof ArgvError ? err.message : `promote-minio-digest failed: ${err.message}`);
      process.exit(1);
    });
}
