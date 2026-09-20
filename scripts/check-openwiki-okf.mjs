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
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

// V14/V15 share their scanner with the generator's normalizer — see that module's header for the
// measurement (POST /api/v1/markup) that establishes why a leading `/` is a dead link here.
import { bodyLinks, classifyBodyLink, relativeFormFor, splitTarget } from './openwiki-links.mjs';

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

// ── front matter ────────────────────────────────────────────────────────────────

/**
 * Normalize every string the front matter yields, ONCE, at the point the fields are read.
 *
 * On a CRLF checkout the last value before the closing `---` keeps a trailing '\r', because the
 * slice below ends at the '\n' of the terminator and leaves the '\r' inside the scalar. Validators
 * downstream then see '2001-01-01T00:00:00Z\r'. V5 survived that because it happened to call
 * `.trim()` first; V12's guard did not, so `Date.parse` returned NaN, the guard read that as "no
 * usable timestamp", and the staleness check silently never ran while the gate printed
 * `✅ conformant`. A gate reporting green while not checking is the worst direction of failure, and
 * it was hiding here in the toolchain of the feature that exists to close exactly this.
 *
 * Normalizing at the boundary — not with one more `.trim()` at the call site — is the point: the
 * asymmetry between two validators was the defect, so the fix has to remove the possibility of a
 * third validator being written without one.
 */
function normalizeFields(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(normalizeFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeFields(v)]));
  }
  return value;
}

function extractFrontMatter(text) {
  if (!/^---\r?\n/.test(text)) return { missing: true };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { unterminated: true };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  try {
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { invalid: 'front matter is not a mapping' };
    }
    return { fields: normalizeFields(parsed) };
  } catch (err) {
    return { invalid: err.message.split('\n')[0] };
  }
}

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

function resolveRelativeResource(value) {
  const withoutFragment = value.split('#')[0].split('?')[0];
  return { target: withoutFragment, abs: resolve(REPO_ROOT, withoutFragment) };
}

// ── the concept provenance stamp (OKF v0.1 `timestamp` → v0.2 `generated.at`) ───
//
// OKF v0.2 replaced the flat `timestamp` scalar with a `generated: {by, at}` event, and openwiki
// >=0.5.0 does not merely ADD it — `finalizeGeneratedProvenance` calls
// `removeFrontmatterField(..., "timestamp")` on every page whose body changed in the run. So a
// bundle mid-migration carries BOTH shapes, one per page, and the set flips over gradually as pages
// are regenerated.
//
// Reading only `timestamp` would therefore not fail loudly — it would make V12 quietly stop
// covering each page as that page was rewritten, until drift detection covered nothing while the
// gate still printed `✅ conformant`. That is the same silent-green failure the normalizeFields
// comment above documents, arriving by a different route, so the fallback is written once, here,
// and every caller goes through it.
//
// `timestamp` is still honoured because v0.2 explicitly tolerates it on pages that have not been
// rewritten yet, and because a hand-authored concept may carry it indefinitely.

/** ISO-8601-valued keys, wherever they appear. Order is preference order, most specific first. */
const STAMP_FIELDS = [
  ['generated', 'at'],
  ['timestamp'],
];

/** Read a nested front-matter path, returning the string only when it is a non-empty one. */
function readPath(fields, path) {
  let cursor = fields;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = cursor[key];
  }
  return isNonEmptyString(cursor) ? cursor : null;
}

/**
 * The concept's provenance stamp: v0.2 `generated.at` if present, else the v0.1 `timestamp`.
 * Returns the field path too, so a message can name the shape it actually read.
 */
function conceptStamp(fields) {
  for (const path of STAMP_FIELDS) {
    const value = readPath(fields, path);
    if (value !== null) return { value, field: path.join('.') };
  }
  return null;
}

// ── drift (V12) — git commit date, NOT mtime ────────────────────────────────────
// A fresh checkout stamps every file's mtime with the checkout time, so an mtime-based comparison
// would report EVERY concept as stale in CI. The last-commit date is the only meaningful signal.
const commitDateCache = new Map();

function lastCommitDate(absPath) {
  if (commitDateCache.has(absPath)) return commitDateCache.get(absPath);
  let result = null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', absPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) result = new Date(out);
  } catch {
    result = null; // not a git repo, or the file is untracked — drift is unknowable, stay silent
  }
  if (!result) {
    try {
      result = statSync(absPath).mtime;
    } catch {
      result = null;
    }
  }
  commitDateCache.set(absPath, result);
  return result;
}

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

function validateBundle(bundleRoot) {
  const findings = [];
  const warnings = [];
  const unstampable = [];
  const rel = (p) => relative(REPO_ROOT, p).split(sep).join('/');
  const add = (rule, file, message) => findings.push({ rule, file: rel(file), message });

  // V10 — fail closed on an absent or empty bundle.
  if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) {
    return {
      findings: [{ rule: 'V10', file: rel(bundleRoot), message: 'no bundle — the bundle is a required artifact' }],
      warnings: [], conceptCount: 0, directoryCount: 0, missingBundle: true,
    };
  }

  const files = collectMarkdown(bundleRoot);
  const validated = files.filter((f) => classifyFile(basename(f)) !== 'instructions');
  if (validated.length === 0) {
    return {
      findings: [{ rule: 'V10', file: rel(bundleRoot), message: 'bundle contains no concepts — the bundle is a required artifact' }],
      warnings: [], conceptCount: 0, directoryCount: 0, missingBundle: true,
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
    // what stops the next validator being written without one (see V12 below).
    for (const path of [...STAMP_FIELDS, ['verified', 'at']]) {
      const value = readPath(fields, path);
      if (value === null) continue;
      if (!ISO_8601.test(value) || Number.isNaN(Date.parse(value))) {
        add('V5', file, `field \`${path.join('.')}\` is not a valid ISO 8601 value: ${value}`);
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
        const { target, abs } = resolveRelativeResource(value);
        if (!existsSync(abs)) {
          add('V6', file, `resource does not resolve: ${target}`);
        } else {
          // V12 — drift REPORTS ONLY. A documentation edit must never block a merge on a paid
          // regeneration run, so this can never touch the exit code.
          const stamp = conceptStamp(fields);
          if (stamp === null || Number.isNaN(Date.parse(stamp.value))) {
            // A concept that cites a source but carries no usable stamp is one V12 CANNOT check.
            // Counted rather than dropped: the whole point of the fallback above is that this
            // number is visible, so a migration that strips stamps shows up as coverage falling
            // instead of as a gate that silently checks less each run.
            unstampable.push({ file: rel(file), source: target });
          } else {
            const sourceDate = lastCommitDate(abs);
            if (sourceDate && sourceDate > new Date(stamp.value)) {
              warnings.push({ rule: 'V12', file: rel(file), source: target });
            }
          }
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

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  warnings.sort((a, b) => a.file.localeCompare(b.file));
  return { findings, warnings, unstampable, conceptCount, directoryCount: byDir.size, missingBundle: false };
}

// ── reporting ───────────────────────────────────────────────────────────────────

function report(result, bundleRoot, asJson) {
  if (asJson) {
    console.log(JSON.stringify({
      bundleRoot: relative(REPO_ROOT, bundleRoot).split(sep).join('/') || DEFAULT_BUNDLE,
      conceptCount: result.conceptCount,
      directoryCount: result.directoryCount,
      findings: result.findings,
      warnings: result.warnings,
      unstampable: result.unstampable,
    }, null, 2));
    return;
  }

  if (result.missingBundle) {
    console.error(`[openwiki-okf] ✗ ${result.findings[0].message} (${result.findings[0].rule}) — ${result.findings[0].file}`);
    return;
  }

  if (result.warnings.length > 0) {
    console.log(`[openwiki-okf] ⚠️  ${result.warnings.length} concept(s) may be stale (source changed after the concept's stamp):`);
    for (const w of result.warnings) console.log(`  ${w.file} ← ${w.source}`);
  }

  // Never a finding — an unstamped concept is not malformed. But it IS a concept drift cannot
  // check, and the number has to be visible: a silent drop in V12 coverage is precisely how this
  // gate could go on printing green while checking less every run.
  if (result.unstampable.length > 0) {
    console.log(
      `[openwiki-okf] ⚠️  ${result.unstampable.length} concept(s) cite a source but carry no usable ` +
        `\`generated.at\` or \`timestamp\` — drift is NOT checked for these:`,
    );
    for (const u of result.unstampable) console.log(`  ${u.file} ← ${u.source}`);
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
  const scenario = (name, files, expect) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    const r = validateBundle(dir);
    const rules = new Set(r.findings.map((f) => f.rule));
    if (expect.rule && !rules.has(expect.rule)) {
      fails.push(`${name}: expected ${expect.rule}, got [${[...rules].join(',') || 'none'}]`);
    }
    if (expect.clean && r.findings.length > 0) {
      fails.push(`${name}: expected no findings, got ${r.findings.map((f) => f.rule).join(',')}`);
    }
    if (expect.warns && r.warnings.length === 0) fails.push(`${name}: expected a drift warning, got none`);
    if (expect.warnsCleanExit && r.findings.length > 0) {
      fails.push(`${name}: drift must not produce findings, got ${r.findings.map((f) => f.rule).join(',')}`);
    }
    if (expect.noWarns && r.warnings.length > 0) {
      fails.push(`${name}: expected no drift warning, got ${r.warnings.length}`);
    }
    if (expect.unstampable !== undefined && r.unstampable.length !== expect.unstampable) {
      fails.push(`${name}: expected ${expect.unstampable} unstampable, got ${r.unstampable.length}`);
    }
    return r;
  };

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

  // V12 — drift warns without escalating. The most likely accidental escalation.
  scenario('v12', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\nresource: README.md\ntimestamp: 2001-01-01T00:00:00Z\n---\nb\n',
  }, { warns: true, warnsCleanExit: true });

  // ── OKF v0.2 provenance (openwiki >=0.5.0) ─────────────────────────────────────
  //
  // These four are the regression guard for the upgrade to 0.5.2. The generator STRIPS `timestamp`
  // from every page whose body it rewrites and replaces it with `generated: {by, at}`, so a gate
  // that reads only the v0.1 field would keep printing green while covering fewer pages each run.

  // Drift is detected from the v0.2 stamp alone, exactly as it was from the v0.1 one.
  scenario('v12-generated-at', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\nresource: README.md\ngenerated:\n  by: openwiki/0.5.2\n  at: 2001-01-01T00:00:00Z\n---\nb\n',
  }, { warns: true, warnsCleanExit: true, unstampable: 0 });

  // A fresh stamp must NOT warn — proves the v0.2 value is really being parsed, not just found.
  scenario('v12-generated-at-fresh', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\nresource: README.md\ngenerated:\n  by: openwiki/0.5.2\n  at: 2999-01-01T00:00:00Z\n---\nb\n',
  }, { clean: true, noWarns: true, unstampable: 0 });

  // `generated.at` wins over a stale legacy `timestamp` left behind on the same page.
  scenario('v12-generated-at-precedence', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\nresource: README.md\ntimestamp: 2001-01-01T00:00:00Z\ngenerated:\n  by: openwiki/0.5.2\n  at: 2999-01-01T00:00:00Z\n---\nb\n',
  }, { clean: true, noWarns: true, unstampable: 0 });

  // V5 reaches INSIDE the nested v0.2 events. A malformed `generated.at` is a finding, not a shrug.
  scenario('v5-generated-at', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\ngenerated:\n  by: openwiki/0.5.2\n  at: someday\n---\nb\n',
  }, { rule: 'V5' });
  scenario('v5-verified-at', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\nverified:\n  by: openwiki/0.5.2\n  at: nope\n---\nb\n',
  }, { rule: 'V5' });

  // A concept citing a source with NO stamp at all: not malformed, so no finding — but it must be
  // COUNTED, because that is the number that makes a silent loss of drift coverage visible.
  scenario('v12-unstampable', {
    'index.md': idx('a.md'),
    'a.md': '---\ntype: R\nresource: README.md\n---\nb\n',
  }, { clean: true, noWarns: true, unstampable: 1 });

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

  // V13 — a conformant bundle passes.
  scenario('v13', { 'index.md': idx('a.md'), 'a.md': '---\ntype: R\ntitle: A\nresource: README.md\ntags:\n  - t\n---\nb\n' }, { clean: true });

  rmSync(root, { recursive: true, force: true });

  if (fails.length > 0) {
    console.error('✗ openwiki-okf gate --selftest FAILED:\n  ' + fails.join('\n  '));
    return 1;
  }
  console.log('✓ openwiki-okf gate --selftest passed (V1–V15: front matter, tags, timestamp, resource resolution, index/orphan structure, fail-closed on absent+empty, INSTRUCTIONS.md exemption, drift-warns-without-failing, site-root-absolute body links rejected with the relative form named, code samples exempt, relative links resolved from their own file)');
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
