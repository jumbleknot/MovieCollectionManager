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

// IMAGES THIS PROJECT BUILDS, EACH SCANNED BY ITS OWN BUILDER — never scanned here.
//
// The rule is "scanned by whoever builds it", not "named like ours" and not "built by cd-deploy".
// Six are cd-deploy's (FR-009). `minio` was added by feature 069 (item #420) and is built and scanned
// by .forgejo/workflows/minio-image.yml, which gates its own publish on a fixable Critical.
//
// Why not scan `minio` here, which was this feature's first design: infra-image-scan is KEYLESS by
// design — its header states it references no `${{ secrets }}` — and that image lives in a private
// registry, so Trivy here cannot pull it (measured: run 3121, "unable to find the specified image").
// Covering it here would have meant handing credentials to the keyless scanner AND scanning only
// after publication. Its builder already holds the image locally and gates the push instead.
//
// The invariant is unchanged and is what matters: every image is scanned by EXACTLY ONE scanner.
// See specs/069-minio-from-source/contracts/scanner-scope.md.
const BUILT_IMAGE_NAMES = ['mcm-bff', 'mc-service', 'agent-gateway', 'movie-mcp', 'web-api-mcp', 'spreadsheet-mcp', 'minio'];

class ScanError extends Error {}

/**
 * Does an image ref carry a tag that can DRIFT (`:latest`, a non-version tag, or no tag at all)?
 *
 * THE PARSE IS THE WHOLE POINT — item #297. This was `ref.split(':').pop()`, which is correct only
 * until a ref carries a digest. `docker:pinDigests` rewrote every ref to `tag@sha256:...`, so that
 * expression started returning the DIGEST HEX and the flag collapsed to "does this image's digest
 * begin with a digit" — a coin flip per image.
 *
 * Measured on `main` the moment PR #289 landed: of the eight `latest`-tagged infra images, the four
 * whose digests begin with a LETTER were reported floating and the four beginning with a DIGIT were
 * reported version-pinned. A `:latest` image reported as pinned is the exact inverse of what this
 * flag exists to say.
 *
 * Three things the ref grammar requires, each of which the old one-liner got wrong:
 *   - strip `@<digest>` FIRST — everything after `@` is never part of the tag;
 *   - a colon is only a tag separator when it comes after the last `/`, otherwise `host:5000/repo`
 *     parses its registry PORT as the tag;
 *   - `v1.9.6` is a version. mailpit publishes exactly that form, so a heuristic anchored on `^\d`
 *     would report item #297's own migration as still-floating.
 */
export function isFloatingTag(ref) {
  const withoutDigest = String(ref).split('@')[0];
  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tag = lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : 'latest';
  return tag === 'latest' || !/^v?\d/.test(tag);
}

/**
 * PURE. Given [{ path, content }] compose/stack files, return the deduped third-party image refs:
 *   [{ ref, locations: [{ path, line }], floatingTag }]
 * Excludes our built images (jumbleknot/* or a bare built-image name) and ${..}-interpolated refs.
 */
export function enumerateImages(files, env = process.env) {
  const byRef = new Map();
  // Locations skipped ONLY because REGISTRY_HOST was absent. Reported by the caller — see below.
  enumerateImages.unresolved = [];
  // `${...}` is ONE unit even when it contains spaces. A compose guard reads
  // `${REGISTRY_HOST:?set in stacks/observability.env}` — the convention every REGISTRY_HOST
  // reference here follows — and the previous `[^"'#\s]+` stopped at the first space, truncating the
  // ref to `${REGISTRY_HOST:?set`. That never mattered while every interpolated ref was skipped
  // outright; it started mattering the moment feature 069 needed to RESOLVE one, and it presented as
  // "the resolution silently does nothing" rather than as a parse error.
  const imageLine = /^\s*image:\s*["']?((?:\$\{[^}]*\}|[^"'#\s])+)["']?/;
  for (const { path, content } of files) {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = imageLine.exec(lines[i]);
      if (!m) continue;
      let ref = m[1];
      // THE REGISTRY HOST IS INTERPOLATED, AND THAT MUST NOT HIDE AN IMAGE FROM THIS SCAN.
      // check-topology-scrub.mjs forbids the real forge host in committed files, so an image we
      // publish ourselves can only be written `${REGISTRY_HOST}/jumbleknot/…`. The blanket `${` skip
      // below would then exclude it — and since cd-deploy does not build it either, it would be
      // published scanned by nothing. That is the same hole feature 069 closed in the exclusion rule,
      // arriving by a different door (found while repointing the compose refs, not by the guard).
      //
      // The host is only unknowable WITHOUT the variable. Where it is set — CI, where this scan
      // actually pulls — the ref is concretely pullable and must be enumerated.
      //
      // Matched with a REGEX, not a literal `${REGISTRY_HOST}`. Compose guards the variable as
      // `${REGISTRY_HOST:?set in stacks/observability.env}` — the convention every other
      // REGISTRY_HOST reference in this repository follows — so a literal match silently stops
      // resolving the moment a ref is brought into line with that convention, which is exactly what
      // happened during feature 069's own implementation.
      const HOST_VAR = /\$\{REGISTRY_HOST(?::[?-][^}]*)?\}/g;
      if (HOST_VAR.test(ref)) {
        HOST_VAR.lastIndex = 0;
        if (env.REGISTRY_HOST) {
          ref = ref.replace(HOST_VAR, env.REGISTRY_HOST);
        } else {
          // Not pullable here — but only report it if resolving the host is the ONLY thing standing
          // between us and scanning it. cd-deploy's own refs also interpolate the host
          // (`${REGISTRY_HOST}/jumbleknot/mcm-bff@${MCM_BFF_DIGEST}`) and would be excluded anyway,
          // twice over: a second `${…}` remains, and the name is in BUILT_IMAGE_NAMES. Reporting
          // those as "unscanned" would be a false alarm, and a warning that cries wolf is one nobody
          // reads — which is the same failure as no warning at all, arrived at differently.
          const probe = ref.replace(HOST_VAR, 'placeholder.invalid');
          const probeBare = probe.split('/').pop().split(':')[0];
          if (!probe.includes('${') && !BUILT_IMAGE_NAMES.includes(probeBare)) {
            enumerateImages.unresolved.push(`${path}:${i + 1}`);
          }
        }
      }
      if (ref.includes('${')) continue; // env-var interpolated — not concretely pullable
      // Exclude what cd-deploy ALREADY SCANS — by membership, not by namespace. This line used to
      // read `if (ref.includes('jumbleknot/')) continue;` with the comment "our built images
      // (cd-deploy owns them)". The comment named the right property; the prefix test implemented a
      // different one, and the two coincided only while every jumbleknot/* image happened to be a
      // cd-deploy image. Feature 069 broke that coincidence: `jumbleknot/minio` is built by us and
      // NOT by cd-deploy, so the prefix rule excluded it here while nothing covered it there — an
      // image published and examined by neither gate, reporting a truthful and meaningless zero.
      //
      // The bareName extraction below already handles both shapes: `jumbleknot/mc-service:latest`
      // yields `mc-service` (excluded, cd-deploy's) and `jumbleknot/minio:REL@sha256:…` yields
      // `minio` (enumerated, ours). So the correct fix was to DELETE the prefix line, not add to it.
      // See specs/069-minio-from-source/contracts/scanner-scope.md for the invariant and its guards.
      const bareName = ref.split('/').pop().split(':')[0];
      if (BUILT_IMAGE_NAMES.includes(bareName)) continue; // cd-deploy scans it; we must not
      const floatingTag = isFloatingTag(ref);
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

  // AN IMAGE SKIPPED FOR A MISSING VARIABLE MUST BE LOUD — feature 069 (item #420).
  //
  // Our own images are referenced as `${REGISTRY_HOST}/jumbleknot/…` because check-topology-scrub
  // forbids the real forge host in a committed file. Without REGISTRY_HOST such a ref is not
  // pullable, so enumerateImages skips it — and a sweep that skipped an image while reporting success
  // is indistinguishable from one that scanned it and found nothing. That is the most repeated
  // failure shape in this repository, and it is what this feature's scanner-partition work exists to
  // prevent; leaving the skip unreported would have reintroduced it one layer down.
  //
  // A warning on --list (enumeration is useful locally without a registry host), but FATAL on a real
  // scan, where "passed" would otherwise be a claim about images nobody looked at.
  if (enumerateImages.unresolved.length > 0) {
    const where = enumerateImages.unresolved.join(', ');
    const n = enumerateImages.unresolved.length;
    if (listOnly) {
      console.warn(
        `⚠ ${n} image ref(s) skipped — REGISTRY_HOST is not set: ${where}\n`
        + '  These are images this project builds and publishes to its own registry. Set REGISTRY_HOST\n'
        + '  to enumerate them; a scan without it does NOT cover them.',
      );
    } else {
      console.error(
        `✗ REGISTRY_HOST is not set, so ${n} image ref(s) cannot be resolved and would go UNSCANNED:\n`
        + `  ${where}\n`
        + '  Refusing to report on a partial image set — a sweep that silently covers less than the\n'
        + '  tree and still passes is worse than one that fails loudly. Set REGISTRY_HOST and re-run.',
      );
      process.exit(2);
    }
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
