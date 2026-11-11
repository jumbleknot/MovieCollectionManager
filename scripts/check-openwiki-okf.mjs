#!/usr/bin/env node
// OKF conformance gate for the openwiki/ knowledge bundle — feature 043.
//
// Usage:
//   node scripts/check-openwiki-okf.mjs                  # validate the real bundle at openwiki/
//   node scripts/check-openwiki-okf.mjs --selftest       # prove detection; does not read the bundle
//   node scripts/check-openwiki-okf.mjs --bundle <path>  # validate an alternate root (test affordance)
//   node scripts/check-openwiki-okf.mjs --json           # machine-readable findings
//
// Exit codes: 0 clean / selftest passed · 1 violation / selftest broken · 2 bad args.
//
// Contract: specs/043-openwiki-okf/contracts/check-openwiki-okf-cli.md
// Rules V1-V15: specs/043-openwiki-okf/data-model.md (V14/V15 added for item #491)
//
// Two properties are load-bearing and easy to break by accident:
//   * OFFLINE (FR-013a). External `resource` links are shape-checked, NEVER fetched, so the
//     always-on guardrails job stays keyless and cannot fail because a third-party host is down.
//   * FAIL-CLOSED (FR-014a). An absent, empty, or partially-written bundle is a VIOLATION (exit 1),
//     never a vacuous pass. There is deliberately no skip flag and no allowlist: FR-012 requires a
//     rejected page be fixed in openwiki/INSTRUCTIONS.md and regenerated, never accepted in place.

import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// V14/V15 share their scanner with the generator's normalizer — see that module's header for the
// measurement (POST /api/v1/markup) that establishes why a leading `/` is a dead link here.
import { bodyLinks, classifyBodyLink, relativeFormFor, splitTarget } from './openwiki-links.mjs';
import { stampValues } from './openwiki-stamp.mjs';
import { extractFrontMatter } from './openwiki-front-matter.mjs';
import { staleDerivedPages } from './openwiki-fingerprint.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUNDLE = 'openwiki';

// Reserved filenames. `log.md` is SINGULAR — the vendor blog says `logs.md`, the shipped code does
// not, and a gate written against the wrong name silently never finds the history file.
const INSTRUCTIONS = 'INSTRUCTIONS.md';
const INDEX = 'index.md';
const LOG = 'log.md';

// Optional front-matter fields that must be non-empty strings WHEN PRESENT.
const OPTIONAL_STRING_FIELDS = ['title', 'description', 'resource', 'timestamp'];

const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// ── argument parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { selftest: false, bundle: DEFAULT_BUNDLE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') opts.selftest = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--bundle') {
      const v = argv[++i];
      if (!v) return { error: '--bundle requires a path' };
      opts.bundle = v;
    } else if (a.startsWith('--bundle=')) opts.bundle = a.slice('--bundle='.length);
    else return { error: `unknown argument: ${a}` };
  }
  return { opts };
}

// ── front matter: ./openwiki-front-matter.mjs, shared with V17's fingerprint reader ──────────

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// ── resource classification (offline in BOTH branches — FR-013a) ────────────────

function classifyResource(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'relative' };
  }
  // A Windows-style drive letter parses as a URL with a single-letter protocol; treat as relative.
  if (/^[a-z]:$/i.test(url.protocol.replace(/:$/, '') + ':')) return { kind: 'relative' };
  return { kind: 'external', wellFormed: Boolean(url.protocol && url.host) };
}

function resolveRelativeResource(value, repoRoot) {
  const withoutFragment = value.split('#')[0].split('?')[0];
  return { target: withoutFragment, abs: resolve(repoRoot, withoutFragment) };
}

// ── the concept provenance stamp ──────────────────────────────────────────────────
// The stamp (newest of generated.at and timestamp) is ./openwiki-stamp.mjs. V5 validates every value
// it yields. Freshness is NOT judged from it: V17 compares the page's source fingerprint instead
// (feature 098), which replaced V12's commit-date drift warning.

// ── bundle walk ─────────────────────────────────────────────────────────────────

function collectMarkdown(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function classifyFile(name) {
  if (name === INSTRUCTIONS) return 'instructions';
  if (name === INDEX) return 'index';
  if (name === LOG) return 'log';
  return 'concept';
}

// ── the gate ────────────────────────────────────────────────────────────────────

function validateBundle(bundleRoot, { repoRoot = REPO_ROOT } = {}) {
  const findings = [];
  const rel = (p) => relative(REPO_ROOT, p).split(sep).join('/');
  const add = (rule, file, message) => findings.push({ rule, file: rel(file), message });

  // V10 — fail closed on an absent or empty bundle.
  if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) {
    return {
      findings: [{ rule: 'V10', file: rel(bundleRoot), message: 'no bundle — the bundle is a required artifact' }],
      conceptCount: 0, directoryCount: 0, missingBundle: true,
    };
  }

  const files = collectMarkdown(bundleRoot);
  const validated = files.filter((f) => classifyFile(basename(f)) !== 'instructions');
  if (validated.length === 0) {
    return {
      findings: [{ rule: 'V10', file: rel(bundleRoot), message: 'bundle contains no concepts — the bundle is a required artifact' }],
      conceptCount: 0, directoryCount: 0, missingBundle: true,
    };
  }

  const byDir = new Map();
  for (const f of files) {
    const d = dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }

  let conceptCount = 0;

  for (const file of validated) {
    const name = basename(file);
    const kind = classifyFile(name);
    if (kind === 'concept') conceptCount++;

    const text = readFileSync(file, 'utf8');

    // V14/V15 — body links, checked BEFORE the front-matter branches below, which `continue` past
    // the rest of the loop for an index carrying none. An index is the bundle's navigation surface:
    // it is the last file whose links should go unchecked.
    //
    // This is the BODY. `resource` front matter is V6's job, and V6 passing on all of them is
    // exactly why 204 dead body links survived on `main` unnoticed (item #491).
    for (const { target, line } of bodyLinks(text)) {
      const kind = classifyBodyLink(target).kind;
      if (kind === 'skip') continue;
      if (kind === 'site-root') {
        add('V14', file, `line ${line}: link \`${target}\` is site-root-absolute — the forge resolves a leading \`/\` against the SITE root, so this renders as \`<forge>${target}\` and 404s (measured via POST /api/v1/markup). Write it relative to this file: \`${relativeFormFor(file, target, REPO_ROOT)}\``);
        continue;
      }
      const abs = resolve(dirname(file), splitTarget(target).path);
      if (!existsSync(abs)) {
        add('V15', file, `line ${line}: link \`${target}\` does not resolve from this file's own directory — no such path as ${rel(abs)}`);
      }
    }

    const fm = extractFrontMatter(text);

    // V1 — front matter present and parseable.
    // A generated directory summary may legitimately carry NONE: the root index.md gets an
    // `okf_version` header from the tool's index-sync step, while per-directory index.md files the
    // agent writes have no front matter at all (both observed 2026-07-27). Absent is therefore
    // tolerated on an index; MALFORMED is still a defect, because that is never intentional.
    if (fm.missing) {
      if (kind === 'index') continue;
      add('V1', file, 'no YAML front matter');
      continue;
    }
    if (fm.unterminated) { add('V1', file, 'front matter is not terminated'); continue; }
    if (fm.invalid) { add('V1', file, `front matter does not parse: ${fm.invalid}`); continue; }

    const fields = fm.fields;

    // V2 — `type` required, non-empty string. The only field the format itself requires.
    // EXCEPT on a generated directory summary: the generator emits `index.md` with an `okf_version`
    // header and NO `type` (observed 2026-07-27 on the first real generation). Requiring `type`
    // there would fail a file the generator itself produces, and no regeneration could fix it —
    // the gate must never fight its own generator (research R8).
    if (kind !== 'index' && !isNonEmptyString(fields.type)) {
      add('V2', file, 'missing required field `type`');
    }

    // V3 — optional string fields must be non-empty WHEN PRESENT.
    // Deliberately NOT requiring title/description: the generator leaves a page with a usable
    // `type` unchanged even when optional fields are absent, so demanding them would fail pages
    // the generator itself considers valid — a red build no regeneration could fix.
    for (const f of OPTIONAL_STRING_FIELDS) {
      if (f in fields && !isNonEmptyString(fields[f])) {
        add('V3', file, `field \`${f}\` is present but blank`);
      }
    }

    // V4 — tags must be an array of non-empty strings.
    if ('tags' in fields) {
      const t = fields.tags;
      if (!Array.isArray(t) || t.some((x) => !isNonEmptyString(x))) {
        add('V4', file, '`tags` must be an array of non-empty strings');
      }
    }

    // V5 — every ISO-8601-valued key must parse, in BOTH the v0.1 and the v0.2 shape. No `.trim()`
    // here: normalizeFields has already done it for every field, nested values included, which is
    // what stops the next validator being written without one.
    // `verified` is a LIST of events in the shape openwiki writes; stampValues descends it (a plain
    // path reader did not, so this rule had validated no real `verified.at` at all).
    for (const { value, field } of stampValues(fields)) {
      if (!ISO_8601.test(value) || Number.isNaN(Date.parse(value))) {
        add('V5', file, `field \`${field}\` is not a valid ISO 8601 value: ${value}`);
      }
    }

    // V6/V7 — resource resolution, offline in both branches.
    if (isNonEmptyString(fields.resource)) {
      const value = fields.resource;
      const cls = classifyResource(value);
      if (cls.kind === 'external') {
        if (!cls.wellFormed) add('V7', file, `external resource is malformed: ${value}`);
        // Never fetched. Liveness of an external link is out of scope by design.
      } else {
        const { target, abs } = resolveRelativeResource(value, repoRoot);
        if (!existsSync(abs)) {
          add('V6', file, `resource does not resolve: ${target}`);
        }
      }
    }
  }

  // V8/V9 — directory structure.
  for (const [dir, dirFiles] of byDir) {
    const concepts = dirFiles.filter((f) => classifyFile(basename(f)) === 'concept');
    if (concepts.length === 0) continue;

    const indexPath = join(dir, INDEX);
    if (!existsSync(indexPath)) {
      add('V8', dir, `directory has concepts but no ${INDEX}`);
      continue;
    }

    // V9 — every concept must be reachable from its directory index.
    const indexText = readFileSync(indexPath, 'utf8');
    for (const c of concepts) {
      if (!indexText.includes(basename(c))) {
        add('V9', indexPath, `concept not listed: ${rel(c)}`);
      }
    }
  }

  // V17 — a derived page must match its source (feature 098, contracts/okf-v17.md). This BLOCKS:
  // the coding session that changes a page's `resource` refreshes the page in the same PR. The
  // judgment is staleDerivedPages, the same function `wiki-refresh.mjs --stale` prints (FR-009).
  const bundleRel = relative(repoRoot, bundleRoot) || '.';
  for (const s of staleDerivedPages({ root: repoRoot, bundle: bundleRel })) {
    add('V17', resolve(repoRoot, s.page), v17Message(s));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return { findings, conceptCount, directoryCount: byDir.size, missingBundle: false };
}

function v17Message({ page, resource, reason }) {
  if (reason === 'no fingerprint') {
    return `V17 ${page}: no source fingerprint — run: node scripts/wiki-refresh.mjs --record ${page} (after refreshing it)`;
  }
  if (reason === 'source changed') {
    return `V17 ${page}: stale against ${resource} — refresh it: node scripts/wiki-refresh.mjs --diff ${page}, update the page, then --record ${page}. Skill: wiki-refresh`;
  }
  if (reason === 'resource missing') {
    return `V17 ${page}: its source ${resource} no longer exists — re-point resource: at the file that now holds this subject (then --record), or retire the page`;
  }
  if (reason === 'resource is not a file') {
    return `V17 ${page}: its source ${resource} is not a single file — a derived page summarises one file (FR-006); re-point resource: at one file, or make the page canonical`;
  }
  const field = reason.replace(/^forbidden field: /, '');
  return `V17 ${page}: forbidden field ${field} (retired with Claims, ADR-0004)`;
}

// ── reporting ───────────────────────────────────────────────────────────────────

function report(result, bundleRoot, asJson) {
  if (asJson) {
    console.log(JSON.stringify({
      bundleRoot: relative(REPO_ROOT, bundleRoot).split(sep).join('/') || DEFAULT_BUNDLE,
      conceptCount: result.conceptCount,
      directoryCount: result.directoryCount,
      findings: result.findings,
    }, null, 2));
    return;
  }

  if (result.missingBundle) {
    console.error(`[openwiki-okf] ✗ ${result.findings[0].message} (${result.findings[0].rule}) — ${result.findings[0].file}`);
    return;
  }

  if (result.findings.length > 0) {
    for (const f of result.findings) console.error(`[openwiki-okf] ✗ ${f.file} — ${f.message} (${f.rule})`);
    console.error(`[openwiki-okf] ✗ ${result.findings.length} conformance violation(s).`);
    return;
  }

  console.log(`[openwiki-okf] ✅ ${result.conceptCount} concepts conformant across ${result.directoryCount} directories.`);
}

// ── selftest ────────────────────────────────────────────────────────────────────
// Proves each rule still detects its case. A refactor that silently disables a check turns this red.

function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'okf-selftest-'));
  const fails = [];
  const scenario = (name, files, expect, { asRepoRoot = false } = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    // `asRepoRoot`: the scenario directory is also the repository root its `resource`s resolve
    // from, so a V17 scenario can own (and edit) its source file.
    const r = validateBundle(dir, asRepoRoot ? { repoRoot: dir } : {});
    const rules = new Set(r.findings.map((f) => f.rule));
    if (expect.rule && !rules.has(expect.rule)) {
      fails.push(`${name}: expected ${expect.rule}, got [${[...rules].join(',') || 'none'}]`);
    }
    if (expect.clean && r.findings.length > 0) {
      fails.push(`${name}: expected no findings, got ${r.findings.map((f) => f.rule).join(',')}`);
    }
    return r;
  };

  // A scenario citing the real README.md is a derived page, so a clean one must carry README's
  // current fingerprint (V17) — computed here, never pasted, so a README edit cannot break it.
  const readmeFp = `resource-sha256: ${createHash('sha256').update(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).digest('hex')}\n`;
  const idx = (link) => `---\ntype: Reference\ndescription: Index.\n---\n# I\n- [x](${link})\n`;
  // The generator emits index.md with `okf_version` and NO `type` — must be accepted (V2 exemption).
  const genIdx = (link) => `---\nokf_version: "0.1"\n---\n# Files\n- [x](${link})\n`;

  scenario('v1', { 'index.md': idx('a.md'), 'a.md': '---\ntype: "unterminated\n  bad: [\n---\nb\n' }, { rule: 'V1' });
  scenario('v1-missing', { 'index.md': idx('a.md'), 'a.md': 'no front matter at all\n' }, { rule: 'V1' });
  scenario('v2', { 'index.md': idx('a.md'), 'a.md': '---\ntitle: No type\n---\nb\n' }, { rule: 'V2' });
  scenario('v3', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\ntitle: "  "\n---\nb\n' }, { rule: 'V3' });
  scenario('v4', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\ntags: notalist\n---\nb\n' }, { rule: 'V4' });
  scenario('v5', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\ntimestamp: someday\n---\nb\n' }, { rule: 'V5' });
  scenario('v6', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\nresource: no/such/file.md\n---\nb\n' }, { rule: 'V6' });
  scenario('v7', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\nresource: https://example.invalid/x\n---\nb\n' }, { clean: true });
  scenario('v8', { 'a.md': '---\ntype: R\n---\nb\n' }, { rule: 'V8' });
  scenario('v9', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\n---\nb\n', 'orphan.md': '---\ntype: R\n---\nb\n' }, { rule: 'V9' });

  // V11 — the hand-authored brief is exempt. The most likely self-inflicted failure: it carries no
  // front matter by design, so a gate that validates it fails on its own instructions file.
  scenario('v11', {
    'INSTRUCTIONS.md': '# Brief\n\nNo front matter, deliberately.\n',
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\n---\nb\n',
  }, { clean: true });

  // V5 reaches INSIDE the nested v0.2 events. A malformed `generated.at` is a finding, not a shrug.
  scenario('v5-generated-at', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\ngenerated:\n  by: openwiki/0.5.2\n  at: someday\n---\nb\n',
  }, { rule: 'V5' });
  // `verified` is no longer a stamp (feature 098, R2): on a derived page it is a forbidden field,
  // whatever its value, so it cannot slip through as an unvalidated date.
  scenario('v17-verified-field', {
    'index.md': idx('a.md'),
    'a.md': `---\ntype: R\nresource: README.md\n${readmeFp}verified:\n  by: openwiki/0.5.2\n  at: nope\n---\nb\n`,
  }, { rule: 'V17' });

  // V2 exemption — a GENERATED directory summary carries no `type`. Regression guard: requiring it
  // would fail a file the generator itself produces.
  scenario('v2-generated-index', { 'index.md': genIdx('a.md'), 'a.md': '---\ntype: R\n---\nb\n' }, { clean: true });
  // A per-directory index written with NO front matter is also legitimate generator output.
  scenario('v1-index-no-frontmatter', { 'index.md': '# Files\n- [x](a.md)\n', 'a.md': '---\ntype: R\n---\nb\n' }, { clean: true });
  // ...but a MALFORMED index is still a defect — absence is intentional, corruption never is.
  scenario('v1-index-malformed', { 'index.md': '---\ntype: "unterminated\n  bad: [\n---\n- [x](a.md)\n', 'a.md': '---\ntype: R\n---\nb\n' }, { rule: 'V1' });

  // V10 — fail closed.
  const absent = validateBundle(join(root, 'does-not-exist'));
  if (!absent.findings.some((f) => f.rule === 'V10')) fails.push('v10-absent: expected V10 for an absent bundle');
  const emptyDir = join(root, 'empty');
  mkdirSync(emptyDir, { recursive: true });
  if (!validateBundle(emptyDir).findings.some((f) => f.rule === 'V10')) fails.push('v10-empty: expected V10 for an empty bundle');

  // V14 — a PLANTED site-root-absolute link must fail. This is the whole point of the rule: the
  // link is a real repository path, `resource` validation is untouched, and every other rule is
  // happy — which is precisely the state 204 dead links sat in on `main` (item #491).
  scenario('v14', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\n---\nsee [the brief](/openwiki/INSTRUCTIONS.md)\n',
  }, { rule: 'V14' });
  // The finding must carry the relative form to use — a rule that says only "wrong" makes the
  // reader re-derive the fix 204 times.
  const v14 = scenario('v14-suggests-the-fix', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\n---\n[x](/openwiki/gotchas/keyset-pagination.md)\n',
  }, { rule: 'V14' });
  if (!v14.findings.some((f) => f.rule === 'V14' && f.message.includes('keyset-pagination.md`'))) {
    fails.push('v14-suggests-the-fix: the finding must name the relative form to write instead');
  }
  // An absolute link inside a FENCE or a code span is illustrative, not a navigation link. A gate
  // that fails on documentation OF the defect cannot be used to document the defect.
  scenario('v14-code-is-illustrative', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\n---\nnever write `[x](/openwiki/a.md)`:\n\n```md\n[x](/openwiki/b.md)\n```\n',
  }, { clean: true });
  // An EXTERNAL or in-page target is not this rule's business.
  scenario('v14-external-and-anchors-pass', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\n---\n[u](https://example.invalid/x) [m](mailto:a@b.c) [p](//cdn.example/x) [h](#here)\n',
  }, { clean: true });

  // V15 — a relative link is resolved from ITS OWN file's directory, not from the bundle root.
  // `a.md` sits at the root here, so `gotchas/missing.md` is genuinely absent.
  scenario('v15', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\n---\n[gone](gotchas/missing.md)\n',
  }, { rule: 'V15' });
  // ...and the same link IS valid from a file one directory down. Resolving from the bundle root
  // instead would pass the case above and fail this one — the mirror-image bug.
  scenario('v15-resolves-from-the-files-own-directory', {
    'index.md': idx('area/a.md'),
    'area/index.md': '# I\n- [x](a.md)\n- [y](b.md)\n',
    'area/a.md': '---\ntype: R\n---\n[sibling](b.md) and [up](../index.md)\n',
    'area/b.md': '---\ntype: R\n---\nb\n',
  }, { clean: true });
  // A fragment, a percent-escape and the angle-bracket form must not be mistaken for part of the
  // path. `<b c.md>` also gives V9 the literal basename it matches on — a percent-escaped link
  // alone would not, and the scenario would fail for a reason that has nothing to do with V15.
  scenario('v15-fragment-and-escape', {
    'index.md': '---\ntype: Reference\ndescription: Index.\n---\n# I\n- [x](a.md)\n- [y](<b c.md>)\n',
    'a.md': '---\ntype: R\n---\n[f](b%20c.md#section) and [g](index.md#top)\n',
    'b c.md': '---\ntype: R\n---\nb\n',
  }, { clean: true });

  // V17 — a derived page's `resource-sha256` must match its source (feature 098,
  // contracts/okf-v17.md). Each scenario is its own repository root, so the source sits beside the
  // bundle and the stale case can change bytes without touching the real tree.
  {
    const SRC = '# Source\n\nline one\n';
    const fpOf = (s) => createHash('sha256').update(s).digest('hex');
    const derived = (extra) => `---\ntype: R\nresource: src.txt\n${extra}---\nb\n`;
    const v17 = (name, files, expect) => scenario(name, files, expect, { asRepoRoot: true });

    v17('v17-fresh', { 'index.md': idx('a.md'), 'src.txt': SRC, 'a.md': derived(`resource-sha256: ${fpOf(SRC)}\n`) }, { clean: true });
    const stale = v17('v17-stale', { 'index.md': idx('a.md'), 'src.txt': `${SRC}edited\n`, 'a.md': derived(`resource-sha256: ${fpOf(SRC)}\n`) }, { rule: 'V17' });
    if (!stale.findings.some((f) => f.rule === 'V17' && f.file.endsWith('a.md') && f.message.includes('wiki-refresh.mjs --diff'))) {
      fails.push('v17-stale: the finding must name the page and the wiki-refresh --diff hint');
    }
    v17('v17-missing', { 'index.md': idx('a.md'), 'src.txt': SRC, 'a.md': derived('') }, { rule: 'V17' });
    v17('v17-malformed', { 'index.md': idx('a.md'), 'src.txt': SRC, 'a.md': derived('resource-sha256: not-a-hash\n') }, { rule: 'V17' });
    v17('v17-crlf', { 'index.md': idx('a.md'), 'src.txt': SRC.replace(/\n/g, '\r\n'), 'a.md': derived(`resource-sha256: ${fpOf(SRC)}\n`) }, { clean: true });
    v17('v17-canonical-ignored', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\ntitle: Canonical\n---\nb\n' }, { clean: true });
    v17('v17-sources-field', {
      'index.md': idx('a.md'), 'src.txt': SRC,
      'a.md': derived(`resource-sha256: ${fpOf(SRC)}\nsources:\n  - id: openwiki-source-1\n    resource: repo://src.txt\n`),
    }, { rule: 'V17' });
    const gone = v17('v17-resource-missing', { 'index.md': idx('a.md'), 'a.md': derived(`resource-sha256: ${fpOf(SRC)}\n`) }, { rule: 'V17' });
    if (!gone.findings.some((f) => f.rule === 'V17' && f.message.includes('re-point') && f.message.includes('retire'))) {
      fails.push('v17-resource-missing: the finding must say to re-point `resource` or retire the page');
    }
  }

  // V13 — a conformant bundle passes.
  scenario('v13', { 'index.md': idx('a.md'), 'a.md': `---\ntype: R\ntitle: A\nresource: README.md\n${readmeFp}tags:\n  - t\n---\nb\n` }, { clean: true });

  rmSync(root, { recursive: true, force: true });

  if (fails.length > 0) {
    console.error('✗ openwiki-okf gate --selftest FAILED:\n  ' + fails.join('\n  '));
    return 1;
  }
  console.log('✓ openwiki-okf gate --selftest passed (V1–V15, V17: front matter, tags, timestamp, resource resolution, index/orphan structure, fail-closed on absent+empty, INSTRUCTIONS.md exemption, site-root-absolute body links rejected with the relative form named, code samples exempt, relative links resolved from their own file, derived pages fresh against their source fingerprint)');
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────────

const { opts, error } = parseArgs(process.argv.slice(2));
if (error) {
  console.error(`[openwiki-okf] ${error}`);
  console.error('Usage: node scripts/check-openwiki-okf.mjs [--selftest] [--bundle <path>] [--json]');
  process.exit(2);
}

if (opts.selftest) process.exit(selftest());

const bundleRoot = resolve(REPO_ROOT, opts.bundle);
const result = validateBundle(bundleRoot);
report(result, bundleRoot, opts.json);
process.exit(result.findings.length > 0 ? 1 : 0);
