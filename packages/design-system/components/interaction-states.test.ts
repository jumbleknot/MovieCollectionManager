/**
 * Interaction-state preservation guard (feature 081 US10, T074 (ii) — research R12 B3).
 *
 * Tamagui 3 replaces the v2 pseudo-state objects (`hoverStyle`, `pressStyle`, `focusVisibleStyle`) with
 * flat clauses on the property they modify. An UNCONVERTED v2 object still typechecks, and v3 forwards it
 * as an unknown prop instead of applying it — the interaction silently stops happening. The jest-expo
 * renderer exposes no hover/press/focus-visible styles, so this asserts statically, in the style of
 * focus-ring.test.ts: each interactive control's source still declares all three states.
 *
 * Mutation RED (2.7.7): delete one `pressStyle` from Card/Button/Chip and the named control fails.
 */
import fs from 'fs';
import path from 'path';

const CONTROLS = {
  Card:   path.resolve(__dirname, 'surfaces/Card.tsx'),
  Button: path.resolve(__dirname, 'primitives/Button.tsx'),
  Chip:   path.resolve(__dirname, 'primitives/Chip.tsx'),
} as const;

/** Blank comment bodies (preserve newlines) so prose like "(not focusStyle)" never matches. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

// The v2 spelling: one pseudo-state object per state.
const STATES = {
  hover:           /\bhoverStyle\b/,
  press:           /\bpressStyle\b/,
  'focus-visible': /\bfocusVisibleStyle\b/,
} as const;

describe('interactive controls keep their hover / press / focus-visible states', () => {
  for (const [name, file] of Object.entries(CONTROLS)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [state, re] of Object.entries(STATES)) {
      it(`${name} declares a ${state} state`, () => {
        expect(re.test(code)).toBe(true);
      });
    }
  }
});
