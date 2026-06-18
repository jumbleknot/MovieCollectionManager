/**
 * Focus-ring convention guard (feature 017 — code-review finding #1).
 *
 * Interactive DS controls must use `focusVisibleStyle` (ring on KEYBOARD focus only), never
 * `focusStyle` — Tamagui's `focusStyle` also fires on a MOUSE click and leaves a persistent
 * :focus outline until blur (the feature-015 bug). This statically scans every primitive/surface
 * source so a regression (or a new control copy-pasting `focusStyle`) fails the unit gate.
 *
 * Comments/strings are stripped first so the explanatory "(not focusStyle)" comments don't fire.
 */
import fs from 'fs';
import path from 'path';

const ROOTS = [
  path.resolve(__dirname, 'primitives'),
  path.resolve(__dirname, 'surfaces'),
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

describe('focus-ring convention', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of collect(root)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      // a `focusStyle` prop/key NOT prefixed by "Visible" (focusVisibleStyle is the allowed form)
      const re = /(?<!Visible)\bfocusStyle\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const line = code.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/')}:${line}`);
      }
    }
  }

  it('no DS primitive/surface uses focusStyle (use focusVisibleStyle)', () => {
    expect(offenders.length === 0 ? '' : `\n  ${offenders.join('\n  ')}\n`).toBe('');
  });
});
