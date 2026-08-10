# Implementation Plan: A message sent while the assistant is still answering is silently lost

**Feature**: 053-assistant-queued-turn-drop
**Spec**: [spec.md](./spec.md)
**Created**: 2026-08-10

## Technical context

| | |
| --- | --- |
| Language | TypeScript (React 19 / React Native Web, Expo Router) |
| Surface | `frontend/mcm-app/src/hooks/use-assistant.tsx` — `useAssistantRun` |
| Transport | CopilotKit `@copilotkit/react-native` — `useAgent`, `copilotkit.runAgent` |
| Tests | Jest + `@testing-library/react-native` (the tier `use-assistant-data-sync.test.tsx` uses) |
| Gate | `pnpm nx test mcm-app` unit tier; then the web E2E spec that first exposed it |

## Root cause

`run()` has one queue branch serving two different conditions:

```ts
if (target && !target.isRunning) { fire(target, text); return; }
pendingRef.current = text;
```

- **agent not registered yet** — `target` is falsy. Recovers when the agent registers, because
  `agent` changes identity and the flush effect's `[agent, …]` dependency fires.
- **agent registered but running** — `target` is truthy. `agent` keeps the SAME identity when
  `isRunning` flips back to false, so the effect never re-runs and the message is never flushed.

The bug is not the queue; it is that the flush is keyed on a signal that does not cover the second
condition.

## Approach

Make the flush effect observe the thing it is actually waiting for: **run completion**.

`useAssistantRun` already computes `isRunning` for its own return value (`agent?.isRunning ?? false`).
Hoist that into a variable and add it to the effect's dependency list, so the effect re-runs on the
false→true→false transition and flushes the queue on the trailing edge.

```ts
const isRunning = agent?.isRunning ?? false;

useEffect(() => {
  const queued = pendingRef.current;
  if (!queued) return;
  const target = resolveAgent();
  if (target && !target.isRunning) {
    pendingRef.current = null;   // cleared BEFORE fire — at-most-once (FR-003)
    fire(target, queued);
  }
}, [agent, isRunning, resolveAgent, fire]);
```

`pendingRef.current = null` already precedes `fire`, which is what makes delivery at-most-once even
if the effect runs twice for one transition (React 19 StrictMode double-invokes effects in dev).

### Why this and not the alternatives

- **Wait for idle in the E2E spec instead.** Rejected: it hides a real defect behind the harness. The
  member-facing behaviour — typed input vanishing — would remain, and the suite would go green while
  proving less. The rule for this branch is explicit that a failure is not to be fixed by weakening
  the test.
- **Block the send button while running.** Rejected as the primary fix: it makes the loss visible but
  still refuses the member's input, and the dock deliberately lets a member type ahead. Worth
  considering as a UX addition, which is why the spec puts it out of scope rather than pretending it
  is equivalent.
- **A queue ARRAY rather than a single slot.** Rejected for now: it changes semantics (all queued
  turns replay) where today the last one wins, and nothing has asked for it. FR-003 pins at-most-once
  for the slot that exists; a growth to a queue is a separate decision. The spec's AC-4 records that
  last-one-wins is deliberate.

## Risk

| Risk | Mitigation |
| --- | --- |
| Double delivery (two turns, two writes) | `pendingRef` cleared before `fire`; unit test asserts exactly one call across a re-render storm |
| The effect fires on every render now | It early-returns on an empty queue before touching anything |
| `isRunning` is not observable as state | It is already read for the hook's return value, so the component re-renders on it; the test pins the transition rather than assuming it |

## Verification

1. **RED**: unit test for the mid-run case fails against current `use-assistant.tsx`.
2. **GREEN**: same test passes after the change; the empty-registry test keeps passing.
3. `pnpm nx test mcm-app` (full unit tier) — no regression.
4. `assistant-disambiguate.spec.ts` against the live containerized stack, `--retries=0`, with the
   contention tally checked alongside so a harness-driven result is not mistaken for a code result.
5. Two consecutive `app-ci` runs, judged by the `e2e-result-gate` counts, not by the exit status.
