/**
 * Design-system compliance scan engine (feature 017).
 *
 * Pure, cached scan helpers extracted from design-system-compliance.test.ts so that:
 *   • each file is read + neutralized + brace-parsed ONCE (a ScanFile), then every rule iterates
 *     that cache instead of re-reading 7× (code-review finding #10);
 *   • the rule predicates can be unit-tested on synthetic in-memory ScanFiles
 *     (ds-compliance-scan.test.ts) — the gate test only wires them to the real src tree.
 *
 * Rules (contracts/compliance-rules.md):
 *   R1 no hardcoded colour (only as a VALUE — after : = , or [ — so a hex inside a plain string
 *      such as a URL fragment is not a false positive; finding #7)
 *   R2 every numeric fontSize ∈ the MD3 scale set
 *   R3 text styles (StyleSheet) declaring size/weight also declare an Outfit/Inter family —
 *      brace-matched so a style that also holds a nested object (shadowOffset…) is still checked
 *      (finding #4)
 *   R4 no bespoke TouchableOpacity/Pressable button outside the sanctioned allowlist
 *   R5 no duplicated agent "pill" button-style block
 *   R6 no synthesized font weight (>700) — matches a weight anywhere in the fontWeight expression,
 *      so a ternary/variable form is still scanned (finding #6)
 *   R7 no re-invented DS surface (raw <Modal>)
 */
import fs from 'fs';
import path from 'path';

export const FONT_SCALE = new Set([11, 12, 14, 16, 18, 22, 24, 28, 32, 36, 45, 57]);
export const MAX_LOADED_WEIGHT = 700;

export type Violation = { file: string; line: number; rule: string; snippet: string };
export interface StyleBlock { body: string; start: number }
export interface ScanFile {
  file: string;
  rawLines: string[];
  code: string;       // neutralized source
  nl: number[];       // newline offsets within `code`
  blocks: StyleBlock[];
}

// ─── File collection ────────────────────────────────────────────────────────────
const EXCLUDED_DIRS = new Set(['bff-server', 'bff-api', '__mocks__', 'unit-tests']);

export function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectFiles(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

// ─── Comment stripping (so literals in comments never false-fire) ─────────────────
/**
 * Blank ONLY comment bodies (preserving length/newlines). Strings are kept INTACT — colour
 * literals and `fontFamily: 'Outfit'` values live inside strings and must remain scannable.
 * String state is still tracked so a `//` inside a URL string isn't mistaken for a comment.
 */
export function neutralize(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }
      i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i++; continue; }
      out[i] = ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++; continue;
    }
    const close = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { i += 2; continue; }
    if (c === close) { state = 'code'; i++; continue; }
    i++; continue;
  }
  return out.join('');
}

/** Newline offsets → O(log n) line lookup (replaces per-match slice+split). */
function newlineOffsets(code: string): number[] {
  const nl: number[] = [];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') nl.push(i);
  return nl;
}
export function lineOf(nl: number[], index: number): number {
  let lo = 0, hi = nl.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nl[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** Extract `StyleSheet.create({ ... })` object bodies (brace-matched) with their start index. */
export function styleSheetBlocks(code: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  const re = /StyleSheet\.create\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index);
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) break; }
    }
    blocks.push({ body: code.slice(open + 1, i), start: open + 1 });
  }
  return blocks;
}

/**
 * Top-level `name: { ... }` entries within a style-object body, BRACE-MATCHED so an entry that
 * itself contains a nested object (e.g. `shadowOffset: { width: 0 }`) is captured whole instead of
 * being skipped by a flat `[^{}]*` match (finding #4). `inner` is the full body between the entry's
 * braces (including any nested objects); `index` is relative to `body`.
 */
export function topLevelStyleEntries(body: string): { name: string; inner: string; index: number }[] {
  const out: { name: string; inner: string; index: number }[] = [];
  let depth = 0;
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (depth === 0) {
      const m = /^(\w+)\s*:\s*\{/.exec(body.slice(i));
      if (m) {
        const nameIdx = i;
        const open = i + m[0].length - 1; // index of the entry's '{'
        let d = 0;
        let j = open;
        for (; j < n; j++) {
          if (body[j] === '{') d++;
          else if (body[j] === '}') { d--; if (d === 0) break; }
        }
        out.push({ name: m[1], inner: body.slice(open + 1, j), index: nameIdx });
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** A rule is exempt at `line` (1-based) if that line or the previous non-blank line carries the marker. */
export function isExempt(rawLines: string[], line: number, rule: string): boolean {
  const marker = (s: string) =>
    s.includes(`ds-exempt(${rule})`) || s.includes('ds-exempt(all)');
  if (marker(rawLines[line - 1] ?? '')) return true;
  for (let p = line - 2; p >= 0; p--) {
    const t = (rawLines[p] ?? '').trim();
    if (t === '') continue;
    return marker(rawLines[p] ?? '');
  }
  return false;
}

// ─── ScanFile cache ───────────────────────────────────────────────────────────
export function makeScanFile(file: string, raw: string): ScanFile {
  const code = neutralize(raw);
  return {
    file,
    rawLines: raw.split('\n'),
    code,
    nl: newlineOffsets(code),
    blocks: styleSheetBlocks(code),
  };
}
export function buildScanFiles(paths: string[]): ScanFile[] {
  return paths.map((p) => makeScanFile(p, fs.readFileSync(p, 'utf8')));
}

// ─── R1: no hardcoded colour (value position only) ───────────────────────────────
// A colour literal always sits as a VALUE: after `:` / `=` (optionally `={`), or inside an array
// (`[` / `,`). Requiring that prefix prevents a hex inside an ordinary string (URL fragment,
// copy text) from firing (finding #7).
const COLOUR_RE = /[:=,[]\s*\{?\s*['"`]?(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\()/g;

export function scanR1(files: ScanFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    COLOUR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COLOUR_RE.exec(f.code))) {
      const line = lineOf(f.nl, m.index);
      if (isExempt(f.rawLines, line, 'R1')) continue;
      out.push({ file: f.file, line, rule: 'R1 no-hardcoded-colour', snippet: f.rawLines[line - 1] ?? m[0] });
    }
  }
  return out;
}

// ─── R2: on-scale fontSize ───────────────────────────────────────────────────────
const FONTSIZE_RE = /fontSize:\s*(\d+)|fontSize=\{(\d+)\}/g;

export function scanR2(files: ScanFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    FONTSIZE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FONTSIZE_RE.exec(f.code))) {
      const size = Number(m[1] ?? m[2]);
      if (FONT_SCALE.has(size)) continue;
      const line = lineOf(f.nl, m.index);
      if (isExempt(f.rawLines, line, 'R2')) continue;
      out.push({ file: f.file, line, rule: `R2 off-scale-font(${size})`, snippet: f.rawLines[line - 1] ?? '' });
    }
  }
  return out;
}

// ─── R3: declared font family in StyleSheet text styles ──────────────────────────
const FAMILY_OK = /fontFamily:\s*['"`](Outfit|Inter)/;

export function scanR3(files: ScanFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    for (const block of f.blocks) {
      for (const entry of topLevelStyleEntries(block.body)) {
        if (!/fontSize\b|fontWeight\b/.test(entry.inner)) continue;
        if (FAMILY_OK.test(entry.inner)) continue;
        const line = lineOf(f.nl, block.start + entry.index);
        if (isExempt(f.rawLines, line, 'R3')) continue;
        out.push({ file: f.file, line, rule: `R3 missing-font-family(${entry.name})`, snippet: f.rawLines[line - 1] ?? '' });
      }
    }
  }
  return out;
}

// ─── R4: bespoke buttons ─────────────────────────────────────────────────────────
function referencedStyleNames(attrs: string): string[] {
  const names: string[] = [];
  const re = /styles\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) names.push(m[1]);
  return names;
}

function styleUnionIsButton(blocks: StyleBlock[], names: string[], inlineAttrs: string): boolean {
  let text = inlineAttrs;
  for (const block of blocks) {
    for (const entry of topLevelStyleEntries(block.body)) {
      if (names.includes(entry.name)) text += ' ' + entry.inner;
    }
  }
  const hasRadius = /borderRadius\b/.test(text);
  const hasPadding = /padding(Horizontal|Vertical|Top|Bottom|Left|Right)?\b/.test(text);
  return hasRadius && hasPadding;
}

export function scanR4(files: ScanFile[]): Violation[] {
  const out: Violation[] = [];
  const tagRe = /<(TouchableOpacity|Pressable)\b/g;
  for (const f of files) {
    tagRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(f.code))) {
      const tag = m[1];
      const start = m.index;
      const gt = f.code.indexOf('>', start);
      if (gt === -1) continue;
      const attrs = f.code.slice(start, gt);
      if (!/onPress[=\s]/.test(attrs)) continue;
      const close = f.code.indexOf(`</${tag}>`, gt);
      const inner = close === -1 ? f.code.slice(gt, gt + 400) : f.code.slice(gt, close);
      if (!/<Text\b/.test(inner)) continue;
      const styleAttr = /style=\{([^}]*\}?[^}]*)\}/.exec(attrs)?.[1] ?? attrs;
      const names = referencedStyleNames(attrs);
      if (!styleUnionIsButton(f.blocks, names, styleAttr)) continue;
      const line = lineOf(f.nl, start);
      if (isExempt(f.rawLines, line, 'R4')) continue;
      out.push({ file: f.file, line, rule: `R4 bespoke-button(${tag})`, snippet: f.rawLines[line - 1] ?? '' });
    }
  }
  return out;
}

// ─── R5: duplicated agent pill style ─────────────────────────────────────────────
export function scanR5(files: ScanFile[], agentDir: string): Violation[] {
  const out: Violation[] = [];
  const seen = new Map<string, string>();
  const find = /(\w*button\w*):\s*\{([^{}]*borderRadius[^{}]*padding[^{}]*)\}/gi;
  for (const f of files) {
    if (!f.file.startsWith(agentDir)) continue;
    find.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = find.exec(f.code))) {
      const norm = m[2].replace(/\s+/g, ' ').replace(/\d+/g, '#').trim();
      const line = lineOf(f.nl, m.index);
      if (isExempt(f.rawLines, line, 'R5')) continue;
      if (seen.has(norm)) {
        out.push({ file: f.file, line, rule: 'R5 duplicated-pill-style', snippet: `${f.rawLines[line - 1]?.trim()} (also in ${seen.get(norm)!})` });
      } else {
        seen.set(norm, f.file);
      }
    }
  }
  return out;
}

// ─── R6: no synthesized font weight (>700) ──────────────────────────────────────
// Match the whole fontWeight expression value, then look for ANY 3-digit weight in it — so a
// ternary/variable form (`fontWeight={active ? '800' : '500'}`) is still scanned (finding #6).
const FONTWEIGHT_EXPR_RE = /fontWeight\s*[:=]\s*([^,;}\n]+)/g;

export function scanR6(files: ScanFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    FONTWEIGHT_EXPR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FONTWEIGHT_EXPR_RE.exec(f.code))) {
      const bad = (m[1].match(/\b\d{3}\b/g) ?? []).map(Number).filter((w) => w > MAX_LOADED_WEIGHT);
      if (!bad.length) continue;
      const line = lineOf(f.nl, m.index);
      if (isExempt(f.rawLines, line, 'R6')) continue;
      out.push({ file: f.file, line, rule: `R6 synthesized-weight(${bad[0]})`, snippet: f.rawLines[line - 1] ?? '' });
    }
  }
  return out;
}

// ─── R7: no re-invented DS surface (raw <Modal>) ─────────────────────────────────
const MODAL_RE = /<Modal\b/g;

export function scanR7(files: ScanFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    MODAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODAL_RE.exec(f.code))) {
      const line = lineOf(f.nl, m.index);
      if (isExempt(f.rawLines, line, 'R7')) continue;
      out.push({ file: f.file, line, rule: 'R7 reinvented-surface(Modal)', snippet: f.rawLines[line - 1] ?? '' });
    }
  }
  return out;
}
