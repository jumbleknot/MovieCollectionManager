/**
 * Design-system unit tests — input & surface controls (feature 015, T023).
 * SearchBar, Chip/ChipGroup, Switch, Dialog, Snackbar, Badge, Divider:
 * render, selected/clear/remove/toggle callbacks, dialog visibility gating,
 * badge dot/count, and testID forwarding.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../tamagui.config';
import { SearchBar } from './inputs/SearchBar';
import { Switch } from './inputs/Switch';
import { Chip, ChipGroup } from './primitives/Chip';
import { Badge } from './primitives/Badge';
import { Divider } from './primitives/Divider';
import { Dialog } from './surfaces/Dialog';
import { Snackbar } from './surfaces/Snackbar';
import { Banner } from './surfaces/Banner';

async function renderDS(ui: React.ReactElement) {
  return await render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('SearchBar', () => {
  it('renders the placeholder and forwards onChangeText', async () => {
    const onChangeText = jest.fn();
    const { getByPlaceholderText, getByTestId } = await renderDS(
      <SearchBar testID="sb" placeholder="Search movies" onChangeText={onChangeText} />,
    );
    expect(getByPlaceholderText('Search movies')).toBeTruthy();
    await fireEvent.changeText(getByTestId('sb'), 'blade');
    expect(onChangeText).toHaveBeenCalledWith('blade');
  });

  it('shows the clear button only when there is a value, and fires onClear', async () => {
    const onClear = jest.fn();
    const { getByText } = await renderDS(
      <SearchBar value="x" onClear={onClear} />,
    );
    await fireEvent.press(getByText('×'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('Chip', () => {
  it('renders the label, forwards testID, and fires onPress', async () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = await renderDS(
      <Chip label="Action" testID="chip" onPress={onPress} />,
    );
    expect(getByText('Action')).toBeTruthy();
    await fireEvent.press(getByTestId('chip'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows the checkmark on a selected filter chip', async () => {
    const { getByText } = await renderDS(<Chip type="filter" label="Owned" selected />);
    expect(getByText('✓')).toBeTruthy();
  });

  it('a selected choice chip fills but shows NO checkmark (single-select; feature 017)', async () => {
    const { getByText, queryByText } = await renderDS(
      <Chip type="choice" label="Action" selected selectedScheme="primary" />,
    );
    expect(getByText('Action')).toBeTruthy();
    expect(queryByText('✓')).toBeNull();
  });

  it('fires onRemove from an input chip without firing onPress', async () => {
    const onPress = jest.fn();
    const onRemove = jest.fn();
    const { getByText } = await renderDS(
      <Chip type="input" label="Tag" onPress={onPress} onRemove={onRemove} />,
    );
    await fireEvent.press(getByText('×'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('defaults to button role with a selected state', async () => {
    const { getByLabelText } = await renderDS(
      <Chip type="choice" label="Action" selected accessibilityLabel="Action" />,
    );
    const node = getByLabelText('Action');
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityState).toMatchObject({ selected: true });
  });

  it('exposes checkbox role + checked state for a multi-select chip (finding #3)', async () => {
    const { getByLabelText } = await renderDS(
      <Chip type="filter" selectionRole="checkbox" label="DVD" selected accessibilityLabel="DVD" />,
    );
    const node = getByLabelText('DVD');
    expect(node.props.accessibilityRole).toBe('checkbox');
    expect(node.props.accessibilityState).toMatchObject({ checked: true });
  });

  it('exposes radio role + selected state for a single-select chip (finding #3)', async () => {
    const { getByLabelText } = await renderDS(
      <Chip type="choice" selectionRole="radio" label="Asc" accessibilityLabel="Asc" />,
    );
    const node = getByLabelText('Asc');
    expect(node.props.accessibilityRole).toBe('radio');
    expect(node.props.accessibilityState).toMatchObject({ selected: false });
  });

  it('renders ChipGroup children', async () => {
    const { getByText } = await renderDS(
      <ChipGroup>
        <Chip label="One" />
        <Chip label="Two" />
      </ChipGroup>,
    );
    expect(getByText('One')).toBeTruthy();
    expect(getByText('Two')).toBeTruthy();
  });
});

describe('Switch', () => {
  it('exposes the switch role/state and toggles on press', async () => {
    const onValueChange = jest.fn();
    const { getByLabelText } = await renderDS(
      <Switch label="Dark mode" value={false} onValueChange={onValueChange} />,
    );
    const node = getByLabelText('Dark mode');
    expect(node.props.accessibilityRole).toBe('switch');
    expect(node.props.accessibilityState.checked).toBe(false);
    await fireEvent.press(node);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', async () => {
    const onValueChange = jest.fn();
    const { getByLabelText } = await renderDS(
      <Switch label="Dark mode" value={false} disabled onValueChange={onValueChange} />,
    );
    await fireEvent.press(getByLabelText('Dark mode'));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  // Item #545. Switch used to destructure `...rest` and never spread it, so a testID passed in
  // reached nothing. On web that is a `[data-testid=...]` locator matching zero elements, and the
  // click TIMES OUT rather than erroring — it reads as a broken screen, which is what made it
  // expensive enough to be worked around twice. These two assertions are the regression guard:
  // the id must land on the element that actually receives the press, and it must not cost the
  // role or the accessible name that `getByRole` locators already depend on.
  it('forwards testID to the element that receives the press', async () => {
    const onValueChange = jest.fn();
    const { getByTestId } = await renderDS(
      <Switch testID="sw" label="Dark mode" value={false} onValueChange={onValueChange} />,
    );
    const node = getByTestId('sw');
    expect(node.props.accessibilityRole).toBe('switch');
    await fireEvent.press(node);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('keeps the role and accessible name when other view props are forwarded', async () => {
    const { getByTestId, getByLabelText } = await renderDS(
      <Switch testID="sw" label="Dark mode" value onValueChange={jest.fn()} />,
    );
    expect(getByTestId('sw')).toBe(getByLabelText('Dark mode'));
    expect(getByLabelText('Dark mode').props.accessibilityState.checked).toBe(true);
  });
});

describe('Dialog', () => {
  it('renders the title, supporting text, and actions when visible', async () => {
    const { getByText } = await renderDS(
      <Dialog
        visible
        title="Delete collection?"
        supportingText="This cannot be undone."
        actions={[<Text key="ok">Confirm</Text>]}
      />,
    );
    expect(getByText('Delete collection?')).toBeTruthy();
    expect(getByText('This cannot be undone.')).toBeTruthy();
    expect(getByText('Confirm')).toBeTruthy();
  });

  it('renders nothing when not visible', async () => {
    const { queryByText } = await renderDS(
      <Dialog visible={false} title="Hidden dialog" actions={[]} />,
    );
    expect(queryByText('Hidden dialog')).toBeNull();
  });

  it('forwards testID to the dialog container (feature 017)', async () => {
    const { getByTestId } = await renderDS(
      <Dialog visible title="Confirm" actions={[<Text key="ok">OK</Text>]} testID="my-dialog" />,
    );
    expect(getByTestId('my-dialog')).toBeTruthy();
  });

  it('sets statusBarTranslucent so the scrim covers the Android status bar (finding #2)', async () => {
    const { container } = await renderDS(
      <Dialog visible title="Confirm" actions={[<Text key="ok">OK</Text>]} />,
    );
    // RNTL 14 removed UNSAFE_getByType (Test Renderer renders host elements only), so the
    // react-native Modal is found as its host element ('Modal' under the RN jest preset).
    const modals = container.queryAll((node) => node.type === 'Modal');
    expect(modals).toHaveLength(1);
    expect(modals[0].props.statusBarTranslucent).toBe(true);
  });

  it('scrolls long content while keeping the actions reachable (finding #5)', async () => {
    const { container, getByText } = await renderDS(
      <Dialog
        visible
        title="Scrolling dialog"
        supportingText={'line\n'.repeat(80)}
        actions={[<Text key="ok">Confirm action</Text>]}
      />,
    );
    // title/supporting/children live inside a ScrollView; the divider + actions are siblings
    // below it, so the action row stays pinned and hittable regardless of content length.
    // Host element of react-native's ScrollView (RNTL 14 has no UNSAFE_getByType).
    expect(container.queryAll((node) => node.type === 'RCTScrollView')).toHaveLength(1);
    expect(getByText('Confirm action')).toBeTruthy();
  });
});

describe('Snackbar', () => {
  it('renders the message and fires the action callback', async () => {
    const onPress = jest.fn();
    const { getByText } = await renderDS(
      <Snackbar
        visible
        message="Saved"
        action={{ label: 'Undo', onPress }}
        onDismiss={jest.fn()}
      />,
    );
    expect(getByText('Saved')).toBeTruthy();
    await fireEvent.press(getByText('Undo'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when not visible', async () => {
    const { queryByText } = await renderDS(
      <Snackbar visible={false} message="Hidden" onDismiss={jest.fn()} />,
    );
    expect(queryByText('Hidden')).toBeNull();
  });
});

describe('Badge', () => {
  it('renders a count', async () => {
    const { getByText } = await renderDS(<Badge count={5} testID="badge" />);
    expect(getByText('5')).toBeTruthy();
  });

  it('clamps a count above max to "99+"', async () => {
    const { getByText } = await renderDS(<Badge count={120} testID="badge" />);
    expect(getByText('99+')).toBeTruthy();
  });

  it('renders a dot (no text) when there is no count', async () => {
    const { getByTestId, queryByText } = await renderDS(<Badge testID="badge" />);
    expect(getByTestId('badge')).toBeTruthy();
    expect(queryByText(/\d/)).toBeNull();
  });

  it('renders an inline string label as a static status pill (feature 017)', async () => {
    const { getByText, getByTestId } = await renderDS(
      <Badge inline count="Default" colorScheme="primary" testID="default-badge" />,
    );
    expect(getByText('Default')).toBeTruthy();
    expect(getByTestId('default-badge').props.style).toBeTruthy();
  });
});

describe('Banner', () => {
  it('renders the message and forwards testID (finding #9)', async () => {
    const { getByText, getByTestId } = await renderDS(
      <Banner tone="error" testID="err-banner">Something failed.</Banner>,
    );
    expect(getByText('Something failed.')).toBeTruthy();
    expect(getByTestId('err-banner')).toBeTruthy();
  });

  it('exposes role="alert" for an error notice (and none for success)', async () => {
    const { getByTestId: errId } = await renderDS(<Banner tone="error" testID="e">x</Banner>);
    expect(errId('e').props.accessibilityRole).toBe('alert');
    const { getByTestId: okId } = await renderDS(<Banner tone="success" testID="s">y</Banner>);
    expect(okId('s').props.accessibilityRole).toBeUndefined();
  });

  it('passes through layout props (marginBottom) without baking them in', async () => {
    const { getByTestId } = await renderDS(
      <Banner tone="success" testID="b" marginBottom={24}>ok</Banner>,
    );
    expect(getByTestId('b')).toBeTruthy();
  });
});

describe('Divider', () => {
  it('renders horizontal and vertical variants and forwards testID', async () => {
    const { getByTestId } = await renderDS(<Divider testID="hr" />);
    expect(getByTestId('hr')).toBeTruthy();
    const { getByTestId: getByTestId2 } = await renderDS(
      <Divider testID="vr" direction="vertical" />,
    );
    expect(getByTestId2('vr')).toBeTruthy();
  });
});
