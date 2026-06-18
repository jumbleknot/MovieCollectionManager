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
 *   R6 no synthesized font weight (fontWeight > 700 — no Outfit/Inter face is loaded above 700)
 *   R7 no re-invented DS surface (raw <Modal> — use the DS Dialog; full-screen form modals exempt)
 *
 * The scan engine (read + neutralize + brace-parse ONCE per file, then iterate) lives in
 * ds-compliance-scan.ts so each rule reuses one cached pass over the tree and the predicates can be
 * unit-tested in isolation (ds-compliance-scan.test.ts).
 *
 * Sanctioned deviations (radios, row/card press wrappers, dock toggle, removable chips, scrim
 * fallbacks, the sparing-orange accents) are exempted at the call site with a
 *   // ds-exempt(R<n>): <reason>
 * comment on the same or the immediately-preceding line — mirroring
 * contracts/sanctioned-deviations.md (single source of truth: a deviation needs a catalogue
 * entry AND a site annotation). `ds-exempt(all)` exempts a line from every rule.
 */
import path from 'path';
import {
  buildScanFiles,
  collectFiles,
  scanR1,
  scanR2,
  scanR3,
  scanR4,
  scanR5,
  scanR6,
  scanR7,
  type Violation,
} from './ds-compliance-scan';

const SRC = path.resolve(__dirname, '../../src');
const AGENT_DIR = path.join(SRC, 'components', 'agent');

// Read + neutralize + brace-parse every source file ONCE; all rules iterate this cache.
const FILES = buildScanFiles(collectFiles(SRC));

function rel(file: string): string {
  return path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');
}

function report(violations: Violation[]): string {
  return violations
    .map((v) => `  ${rel(v.file)}:${v.line} — ${v.rule} — ${v.snippet.trim().slice(0, 110)}`)
    .join('\n');
}

function expectClean(v: Violation[], rule: string): void {
  expect(v.length === 0 ? '' : `\n${report(v)}\n(${v.length} ${rule} violations)`).toBe('');
}

describe('Design-system compliance (feature 017)', () => {
  it('R1 — no hardcoded colour literals outside the allowlist', () => {
    expectClean(scanR1(FILES), 'R1');
  });

  it('R2 — every numeric fontSize is on the MD3 scale', () => {
    expectClean(scanR2(FILES), 'R2');
  });

  it('R3 — StyleSheet text styles declare an Outfit/Inter family', () => {
    expectClean(scanR3(FILES), 'R3');
  });

  it('R4 — no bespoke TouchableOpacity/Pressable buttons outside the sanctioned allowlist', () => {
    expectClean(scanR4(FILES), 'R4');
  });

  it('R5 — no duplicated agent pill button-style block', () => {
    expectClean(scanR5(FILES, AGENT_DIR), 'R5');
  });

  it('R6 — no synthesized font weight above the loaded faces (≤700)', () => {
    expectClean(scanR6(FILES), 'R6');
  });

  it('R7 — no re-invented DS surface (raw <Modal> — use DS Dialog)', () => {
    expectClean(scanR7(FILES), 'R7');
  });
});
