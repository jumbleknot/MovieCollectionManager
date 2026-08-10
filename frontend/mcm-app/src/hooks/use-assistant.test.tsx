/**
 * Unit tests for `useAssistantRun` (feature 053) — the dock's send path must never lose a message.
 *
 * THE DEFECT THESE PIN. `run()` fires when the agent is resolvable and idle, and otherwise queues:
 *
 *     if (target && !target.isRunning) { fire(target, text); return; }
 *     pendingRef.current = text;
 *
 * That one branch serves two different conditions. The queue was written for "the agent registry is
 * transiently empty", and its flush effect was keyed on that — `[agent, resolveAgent, fire]`. But the
 * branch ALSO catches "the agent is registered and currently running", and none of those dependencies
 * change when a run finishes: `agent` is a stable object whose `isRunning` is a mutable property, and
 * the two callbacks are memoised on it. So a message queued mid-answer was never flushed at all.
 *
 * Measured 2026-08-10 against the live containerized stack: the member's second turn produced ZERO
 * gateway requests, no user bubble, and no error — `page.fill`/`page.click` both succeeded, so the UI
 * accepted the input and discarded it. It reached CI as `assistant-disambiguate.spec.ts:154` and read
 * as live-model nondeterminism, because whether turn 2 lands before turn 1 finishes is a race.
 *
 * The agent object identity is deliberately STABLE across the isRunning transition in these tests.
 * That is the whole point: handing the hook a fresh object would make the broken implementation pass,
 * because a new identity is exactly what its effect was watching for.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';

import { useAssistantRun, ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

// ── CopilotKit test double ───────────────────────────────────────────────────────────────────────
// A mutable agent whose `isRunning` flips in place, and a `copilotkit` whose registry returns it.

type FakeAgent = { isRunning: boolean; addMessage: jest.Mock };

// `mock`-prefixed so jest's module factory may close over them (its out-of-scope guard allows it).
let mockAgentState: FakeAgent | null;
const mockRunAgent = jest.fn();

// The `copilotkit` value and the object `useCopilotKit` returns are BOTH created once, because the
// real ones are: `useCopilotKit` returns the context value straight from `useContext`, and
// `copilotkit` is a single `CopilotKitCoreReact` instance. Returning a fresh object per render here
// would invalidate the hook's memoised callbacks every render, re-run its flush effect for free, and
// make the broken implementation pass — a test double that repairs the bug it is meant to catch.
const mockCopilotkit = {
  getAgent: () => mockAgentState,
  runAgent: mockRunAgent,
};
const mockCopilotKitValue = { copilotkit: mockCopilotkit };

jest.mock('@copilotkit/react-native', () => ({
  __esModule: true,
  CopilotKitProvider: ({ children }: { children: React.ReactNode }) => children,
  useAgent: () => ({ agent: mockAgentState }),
  useCopilotKit: () => mockCopilotKitValue,
}));

function makeAgent(isRunning: boolean): FakeAgent {
  return { isRunning, addMessage: jest.fn() };
}

beforeEach(() => {
  mockRunAgent.mockClear();
  mockAgentState = null;
});

describe('useAssistantRun — a message the dock accepted is never silently dropped (053 FR-001)', () => {
  it('delivers immediately when the agent is idle', () => {
    const agent = makeAgent(false);
    mockAgentState = agent;

    const { result } = renderHook(() => useAssistantRun());
    act(() => result.current.run('tell me about Avatar'));

    expect(agent.addMessage).toHaveBeenCalledTimes(1);
    expect(agent.addMessage.mock.calls[0][0]).toMatchObject({
      role: 'user',
      content: 'tell me about Avatar',
    });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('FLUSHES a message queued while the assistant was mid-answer (FR-002)', () => {
    // The regression. Turn 1 is still streaming when the member sends turn 2.
    const agent = makeAgent(true);
    mockAgentState = agent;

    const { result, rerender } = renderHook(() => useAssistantRun());
    act(() => result.current.run('Avatar: The Way of Water'));

    // Nothing goes out yet — correct, the agent is busy.
    expect(agent.addMessage).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();

    // Turn 1 finishes. SAME object — only the mutable flag changes, exactly as CopilotKit does it.
    act(() => {
      agent.isRunning = false;
      rerender({});
    });

    expect(agent.addMessage).toHaveBeenCalledTimes(1);
    expect(agent.addMessage.mock.calls[0][0]).toMatchObject({
      role: 'user',
      content: 'Avatar: The Way of Water',
    });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('delivers a queued message AT MOST ONCE across further renders (FR-003)', () => {
    // A duplicate here is not cosmetic: an add turn delivered twice writes the movie twice.
    const agent = makeAgent(true);
    mockAgentState = agent;

    const { result, rerender } = renderHook(() => useAssistantRun());
    act(() => result.current.run('the first one'));

    act(() => {
      agent.isRunning = false;
      rerender({});
    });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);

    // Another run starts and finishes with nothing queued — the earlier message must not replay.
    act(() => {
      agent.isRunning = true;
      rerender({});
    });
    act(() => {
      agent.isRunning = false;
      rerender({});
    });

    expect(agent.addMessage).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('still self-heals the empty-registry tap the queue was written for (US2, FR-004)', () => {
    mockAgentState = null;

    const { result, rerender } = renderHook(() => useAssistantRun());
    act(() => result.current.run('open Coherence'));
    expect(mockRunAgent).not.toHaveBeenCalled();

    const agent = makeAgent(false);
    act(() => {
      mockAgentState = agent;
      rerender({});
    });

    expect(agent.addMessage).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty or whitespace-only send', () => {
    const agent = makeAgent(false);
    mockAgentState = agent;

    const { result } = renderHook(() => useAssistantRun());
    act(() => result.current.run('   '));

    expect(agent.addMessage).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('exposes the agent id the gateway registers', () => {
    expect(ASSISTANT_AGENT_ID).toBe('movie_assistant');
  });
});
