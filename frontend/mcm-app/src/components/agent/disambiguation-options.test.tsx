/**
 * DisambiguationOptions unit tests (013 US4 / T035).
 *
 * The curator emits a `render_disambiguation` tool call carrying the candidate options. The dock
 * maps it to this component, which renders one selectable button per candidate (≤5 + an overflow
 * control) and, on tap, posts the canonical disambiguator text ("<title> (<year>)") through the
 * same send path as the dock input. Only the CopilotKit agent source is mocked.
 */
import React from 'react';
import { fireEvent, render } from '@/test-support/render';
import * as copilot from '@copilotkit/react-native';

import { DisambiguationOptions } from '@/components/agent/disambiguation-options';

jest.mock('@copilotkit/react-native', () => ({
  useAgent: jest.fn(),
  useCopilotKit: jest.fn(),
  useRenderTool: jest.fn(),
}));

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;

const addMessage = jest.fn();
const runAgent = jest.fn();

// ⚠️ STABLE DOUBLES — see use-assistant.test.tsx. The send now goes through `useAssistantRun`, whose
// flush effect is keyed on the agent object's identity plus its mutable `isRunning`; a double that
// returns a fresh object per render repairs the bug under test for free (feature 053).
const agentState = { isRunning: false, addMessage };
const copilotkitState = { runAgent, getAgent: () => agentState };

beforeEach(() => {
  addMessage.mockClear();
  runAgent.mockClear();
  agentState.isRunning = false;
  mockedUseAgent.mockReturnValue({ agent: agentState });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: copilotkitState });
});

const OPTS = [
  { title: 'A', year: 1999, sourceId: 'tmdb:1' },
  { title: 'A', year: 2003, sourceId: 'tmdb:2' },
];

describe('DisambiguationOptions', () => {
  it('renders a button per candidate and posts the canonical pick on tap (US4-AC1/AC2)', () => {
    const { getByTestId } = render(<DisambiguationOptions options={OPTS} />);
    fireEvent.press(getByTestId('disambig-option-1'));
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'A (2003)' }),
    );
    expect(runAgent).toHaveBeenCalled();
  });

  // Item #337 / 064 US1. This component is what `agent-disambiguation.yaml` taps, and that mobile
  // flow retries 3x with 150 s waits — so one dropped pick costs ~7.5 minutes of runner time before
  // it fails. The old `if (!agent || isRunning) return` dropped it whenever the tap landed while the
  // assistant was still streaming, which is precisely when a member taps: the buttons are on screen
  // and the reply below them is still arriving.
  it('delivers a pick taken mid-answer, once the run finishes', () => {
    agentState.isRunning = true;
    const { getByTestId, rerender } = render(<DisambiguationOptions options={OPTS} />);

    fireEvent.press(getByTestId('disambig-option-1'));
    expect(addMessage).not.toHaveBeenCalled(); // queued, not sent

    agentState.isRunning = false;
    rerender(<DisambiguationOptions options={OPTS} />);

    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'A (2003)' }),
    );
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('shows ≤5 buttons with an overflow control that reveals the rest (US4-AC4)', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      title: `M${i}`,
      year: 2000 + i,
      sourceId: `s${i}`,
    }));
    const { getByTestId, queryByTestId } = render(<DisambiguationOptions options={many} />);
    expect(getByTestId('disambig-option-4')).toBeTruthy(); // 5th (index 4) shown
    expect(queryByTestId('disambig-option-5')).toBeNull(); // 6th hidden until expanded
    expect(getByTestId('disambig-more')).toBeTruthy();

    fireEvent.press(getByTestId('disambig-more'));
    expect(getByTestId('disambig-option-6')).toBeTruthy(); // a beyond-first-5 pick is reachable
  });
});
