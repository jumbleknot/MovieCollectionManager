/**
 * Unit tests for the design-system compliance scan engine (ds-compliance-scan.ts).
 *
 * These feed synthetic in-memory ScanFiles to the rule predicates to prove the three code-review
 * findings are closed:
 *   #4 — R3 still checks a text style that ALSO holds a nested object (shadowOffset…)
 *   #6 — R6 still catches a synthesized weight written via a ternary/variable
 *   #7 — R1 does NOT false-fire on a hex inside an ordinary string (URL fragment / label)
 * plus baseline detection so a future refactor can't silently neuter a rule.
 */
import {
  makeScanFile,
  scanR1,
  scanR3,
  scanR6,
  type ScanFile,
} from './ds-compliance-scan';

const sf = (raw: string): ScanFile[] => [makeScanFile('/virtual/file.tsx', raw)];

describe('R3 — font-family on text styles (finding #4: nested-object aware)', () => {
  it('flags a text style that lacks a family even when it contains a nested object', () => {
    const v = scanR3(sf(
      `const styles = StyleSheet.create({
        title: { fontSize: 22, fontWeight: '700', shadowOffset: { width: 0, height: 1 } },
      });`,
    ));
    expect(v.map((x) => x.rule)).toEqual(['R3 missing-font-family(title)']);
  });

  it('does NOT flag a text style that declares an Outfit/Inter family (nested object present)', () => {
    const v = scanR3(sf(
      `const styles = StyleSheet.create({
        title: { fontSize: 22, fontFamily: 'Inter', shadowOffset: { width: 0, height: 1 } },
      });`,
    ));
    expect(v).toHaveLength(0);
  });

  it('ignores a non-text style (no fontSize/fontWeight)', () => {
    const v = scanR3(sf(
      `const styles = StyleSheet.create({
        row: { flexDirection: 'row', shadowOffset: { width: 0, height: 1 } },
      });`,
    ));
    expect(v).toHaveLength(0);
  });
});

describe('R6 — synthesized weight (finding #6: ternary/variable aware)', () => {
  it('flags a weight > 700 written as a ternary', () => {
    const v = scanR6(sf(`<Text fontWeight={active ? '800' : '500'}>x</Text>`));
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('R6 synthesized-weight(800)');
  });

  it('flags a plain weight > 700', () => {
    const v = scanR6(sf(`const s = { fontWeight: '900' };`));
    expect(v[0].rule).toBe('R6 synthesized-weight(900)');
  });

  it('does NOT flag weights ≤ 700 (including a ternary of loaded faces)', () => {
    const v = scanR6(sf(`<Text fontWeight={active ? '700' : '500'}>x</Text>`));
    expect(v).toHaveLength(0);
  });
});

describe('R1 — hardcoded colour (finding #7: value-position only)', () => {
  it('flags a hex used as a style value', () => {
    expect(scanR1(sf(`const s = { color: '#ffffff' };`)).map((v) => v.rule))
      .toEqual(['R1 no-hardcoded-colour']);
  });

  it('flags a hex value passed as a JSX prop', () => {
    expect(scanR1(sf(`<View backgroundColor={'#abcdef'} />`))).toHaveLength(1);
  });

  it('flags hexes inside an array literal', () => {
    expect(scanR1(sf(`const g = ['#fff', '#000'];`))).toHaveLength(2);
  });

  it('flags an rgba() value', () => {
    expect(scanR1(sf(`const s = { shadowColor: 'rgba(0,0,0,0.4)' };`))).toHaveLength(1);
  });

  it('does NOT flag a hex inside an ordinary string (URL fragment)', () => {
    expect(scanR1(sf(`const href = 'https://example.com/docs#abcdef';`))).toHaveLength(0);
  });

  it('does NOT flag a hex inside a label string', () => {
    expect(scanR1(sf(`<Text accessibilityLabel="shade #ABCDEF">x</Text>`))).toHaveLength(0);
  });

  it('honours a ds-exempt(R1) site annotation', () => {
    const v = scanR1(sf(
      `// ds-exempt(R1): sanctioned brand accent
      const s = { color: '#ff8800' };`,
    ));
    expect(v).toHaveLength(0);
  });
});
