/**
 * Unit test for NotFoundScreen (feature 074, T001).
 *
 * US1-AC1, US1-AC2, US1-AC3 / FR-003, FR-004. Written RED: the screen does not exist when this
 * file is first run, so the failure is an unresolved import. That is a genuine RED — the
 * behaviour under test does not already exist, so the mutation-RED rule for test-only features
 * (openwiki/process/spec-driven-development.md) does not apply here.
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { ThemeProvider } from '@/hooks/use-theme';
import { NotFoundScreen } from '@/screens/not-found-screen';

// The screen renders NavigationBar for a signed-in visitor, which reaches use-theme →
// AsyncStorage. Same mock and the same ThemeProvider wrapper as navigation-bar.test.tsx.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: mockReplace }),
  usePathname: () => '/no-such-route',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const mockUseAuth = jest.fn();
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => mockUseAuth(),
}));

describe('NotFoundScreen', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockUseAuth.mockReset();
    // The default for the cases below: a signed-in visitor who followed a dead bookmark, which is
    // the situation item #237 actually reported.
    mockUseAuth.mockReturnValue({ isAuthenticated: true });
  });

  const renderScreen = () =>
    render(
      <ThemeProvider>
        <NotFoundScreen />
      </ThemeProvider>,
    );

  it('renders the not-found container on a host node', () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId('not-found-screen')).toBeTruthy();
  });

  it('states that the address was not found', () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId('not-found-screen')).toHaveTextContent(/not found/i);
  });

  it('offers the affordance back into the app', () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId('not-found-home-link')).toBeTruthy();
    // FR-004's "exactly ONE affordance" half is asserted in the web E2E, not here. Measured:
    // queryAllByRole('button') returns [] under jest-expo — RNTL's role query does not resolve
    // the `role="button"` Tamagui puts on the Button, and no test in this repository uses
    // ByRole for that reason. On web the same prop DOES reach the DOM (see the comment in
    // packages/design-system/components/primitives/Button.tsx, which notes Playwright's
    // toBeDisabled() depends on it), so the count is asserted where the instrument works:
    // tests/e2e/web/settings.spec.ts, scoped inside the not-found-screen container.
  });

  it("keeps the app's chrome for a signed-in visitor", () => {
    // FR-002 as REVISED. The original design put a second route inside the (app) group to inherit
    // the navigation bar; web E2E measured that route to be unreachable, because Expo Router
    // groups are URL-transparent and the ROOT +not-found takes every unmatched address. The
    // chrome is rendered by the screen instead — see the header comment.
    const { getByTestId } = renderScreen();
    expect(getByTestId('navigation-bar')).toBeTruthy();
  });

  it('offers no authenticated navigation to an anonymous visitor', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    const { queryByTestId, getByTestId } = renderScreen();
    // Every nav link points at an authenticated destination, so showing them here would send an
    // anonymous visitor straight into AuthGuard. The screen and its way back still render.
    expect(queryByTestId('navigation-bar')).toBeNull();
    expect(getByTestId('not-found-screen')).toBeTruthy();
    expect(getByTestId('not-found-home-link')).toBeTruthy();
  });

  it('sends the user to the home route, replacing the dead address in history', () => {
    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('not-found-home-link'));
    // replace, not push — the address that matched nothing must not sit in the back stack
    // behind home. See plan.md §"Navigation back".
    expect(mockReplace).toHaveBeenCalledWith('/(app)/home');
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });
});
