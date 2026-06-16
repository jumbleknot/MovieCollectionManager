/**
 * Design-system unit tests — AppBar + IconButton + NavigationBar (feature 015, T013).
 * Verifies title/subtitle render, label/role forwarding, active state, the badge
 * count clamp, destination press callbacks, and the disabled accessibility state.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { AppBar } from './AppBar';
import { IconButton } from '../primitives/IconButton';
import { NavigationBar, type NavDestination } from './NavigationBar';

const metrics = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>
    </TamaguiProvider>,
  );
}

describe('AppBar', () => {
  it('renders the title', () => {
    const { getByText } = renderDS(<AppBar title="My Movies" />);
    expect(getByText('My Movies')).toBeTruthy();
  });

  it('renders the subtitle in the large variant', () => {
    const { getByText } = renderDS(
      <AppBar title="My Movies" subtitle="42 films" variant="large" />,
    );
    expect(getByText('42 films')).toBeTruthy();
  });
});

describe('IconButton', () => {
  const icon = <Text>+</Text>;

  it('forwards testID, exposes the accessibility label/role, and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId, getByLabelText } = renderDS(
      <IconButton icon={icon} label="Add" testID="icon-add" onPress={onPress} />,
    );
    const node = getByLabelText('Add');
    expect(node.props.accessibilityRole).toBe('button');
    fireEvent.press(getByTestId('icon-add'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes the disabled accessibility state', () => {
    // The disabled press guard is web-only (jest-expo's fireEvent ignores it); assert
    // the observable a11y contract instead.
    const { getByTestId } = renderDS(
      <IconButton icon={icon} label="Add" testID="icon-add" disabled onPress={() => {}} />,
    );
    expect(getByTestId('icon-add').props.accessibilityState).toEqual({ disabled: true, selected: false });
  });
});

describe('NavigationBar', () => {
  const destinations: NavDestination[] = [
    { key: 'home', label: 'Home', icon: <Text>H</Text>, onPress: jest.fn() },
    { key: 'search', label: 'Search', icon: <Text>S</Text>, badge: 150, onPress: jest.fn() },
  ];

  it('renders destination labels and fires the pressed destination callback', () => {
    const { getByLabelText } = renderDS(
      <NavigationBar destinations={destinations} activeKey="home" />,
    );
    fireEvent.press(getByLabelText('Search'));
    expect(destinations[1].onPress).toHaveBeenCalledTimes(1);
    expect(destinations[0].onPress).not.toHaveBeenCalled();
  });

  it('clamps a badge count above 99 to "99+"', () => {
    const { getByText } = renderDS(
      <NavigationBar destinations={destinations} activeKey="home" />,
    );
    expect(getByText('99+')).toBeTruthy();
  });

  it('marks the active destination as selected', () => {
    const { getByLabelText } = renderDS(
      <NavigationBar destinations={destinations} activeKey="home" />,
    );
    expect(getByLabelText('Home').props.accessibilityState).toEqual({ selected: true });
  });
});
