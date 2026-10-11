// Guard: nothing LIVE in this repository names MinIO — feature 080 (item #560), US4.
//
// Contract: specs/080-minio-to-rustfs/contracts/no-minio-guard.md (G1–G3).
//
// WHY A GUARD AND NOT A REVIEW. Feature 080 replaced every MinIO with RustFS across 72 tracked files.
// A single missed runbook line sends an operator to `mc ready local` on a server that has no `mc`,
// at night, during an incident — and item #560 is itself a case of prose describing a mechanism
// that did not exist (a renovate.json rule "matched by the customManager below", with no
// customManager). Review missed that for months. A scan does not get tired.
//
// G1  Every git-tracked file — its PATH and its CONTENT — matched case-insensitively against /minio/.
// G2  A CLOSED list of exemptions, each with its reason. Anything else fails, naming `path:line`.
// G3  The guard proves it read something: it scanned more than a floor of files, every PATH
//     exemption matches at least one tracked file, every LINE exemption matches at least one line,
//     and at least one runbook history block exists. An exemption that matches nothing is stale and
//     FAILS — the same rule the allowlist gate applies to an unmatched entry — because a stale
//     exemption is a hole waiting for the next file to fall into it.
//
// HISTORY BLOCKS. A runbook case study may keep its evidence between `<!-- history:begin -->` and
// `<!-- history:end -->`. The marker makes "this is history" a reviewable claim in the diff rather
// than an excuse made in a comment, and it is honoured under docs/runbooks/** only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PATTERN = /minio/i;

// G3 floor: the text files this guard actually scans (tracked, not path-exempt, not binary) when it
// was written — 1,826 of 2,679 tracked files on 2026-10-11 — rounded down.
const MIN_FILES_SCANNED = 1800;

/** G2 — path exemptions. A string is an exact path; a string ending `/**` is a directory prefix. */
export const PATH_EXEMPTIONS = [
  { path: 'specs/**', why: 'Completed specifications are history; 069/070 describe what was built, and 080 describes the replacement.' },
  { path: 'docs/decisions/**', why: 'ADRs record the decision as made (ADR-0002 names MinIO in Langfuse\'s dependency set at the time).' },
  { path: 'docs/proposals/**', why: 'Pre-specification history, already excluded from Renovate and the wiki.' },
  { path: 'openwiki/**', why: 'Generated; regenerated from sources this guard covers. Pages summarising specs 069/070 legitimately name MinIO.' },
  { path: 'pnpm-lock.yaml', why: 'Third-party package names, not ours to rename.' },
  { path: 'scripts/__tests__/no-minio-references.guard.test.mjs', why: 'The guard holds the pattern.' },
  // TEMPORARY — removed with the tool in the cleanup PR (tasks.md T048). The tool must name
  // `.minio.sys`, MinIO's SSE marker and its own provenance; the rehearsal must name the deployed
  // MinIO image; the wrapper documents the volume it is run against.
  { path: 'scripts/object-store-migration.mjs', why: 'TEMPORARY (T048): reads MinIO\'s on-disk structures by name.' },
  { path: 'scripts/object-store-migration.sh', why: 'TEMPORARY (T048): the production wrapper names the volume it migrates.' },
  { path: 'scripts/__tests__/object-store-migration.test.mjs', why: 'TEMPORARY (T048): the tool\'s unit tests.' },
  { path: 'scripts/__tests__/object-store-migration.rehearsal.mjs', why: 'TEMPORARY (T048): seeds a drive with the deployed MinIO image.' },
];

/** G2 — line exemptions: only lines in `path` that match `line` are exempt. */
export const LINE_EXEMPTIONS = [
  {
    path: 'scripts/secret-scan.mjs',
    line: /\\bminiosecret\\b/,
    why: 'A scanner\'s detection set must not shrink as a side effect of a rename: old dev .env files and stashes can still hold that literal.',
  },
  {
    path: 'scripts/__tests__/ci-digest-redact.test.mjs',
    line: /'minio' \+ 'secret'/,
    why: 'Proves the redaction of the pattern above.',
  },
  {
    path: 'scripts/__tests__/ci-failure-digest.test.mjs',
    line: /'minio' \+ 'secret'/,
    why: 'Proves the redaction of the pattern above.',
  },
  {
    path: 'scripts/gen-dev-env.mjs',
    line: /^const RETIRED_S3_HOST = 'mcm-bff-backup-minio'; \/\/ the pre-080 container name$/,
    why: 'An existing dev .env.local still holds the pre-080 SEEDED default; the generator must recognise it to migrate it.',
  },
  {
    path: 'scripts/__tests__/gen-dev-env.guard.test.mjs',
    line: /^const RETIRED_S3_HOST = 'mcm-bff-backup-minio'; \/\/ the pre-080 container name, as old \.env\.local files hold it$/,
    why: 'Proves that migration on the exact value old files hold.',
  },
  {
    path: 'scripts/__tests__/object-store-service.guard.test.mjs',
    line: /MINIO_/,
    why: 'Contract S3 forbids the MINIO_ROOT_* aliases the RustFS binary still honours; the guard must name what it forbids.',
  },
  {
    path: 'scripts/check-resource-naming.mjs',
    line: /^\s*'langfuse-minio', 'langfuse-minio-init', 'mcm-bff-backup-minio', 'mcm-bff-backup-minio-init',$/,
    why: 'Rule 4 of the naming gate: a retired service key resurrected as an alias must fail loudly. Naming the dead keys is the mechanism.',
  },
];

/**
 * G2 — TOKEN exemptions: these exact strings are removed from a line before it is matched, so a line
 * that names one of them AND says MinIO in any other way still fails.
 */
export const TOKEN_EXEMPTIONS = [
  {
    // A spec directory's NAME is history — it is fixed when the feature is specified — and live files
    // legitimately cite the contract they implement (e.g. this guard's own header).
    token: /specs\/0(?:69|70|80)-minio-[a-z0-9-]+|no-minio-references\.guard\.test\.mjs|no-minio-guard\.md/g,
    scope: () => true,
    why: 'Citations of the 069/070/080 spec directories, and of this guard and its contract, whose names are fixed.',
  },
  {
    // TEMPORARY — until the rollback window closes (M7 / tasks.md T047) and the cleanup PR (T048).
    // These are the REAL names of production resources that still exist and ARE the rollback target:
    // the original volume, the Komodo Variable the revert needs (and the old store's access-key id,
    // which the cutover's manifest step authenticates with), the containers the cutover stops,
    // the host-managed Nx-cache store, and the registry package rollback pulls. An operator must be
    // able to find them in the runbook on the night; deleting the names would not delete the things.
    token: /observability-langfuse-minio-data|LANGFUSE_MINIO_ROOT_PASSWORD|S3_ACCESS_KEY=minio\b|langfuse-minio-init|langfuse-minio|minio_minio-data|\/home\/prod\/minio\/?|jumbleknot\/minio/g,
    scope: (file) => file.startsWith('docs/runbooks/') || file === 'infrastructure-as-code/komodo/stacks.toml',
    why: 'TEMPORARY (T047/T048): names of production resources that exist until M7 and are the rollback target.',
  },
];

const HISTORY_BEGIN = '<!-- history:begin -->';
const HISTORY_END = '<!-- history:end -->';
const HISTORY_SCOPE = 'docs/runbooks/';

const pathExempt = (file, e) => (e.path.endsWith('/**') ? file.startsWith(e.path.slice(0, -2)) : file === e.path);

function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

function readText(file) {
  let buf;
  try {
    buf = readFileSync(resolve(REPO_ROOT, file));
  } catch {
    return null; // tracked but deleted in the working tree (mid-edit); nothing to scan
  }
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

/**
 * Scan the given files. Returns the violations plus what each exemption matched (for G3).
 * Exported so the mutation checks below can run it over a doctored file set without touching disk.
 */
export function scan(files, read = readText) {
  const violations = [];
  const lineHits = new Map(LINE_EXEMPTIONS.map((e) => [e, 0]));
  const tokenHits = new Map(TOKEN_EXEMPTIONS.map((e) => [e, 0]));
  let historyBlocks = 0;
  let scanned = 0;
  for (const file of files) {
    if (PATH_EXEMPTIONS.some((e) => pathExempt(file, e))) continue;
    if (PATTERN.test(file)) violations.push(`${file} (the PATH names MinIO)`);
    const text = read(file);
    if (text === null) continue;
    scanned++;
    const lines = text.split('\n');
    let inHistory = false;
    lines.forEach((l, i) => {
      if (file.startsWith(HISTORY_SCOPE)) {
        if (l.includes(HISTORY_BEGIN)) {
          inHistory = true;
          historyBlocks++;
          return;
        }
        if (l.includes(HISTORY_END)) {
          inHistory = false;
          return;
        }
      }
      if (!PATTERN.test(l)) return;
      if (inHistory) return;
      let rest = l;
      for (const t of TOKEN_EXEMPTIONS) {
        if (!t.scope(file)) continue;
        const stripped = rest.replace(t.token, '');
        if (stripped !== rest) tokenHits.set(t, tokenHits.get(t) + 1);
        rest = stripped;
      }
      if (!PATTERN.test(rest)) return;
      const lineEx = LINE_EXEMPTIONS.find((e) => e.path === file && e.line.test(l));
      if (lineEx) {
        lineHits.set(lineEx, lineHits.get(lineEx) + 1);
        return;
      }
      violations.push(`${file}:${i + 1}: ${l.trim().slice(0, 140)}`);
    });
    if (inHistory) violations.push(`${file}: a ${HISTORY_BEGIN} block is never closed`);
  }
  return { violations, lineHits, tokenHits, historyBlocks, scanned };
}

const FILES = trackedFiles();
const RESULT = scan(FILES);

test('G1/G2: no live file names MinIO outside the declared exemptions', () => {
  assert.deepEqual(
    RESULT.violations,
    [],
    `\n${RESULT.violations.length} live MinIO reference(s):\n  ${RESULT.violations.join('\n  ')}\n\n` +
      'Rename it to what is true now (RustFS, or "the object store"), or — for a runbook case study —\n' +
      `wrap the evidence in ${HISTORY_BEGIN} … ${HISTORY_END}. Do not add an exemption to quieten this.`,
  );
});

test('G3: the guard scanned the tree, not a handful of files', () => {
  assert.ok(RESULT.scanned > MIN_FILES_SCANNED, `scanned only ${RESULT.scanned} text files (floor ${MIN_FILES_SCANNED})`);
});

/** G3 — path exemptions that match no tracked file. */
export const stalePathExemptions = (files, exemptions) =>
  exemptions.filter((e) => !files.some((f) => pathExempt(f, e))).map((e) => e.path);

test('G3: every PATH exemption matches at least one tracked file', () => {
  const stale = stalePathExemptions(FILES, PATH_EXEMPTIONS);
  assert.deepEqual(stale, [], `stale path exemption(s) — delete them: ${stale.join(', ')}`);
});

test('G3: every LINE exemption matches at least one line', () => {
  const stale = LINE_EXEMPTIONS.filter((e) => RESULT.lineHits.get(e) === 0).map((e) => `${e.path} ${e.line}`);
  assert.deepEqual(stale, [], `stale line exemption(s) — delete them: ${stale.join(', ')}`);
});

test('G3: every TOKEN exemption strips at least one occurrence', () => {
  const stale = TOKEN_EXEMPTIONS.filter((e) => RESULT.tokenHits.get(e) === 0).map((e) => String(e.token));
  assert.deepEqual(stale, [], `stale token exemption(s) — delete them: ${stale.join(', ')}`);
});

test('mutation: a line naming an exempt token AND MinIO otherwise still fails', () => {
  const runbook = 'docs/runbooks/prod-control-tower.md';
  const r = scan([runbook], plant(runbook, 'Stop langfuse-minio, then start MinIO again.'));
  assert.equal(r.violations.length, 1, r.violations.join('\n'));
  const ok = scan([runbook], plant(runbook, 'docker stop langfuse-minio-init langfuse-minio'));
  assert.deepEqual(ok.violations, []);
});

test('G3: the history-block mechanism is in use, so its parser is exercised on real input', () => {
  assert.ok(RESULT.historyBlocks >= 1, `no ${HISTORY_BEGIN} block found under ${HISTORY_SCOPE}`);
});

// Mutation checks (tasks.md T033), as tests: each plants a reference in memory and must go RED.
const plant = (file, extra) => (f) => (f === file ? `${readText(f) ?? ''}\n${extra}\n` : readText(f));

test('mutation: a MinIO reference planted in README.md is named as README.md:<line>', () => {
  const r = scan(['README.md'], plant('README.md', 'Run mc ready local against the MinIO server.'));
  assert.equal(r.violations.length, 1, r.violations.join('\n'));
  assert.match(r.violations[0], /^README\.md:\d+: /);
});

test('mutation: in a runbook, OUTSIDE a history block fails and INSIDE one passes', () => {
  const runbook = 'docs/runbooks/renovate.md';
  const outside = scan([runbook], plant(runbook, 'Restart MinIO first.'));
  assert.equal(outside.violations.length, 1, outside.violations.join('\n'));
  const inside = scan([runbook], plant(runbook, `${HISTORY_BEGIN}\nRestart MinIO first.\n${HISTORY_END}`));
  assert.deepEqual(inside.violations, []);
  const unclosed = scan([runbook], plant(runbook, `${HISTORY_BEGIN}\nRestart MinIO first.`));
  assert.ok(unclosed.violations.some((v) => /never closed/.test(v)), 'an unclosed history block must not exempt the rest of the file');
});

test('mutation: a history block OUTSIDE docs/runbooks/ exempts nothing', () => {
  const r = scan(['README.md'], plant('README.md', `${HISTORY_BEGIN}\nMinIO\n${HISTORY_END}`));
  assert.equal(r.violations.length, 1);
});

test('mutation: a path exemption that matches no file is reported stale', () => {
  const withBogus = [...PATH_EXEMPTIONS, { path: 'scripts/no-such-object-store-tool.mjs', why: 'planted' }];
  assert.deepEqual(stalePathExemptions(FILES, withBogus), ['scripts/no-such-object-store-tool.mjs']);
});
