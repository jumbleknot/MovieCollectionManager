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
import { NotFoundScreen } from '@/screens/not-found-screen';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: mockReplace }),
}));

describe('NotFoundScreen', () => {
  beforeEach(() => {
    mockReplace.mockClear();
  });

  it('renders the not-found container on a host node', () => {
    const { getByTestId } = render(<NotFoundScreen />);
    expect(getByTestId('not-found-screen')).toBeTruthy();
  });

  it('states that the address was not found', () => {
    const { getByTestId } = render(<NotFoundScreen />);
    expect(getByTestId('not-found-screen')).toHaveTextContent(/not found/i);
  });

  it('offers the affordance back into the app', () => {
    const { getByTestId } = render(<NotFoundScreen />);
    expect(getByTestId('not-found-home-link')).toBeTruthy();
    // FR-004's "exactly ONE affordance" half is asserted in the web E2E, not here. Measured:
    // queryAllByRole('button') returns [] under jest-expo — RNTL's role query does not resolve
    // the `role="button"` Tamagui puts on the Button, and no test in this repository uses
    // ByRole for that reason. On web the same prop DOES reach the DOM (see the comment in
    // packages/design-system/components/primitives/Button.tsx, which notes Playwright's
    // toBeDisabled() depends on it), so the count is asserted where the instrument works:
    // tests/e2e/web/settings.spec.ts, scoped inside the not-found-screen container.
  });

  it('sends the user to the home route, replacing the dead address in history', () => {
    const { getByTestId } = render(<NotFoundScreen />);
    fireEvent.press(getByTestId('not-found-home-link'));
    // replace, not push — the address that matched nothing must not sit in the back stack
    // behind home. See plan.md §"Navigation back".
    expect(mockReplace).toHaveBeenCalledWith('/(app)/home');
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });
});
