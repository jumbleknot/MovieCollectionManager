/**
 * Focus-ring convention guard (feature 017 — code-review finding #1; updated at its cause for
 * Tamagui 3 by feature 081 US10, T075).
 *
 * Interactive DS controls must show their ring on KEYBOARD focus only, never on any focus — a
 * plain focus state also fires on a MOUSE click and leaves a persistent :focus outline until blur
 * (the feature-015 bug). Under Tamagui 2 that meant `focusVisibleStyle`, never `focusStyle`.
 *
 * Tamagui 3 removed both pseudo-state objects: a state is a clause on the property it modifies,
 * either in a string program (`outlineStyle="none focus-visible:solid"`) or as a key of a typed
 * value (`outlineStyle={{ default: 'none', 'focus-visible': 'solid' }}`). `focus-visible` is the
 * keyboard-only modifier (`@tamagui/style-grammar` `CoreStateModifierName`); a bare `focus`
 * modifier is the mouse-click bug again. A leftover v2 object is worse than wrong under v3: it
 * typechecks and is forwarded as an unknown prop, so the ring silently disappears.
 *
 * So this statically scans every primitive/surface source and asserts:
 *   1. no leftover `focusStyle` / `focusVisibleStyle` object;
 *   2. no bare `focus` state clause or key (the mouse-focus ring);
 *   3. every control that draws a keyboard ring still declares a `focus-visible` state.
 *
 * Comments are stripped first so the explanatory prose never fires.
 */
import fs from 'fs';
import path from 'path';

const ROOTS = [
  path.resolve(__dirname, 'primitives'),
  path.resolve(__dirname, 'surfaces'),
];

/** The controls that draw a keyboard focus ring — each must keep it. */
const RINGED = [
  'primitives/Button.tsx',
  'primitives/Chip.tsx',
  'primitives/FAB.tsx',
  'primitives/IconButton.tsx',
  'primitives/PillButton.tsx',
  'surfaces/Card.tsx',
];

function collect(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Blank comment bodies (preserve newlines) so prose like "(not focusStyle)" never matches. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const rel = (file: string) => path.relative(__dirname, file).replace(/\\/g, '/');

function offendersOf(re: RegExp): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of collect(root)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const g = new RegExp(re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = g.exec(code))) {
        out.push(`${rel(file)}:${code.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  return out;
}

const show = (list: string[]) => (list.length === 0 ? '' : `\n  ${list.join('\n  ')}\n`);

/** A `focus-visible` state, as a string-program clause or a typed-value key. */
const FOCUS_VISIBLE = /(?:^|[\s"'`{,])['"]?focus-visible['"]?\s*:/m;
/** A bare `focus` state (string clause ` focus:x` or object key `focus:` / `'focus':`). */
const BARE_FOCUS = /(?:^|[\s"'`{,])['"]?focus['"]?\s*:/;

describe('focus-ring convention (Tamagui 3 spelling)', () => {
  it('no DS primitive/surface keeps a v2 focusStyle / focusVisibleStyle object (v3 forwards it unapplied)', () => {
    expect(show(offendersOf(/\bfocus(?:Visible)?Style\b/))).toBe('');
  });

  it('no DS primitive/surface uses a bare `focus` state (it fires on a mouse click — use focus-visible)', () => {
    expect(show(offendersOf(BARE_FOCUS))).toBe('');
  });

  it.each(RINGED)('%s still declares a keyboard (focus-visible) ring', (file) => {
    const code = stripComments(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
    expect(FOCUS_VISIBLE.test(code)).toBe(true);
  });

  // The guard must still catch the bug it was written for, in the new spelling.
  it('self-check: the patterns catch a mouse-focus ring and accept a keyboard one', () => {
    expect(BARE_FOCUS.test(`outlineStyle="none focus:solid"`)).toBe(true);
    expect(BARE_FOCUS.test(`outlineStyle={{ default: 'none', focus: 'solid' }}`)).toBe(true);
    expect(BARE_FOCUS.test(`outlineStyle="none focus-visible:solid"`)).toBe(false);
    expect(BARE_FOCUS.test(`outlineStyle={{ 'focus-visible': 'solid' }}`)).toBe(false);
    expect(FOCUS_VISIBLE.test(`outlineStyle="none focus-visible:solid"`)).toBe(true);
    expect(FOCUS_VISIBLE.test(`outlineStyle={{ default: 'none', 'focus-visible': 'solid' }}`)).toBe(true);
  });
});
