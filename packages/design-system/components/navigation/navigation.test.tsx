/**
 * Design-system unit tests — AppBar + IconButton + NavigationBar (feature 015, T013)
 * and Tabs (feature 062, T003).
 * Verifies title/subtitle render, label/role forwarding, active state, the badge
 * count clamp, destination press callbacks, the disabled accessibility state, and
 * that a per-tab testID reaches a host node so automation can locate a tab.
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
import { Tabs, type TabItem } from './Tabs';

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

describe('Tabs', () => {
  const tabs: TabItem[] = [
    { key: 'index', label: 'Profile', testID: 'settings-nav-profile' },
    { key: 'assistant', label: 'Movie Assistant', testID: 'settings-nav-assistant' },
  ];

  it('renders a per-tab testID and fires onTabChange for the pressed tab', () => {
    const onTabChange = jest.fn();
    const { getByTestId } = renderDS(
      <Tabs tabs={tabs} activeKey="index" onTabChange={onTabChange} />,
    );

    fireEvent.press(getByTestId('settings-nav-assistant'));

    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith('assistant');
  });

  it('keeps the testID node the accessible tab, carrying its selected state', () => {
    const { getByTestId } = renderDS(
      <Tabs tabs={tabs} activeKey="index" onTabChange={() => {}} />,
    );

    expect(getByTestId('settings-nav-profile').props.accessibilityRole).toBe('tab');
    expect(getByTestId('settings-nav-profile').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(getByTestId('settings-nav-assistant').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    // The WEB half of this contract — that `aria-selected` actually reaches the DOM — CANNOT be
    // asserted here and is deliberately not faked: React Native's Pressable normalizes the aria
    // prop INTO accessibilityState and strips it, so the RN renderer this suite uses can never
    // see it. It is asserted in a real browser, in settings.spec.ts. Same division as the testID.
  });

  it('colours the active label for CONTRAST against the secondary variant\'s filled pill', () => {
    // The secondary indicator is a filled `secondaryContainer` pill drawn BEHIND the label, so
    // the active label must be `onSecondaryContainer`. It was `primary` — the same colour the
    // pill itself used to be — which rendered the active tab's text invisible inside it. This
    // path had no consumer before feature 062, so nothing had ever rendered it.
    const { getByText: getSecondary } = renderDS(
      <Tabs tabs={tabs} activeKey="index" onTabChange={() => {}} type="secondary" />,
    );
    const { getByText: getPrimary } = renderDS(
      <Tabs tabs={tabs} activeKey="index" onTabChange={() => {}} type="primary" />,
    );

    const secondaryActive = getSecondary('Profile').props.style;
    const primaryActive = getPrimary('Profile').props.style;
    const colourOf = (style: unknown): unknown =>
      (Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style as object)?.['color' as never];

    // Different roles, so the two variants cannot silently converge on one colour again.
    expect(colourOf(secondaryActive)).toBeTruthy();
    expect(colourOf(secondaryActive)).not.toBe(colourOf(primaryActive));
  });

  it('renders tabs without a testID unchanged, so existing callers are unaffected', () => {
    const { getByText, queryByTestId } = renderDS(
      <Tabs
        tabs={[{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]}
        activeKey="a"
        onTabChange={() => {}}
      />,
    );

    expect(getByText('Alpha')).toBeTruthy();
    expect(queryByTestId('undefined')).toBeNull();
  });
});
