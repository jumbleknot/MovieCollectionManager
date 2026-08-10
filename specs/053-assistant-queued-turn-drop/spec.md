# Feature Specification: A message sent while the assistant is still answering is silently lost

**Feature Branch**: `150-assistant-e2e-stale-ownership-and-provider`

**Created**: 2026-08-10

**Status**: Draft

**Input**: Found while driving `app-e2e` to a reliably green state (backlog #150). `assistant-disambiguate.spec.ts:154`
failed in CI run 1619 and reproduces locally against a live stack: the member's second message never
reaches the gateway, is never echoed into the dock, and produces no error.

## Why this exists

`useAssistantRun.run()` fires the message when the agent exists and is idle, and otherwise stashes it
in `pendingRef` for a flush effect to pick up:

```ts
const target = resolveAgent();
if (target && !target.isRunning) { fire(target, text); return; }
pendingRef.current = text;            // "Agent transiently unavailable — queue and flush"
```

The queue was written for one case — the agent not yet being registered — and its flush effect is
keyed on that case:

```ts
useEffect(() => { … }, [agent, resolveAgent, fire]);
```

But the same branch also catches `target.isRunning === true`, and **none of those dependencies change
when a run finishes**. `agent` is a stable object whose `isRunning` is a mutable property, and
`resolveAgent`/`fire` are memoised on `[agent, copilotkit]`. So a message queued because the assistant
was mid-answer is never flushed: it is dropped, permanently and silently.

**Measured** (2026-08-10, live containerized stack, `--retries=0`): the accessibility snapshot at
failure shows turn 1's answer rendered in full and turn 2 absent — no user bubble, no assistant reply,
no error — while the gateway log records **zero** requests for that turn. `page.fill` and
`page.click` both succeeded, so the UI accepted the input and discarded it.

This is a user-facing defect, not a test artifact. A member who types a follow-up while the assistant
is still streaming loses what they typed, with no indication that anything went wrong. It surfaced as
E2E flakiness only because whether turn 2 lands before turn 1 finishes is a timing race — which is
also why it has read as live-model nondeterminism.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A follow-up typed mid-answer is not lost (Priority: P1)

A member asks the assistant something, and while it is still answering they type their next message —
a correction, or the option they have already decided on — and press Send. The message must be
delivered once the current turn finishes, not discarded.

**Why this priority**: It is the whole defect. Losing typed input with no error is the worst failure
mode available to a chat surface: the member cannot tell whether the assistant is slow, broken, or
ignoring them, and their only recourse is to retype and hope.

**Independent Test**: Drive `useAssistantRun` with an agent whose `isRunning` is true, send a message,
then flip `isRunning` to false and re-render. The message must be delivered exactly once.

**Acceptance Scenarios**:

1. **Given** the assistant is mid-run, **When** the member sends a message and the run then finishes,
   **Then** the message is delivered exactly once, without the member resending it.
2. **Given** the assistant is idle, **When** the member sends a message, **Then** it is delivered
   immediately (unchanged from today).
3. **Given** a message was queued and delivered, **When** the next run finishes, **Then** it is not
   delivered a second time.
4. **Given** the member sends two messages while a run is in flight, **Then** the queue does not
   silently discard one without record — the last one wins, and that is deliberate, not accidental.

---

### User Story 2 - The agent-not-yet-registered case keeps working (Priority: P2)

The existing behaviour this queue was built for — a tap that lands before the CopilotKit agent
registry is populated — must continue to self-heal.

**Why this priority**: It is the case the current code was written for and the one already relied on
(`use-assistant.tsx` calls it "self-heals an empty-registry tap"). A fix that traded one silent drop
for another would be no improvement.

**Independent Test**: Drive `run()` with no agent resolvable, then make one available and re-render.

**Acceptance Scenarios**:

1. **Given** no agent is registered, **When** the member sends a message and an agent then registers,
   **Then** the message is delivered exactly once.

## Requirements *(mandatory)*

- **FR-001**: A message accepted by the dock MUST eventually be delivered or surfaced as an error. It
  MUST NOT be silently discarded.
- **FR-002**: A message queued because the agent was mid-run MUST be flushed when that run completes.
- **FR-003**: A queued message MUST be delivered at most once (no duplicate turn, no double write).
- **FR-004**: The existing empty-registry self-heal MUST keep working.
- **FR-005**: Delivery MUST NOT depend on the member interacting again (no "press Send twice").

## Success Criteria *(mandatory)*

- **SC-001**: A unit test drives the mid-run case and fails on the current implementation (RED) and
  passes on the fixed one (GREEN).
- **SC-002**: `assistant-disambiguate.spec.ts:154` passes locally against the live stack with
  `--retries=0`, with the contention tally reading `refresh_rate_limited=0` so the run is valid.
- **SC-003**: Two consecutive `app-ci` runs report `failed=0 skipped=0 did-not-run=0` from the
  `e2e-result-gate` step.

## Out of scope

- Any change to how the dock RENDERS a pending message (e.g. showing it greyed while queued). Worth
  considering, but it is a UX addition; this spec is about not losing it.
- The retry/idempotency behaviour of `/run` itself.
- The live-model and live-TMDB nondeterminism that remains in the agent E2E suite.
