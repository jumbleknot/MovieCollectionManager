#!/usr/bin/env node
// SAST/SCA scan orchestrator (feature 033, T011–T016 / T021).
// Contract: specs/033-sast-semgrep/contracts/sast-scan.cli.md + data-model.md.
//
// Runs four keyless scanners — Semgrep (code SAST, TS/JS + Python), cargo audit (Rust deps),
// pnpm audit (JS deps), pip-audit (Python deps) — normalizes their heterogeneous output onto one
// Critical/High/Medium/Low scale via security/sast/severity-map.yaml, derives the SCA runtime-vs-dev
// scope + the `blocking` flag, and writes a consolidated findings.json (the gate's input contract) plus
// SARIF, a human summary, and each scanner's secret-scrubbed native output to security/sast/reports/.
//
// Does NOT decide pass/fail — that is the gate's job (check-sast-findings.mjs). Fails fast (exit 1) if a
// required toolchain is missing / advisory data is unreachable / a native severity is unmapped (FR-015),
// recording scanners[].error, rather than silently dropping a language surface.
//
// Usage:
//   node scripts/sast-scan.mjs [--scope full|changed] [--base <ref>] [--only <scanner,...>] [--out <dir>]

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const SEMGREP_PIN = '1.169.0';
const ALL_SCANNERS = ['semgrep', 'cargo-audit', 'pnpm-audit', 'pip-audit'];
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

// ── Shared spawn helper ──────────────────────────────────────────────────────
// shell:false everywhere (avoids the DEP0190 shell+args warning and its escaping pitfall). Windows
// CreateProcess resolves bare .exe tools (cargo/uvx/uv/git/where) by appending .exe; pnpm ships a
// .cmd shim that CreateProcess can't launch directly, so route it through `cmd /c` on Windows.
function run(cmd, args, opts = {}) {
  let c = cmd;
  let a = args;
  if (IS_WIN && cmd === 'pnpm') { c = 'cmd'; a = ['/c', 'pnpm', ...args]; }
  // NO_COLOR: some tools (notably `uv`) colorize even when stdout is a pipe, injecting ANSI escapes
  // that corrupt the machine-readable output we parse (e.g. pip-audit rejects the requirements file).
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...(opts.env || {}) };
  return spawnSync(c, a, { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 1 << 28, ...opts, env });
}

// ── Config loaders ───────────────────────────────────────────────────────────
export function loadSeverityMap(path = resolve(REPO_ROOT, 'security/sast/severity-map.yaml')) {
  return parseYaml(readFileSync(path, 'utf8'));
}

function loadSemgrepConfigs(path = resolve(REPO_ROOT, 'security/sast/semgrep.yaml')) {
  const doc = parseYaml(readFileSync(path, 'utf8')) ?? {};
  return Array.isArray(doc.configs) ? doc.configs : [];
}

function loadSemgrepExcludes(path = resolve(REPO_ROOT, 'security/sast/.semgrepignore')) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/\/+$/, ''));
}

// ── Pure normalization primitives (unit-tested by sast-scan.guard.test.mjs) ──

/** Map a scanner's native severity onto the normalized scale. Throws (fail-fast) on an unmapped value. */
export function normalizeSeverity(scanner, native, map) {
  if (scanner === 'semgrep') {
    const v = map.semgrep?.[native];
    if (!v) throw new Error(`[semgrep] unmapped native severity "${native}" — add it to severity-map.yaml (no silent default).`);
    return v;
  }
  if (scanner === 'pnpm-audit') {
    const v = map.pnpmAudit?.[String(native).toLowerCase()];
    if (!v) throw new Error(`[pnpm-audit] unmapped native severity "${native}" — add it to severity-map.yaml.`);
    return v;
  }
  if (scanner === 'cargo-audit' || scanner === 'pip-audit') {
    if (native === 'unscored') return map.unscoredAdvisory;
    if (native === 'informational') return map.informationalWarning;
    const score = typeof native === 'number' ? native : Number(native);
    if (!Number.isFinite(score)) {
      throw new Error(`[${scanner}] unmapped native severity "${native}" — expected a CVSS number, 'unscored', or 'informational'.`);
    }
    const b = map.cvssBands ?? {};
    if (score >= b.critical) return 'Critical';
    if (score >= b.high) return 'High';
    if (score >= b.medium) return 'Medium';
    return 'Low';
  }
  throw new Error(`Unknown scanner "${scanner}"`);
}

/** Derived per data-model: block iff High/Critical AND (SAST, or SCA runtime-scoped). */
export function deriveBlocking({ kind, severity, scope }) {
  if (severity !== 'High' && severity !== 'Critical') return false;
  return kind === 'sast' || scope === 'runtime';
}

/** SCA scope: runtime if the package is in the ecosystem runtime set; unknown set → runtime (conservative). */
export function classifyScope(pkgName, runtimeSet) {
  if (!runtimeSet) return 'runtime';
  return runtimeSet.has(pkgName) ? 'runtime' : 'dev';
}

/** Fail-fast if a required scanner toolchain is not on PATH (FR-015). */
export function assertToolchain(cmd, scanner) {
  const probe = IS_WIN ? run('where', [cmd], { shell: false }) : run('sh', ['-c', `command -v ${cmd}`]);
  if (!probe || probe.status !== 0) {
    throw new Error(`[${scanner}] required toolchain "${cmd}" not found on PATH — install it (see docs/runbooks/sast-scanning.md). Refusing to skip a language surface (FR-015).`);
  }
}

/** Assemble the findings report object (the gate's input contract; validates against findings.schema.json). */
export function buildFindingsReport({ scope, scanners, findings }) {
  return { schemaVersion: 1, generatedAtScope: scope, scanners, findings };
}

// ── Secret scrubbing (T016 / FR-018 — reuses the DAST scrub shapes) ──────────
export function scrubSecretsInText(text) {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '<redacted-jwt>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, '$1<redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '<redacted-anthropic-key>')
    .replace(/(mcm_(?:access_token|refresh_token|session_id)=)[^;"'\s\\]+/g, '$1<redacted>');
}

function writeReport(path, text) {
  writeFileSync(path, scrubSecretsInText(text));
}

// ── Semgrep runner (T011) ────────────────────────────────────────────────────
function normalizeSemgrep(native, map) {
  const out = [];
  for (const r of native.results ?? []) {
    const nativeSeverity = r.extra?.severity ?? 'INFO';
    const severity = normalizeSeverity('semgrep', nativeSeverity, map);
    const line = r.start?.line ?? 0;
    const title = String(r.extra?.message ?? r.check_id ?? '').split('\n')[0].trim();
    out.push({
      scanner: 'semgrep', kind: 'sast', id: String(r.check_id ?? 'semgrep'),
      title, location: `${r.path}:${line}`, ecosystem: null,
      nativeSeverity: String(nativeSeverity), severity, scope: null,
      blocking: deriveBlocking({ kind: 'sast', severity, scope: null }), fixAvailable: null,
    });
  }
  return out;
}

function runSemgrep({ scope, targets, outDir, map }) {
  assertToolchain('uvx', 'semgrep');
  const nativeOut = resolve(outDir, 'semgrep-native.json');
  const args = [
    `semgrep@${SEMGREP_PIN}`, 'scan', '--metrics=off', '--disable-version-check',
    '--json', '--output', nativeOut,
  ];
  for (const c of loadSemgrepConfigs()) args.push('--config', c);
  args.push('--config', 'security/sast/rules/');
  for (const ex of loadSemgrepExcludes()) args.push('--exclude', ex);

  const scanTargets = scope === 'changed' ? targets : ['.'];
  if (scope === 'changed' && scanTargets.length === 0) {
    // No changed code files → Semgrep is a no-op (SCA still runs). Emit an empty native report.
    writeReport(nativeOut, JSON.stringify({ results: [], errors: [], skipped: 'no changed code files' }, null, 2));
    return { native: { results: [], errors: [] }, findings: [] };
  }
  args.push(...scanTargets);

  const r = run('uvx', args);
  // semgrep exit: 0 = no findings, 1 = findings present, >=2 = error (registry unreachable, bad rule, …).
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`[semgrep] scan failed (exit ${r.status}) — rules/registry may be unreachable (fail-closed, FR-015): ${(r.stderr || '').slice(-500)}`);
  }
  if (!existsSync(nativeOut)) {
    throw new Error(`[semgrep] produced no JSON output (exit ${r.status}) — refusing to report a clean scan.`);
  }
  const native = JSON.parse(readFileSync(nativeOut, 'utf8'));
  return { native, findings: normalizeSemgrep(native, map) };
}

// ── cargo audit runner (T012) ────────────────────────────────────────────────
function computeCargoRuntimeSet() {
  const r = run('cargo', ['tree', '--edges', 'no-dev', '--prefix', 'none', '--no-dedupe']);
  if (r.status !== 0) return null; // can't classify → conservative (everything runtime)
  const set = new Set();
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_-]+)\s+v\d/);
    if (m) set.add(m[1]);
  }
  return set.size ? set : null;
}

// RustSec `cvss` is null, a numeric score, or a CVSS vector string. Only a plain number is scorable;
// a vector string can't be scored without a calculator → treat as unscored (conservative → High).
function cargoCvssNative(cvss) {
  if (cvss == null) return 'unscored';
  if (typeof cvss === 'number') return cvss;
  const n = Number(cvss);
  return Number.isFinite(n) ? n : 'unscored';
}

function normalizeCargoAudit(native, runtimeSet, map) {
  const out = [];
  for (const v of native.vulnerabilities?.list ?? []) {
    const adv = v.advisory ?? {};
    const pkg = v.package ?? {};
    const nativeSev = cargoCvssNative(adv.cvss);
    const severity = normalizeSeverity('cargo-audit', nativeSev, map);
    const scope = classifyScope(pkg.name, runtimeSet);
    out.push({
      scanner: 'cargo-audit', kind: 'sca', id: String(adv.id ?? 'RUSTSEC-unknown'),
      title: String(adv.title ?? adv.id ?? ''), location: `${pkg.name}@${pkg.version}`,
      ecosystem: 'cargo', nativeSeverity: String(adv.cvss ?? 'unscored'), severity, scope,
      blocking: deriveBlocking({ kind: 'sca', severity, scope }),
      fixAvailable: (v.versions?.patched ?? [])[0] ?? null,
    });
  }
  // Informational warnings (unmaintained / yanked / unsound) → Low, never blocking.
  for (const [kind, list] of Object.entries(native.warnings ?? {})) {
    for (const w of list ?? []) {
      const pkg = w.package ?? {};
      const adv = w.advisory ?? null;
      const severity = normalizeSeverity('cargo-audit', 'informational', map);
      const scope = classifyScope(pkg.name, runtimeSet);
      out.push({
        scanner: 'cargo-audit', kind: 'sca', id: String(adv?.id ?? `cargo-${kind}-${pkg.name}`),
        title: String(adv?.title ?? `${kind}: ${pkg.name}`), location: `${pkg.name}@${pkg.version}`,
        ecosystem: 'cargo', nativeSeverity: String(kind), severity, scope,
        blocking: false, fixAvailable: null,
      });
    }
  }
  return out;
}

function runCargoAudit({ map }) {
  assertToolchain('cargo', 'cargo-audit');
  const runtimeSet = computeCargoRuntimeSet();
  const r = run('cargo', ['audit', '--file', 'Cargo.lock', '--json']);
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`[cargo-audit] failed (exit ${r.status}) — advisory DB may be unreachable (fail-closed): ${(r.stderr || '').slice(-500)}`);
  }
  let native;
  try {
    native = JSON.parse(r.stdout);
  } catch {
    throw new Error(`[cargo-audit] non-JSON output — is cargo-audit installed and the advisory DB fetchable? ${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { native, findings: normalizeCargoAudit(native, runtimeSet, map) };
}

// ── pnpm audit runner (T013) ─────────────────────────────────────────────────
function pnpmAuditJson(extra) {
  const r = run('pnpm', ['audit', '--json', ...extra]);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`[pnpm-audit] non-JSON output (registry advisories unreachable?): ${(r.stderr || r.stdout || '').slice(-300)}`);
  }
}

function normalizePnpmAudit(full, prodKeys, map) {
  const out = [];
  for (const [key, adv] of Object.entries(full.advisories ?? {})) {
    const id = String(adv.github_advisory_id || (adv.cves || [])[0] || adv.id || key);
    const scope = prodKeys.has(String(key)) || prodKeys.has(String(adv.id)) ? 'runtime' : 'dev';
    const severity = normalizeSeverity('pnpm-audit', adv.severity, map);
    const fix = adv.patched_versions && adv.patched_versions !== '<0.0.0' ? String(adv.patched_versions) : null;
    const versions = (adv.findings ?? []).map((f) => f.version).filter(Boolean);
    for (const version of versions.length ? versions : ['*']) {
      out.push({
        scanner: 'pnpm-audit', kind: 'sca', id, title: String(adv.title ?? id),
        location: `${adv.module_name}@${version}`, ecosystem: 'npm',
        nativeSeverity: String(adv.severity), severity, scope,
        blocking: deriveBlocking({ kind: 'sca', severity, scope }), fixAvailable: fix,
      });
    }
  }
  return out;
}

function runPnpmAudit({ map }) {
  assertToolchain('pnpm', 'pnpm-audit');
  const full = pnpmAuditJson([]);
  const prod = pnpmAuditJson(['--prod']);
  const prodKeys = new Set(Object.keys(prod.advisories ?? {}));
  return { native: full, findings: normalizePnpmAudit(full, prodKeys, map) };
}

// ── pip-audit runner (T014) ──────────────────────────────────────────────────
const normPyName = (n) => String(n).toLowerCase().replace(/[_.]+/g, '-');

function uvExport(agentDir, extra) {
  // --no-hashes is REQUIRED: a hashed requirements file puts pip-audit into --require-hashes mode,
  // which spins up a virtualenv and runs internal pip to resolve/download all deps (extremely slow —
  // it hangs for many minutes on the full set). Without hashes, pip-audit audits the pins directly
  // against OSV (~1s/package), no venv, no resolution.
  const r = run('uv', ['export', '--frozen', '--no-emit-project', '--no-hashes', ...extra, '--format', 'requirements-txt'], { cwd: agentDir });
  if (r.status !== 0) {
    throw new Error(`[pip-audit] uv export failed (exit ${r.status}): ${(r.stderr || '').slice(-300)}`);
  }
  return r.stdout || '';
}

function parseReqNames(text) {
  const set = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9._-]+)==/);
    if (m) set.add(normPyName(m[1]));
  }
  return set.size ? set : null;
}

function normalizePipAudit(native, agentSet, runtimeSet, map) {
  const out = [];
  for (const dep of native.dependencies ?? []) {
    const name = normPyName(dep.name);
    // Auditing the installed env also surfaces pip-audit's own ephemerally-injected deps; keep only
    // packages that are actually in the agent's dependency graph (agentSet). Null set → keep all.
    if (agentSet && !agentSet.has(name)) continue;
    for (const vuln of dep.vulns ?? []) {
      // pip-audit/OSV rarely carries a CVSS score → conservative 'unscored' (→ High).
      const severity = normalizeSeverity('pip-audit', 'unscored', map);
      const scope = classifyScope(name, runtimeSet);
      out.push({
        scanner: 'pip-audit', kind: 'sca', id: String(vuln.id),
        title: String((vuln.aliases || [])[0] || vuln.id), location: `${dep.name}@${dep.version}`,
        ecosystem: 'pypi', nativeSeverity: 'unscored', severity, scope,
        blocking: deriveBlocking({ kind: 'sca', severity, scope }),
        fixAvailable: (vuln.fix_versions || [])[0] ?? null,
      });
    }
  }
  return out;
}

function runPipAudit({ map }) {
  assertToolchain('uv', 'pip-audit');
  const agentDir = resolve(REPO_ROOT, 'agents/movie-assistant');
  const agentSet = parseReqNames(uvExport(agentDir, []));               // full agent dep graph (names)
  const runtimeSet = parseReqNames(uvExport(agentDir, ['--no-dev']));   // runtime subset (names)

  // Audit the INSTALLED venv, NOT a requirements file: pip-audit's `-r` mode resolves the file in an
  // ephemeral venv (downloads every dep — hangs for many minutes on the full lockfile). Auditing the
  // already-synced env queries OSV for the installed distributions directly (~1 min, no download).
  // pip-audit is injected via `uv run --with`; its own deps are filtered out in normalizePipAudit via
  // agentSet. Prereq: the agent venv is synced (`uv sync` in agents/movie-assistant).
  const r = run('uv', ['run', '--no-sync', '--with', 'pip-audit', 'pip-audit', '--format', 'json', '-s', 'osv', '--progress-spinner', 'off'], { cwd: agentDir });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`[pip-audit] failed (exit ${r.status}) — OSV unreachable, or the agent venv is not synced (run \`uv sync\` in agents/movie-assistant): ${(r.stderr || '').slice(-500)}`);
  }
  let native;
  try {
    native = JSON.parse(r.stdout);
  } catch {
    throw new Error(`[pip-audit] non-JSON output: ${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { native, findings: normalizePipAudit(native, agentSet, runtimeSet, map) };
}

// ── SARIF + summary (T015) ───────────────────────────────────────────────────
function toSarif(findings) {
  const level = (s) => ({ Critical: 'error', High: 'error', Medium: 'warning', Low: 'note' }[s] || 'note');
  const results = findings.map((f) => {
    const loc = f.kind === 'sast'
      ? { physicalLocation: { artifactLocation: { uri: f.location.replace(/:\d+$/, '') }, region: { startLine: Number(f.location.match(/:(\d+)$/)?.[1] || 1) } } }
      : { logicalLocations: [{ name: f.location, kind: 'package' }] };
    return {
      ruleId: `${f.scanner}:${f.id}`,
      level: level(f.severity),
      message: { text: `[${f.severity}${f.blocking ? '/blocking' : ''}] ${f.title}` },
      locations: [loc],
      properties: { scanner: f.scanner, kind: f.kind, severity: f.severity, scope: f.scope, blocking: f.blocking },
    };
  });
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{ tool: { driver: { name: 'mcm-sast-scan', informationUri: 'https://github.com/jumbleknot/mcm', rules: [] } }, results }],
  };
}

const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low'];

function summarize(report) {
  const lines = ['── SAST/SCA scan summary ──────────────────────────────'];
  lines.push(`scope=${report.generatedAtScope}  findings=${report.findings.length}  blocking=${report.findings.filter((f) => f.blocking).length}`);
  for (const s of report.scanners ?? []) {
    lines.push(`  ${s.scanner}: ${s.ran ? `${s.findingCount} finding(s)` : `NOT RUN — ${s.error}`}`);
  }
  for (const sev of SEV_ORDER) {
    const items = report.findings.filter((f) => f.severity === sev);
    if (!items.length) continue;
    lines.push(`${sev}: ${items.length}${sev === 'High' || sev === 'Critical' ? ` (${items.filter((f) => f.blocking).length} blocking)` : ''}`);
    for (const f of items.slice(0, 40)) {
      lines.push(`  [${f.scanner}${f.blocking ? '/BLOCK' : f.scope === 'dev' ? '/dev' : ''}] ${f.id} — ${f.location}`);
    }
    if (items.length > 40) lines.push(`  … and ${items.length - 40} more`);
  }
  lines.push('───────────────────────────────────────────────────────');
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { scope: 'full', base: 'origin/main', only: null, out: 'security/sast/reports' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') args.scope = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
    else { console.error(`Unknown argument: ${a}. Usage: sast-scan.mjs [--scope full|changed] [--base <ref>] [--only <scanner,...>] [--out <dir>]`); process.exit(2); }
  }
  if (!['full', 'changed'].includes(args.scope)) { console.error(`--scope must be full|changed (got "${args.scope}")`); process.exit(2); }
  if (args.only) {
    const bad = args.only.filter((s) => !ALL_SCANNERS.includes(s));
    if (bad.length) { console.error(`--only: unknown scanner(s) ${bad.join(', ')} (valid: ${ALL_SCANNERS.join(', ')})`); process.exit(2); }
  }
  return args;
}

function computeChangedTargets(base) {
  const r = run('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]);
  if (r.status !== 0) {
    console.warn(`[sast-scan] git diff vs ${base} failed — scanning changed set is empty. ${(r.stderr || '').slice(-200)}`);
    return [];
  }
  return (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && CODE_EXT_RE.test(l) && existsSync(resolve(REPO_ROOT, l)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(REPO_ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const map = loadSeverityMap();
  const selected = args.only ?? ALL_SCANNERS;
  const changedTargets = args.scope === 'changed' ? computeChangedTargets(args.base) : [];

  const runners = {
    'semgrep': () => runSemgrep({ scope: args.scope, targets: changedTargets, outDir, map }),
    'cargo-audit': () => runCargoAudit({ map }),
    'pnpm-audit': () => runPnpmAudit({ map }),
    'pip-audit': () => runPipAudit({ map }),
  };

  const scanners = [];
  const findings = [];
  let failed = null;
  for (const name of ALL_SCANNERS) {
    if (!selected.includes(name)) continue;
    console.log(`[sast-scan] running ${name} …`);
    try {
      const res = runners[name]();
      writeReport(resolve(outDir, `${name}-native.json`), JSON.stringify(res.native ?? {}, null, 2));
      findings.push(...res.findings);
      scanners.push({ scanner: name, ran: true, findingCount: res.findings.length, error: null });
    } catch (e) {
      // FAIL-FAST (FR-015): record the error in the report, then stop with a non-zero exit.
      scanners.push({ scanner: name, ran: false, findingCount: 0, error: String(e.message) });
      failed = e;
      break;
    }
  }

  const report = buildFindingsReport({ scope: args.scope, scanners, findings });
  writeReport(resolve(outDir, 'findings.json'), JSON.stringify(report, null, 2));
  writeReport(resolve(outDir, 'findings.sarif'), JSON.stringify(toSarif(findings), null, 2));
  const summary = summarize(report);
  writeReport(resolve(outDir, 'summary.txt'), summary);
  console.log(summary);

  if (failed) {
    console.error(`[sast-scan] FAILED fast: ${failed.message}`);
    process.exit(1);
  }
  console.log(`[sast-scan] done — reports in ${args.out}/ (${findings.length} findings, ${findings.filter((f) => f.blocking).length} blocking).`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
