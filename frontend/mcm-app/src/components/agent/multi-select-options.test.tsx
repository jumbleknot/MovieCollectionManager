/**
 * MultiSelectOptions unit tests (047 US4 / T081).
 *
 * The organizer emits a `render_multi_select` tool call carrying `{ prompt, options, confirmLabel }`.
 * This component renders a toggle list; nothing is sent until confirm, and confirming posts ONE
 * canonical message through the same send path as the dock input.
 *
 * Contract: specs/047-movie-assistant-enhancements/contracts/render-multi-select.md.
 * Only the CopilotKit agent source is mocked.
 */
import React from 'react';
import { fireEvent, render } from '@/test-support/render';
import * as copilot from '@copilotkit/react-native';

import {
  MultiSelectOptions,
  buildMultiSelectReply,
} from '@/components/agent/multi-select-options';

jest.mock('@copilotkit/react-native', () => ({
  useAgent: jest.fn(),
  useCopilotKit: jest.fn(),
  useRenderTool: jest.fn(),
}));

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;

const addMessage = jest.fn();
const runAgent = jest.fn();
const getAgent = jest.fn();

const FORMATS = [
  { label: 'DVD', value: 'DVD' },
  { label: 'Blu-Ray', value: 'Blu-Ray' },
  { label: 'Blu-Ray 3D', value: 'Blu-Ray 3D' },
  { label: 'UHD Blu-Ray', value: 'UHD Blu-Ray' },
];

const renderList = (props: Partial<React.ComponentProps<typeof MultiSelectOptions>> = {}) =>
  render(
    <MultiSelectOptions
      prompt="Which formats do you own it on?"
      options={FORMATS}
      {...props}
    />,
  );

beforeEach(() => {
  addMessage.mockClear();
  runAgent.mockClear();
  getAgent.mockReset();
  mockedUseAgent.mockReturnValue({ agent: { isRunning: false, addMessage } });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent, getAgent } });
});

describe('MultiSelectOptions', () => {
  it('sends nothing until confirm (US4-AC2)', () => {
    const { getByTestId } = renderList();

    fireEvent.press(getByTestId('multi-select-option-0'));
    fireEvent.press(getByTestId('multi-select-option-1'));

    expect(addMessage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('posts exactly the still-selected values on confirm (US4-AC3)', () => {
    const { getByTestId } = renderList();

    fireEvent.press(getByTestId('multi-select-option-0')); // DVD on
    fireEvent.press(getByTestId('multi-select-option-1')); // Blu-Ray on
    fireEvent.press(getByTestId('multi-select-option-2')); // Blu-Ray 3D on
    fireEvent.press(getByTestId('multi-select-option-2')); // …and back off
    fireEvent.press(getByTestId('multi-select-confirm'));

    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'Selected: DVD, Blu-Ray' }),
    );
    expect(runAgent).toHaveBeenCalled();
  });

  it('posts in the offered order regardless of tap order', () => {
    const { getByTestId } = renderList();

    fireEvent.press(getByTestId('multi-select-option-3')); // UHD first
    fireEvent.press(getByTestId('multi-select-option-0')); // DVD second
    fireEvent.press(getByTestId('multi-select-confirm'));

    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Selected: DVD, UHD Blu-Ray' }),
    );
  });

  it('confirming zero selections posts "Selected: none" (US4-AC8 / FR-028)', () => {
    const { getByTestId } = renderList();

    fireEvent.press(getByTestId('multi-select-confirm'));

    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Selected: none' }),
    );
    expect(runAgent).toHaveBeenCalled();
  });

  it('shows the current selection before confirming (FR-020a)', () => {
    const { getByTestId } = renderList();

    expect(getByTestId('multi-select-summary').props.children).toBe('Nothing selected');

    fireEvent.press(getByTestId('multi-select-option-1'));
    expect(getByTestId('multi-select-summary').props.children).toBe('Selected: Blu-Ray');
  });

  it('honours the initial selected flags so a re-ask shows what was already chosen', () => {
    const { getByTestId } = renderList({
      options: [
        { label: 'DVD', value: 'DVD', selected: true },
        { label: 'Blu-Ray', value: 'Blu-Ray' },
      ],
    });

    expect(getByTestId('multi-select-summary').props.children).toBe('Selected: DVD');
    expect(getByTestId('multi-select-option-0').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('multi-select-option-1').props.accessibilityState.checked).toBe(false);
  });

  it('exposes each toggle state to assistive technology, not by colour alone', () => {
    const { getByTestId } = renderList();

    const before = getByTestId('multi-select-option-0');
    expect(before.props.accessibilityRole).toBe('checkbox');
    expect(before.props.accessibilityState.checked).toBe(false);

    fireEvent.press(before);
    expect(getByTestId('multi-select-option-0').props.accessibilityState.checked).toBe(true);
  });

  it('disables the list and confirm after confirming, so it cannot be answered twice', () => {
    const { getByTestId } = renderList();

    fireEvent.press(getByTestId('multi-select-option-0'));
    fireEvent.press(getByTestId('multi-select-confirm'));
    expect(addMessage).toHaveBeenCalledTimes(1);

    expect(getByTestId('multi-select-confirm').props.accessibilityState.disabled).toBe(true);
    expect(getByTestId('multi-select-option-0').props.accessibilityState.disabled).toBe(true);

    // A second confirm must post nothing more.
    fireEvent.press(getByTestId('multi-select-confirm'));
    expect(addMessage).toHaveBeenCalledTimes(1);
  });

  it('uses the supplied confirm label', () => {
    const { getByTestId } = renderList({ confirmLabel: 'Save' });
    expect(getByTestId('multi-select-confirm').props.children).toBeDefined();
    expect(getByTestId('multi-select-confirm').props.accessibilityLabel).toContain('Save');
  });

  it('contains no hardcoded domain values — the options come from the agent', () => {
    // The published media formats are mc-service's, fetched at question time. If this component
    // ever grows a fallback list, it renders values the service may not accept — the exact
    // failure RQ-4 exists to prevent. Rendering an arbitrary option set proves it has none.
    const { getByTestId, queryByTestId } = renderList({
      options: [{ label: 'Betamax', value: 'Betamax' }],
    });

    expect(getByTestId('multi-select-option-0').props.accessibilityLabel).toContain('Betamax');
    expect(queryByTestId('multi-select-option-1')).toBeNull();
  });
});

describe('buildMultiSelectReply', () => {
  it('builds the canonical confirm payloads the agent resolves', () => {
    expect(buildMultiSelectReply([])).toBe('Selected: none');
    expect(buildMultiSelectReply(['DVD'])).toBe('Selected: DVD');
    expect(buildMultiSelectReply(['DVD', 'Blu-Ray'])).toBe('Selected: DVD, Blu-Ray');
  });
});
