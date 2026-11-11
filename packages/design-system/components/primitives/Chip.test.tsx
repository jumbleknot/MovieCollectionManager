/**
 * Chip a11y semantics (098 T011a, WCAG 2.1.1 Keyboard + 4.1.2 Name/Role/Value).
 *
 * On web Tamagui drops `accessibilityRole` / `accessible`, so a Chip rendered as a bare <div> with no
 * role and no tabindex — no filter or sort chip could be reached by keyboard. The chip must carry an
 * explicit `role`, its state as `aria-*`, and `tabIndex`; on web Enter/Space activate it.
 * Tamagui does not forward `onKeyDown` on native, so the key handling is a pure exported helper.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { Chip, chipKeyActivates } from './Chip';

async function renderDS(ui: React.ReactElement) {
  return await render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('Chip a11y semantics', () => {
  it('is a focusable button by default', async () => {
    const { getByTestId } = await renderDS(<Chip testID="c" label="Action" onPress={() => {}} />);
    const p = getByTestId('c').props;
    expect(p.role).toBe('button');
    expect(p.tabIndex).toBe(0);
  });

  it('a selected choice chip with the button role is aria-pressed', async () => {
    const { getByTestId, rerender } = await renderDS(
      <Chip testID="c" type="choice" selected label="Movie" onPress={() => {}} />,
    );
    expect(getByTestId('c').props['aria-pressed']).toBe(true);
    await rerender(
      <TamaguiProvider config={config} defaultTheme="dark">
        <Chip testID="c" type="choice" selected={false} label="Movie" onPress={() => {}} />
      </TamaguiProvider>,
    );
    expect(getByTestId('c').props['aria-pressed']).toBe(false);
  });

  it('an assist chip carries no pressed state', async () => {
    const { getByTestId } = await renderDS(<Chip testID="c" label="Help" onPress={() => {}} />);
    expect(getByTestId('c').props['aria-pressed']).toBeUndefined();
  });

  it.each(['checkbox', 'radio'] as const)('selectionRole %s → role + aria-checked', async (r) => {
    const { getByTestId } = await renderDS(
      <Chip testID="c" type="filter" selected selectionRole={r} label="Drama" onPress={() => {}} />,
    );
    const p = getByTestId('c').props;
    expect(p.role).toBe(r);
    expect(p['aria-checked']).toBe(true);
    expect(p['aria-pressed']).toBeUndefined();
  });

  it('a disabled chip is aria-disabled and out of the tab order', async () => {
    const { getByTestId } = await renderDS(
      <Chip testID="c" label="X" disabled onPress={() => {}} />,
    );
    const p = getByTestId('c').props;
    expect(p['aria-disabled']).toBe(true);
    expect(p.tabIndex).toBe(-1);
  });
});

describe('chipKeyActivates (web Enter/Space)', () => {
  it.each(['Enter', ' ', 'Spacebar'])('%j activates', (key) => {
    expect(chipKeyActivates(key)).toBe(true);
  });

  it.each(['Tab', 'Escape', 'a', 'ArrowRight'])('%j does not', (key) => {
    expect(chipKeyActivates(key)).toBe(false);
  });
});
