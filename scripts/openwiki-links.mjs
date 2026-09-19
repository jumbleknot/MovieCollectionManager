// Markdown body-link scanning and normalization for the openwiki/ bundle — item #491.
//
// Shared by BOTH consumers on purpose:
//   * scripts/check-openwiki-okf.mjs   — rules V14/V15, the fail-closed gate
//   * scripts/wiki-maintain.mjs        — the generator's deterministic post-write normalizer
//
// Two regexes kept in step by hand is the failure this module exists to prevent: a link the
// normalizer rewrites and the gate never looked at, or the reverse, and neither shows up as a
// failure — it shows up as a reader following a dead link months later.
//
// ── The measurement this is all built on ────────────────────────────────────────────────────────
//
// Forgejo 15.0.3+gitea-1.22.0, measured 2026-09-19 with `POST /api/v1/markup`. That endpoint —
// unlike `/api/v1/markdown` — accepts `Context`, `BranchPath` and `FilePath`, so it renders a link
// the way the repository file view does:
//
//   [x](/openwiki/process/spec-driven-development.md)
//     → http://<forge>/openwiki/process/spec-driven-development.md           ← 404
//   [x](spec-driven-development.md)
//     → http://<forge>/jumbleknot/mcm/src/branch/main/…/spec-driven-development.md   ← resolves
//
// A leading `/` resolves against the SITE root, not the repository root, so `/openwiki/…` is read as
// a *username*. There is no such user and the route 404s — confirmed anonymously, where `/`,
// `/jumbleknot` and `/explore/repos` all answer 200 while `/openwiki` answers 404, which is what
// separates a genuine route miss from a not-logged-in 404.
//
// The absolute form is also BASE-INDEPENDENT: four different Context/BranchPath/FilePath
// combinations rendered a byte-identical href. The file view differs from the API only in its base,
// so the API result transfers to it rather than merely suggesting an answer.

import { dirname, relative, resolve, sep } from 'node:path';

/** Blank out fenced code blocks and inline code spans so an ILLUSTRATIVE bad link in a sample is
 *  not treated as a real one.
 *
 *  LENGTH-PRESERVING, deliberately: every masked character becomes a space, so an offset into the
 *  masked text is the same offset in the original. That is what lets the gate report a link and the
 *  normalizer splice it out using one scan. */
export function maskCode(text) {
  const blank = (str) => str.replace(/[^\n]/g, ' ');
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const open = line.match(/^\s*(```+|~~~+)/);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
        return blank(line);
      }
      if (open) { fence = open[1]; return blank(line); }
      return line.replace(/`[^`]*`/g, blank);
    })
    .join('\n');
}

/** Inline markdown links and images, each with its 1-based line and the offset/length of its TARGET
 *  in the original text, so a caller can splice a replacement in without re-parsing.
 *
 *  Reference-style definitions (`[x]: /path`) are deliberately not followed: the bundle contains
 *  none, and a silent half-implementation would be worse than an honest absence — the rules would
 *  pass a form they never inspected. If one ever appears, that is a new rule, not a quiet extension. */
export function bodyLinks(text) {
  const masked = maskCode(text);
  const out = [];
  // Two target forms, because CommonMark has two: `<a b.md>`, which MAY contain spaces, and a bare
  // target, which may not. Matching only the bare form silently skips every angle-bracket link —
  // it does not report it, which is the failure mode this module exists to avoid.
  const LINK = /(!?\[[^\]]*\]\(\s*)(?:<([^<>\n]*)>|([^()\s]+))((?:\s+"[^"]*"|\s+'[^']*')?\s*\))/g;
  for (const m of masked.matchAll(LINK)) {
    const bracketed = m[2] !== undefined;
    const target = bracketed ? m[2] : m[3];
    out.push({
      target,
      bracketed,
      line: masked.slice(0, m.index).split('\n').length,
      targetIndex: m.index + m[1].length + (bracketed ? 1 : 0),
      targetLength: target.length,
    });
  }
  return out;
}

/** How a body link should be treated. `skip` targets are outside the remit of V14/V15. */
export function classifyBodyLink(target) {
  if (target === '' || target.startsWith('#')) return { kind: 'skip' };     // in-page anchor
  if (target.startsWith('//')) return { kind: 'skip' };                     // protocol-relative URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { kind: 'skip' };         // http:, mailto:, …
  if (target.startsWith('/')) return { kind: 'site-root' };                 // V14 — renders to the site root
  return { kind: 'relative' };                                              // V15 — must resolve on disk
}

/** Percent-decode, tolerating a malformed escape rather than throwing mid-scan. */
function decodeSafely(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // a malformed escape is not a resolution question; let the filesystem answer
  }
}

/** Split a target into its path and its `#fragment`/`?query` suffix.
 *  Split on the RAW target, never the decoded one: percent-decoding changes the length, so slicing
 *  the raw string by the decoded path's length would cut the suffix in the wrong place. */
export function splitTarget(target) {
  const cut = target.search(/[#?]/);
  return cut === -1
    ? { path: decodeSafely(target), rawPath: target, suffix: '' }
    : { path: decodeSafely(target.slice(0, cut)), rawPath: target.slice(0, cut), suffix: target.slice(cut) };
}

/** The file-relative form a site-root-absolute link should have been written as. Emitted in the
 *  gate finding too, so the remedy is mechanical rather than a puzzle for the next reader. */
export function relativeFormFor(fileAbs, target, repoRoot) {
  const { path, suffix } = splitTarget(target);
  const to = resolve(repoRoot, path.replace(/^\/+/, ''));
  let rel = relative(dirname(fileAbs), to).split(sep).join('/');
  if (rel === '') rel = '.';
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel + suffix;
}

/**
 * Rewrite every site-root-absolute body link in `text` into the file-relative form.
 *
 * Purely mechanical and lossless: only the target inside `](…)` changes, never the link text, never
 * surrounding prose, never a link already relative or external. Splices run back-to-front so an
 * earlier replacement cannot shift a later offset.
 *
 * Returns the new text and the rewrites made, so a caller can report what it changed instead of
 * silently reformatting a file.
 */
export function normalizeLinks(text, fileAbs, repoRoot) {
  const rewrites = [];
  let out = text;
  const links = bodyLinks(text).filter((l) => classifyBodyLink(l.target).kind === 'site-root');
  for (const link of links.reverse()) {
    const replacement = relativeFormFor(fileAbs, link.target, repoRoot);
    out = out.slice(0, link.targetIndex) + replacement + out.slice(link.targetIndex + link.targetLength);
    rewrites.unshift({ line: link.line, from: link.target, to: replacement });
  }
  return { text: out, rewrites };
}
