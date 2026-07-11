#!/usr/bin/env node
// Infra-image CVE scanner orchestrator (feature 035).
// Plan: specs/035-infra-image-cve-scan/plan.md · research R2/R3.
//
// Enumerates the THIRD-PARTY images referenced in infrastructure-as-code/** (excluding our own
// built jumbleknot/* images — already Trivy-scanned in cd-deploy — and ${..}-interpolated refs),
// scans each with Trivy, normalizes to Critical/High/Medium/Low findings, and writes a visible
// report (security/infra-images/reports/findings.json + summary.txt + raw per-image Trivy JSON).
//
// KEYLESS (public images, Trivy bundles/fetches advisory data with no account) and FAIL-CLOSED:
// a Trivy spawn error, image-pull failure, or unparseable output exits non-zero — never a clean
// report on failure.
//
// Usage:
//   node scripts/infra-image-scan.mjs               # enumerate → scan → write reports
//   node scripts/infra-image-scan.mjs --list        # enumerate only (no Trivy — Windows-usable)
//   node scripts/infra-image-scan.mjs --emit-allowlist   # scan, then write reports/allowlist.proposed.yaml
//
// Exit codes: 0 ok · 1 scan/gate-relevant failure (fail-closed) · 2 bad args / config error.

import { readFileSync, writeFileSync, mkdirSync, globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INFRA_GLOB = 'infrastructure-as-code/**/*.{yaml,yml}';
const REPORT_DIR = resolve(REPO_ROOT, 'security/infra-images/reports');
const SEVERITY_MAP_PATH = resolve(REPO_ROOT, 'security/infra-images/severity-map.yaml');

// Our own built images (owned by cd-deploy's Trivy step, FR-009) — never scanned here.
const BUILT_IMAGE_NAMES = ['mcm-bff', 'mc-service', 'agent-gateway', 'movie-mcp', 'web-api-mcp', 'spreadsheet-mcp'];

class ScanError extends Error {}

/**
 * PURE. Given [{ path, content }] compose/stack files, return the deduped third-party image refs:
 *   [{ ref, locations: [{ path, line }], floatingTag }]
 * Excludes our built images (jumbleknot/* or a bare built-image name) and ${..}-interpolated refs.
 */
export function enumerateImages(files) {
  const byRef = new Map();
  const imageLine = /^\s*image:\s*["']?([^"'#\s]+)["']?/;
  for (const { path, content } of files) {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = imageLine.exec(lines[i]);
      if (!m) continue;
      const ref = m[1];
      if (ref.includes('${')) continue; // env-var interpolated — not concretely pullable
      if (ref.includes('jumbleknot/')) continue; // our built images (cd-deploy owns them)
      const bareName = ref.split('/').pop().split(':')[0];
      if (BUILT_IMAGE_NAMES.includes(bareName)) continue; // built image referenced by local tag
      const tag = ref.includes(':') ? ref.split(':').pop() : 'latest';
      const floatingTag = tag === 'latest' || !/^\d/.test(tag); // heuristic: non-versioned tag can drift
      const loc = { path, line: i + 1 };
      if (byRef.has(ref)) byRef.get(ref).locations.push(loc);
      else byRef.set(ref, { ref, locations: [loc], floatingTag });
    }
  }
  return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Load + validate the Trivy→normalized severity map. Unknown native value = hard error. */
export function loadSeverityMap(path = SEVERITY_MAP_PATH) {
  const parsed = parseYaml(readFileSync(path, 'utf8'));
  const map = parsed?.trivy;
  if (!map || typeof map !== 'object') throw new ScanError('severity-map.yaml missing a "trivy:" mapping');
  return map;
}

/**
 * PURE. Map one image's Trivy JSON → normalized findings. `severityMap` maps Trivy severities to the
 * normalized scale; an unmapped severity throws (no silent default). blocking = fixable High/Critical.
 */
export function normalizeTrivy(trivyJson, image, locations, severityMap) {
  const out = [];
  const results = trivyJson?.Results ?? [];
  for (const r of results) {
    for (const v of r.Vulnerabilities ?? []) {
      const native = v.Severity ?? 'UNKNOWN';
      const severity = severityMap[native];
      if (!severity) throw new ScanError(`unmapped Trivy severity "${native}" for ${image} (${v.VulnerabilityID}) — add it to severity-map.yaml`);
      const fixedVersion = v.FixedVersion ?? '';
      const fixAvailable = fixedVersion !== '';
      // Block only on FIXABLE Critical — matching the sibling cd-deploy Trivy step
      // (`--severity CRITICAL --ignore-unfixed`). Base OS images carry hundreds of slow-backport
      // High CVEs; gating on those is noise, so High/Medium/Low are report-only warnings.
      const blocking = severity === 'Critical' && fixAvailable;
      out.push({
        image,
        location: locations.map((l) => `${l.path}:${l.line}`),
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion ?? '',
        fixedVersion,
        severity,
        fixAvailable,
        blocking,
      });
    }
  }
  return out;
}

/** Read the infra tree into [{ path, content }] (paths repo-relative, forward-slashed). */
function readInfraFiles() {
  const abs = globSync(INFRA_GLOB, { cwd: REPO_ROOT });
  return abs.map((p) => ({
    path: relative(REPO_ROOT, resolve(REPO_ROOT, p)).replaceAll('\\', '/'),
    content: readFileSync(resolve(REPO_ROOT, p), 'utf8'),
  }));
}

/** Spawn Trivy for one image. Fail-closed: spawn error or non-zero exit throws. */
function scanImage(ref) {
  const res = spawnSync('trivy', ['image', '--format', 'json', '--no-progress', '--scanners', 'vuln', ref], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new ScanError(`trivy failed to run for ${ref}: ${res.error.message} (is Trivy installed / on PATH?)`);
  if (res.status !== 0) throw new ScanError(`trivy exited ${res.status} for ${ref} (fail-closed): ${(res.stderr || '').slice(0, 500)}`);
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch (e) {
    throw new ScanError(`trivy output for ${ref} was not parseable JSON (fail-closed): ${e.message}`);
  }
  return json;
}

function writeReports(images, findings) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const report = { schemaVersion: 1, generatedForImages: images.map((i) => i.ref), findings };
  writeFileSync(resolve(REPORT_DIR, 'findings.json'), JSON.stringify(report, null, 2));
  const blocking = findings.filter((f) => f.blocking).length;
  const lines = [
    `Infra-image CVE scan — ${images.length} images, ${findings.length} findings (${blocking} blocking = fixable High/Critical)`,
    '',
    ...images.map((i) => {
      const fs = findings.filter((f) => f.image === i.ref);
      const b = fs.filter((f) => f.blocking).length;
      return `  ${i.ref}${i.floatingTag ? ' [floating tag]' : ''} — ${fs.length} findings, ${b} blocking`;
    }),
  ];
  writeFileSync(resolve(REPORT_DIR, 'summary.txt'), lines.join('\n') + '\n');
  return report;
}

/** PURE. Build the proposed-baseline allowlist YAML from the current blocking findings. */
export function buildProposedAllowlist(findings) {
  // Regex-escape the ref/id, then emit as a YAML SINGLE-quoted scalar (backslash is literal there — no
  // double-backslash needed; image refs/CVE ids contain no single quotes). A literal ' would be '' .
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "''");
  const jesc = (s) => String(s).replace(/'/g, "''");
  const entries = findings
    .filter((f) => f.blocking)
    .map((f) =>
      `- image: '${esc(f.image)}'\n  id: '${esc(f.id)}'\n  justification: 'Baseline (035): pre-existing ${jesc(f.severity)} in ${jesc(f.pkg)} — awaiting Renovate base-image bump (fix ${jesc(f.fixedVersion)}).'\n  addedBy: 'seed'\n`
    );
  const header = '# PROPOSED baseline allowlist — generated by infra-image-scan.mjs --emit-allowlist.\n# Review, then paste the accepted entries into security/infra-images/allowlist.yaml.\n\n';
  return header + entries.join('');
}

function emitProposedAllowlist(findings) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(resolve(REPORT_DIR, 'allowlist.proposed.yaml'), buildProposedAllowlist(findings));
}

function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const emitAllowlist = argv.includes('--emit-allowlist');
  for (const a of argv) {
    if (!['--list', '--emit-allowlist'].includes(a)) { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }

  let images;
  try {
    images = enumerateImages(readInfraFiles());
  } catch (e) {
    console.error(`✗ enumeration failed: ${e.message}`);
    process.exit(2);
  }

  if (listOnly) {
    console.log(`Third-party infra images (${images.length}) — would be scanned (jumbleknot/* + \${..} excluded):`);
    for (const i of images) console.log(`  ${i.ref}${i.floatingTag ? '  [floating tag]' : ''}\n    ${i.locations.map((l) => `${l.path}:${l.line}`).join(', ')}`);
    process.exit(0);
  }

  let severityMap;
  try {
    severityMap = loadSeverityMap();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }

  const findings = [];
  try {
    for (const img of images) {
      console.log(`── trivy scan ${img.ref} ──`);
      const json = scanImage(img.ref);
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(resolve(REPORT_DIR, `trivy-${img.ref.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`), JSON.stringify(json));
      findings.push(...normalizeTrivy(json, img.ref, img.locations, severityMap));
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1); // fail-closed — never write/leave a clean report on scan failure
  }

  const report = writeReports(images, findings);
  if (emitAllowlist) emitProposedAllowlist(findings);
  console.log(`✓ scanned ${images.length} images → ${report.findings.length} findings (${findings.filter((f) => f.blocking).length} blocking). Report: security/infra-images/reports/findings.json`);
  process.exit(0);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
