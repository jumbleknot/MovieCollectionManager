/**
 * Unit tests for NoAutoFillInput component.
 *
 * Tests cover:
 * - Renders as a TextInput
 * - Forwards all standard TextInput props
 * - On web (Platform.OS === 'web'): injects autofill suppression attributes
 * - On native (Platform.OS !== 'web'): does NOT inject web-specific attributes
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { NoAutoFillInput } from '@/components/no-autofill-input';

describe('NoAutoFillInput', () => {
  it('renders without errors', () => {
    const { getByTestId } = render(
      <NoAutoFillInput testID="test-input" placeholder="Enter text" />,
    );
    expect(getByTestId('test-input')).toBeTruthy();
  });

  it('forwards testID prop', () => {
    const { getByTestId } = render(<NoAutoFillInput testID="my-input" />);
    expect(getByTestId('my-input')).toBeTruthy();
  });

  it('forwards value and onChangeText props', () => {
    const onChange = jest.fn();
    const { getByTestId } = render(
      <NoAutoFillInput testID="my-input" value="hello" onChangeText={onChange} />,
    );
    const input = getByTestId('my-input');
    expect(input.props.value).toBe('hello');
  });

  it('forwards placeholder prop', () => {
    const { getByTestId } = render(
      <NoAutoFillInput testID="my-input" placeholder="Search…" />,
    );
    const input = getByTestId('my-input');
    expect(input.props.placeholder).toBe('Search…');
  });

  describe('web autofill suppression', () => {
    const originalOS = Platform.OS;
    afterEach(() => {
      Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
    });

    it('injects autoComplete=off on web', () => {
      Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
      const { getByTestId } = render(<NoAutoFillInput testID="my-input" />);
      const input = getByTestId('my-input');
      expect(input.props.autoComplete).toBe('off');
    });

    it('does NOT inject autoComplete override on android', () => {
      Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
      const { getByTestId } = render(<NoAutoFillInput testID="my-input" />);
      const input = getByTestId('my-input');
      // autoComplete should not be 'off' unless we explicitly passed it
      expect(input.props.autoComplete).not.toBe('off');
    });

    it('does NOT inject autoComplete override on ios', () => {
      Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
      const { getByTestId } = render(<NoAutoFillInput testID="my-input" />);
      const input = getByTestId('my-input');
      expect(input.props.autoComplete).not.toBe('off');
    });

    it('sets HTML name attribute via webName on web to suppress Chrome name-field heuristic', () => {
      Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
      const { getByTestId } = render(
        <NoAutoFillInput testID="my-input" webName="director-entry" />,
      );
      const input = getByTestId('my-input');
      expect(input.props.name).toBe('director-entry');
    });

    it('does NOT set name attribute when webName is omitted', () => {
      Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
      const { getByTestId } = render(<NoAutoFillInput testID="my-input" />);
      const input = getByTestId('my-input');
      expect(input.props.name).toBeUndefined();
    });

    it('does NOT set name attribute from webName on native (android)', () => {
      Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
      const { getByTestId } = render(
        <NoAutoFillInput testID="my-input" webName="director-entry" />,
      );
      const input = getByTestId('my-input');
      // webName is a custom prop; on native the extra spread is skipped entirely
      expect(input.props.name).toBeUndefined();
    });
  });
});
