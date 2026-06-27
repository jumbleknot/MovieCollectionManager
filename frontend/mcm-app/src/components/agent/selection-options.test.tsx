/**
 * SelectionOptions unit tests (013 US7 / T064).
 *
 * The search node emits a `render_selection` tool call carrying `{ label, value, kind }` options.
 * This component renders result picks (kind movie/collection) capped at 5 + overflow, and always
 * shows workflow controls (scope/control). A tap posts the option `value` through the same send
 * path as the dock input. Only the CopilotKit agent source is mocked.
 */
import React from 'react';
import { fireEvent, render } from '@/test-support/render';
import * as copilot from '@copilotkit/react-native';

import { SelectionOptions } from '@/components/agent/selection-options';

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

beforeEach(() => {
  addMessage.mockClear();
  runAgent.mockClear();
  getAgent.mockReset();
  mockedUseAgent.mockReturnValue({ agent: { isRunning: false, addMessage } });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent, getAgent } });
});

describe('SelectionOptions', () => {
  it('renders result + control buttons and posts the canonical value on tap (US7-AC2)', () => {
    const options = [
      { label: 'Avatar (2009)', value: 'Avatar (2009)', kind: 'movie' as const },
      { label: 'Avatar: The Way of Water (2022)', value: 'Avatar: The Way of Water (2022)', kind: 'movie' as const },
      { label: 'Exit search', value: 'exit search', kind: 'control' as const },
    ];
    const { getByTestId } = render(<SelectionOptions options={options} />);
    fireEvent.press(getByTestId('selection-option-pick-1'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'Avatar: The Way of Water (2022)' }),
    );
    expect(runAgent).toHaveBeenCalled();
  });

  it('always shows control buttons even when results overflow (US7-AC6)', () => {
    const picks = Array.from({ length: 7 }, (_, i) => ({
      label: `M${i} (200${i})`,
      value: `M${i} (200${i})`,
      kind: 'movie' as const,
    }));
    const controls = [
      { label: 'Search the web', value: 'search the web', kind: 'control' as const },
      { label: 'Exit search', value: 'exit search', kind: 'control' as const },
    ];
    const { getByTestId, queryByTestId } = render(
      <SelectionOptions options={[...picks, ...controls]} />,
    );
    expect(getByTestId('selection-option-pick-4')).toBeTruthy(); // 5th result shown
    expect(queryByTestId('selection-option-pick-5')).toBeNull(); // 6th hidden until expanded
    expect(getByTestId('selection-more')).toBeTruthy();
    // controls are NOT behind the overflow — both always rendered
    expect(getByTestId('selection-option-control-0')).toBeTruthy();
    expect(getByTestId('selection-option-control-1')).toBeTruthy();

    fireEvent.press(getByTestId('selection-more'));
    expect(getByTestId('selection-option-pick-6')).toBeTruthy(); // beyond-first-5 reachable
  });

  it('falls back to the live registry agent when the hook agent is transiently null (resilient pick-tap)', () => {
    // The CopilotKit-RN registry can lag a render: useAgent() returns null while the
    // core registry already has the agent. The pick-tap must resolve from the registry
    // (copilotkit.getAgent) rather than no-op.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // TEMP diagnostics
    const liveAgent = { isRunning: false, addMessage };
    mockedUseAgent.mockReturnValue({ agent: null });
    getAgent.mockReturnValue(liveAgent);
    const options = [{ label: 'Avatar (2009)', value: 'Avatar (2009)', kind: 'movie' as const }];
    const { getByTestId } = render(<SelectionOptions options={options} />);
    fireEvent.press(getByTestId('selection-option-pick-0'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'Avatar (2009)' }),
    );
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: liveAgent }));
    errSpy.mockRestore();
  });

  it('queues the pick and flushes it when the agent appears (transient empty registry)', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // TEMP diagnostics
    // Both the hook agent AND the registry are momentarily empty at tap time. The pick
    // must NOT be dropped — it is queued and fired once the agent registers.
    mockedUseAgent.mockReturnValue({ agent: null });
    getAgent.mockReturnValue(undefined);
    const options = [{ label: 'Avatar (2009)', value: 'Avatar (2009)', kind: 'movie' as const }];
    const { getByTestId, rerender } = render(<SelectionOptions options={options} />);
    fireEvent.press(getByTestId('selection-option-pick-0'));
    expect(runAgent).not.toHaveBeenCalled(); // dropped today; must be queued

    // Agent registers on a later render — the queued pick flushes.
    const lateAgent = { isRunning: false, addMessage };
    mockedUseAgent.mockReturnValue({ agent: lateAgent });
    rerender(<SelectionOptions options={options} />);
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'Avatar (2009)' }),
    );
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: lateAgent }));
    errSpy.mockRestore();
  });

  it('posts a scope choice on tap (US7-AC4)', () => {
    const options = [
      { label: 'Search a collection', value: 'search a collection', kind: 'scope' as const },
      { label: 'Search the web', value: 'search the web', kind: 'scope' as const },
    ];
    const { getByTestId } = render(<SelectionOptions options={options} />);
    fireEvent.press(getByTestId('selection-option-control-1'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'search the web' }),
    );
  });
});
