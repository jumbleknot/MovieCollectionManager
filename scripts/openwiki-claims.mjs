// The Markdown/Claims durability invariant — ONE definition, used by the OKF gate (rule V16) and by
// wiki-maintain's post-generation link rewrite. Items #611 and #616.
//
// openwiki 0.6.0 re-proves every page that has an entry in `openwiki/.page-manifest.json` before a
// run can advance (generation/page-manifest.js, buildManifestEntry): the page's sidecar
// `openwiki/.claims/<page>.json` must exist, carry a `verification`, and record a `pageVersion` equal
// to `sha256:<hex>` of the page's CURRENT bytes. Anything else throws
//
//   Cannot advance page coverage for /openwiki/<page>; Markdown and verified Claims are not durable.
//
// and fails the WHOLE run — every slice, every page, before any generation. A page with NO manifest
// entry is tolerated: openwiki leaves it "uncovered for full review". Measured twice on 2026-09-29,
// both CI-green because nothing checked this: a reviewer's hand edit of four verified pages (#606,
// recovered by #610) and a run's own output on runbooks/ci-diagnostics.md (proposal #615).
//
// Keyed on the manifest's `/openwiki/<rel>` page names; `<rel>` is resolved against whatever bundle
// directory is being checked, so fixtures outside a real `openwiki/` directory work the same way.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PAGE_MANIFEST = '.page-manifest.json';
export const CLAIMS_DIR = '.claims';
const PAGE_PREFIX = '/openwiki/';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sidecarRel = (rel) => join(CLAIMS_DIR, rel.replace(/\.md$/u, '.json'));
const pageKey = (rel) => `${PAGE_PREFIX}${rel}`;

const FIX = 'Either revert the page to the bytes its Claims certify, or uncover it: remove its '
  + `${PAGE_MANIFEST} entry, delete its ${CLAIMS_DIR} sidecar and its front-matter \`verified:\` event `
  + '(openwiki then leaves it for full review).';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Every covered page whose Markdown and Claims openwiki would reject, as `{ page, message }` with
 * `page` relative to the bundle. Empty when the bundle has no manifest (nothing is covered).
 */
export function claimsDurabilityFindings(bundleDir) {
  const manifestPath = join(bundleDir, PAGE_MANIFEST);
  if (!existsSync(manifestPath)) return [];
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    return [{ page: PAGE_MANIFEST, message: `${PAGE_MANIFEST} is not valid JSON (${err.message}) — openwiki cannot read page coverage at all` }];
  }
  const findings = [];
  for (const key of Object.keys(manifest?.pages ?? {}).sort()) {
    if (!key.startsWith(PAGE_PREFIX)) {
      findings.push({ page: key, message: `manifest entry "${key}" is not a ${PAGE_PREFIX} page path` });
      continue;
    }
    const rel = key.slice(PAGE_PREFIX.length);
    const pagePath = join(bundleDir, rel);
    if (!existsSync(pagePath)) {
      findings.push({ page: rel, message: `has a ${PAGE_MANIFEST} entry but the page does not exist. ${FIX}` });
      continue;
    }
    const scPath = join(bundleDir, sidecarRel(rel));
    if (!existsSync(scPath)) {
      findings.push({ page: rel, message: `has a ${PAGE_MANIFEST} entry but no Claims sidecar at ${sidecarRel(rel)}. ${FIX}` });
      continue;
    }
    let sidecar;
    try {
      sidecar = readJson(scPath);
    } catch (err) {
      findings.push({ page: rel, message: `Claims sidecar ${sidecarRel(rel)} is not valid JSON (${err.message}). ${FIX}` });
      continue;
    }
    if (!sidecar?.verification) {
      findings.push({ page: rel, message: `Claims sidecar ${sidecarRel(rel)} has no verification. ${FIX}` });
      continue;
    }
    const actual = sha256(readFileSync(pagePath));
    if (sidecar.pageVersion !== actual) {
      findings.push({
        page: rel,
        message: `the page's bytes (${actual.slice(0, 19)}…) no longer match the ${sidecar.pageVersion ? `${String(sidecar.pageVersion).slice(0, 19)}…` : 'missing'} `
          + `pageVersion its verified Claims certify — it was edited after verification. openwiki refuses every run on this. ${FIX}`,
      });
    }
  }
  return findings;
}

/**
 * Carry a covered page's certified hash across a PURE harness rewrite of its bytes (the link-form
 * normalization in wiki-maintain), which changes no statement the Claims were verified against.
 *
 * Only when the page was durable BEFORE the rewrite — the old bytes hash to the sidecar's
 * `pageVersion` — so an already-broken page is never laundered into a consistent one. Updates the
 * sidecar and the manifest entry by exact string replacement of the old hash, preserving each file's
 * formatting. Returns whether anything was carried.
 */
export function carryClaimsHash(bundleDir, rel, oldBytes, newBytes) {
  const manifestPath = join(bundleDir, PAGE_MANIFEST);
  const scPath = join(bundleDir, sidecarRel(rel));
  if (!existsSync(manifestPath) || !existsSync(scPath)) return false;
  let manifest;
  let sidecar;
  try {
    manifest = readJson(manifestPath);
    sidecar = readJson(scPath);
  } catch {
    return false;
  }
  const entry = manifest?.pages?.[pageKey(rel)];
  const oldHash = sha256(oldBytes);
  if (!entry || !sidecar?.verification || sidecar.pageVersion !== oldHash) return false;
  const newHash = sha256(newBytes);
  if (newHash === oldHash) return false;
  writeFileSync(scPath, readFileSync(scPath, 'utf8').split(oldHash).join(newHash));
  // The manifest entry may lag the sidecar (openwiki refreshes it); replace whichever hash it holds.
  const mText = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, entry.pageVersion ? mText.split(entry.pageVersion).join(newHash) : mText);
  return true;
}
