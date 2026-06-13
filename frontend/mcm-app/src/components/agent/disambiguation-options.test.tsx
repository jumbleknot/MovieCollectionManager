/**
 * DisambiguationOptions unit tests (013 US4 / T035).
 *
 * The curator emits a `render_disambiguation` tool call carrying the candidate options. The dock
 * maps it to this component, which renders one selectable button per candidate (≤5 + an overflow
 * control) and, on tap, posts the canonical disambiguator text ("<title> (<year>)") through the
 * same send path as the dock input. Only the CopilotKit agent source is mocked.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
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

beforeEach(() => {
  addMessage.mockClear();
  runAgent.mockClear();
  mockedUseAgent.mockReturnValue({ agent: { isRunning: false, addMessage } });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent } });
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
