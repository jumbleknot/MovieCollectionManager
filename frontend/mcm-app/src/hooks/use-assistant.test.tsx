/**
 * Feature 054 US5 — a message typed while the assistant is answering must not be silently lost.
 *
 * `useAssistantRun.run()` fires when the agent exists and is idle, and otherwise stashes the text for
 * a flush effect. The queue was written for ONE case — the agent not yet registered — and its effect
 * is keyed on that case: `[agent, resolveAgent, fire]`. But the same branch also catches
 * `target.isRunning === true`, and none of those dependencies change when a run FINISHES. `agent` is
 * a stable object whose `isRunning` is a mutable property, and both callbacks are memoised on it. So
 * a message queued mid-answer was never flushed — dropped permanently, with no error, no echo, and
 * zero requests to the gateway (measured 2026-08-10 against the live stack).
 *
 * ⚠️ THE DOUBLE MUST BE STABLE, AND THIS IS THE WHOLE TEST.
 *
 * Feature 053's first attempt at this file was NOT red. Its double returned a fresh `copilotkit`
 * object per render, which invalidates the memoised callbacks, which re-runs the flush effect for
 * free — repairing the very bug the test existed to catch. It was checked against the installed
 * CopilotKit source: `useCopilotKit` returns the context value straight from `useContext`, and
 * `copilotkit` is one class instance for the provider's lifetime. So the double is a module-level
 * singleton here, and the agent object's identity is deliberately held across `isRunning` flips. A
 * fresh object would pass on the broken code.
 */
import { act, renderHook } from '@testing-library/react-native';

const mockAgentState = {
  isRunning: false,
  addMessage: jest.fn(),
};

// ONE instance for the whole module, mirroring the real context value. Recreating this per render is
// the mistake that made 053's first attempt green against broken code.
const mockCopilotkit = {
  getAgent: jest.fn(() => mockAgentState),
  runAgent: jest.fn(),
};

let mockRegistryHasAgent = true;

jest.mock('@copilotkit/react-native', () => ({
  CopilotKitProvider: ({ children }: { children: React.ReactNode }) => children,
  useCopilotKit: () => ({ copilotkit: mockCopilotkit }),
  useAgent: () => ({ agent: mockRegistryHasAgent ? mockAgentState : null }),
}));

// eslint-disable-next-line import/first
import { useAssistantRun } from '@/hooks/use-assistant';

/** Messages actually dispatched to the agent, in order. */
const sentMessages = () => mockAgentState.addMessage.mock.calls.map((c) => c[0].content);

beforeEach(() => {
  mockAgentState.isRunning = false;
  mockAgentState.addMessage.mockClear();
  mockCopilotkit.runAgent.mockClear();
  mockCopilotkit.getAgent.mockClear();
  mockRegistryHasAgent = true;
});

describe('useAssistantRun — a follow-up typed mid-answer (US5)', () => {
  it('delivers a message sent while the assistant is running, once the run completes', () => {
    const { result, rerender } = renderHook(() => useAssistantRun());

    // Turn 1 is in flight and the dock is showing its thinking state. That render is REAL, not
    // scaffolding: `useAgent` re-renders when `isRunning` flips (it is how the spinner appears at
    // all), and the hook returns `isRunning` for exactly that purpose. Mutating the property without
    // it would mean the effect's dependency never observes true→false, and the test would be
    // asserting against a sequence the app never produces.
    mockAgentState.isRunning = true;
    rerender({});

    act(() => result.current.run('the second thing I wanted to say'));
    expect(sentMessages()).toEqual([]); // queued, not sent — correct so far

    // The run finishes. `agent` keeps its identity; only the mutable property flips. That is exactly
    // the transition the old dependency list could not observe.
    mockAgentState.isRunning = false;
    rerender({});

    expect(sentMessages()).toEqual(['the second thing I wanted to say']);
    expect(mockCopilotkit.runAgent).toHaveBeenCalledTimes(1);
  });

  it('sends immediately when the assistant is idle (the path that already worked)', () => {
    const { result } = renderHook(() => useAssistantRun());
    act(() => result.current.run('hello'));
    expect(sentMessages()).toEqual(['hello']);
  });

  it('delivers a queued message AT MOST ONCE across a re-render storm', () => {
    const { result, rerender } = renderHook(() => useAssistantRun());

    mockAgentState.isRunning = true;
    rerender({});
    act(() => result.current.run('only once please'));
    mockAgentState.isRunning = false;

    for (let i = 0; i < 5; i++) rerender({});

    expect(sentMessages()).toEqual(['only once please']);
  });

  it('ignores an empty or whitespace-only message', () => {
    const { result } = renderHook(() => useAssistantRun());
    act(() => result.current.run('   '));
    expect(sentMessages()).toEqual([]);
  });
});

describe('useAssistantRun — the empty-registry self-heal must keep working (US5)', () => {
  it('delivers a message sent before any agent is registered, once one registers', () => {
    mockRegistryHasAgent = false;
    mockCopilotkit.getAgent.mockReturnValueOnce(undefined);

    const { result, rerender } = renderHook(() => useAssistantRun());
    act(() => result.current.run('sent into the void'));
    expect(sentMessages()).toEqual([]);

    mockRegistryHasAgent = true;
    rerender({});

    expect(sentMessages()).toEqual(['sent into the void']);
  });
});

describe('useAssistantRun — two messages in flight (US5, FR-022)', () => {
  it('does not silently discard the first when a second is typed', () => {
    // Before this, `pendingRef.current = text` OVERWROTE the slot: the first message vanished with
    // no error and no indication. FR-022 states the property rather than the implementation — each
    // message is delivered, or its supersession is surfaced. A queue satisfies it by delivering both.
    const { result, rerender } = renderHook(() => useAssistantRun());

    mockAgentState.isRunning = true;
    rerender({});
    act(() => result.current.run('first'));
    act(() => result.current.run('second'));

    mockAgentState.isRunning = false;
    rerender({});
    rerender({});

    expect(sentMessages()).toEqual(['first', 'second']);
  });

  it('preserves order across many queued messages', () => {
    const { result, rerender } = renderHook(() => useAssistantRun());

    mockAgentState.isRunning = true;
    rerender({});
    for (const m of ['a', 'b', 'c']) act(() => result.current.run(m));

    mockAgentState.isRunning = false;
    for (let i = 0; i < 5; i++) rerender({});

    expect(sentMessages()).toEqual(['a', 'b', 'c']);
  });

  it('bounds the queue rather than growing without limit, and surfaces the refusal', () => {
    // A memory guard, not a UX limit: 8 is far above any realistic type-ahead during one answer.
    // What matters is that going past it is REFUSED and visible, never dropped silently — dropping
    // would re-create the exact defect this story fixes.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, rerender } = renderHook(() => useAssistantRun());

    mockAgentState.isRunning = true;
    rerender({});
    for (let i = 0; i < 12; i++) act(() => result.current.run(`m${i}`));

    expect(warn).toHaveBeenCalled();
    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toMatch(/queue/i);

    mockAgentState.isRunning = false;
    for (let i = 0; i < 15; i++) rerender({});

    // The first 8 are kept; the rest were refused rather than silently displacing them.
    expect(sentMessages()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    warn.mockRestore();
  });
});
