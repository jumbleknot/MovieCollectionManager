/**
 * The dock's turn marker (064 US3, item #337).
 *
 * ONE affordance that says "the assistant has answered N times", readable by BOTH E2E runners.
 *
 * Why it has to exist in the app rather than in the tests: Playwright can count
 * `assistant-msg-assistant` nodes, and MAESTRO CANNOT COUNT ANYTHING. The mobile suite has no tier
 * split either, so `@model-decision` is not available there — which is what made item #337 a design
 * task rather than a relabelling. A testid carrying the count is the smallest thing both runners can
 * read: Playwright resolves `assistant-turn-<n>` as a locator, Maestro as an `id:`.
 *
 * What it buys: a test can wait for the TURN to complete without naming the branch the turn took.
 * "The model must answer something" is invariant; "the model offered a selection" is not.
 */
import React from 'react';
import { fireEvent, render } from '@/test-support/render';
import * as copilot from '@copilotkit/react-native';

import { AssistantDock } from '@/components/agent/assistant-dock';
import { AssistantProvider } from '@/hooks/use-assistant';

jest.mock('@copilotkit/react-native', () => {
  const actual = jest.requireActual('@copilotkit/react-native');
  return { ...actual, useAgent: jest.fn(), useCopilotKit: jest.fn() };
});

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;

type Msg = { id: string; role: string; content?: string; toolCalls?: unknown[] };

function mockMessages(messages: Msg[]) {
  mockedUseAgent.mockReturnValue({
    agent: {
      isRunning: false,
      addMessage: jest.fn(),
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
      messages,
    },
  });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent: jest.fn() } });
}

function openDock() {
  const utils = render(
    <AssistantProvider>
      <AssistantDock />
    </AssistantProvider>,
  );
  fireEvent.press(utils.getByTestId('assistant-dock-toggle'));
  return utils;
}

describe('AssistantDock turn marker', () => {
  it('starts at zero on an empty conversation', () => {
    mockMessages([]);
    expect(openDock().getByTestId('assistant-turn-0')).toBeTruthy();
  });

  it('counts assistant replies, not user turns', () => {
    mockMessages([
      { id: 'u1', role: 'user', content: 'do I have Epsilon in my E2E Browse collection' },
      { id: 'a1', role: 'assistant', content: 'I found one match.' },
    ]);
    const { getByTestId, queryByTestId } = openDock();
    expect(getByTestId('assistant-turn-1')).toBeTruthy();
    expect(queryByTestId('assistant-turn-0')).toBeNull();
    expect(queryByTestId('assistant-turn-2')).toBeNull();
  });

  it('rises with each further reply, so a wait can be expressed as "one more than before"', () => {
    mockMessages([
      { id: 'u1', role: 'user', content: 'first question' },
      { id: 'a1', role: 'assistant', content: 'first answer' },
      { id: 'u2', role: 'user', content: 'second question' },
      { id: 'a2', role: 'assistant', content: 'second answer' },
    ]);
    expect(openDock().getByTestId('assistant-turn-2')).toBeTruthy();
  });

  // The marker must track what a reader would call "the assistant answered", which is a TEXT reply.
  // A bare tool call renders a card or a button row, not a message bubble, and Playwright's
  // `assistant-msg-assistant` count does not include it — the two measures have to agree or the
  // web helper and the mobile sub-flow would be waiting for different things.
  it('does not count a tool-call-only message, matching assistant-msg-assistant', () => {
    mockMessages([
      { id: 'u1', role: 'user', content: 'take me to my E2E collection' },
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'render_selection',
              arguments: JSON.stringify({
                options: [{ label: 'E2E Browse', value: 'E2E Browse', kind: 'collection' }],
              }),
            },
          },
        ],
      },
    ]);
    expect(openDock().getByTestId('assistant-turn-0')).toBeTruthy();
  });

  it('is accessible, so Maestro can find it in the Android hierarchy', () => {
    mockMessages([{ id: 'a1', role: 'assistant', content: 'answered' }]);
    const marker = openDock().getByTestId('assistant-turn-1');
    expect(marker.props.accessible).toBe(true);
    expect(String(marker.props.accessibilityLabel)).toMatch(/1/);
  });
});
