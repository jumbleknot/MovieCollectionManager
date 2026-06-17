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

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('SearchBar', () => {
  it('renders the placeholder and forwards onChangeText', () => {
    const onChangeText = jest.fn();
    const { getByPlaceholderText, getByTestId } = renderDS(
      <SearchBar testID="sb" placeholder="Search movies" onChangeText={onChangeText} />,
    );
    expect(getByPlaceholderText('Search movies')).toBeTruthy();
    fireEvent.changeText(getByTestId('sb'), 'blade');
    expect(onChangeText).toHaveBeenCalledWith('blade');
  });

  it('shows the clear button only when there is a value, and fires onClear', () => {
    const onClear = jest.fn();
    const { getByText } = renderDS(
      <SearchBar value="x" onClear={onClear} />,
    );
    fireEvent.press(getByText('×'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('Chip', () => {
  it('renders the label, forwards testID, and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = renderDS(
      <Chip label="Action" testID="chip" onPress={onPress} />,
    );
    expect(getByText('Action')).toBeTruthy();
    fireEvent.press(getByTestId('chip'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows the checkmark on a selected filter chip', () => {
    const { getByText } = renderDS(<Chip type="filter" label="Owned" selected />);
    expect(getByText('✓')).toBeTruthy();
  });

  it('fires onRemove from an input chip without firing onPress', () => {
    const onPress = jest.fn();
    const onRemove = jest.fn();
    const { getByText } = renderDS(
      <Chip type="input" label="Tag" onPress={onPress} onRemove={onRemove} />,
    );
    fireEvent.press(getByText('×'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders ChipGroup children', () => {
    const { getByText } = renderDS(
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
  it('exposes the switch role/state and toggles on press', () => {
    const onValueChange = jest.fn();
    const { getByLabelText } = renderDS(
      <Switch label="Dark mode" value={false} onValueChange={onValueChange} />,
    );
    const node = getByLabelText('Dark mode');
    expect(node.props.accessibilityRole).toBe('switch');
    expect(node.props.accessibilityState.checked).toBe(false);
    fireEvent.press(node);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', () => {
    const onValueChange = jest.fn();
    const { getByLabelText } = renderDS(
      <Switch label="Dark mode" value={false} disabled onValueChange={onValueChange} />,
    );
    fireEvent.press(getByLabelText('Dark mode'));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('Dialog', () => {
  it('renders the title, supporting text, and actions when visible', () => {
    const { getByText } = renderDS(
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

  it('renders nothing when not visible', () => {
    const { queryByText } = renderDS(
      <Dialog visible={false} title="Hidden dialog" actions={[]} />,
    );
    expect(queryByText('Hidden dialog')).toBeNull();
  });

  it('forwards testID to the dialog container (feature 017)', () => {
    const { getByTestId } = renderDS(
      <Dialog visible title="Confirm" actions={[<Text key="ok">OK</Text>]} testID="my-dialog" />,
    );
    expect(getByTestId('my-dialog')).toBeTruthy();
  });
});

describe('Snackbar', () => {
  it('renders the message and fires the action callback', () => {
    const onPress = jest.fn();
    const { getByText } = renderDS(
      <Snackbar
        visible
        message="Saved"
        action={{ label: 'Undo', onPress }}
        onDismiss={jest.fn()}
      />,
    );
    expect(getByText('Saved')).toBeTruthy();
    fireEvent.press(getByText('Undo'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when not visible', () => {
    const { queryByText } = renderDS(
      <Snackbar visible={false} message="Hidden" onDismiss={jest.fn()} />,
    );
    expect(queryByText('Hidden')).toBeNull();
  });
});

describe('Badge', () => {
  it('renders a count', () => {
    const { getByText } = renderDS(<Badge count={5} testID="badge" />);
    expect(getByText('5')).toBeTruthy();
  });

  it('clamps a count above max to "99+"', () => {
    const { getByText } = renderDS(<Badge count={120} testID="badge" />);
    expect(getByText('99+')).toBeTruthy();
  });

  it('renders a dot (no text) when there is no count', () => {
    const { getByTestId, queryByText } = renderDS(<Badge testID="badge" />);
    expect(getByTestId('badge')).toBeTruthy();
    expect(queryByText(/\d/)).toBeNull();
  });

  it('renders an inline string label as a static status pill (feature 017)', () => {
    const { getByText, getByTestId } = renderDS(
      <Badge inline count="Default" colorScheme="primary" testID="default-badge" />,
    );
    expect(getByText('Default')).toBeTruthy();
    expect(getByTestId('default-badge').props.style).toBeTruthy();
  });
});

describe('Divider', () => {
  it('renders horizontal and vertical variants and forwards testID', () => {
    const { getByTestId } = renderDS(<Divider testID="hr" />);
    expect(getByTestId('hr')).toBeTruthy();
    const { getByTestId: getByTestId2 } = renderDS(
      <Divider testID="vr" direction="vertical" />,
    );
    expect(getByTestId2('vr')).toBeTruthy();
  });
});
