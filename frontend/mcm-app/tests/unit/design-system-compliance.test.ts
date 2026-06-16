/**
 * Static design-system compliance scan (feature 017 — the RED→GREEN driver).
 *
 * One `it()` per rule from specs/017-design-system-consistency/contracts/compliance-rules.md.
 * Each rule scans frontend/mcm-app/src/** (excluding bff-server/bff-api/tests/__mocks__/test
 * files) and asserts ZERO violations, printing `file:line — rule — snippet` for each one so the
 * migration can be driven file-by-file.
 *
 *   R1 no hardcoded colour (hex / rgb / rgba / hsl) outside the allowlist
 *   R2 every numeric fontSize ∈ the MD3 scale set
 *   R3 text styles (StyleSheet) declaring size/weight also declare an Outfit/Inter family
 *   R4 no bespoke TouchableOpacity/Pressable button outside the sanctioned allowlist
 *   R5 no duplicated agent "pill" button-style block
 *
 * Sanctioned deviations (radios, row/card press wrappers, dock toggle, removable chips, scrim
 * fallbacks, the sparing-orange accents) are exempted at the call site with a
 *   // ds-exempt(R<n>): <reason>
 * comment on the same or the immediately-preceding line — mirroring
 * contracts/sanctioned-deviations.md (single source of truth: a deviation needs a catalogue
 * entry AND a site annotation). `ds-exempt(all)` exempts a line from every rule.
 */
import fs from 'fs';
import path from 'path';

// ─── On-scale MD3 font sizes (contracts/compliance-rules.md R2) ────────────────
const FONT_SCALE = new Set([11, 12, 14, 16, 18, 22, 24, 28, 32, 36, 45, 57]);

const SRC = path.resolve(__dirname, '../../src');

// ─── File collection ───────────────────────────────────────────────────────────
const EXCLUDED_DIRS = new Set(['bff-server', 'bff-api', '__mocks__', 'unit-tests']);

function collectFiles(dir: string, out: string[] = []): string[] {
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

const FILES = collectFiles(SRC);

// ─── Comment stripping (so literals in comments never false-fire) ─────────────────
/**
 * Blank ONLY comment bodies (preserving length/newlines). Strings are kept INTACT — colour
 * literals and `fontFamily: 'Outfit'` values live inside strings and must remain scannable.
 * String state is still tracked so a `//` inside a URL string isn't mistaken for a comment.
 */
function neutralize(src: string): string {
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
    // string states — leave the contents untouched; just find the close quote
    const close = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { i += 2; continue; }
    if (c === close) { state = 'code'; i++; continue; }
    i++; continue;
  }
  return out.join('');
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** A rule is exempt at `line` (1-based) if that line or the previous non-blank line carries the marker. */
function isExempt(rawLines: string[], line: number, rule: string): boolean {
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

type Violation = { file: string; line: number; rule: string; snippet: string };

function rel(file: string): string {
  return path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');
}

function report(violations: Violation[]): string {
  return violations
    .map((v) => `  ${rel(v.file)}:${v.line} — ${v.rule} — ${v.snippet.trim().slice(0, 110)}`)
    .join('\n');
}

// ─── R1: no hardcoded colour ─────────────────────────────────────────────────────
const COLOUR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsl\(/g;

function scanR1(): Violation[] {
  const out: Violation[] = [];
  for (const file of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const code = neutralize(raw);
    let m: RegExpExecArray | null;
    COLOUR_RE.lastIndex = 0;
    while ((m = COLOUR_RE.exec(code))) {
      const line = lineOf(code, m.index);
      if (isExempt(rawLines, line, 'R1')) continue;
      out.push({ file, line, rule: 'R1 no-hardcoded-colour', snippet: rawLines[line - 1] ?? m[0] });
    }
  }
  return out;
}

// ─── R2: on-scale fontSize ───────────────────────────────────────────────────────
const FONTSIZE_RE = /fontSize:\s*(\d+)|fontSize=\{(\d+)\}/g;

function scanR2(): Violation[] {
  const out: Violation[] = [];
  for (const file of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const code = neutralize(raw);
    let m: RegExpExecArray | null;
    FONTSIZE_RE.lastIndex = 0;
    while ((m = FONTSIZE_RE.exec(code))) {
      const size = Number(m[1] ?? m[2]);
      if (FONT_SCALE.has(size)) continue;
      const line = lineOf(code, m.index);
      if (isExempt(rawLines, line, 'R2')) continue;
      out.push({ file, line, rule: `R2 off-scale-font(${size})`, snippet: rawLines[line - 1] ?? '' });
    }
  }
  return out;
}

// ─── R3: declared font family in StyleSheet text styles ──────────────────────────
const FAMILY_OK = /fontFamily:\s*['"`](Outfit|Inter)/;

/** Extract `StyleSheet.create({ ... })` object bodies (brace-matched) with their start index. */
function styleSheetBlocks(code: string): { body: string; start: number }[] {
  const blocks: { body: string; start: number }[] = [];
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

function scanR3(): Violation[] {
  const out: Violation[] = [];
  // flat style object: `name: { ...no nested braces... }`
  const styleObj = /(\w+):\s*\{([^{}]*)\}/g;
  for (const file of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const code = neutralize(raw);
    for (const block of styleSheetBlocks(code)) {
      let m: RegExpExecArray | null;
      styleObj.lastIndex = 0;
      while ((m = styleObj.exec(block.body))) {
        const body = m[2];
        const hasType = /fontSize\b|fontWeight\b/.test(body);
        if (!hasType) continue;
        if (FAMILY_OK.test(body)) continue;
        const absIndex = block.start + m.index;
        const line = lineOf(code, absIndex);
        if (isExempt(rawLines, line, 'R3')) continue;
        out.push({ file, line, rule: `R3 missing-font-family(${m[1]})`, snippet: rawLines[line - 1] ?? '' });
      }
    }
  }
  return out;
}

// ─── R4: bespoke buttons ─────────────────────────────────────────────────────────
/** Pull the names referenced in a `style={...}` attribute value (styles.X, [styles.X, ...]). */
function referencedStyleNames(attrs: string): string[] {
  const names: string[] = [];
  const re = /styles\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) names.push(m[1]);
  return names;
}

/** Union of the named style bodies (from StyleSheet) is "button-like": borderRadius + padding. */
function styleUnionIsButton(blocks: { body: string }[], names: string[], inlineAttrs: string): boolean {
  let text = inlineAttrs;
  const find = /(\w+):\s*\{([^{}]*)\}/g;
  for (const block of blocks) {
    let m: RegExpExecArray | null;
    find.lastIndex = 0;
    while ((m = find.exec(block.body))) {
      if (names.includes(m[1])) text += ' ' + m[2];
    }
  }
  const hasRadius = /borderRadius\b/.test(text);
  const hasPadding = /padding(Horizontal|Vertical|Top|Bottom|Left|Right)?\b/.test(text);
  return hasRadius && hasPadding;
}

function scanR4(): Violation[] {
  const out: Violation[] = [];
  const tagRe = /<(TouchableOpacity|Pressable)\b/g;
  for (const file of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const code = neutralize(raw);
    const blocks = styleSheetBlocks(code);
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(code))) {
      const tag = m[1];
      const start = m.index;
      // opening-tag attributes: from tag start to the first top-level '>'
      const gt = code.indexOf('>', start);
      if (gt === -1) continue;
      const attrs = code.slice(start, gt);
      if (!/onPress[=\s]/.test(attrs)) continue; // a button reacts to press
      // element inner: to the matching close tag
      const close = code.indexOf(`</${tag}>`, gt);
      const inner = close === -1 ? code.slice(gt, gt + 400) : code.slice(gt, close);
      if (!/<Text\b/.test(inner)) continue; // a button carries a text label
      const styleAttr = /style=\{([^}]*\}?[^}]*)\}/.exec(attrs)?.[1] ?? attrs;
      const names = referencedStyleNames(attrs);
      if (!styleUnionIsButton(blocks, names, styleAttr)) continue; // not styled as a button
      const line = lineOf(code, start);
      if (isExempt(rawLines, line, 'R4')) continue;
      out.push({ file, line, rule: `R4 bespoke-button(${tag})`, snippet: rawLines[line - 1] ?? '' });
    }
  }
  return out;
}

// ─── R5: duplicated agent pill style ─────────────────────────────────────────────
function scanR5(): Violation[] {
  const out: Violation[] = [];
  const agentDir = path.join(SRC, 'components', 'agent');
  const seen = new Map<string, string>(); // normalized pill body -> first file
  const find = /(\w*button\w*):\s*\{([^{}]*borderRadius[^{}]*padding[^{}]*)\}/gi;
  for (const file of FILES) {
    if (!file.startsWith(agentDir)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const code = neutralize(raw);
    let m: RegExpExecArray | null;
    find.lastIndex = 0;
    while ((m = find.exec(code))) {
      const norm = m[2].replace(/\s+/g, ' ').replace(/\d+/g, '#').trim();
      const line = lineOf(code, m.index);
      if (isExempt(rawLines, line, 'R5')) continue;
      if (seen.has(norm)) {
        out.push({
          file,
          line,
          rule: 'R5 duplicated-pill-style',
          snippet: `${rawLines[line - 1]?.trim()} (also in ${rel(seen.get(norm)!)})`,
        });
      } else {
        seen.set(norm, file);
      }
    }
  }
  return out;
}

// ─── Tests ───────────────────────────────────────────────────────────────────────
describe('Design-system compliance (feature 017)', () => {
  it('R1 — no hardcoded colour literals outside the allowlist', () => {
    const v = scanR1();
    expect(v.length === 0 ? '' : `\n${report(v)}\n(${v.length} R1 violations)`).toBe('');
  });

  it('R2 — every numeric fontSize is on the MD3 scale', () => {
    const v = scanR2();
    expect(v.length === 0 ? '' : `\n${report(v)}\n(${v.length} R2 violations)`).toBe('');
  });

  it('R3 — StyleSheet text styles declare an Outfit/Inter family', () => {
    const v = scanR3();
    expect(v.length === 0 ? '' : `\n${report(v)}\n(${v.length} R3 violations)`).toBe('');
  });

  it('R4 — no bespoke TouchableOpacity/Pressable buttons outside the sanctioned allowlist', () => {
    const v = scanR4();
    expect(v.length === 0 ? '' : `\n${report(v)}\n(${v.length} R4 violations)`).toBe('');
  });

  it('R5 — no duplicated agent pill button-style block', () => {
    const v = scanR5();
    expect(v.length === 0 ? '' : `\n${report(v)}\n(${v.length} R5 violations)`).toBe('');
  });
});
