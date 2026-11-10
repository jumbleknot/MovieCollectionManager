// The source fingerprint of a derived openwiki page, and the one staleness judgment built on it.
// Feature 098 (FR-001 fingerprint per page, FR-002 page-level not Claim-level, FR-009 one function
// shared by V17 and `wiki-refresh.mjs --stale`, so the gate and the tool cannot disagree).
//
// `resource-sha256` is the SHA-256 of the page's single `resource` file as it sits in the WORKING
// TREE, after CRLF→LF normalisation (research R1). Working tree because a session records before it
// commits and CI's checkout is the commit; normalised because a Windows checkout with
// `core.autocrlf` must not make every page stale.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { extractFrontMatter } from './openwiki-front-matter.mjs';

export const FINGERPRINT_FIELD = 'resource-sha256';
// Retired with Claims (ADR-0004): `sources` was openwiki's citation list, `verified` its Claims event.
export const FORBIDDEN_FIELDS = ['sources', 'verified'];
const RESERVED = new Set(['INSTRUCTIONS.md', 'index.md', 'log.md']);
const HEX64 = /^[0-9a-f]{64}$/;

const posix = (p) => p.split(sep).join('/');

/** SHA-256 (hex) of a byte buffer with every CRLF normalised to LF (latin1 round-trips bytes 1:1). */
export function fingerprintBytes(buf) {
  const text = Buffer.from(buf).toString('latin1').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');
}

/** The fingerprint of a file as it sits in the working tree. */
export function sourceFingerprint(absPath) {
  return fingerprintBytes(readFileSync(absPath));
}

const isExternal = (value) => {
  try {
    const url = new URL(value);
    // A Windows drive letter parses as a one-letter protocol; that is a path, not a URL.
    return !/^[a-z]:$/i.test(url.protocol);
  } catch {
    return false;
  }
};

/**
 * Read one page as a derived page. Returns null for anything that is not one: unparseable front
 * matter (V1's job), no `resource` (a canonical page), or an external `resource` (V7's job).
 */
export function readDerivedPage(pageAbs, { root }) {
  const fm = extractFrontMatter(readFileSync(pageAbs, 'utf8'));
  if (!fm.fields) return null;
  const value = typeof fm.fields.resource === 'string' ? fm.fields.resource : '';
  if (value === '' || isExternal(value)) return null;
  const resource = value.split('#')[0].split('?')[0];
  const resourceAbs = resolve(root, resource);
  return {
    page: posix(relative(root, pageAbs)),
    pageAbs,
    resource,
    resourceAbs,
    fields: fm.fields,
  };
}

/** Every derived page under `<root>/<bundle>`, sorted by path. */
export function derivedPages({ root, bundle = 'openwiki' }) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && !RESERVED.has(entry.name)) {
        const p = readDerivedPage(full, { root });
        if (p) out.push(p);
      }
    }
  };
  const bundleAbs = resolve(root, bundle);
  if (existsSync(bundleAbs)) walk(bundleAbs);
  return out.sort((a, b) => a.page.localeCompare(b.page));
}

/**
 * Why a derived page is not fresh, or null when it is. One reason per page, in a fixed precedence:
 * a missing source first (nothing else can be judged), then a missing fingerprint, then a changed
 * source, then a retired field.
 */
export function staleReason(p) {
  if (!existsSync(p.resourceAbs)) return 'resource missing';
  if (!statSync(p.resourceAbs).isFile()) return 'resource is not a file';
  const recorded = p.fields[FINGERPRINT_FIELD];
  if (typeof recorded !== 'string' || !HEX64.test(recorded)) return 'no fingerprint';
  if (recorded !== sourceFingerprint(p.resourceAbs)) return 'source changed';
  for (const f of FORBIDDEN_FIELDS) if (f in p.fields) return `forbidden field: ${f}`;
  return null;
}

/** Every derived page that is not fresh: `[{page, resource, reason}]`, sorted by page. */
export function staleDerivedPages({ root, bundle = 'openwiki' }) {
  const out = [];
  for (const p of derivedPages({ root, bundle })) {
    const reason = staleReason(p);
    if (reason !== null) out.push({ page: p.page, resource: p.resource, reason });
  }
  return out;
}

const TOP_KEY = /^([A-Za-z0-9_.-]+)\s*:/;
// A line belonging to the value of the top-level key above it: indented, or a column-0 list item.
const isContinuation = (line) => /^[ \t]/.test(line) || (line.startsWith('-') && !line.startsWith('---'));

/**
 * Record a derived page's fingerprint against its source as it is now. Rewrites ONLY the
 * front-matter keys `resource-sha256` and `timestamp` (in place when present; after `resource:` and
 * at the end otherwise) and removes `sources` and `verified`. The body is never touched, and the
 * page's own line ending is kept.
 */
export function recordSourceFingerprint(pagePath, { root, now = new Date() }) {
  const pageAbs = resolve(root, pagePath);
  if (!existsSync(pageAbs)) throw new Error(`${pagePath}: no such page`);
  const p = readDerivedPage(pageAbs, { root });
  if (p === null) throw new Error(`${pagePath}: not a derived page (no file \`resource\`) — a canonical page has no fingerprint`);
  if (!existsSync(p.resourceAbs)) throw new Error(`${p.page}: resource missing — ${p.resource} does not exist; re-point \`resource\` or retire the page`);
  if (!statSync(p.resourceAbs).isFile()) throw new Error(`${p.page}: resource ${p.resource} is not a file`);

  const fingerprint = sourceFingerprint(p.resourceAbs);
  const stamp = now.toISOString();
  const text = readFileSync(pageAbs, 'utf8');
  const eol = text.startsWith('---\r\n') ? '\r\n' : '\n';
  const open = 3 + eol.length;
  const close = text.indexOf(`${eol}---`, open - eol.length);
  const lines = text.slice(open, close).split(eol);
  const rest = text.slice(close);

  const out = [];
  let dropping = false;
  let wroteFingerprint = false;
  let wroteStamp = false;
  for (const line of lines) {
    const key = TOP_KEY.exec(line)?.[1];
    if (key === undefined && dropping && isContinuation(line)) continue;
    dropping = false;
    if (key !== undefined && FORBIDDEN_FIELDS.includes(key)) { dropping = true; continue; }
    if (key === FINGERPRINT_FIELD) {
      if (!wroteFingerprint) out.push(`${FINGERPRINT_FIELD}: ${fingerprint}`);
      wroteFingerprint = true;
      dropping = true;
      continue;
    }
    if (key === 'timestamp') {
      if (!wroteStamp) out.push(`timestamp: ${stamp}`);
      wroteStamp = true;
      dropping = true;
      continue;
    }
    out.push(line);
  }
  if (!wroteFingerprint) {
    const at = out.findIndex((l) => TOP_KEY.exec(l)?.[1] === 'resource');
    // `resource:` may be followed by continuation lines (a folded scalar); insert after them.
    let i = at + 1;
    while (i < out.length && isContinuation(out[i])) i++;
    out.splice(i, 0, `${FINGERPRINT_FIELD}: ${fingerprint}`);
  }
  if (!wroteStamp) out.push(`timestamp: ${stamp}`);

  writeFileSync(pageAbs, `---${eol}${out.join(eol)}${rest}`);
  return { page: p.page, resource: p.resource, fingerprint };
}
