# Feature Specification: A message sent while the assistant is still answering is silently lost

**Feature Branch**: `150-assistant-e2e-stale-ownership-and-provider`

**Created**: 2026-08-10

**Status**: **ATTEMPT REVERTED — but the reason was WRONG. See the 2026-08-11 correction below.**

**Input**: Found while driving `app-e2e` to a reliably green state (backlog #150). `assistant-disambiguate.spec.ts:154`
failed in CI run 1619 and reproduces locally against a live stack: the member's second message never
reaches the gateway, is never echoed into the dock, and produces no error.

## ✅ Correction (2026-08-11): the revert's premise did not hold

`app-ci` run **1633 reproduced the identical signature with this fix ABSENT** — 30 failed, `flaky=0`,
~39 gateway POSTs against a healthy run's ~155. So the regression attributed below to this change is
an intermittent whole-suite collapse that occurs roughly **one run in seven regardless of it**, now
tracked as backlog item **#173** (p1). Two consecutive samples of that event were mistaken for
causation.

| run | fix present? | failed | gateway POSTs | anthropic calls |
| --- | --- | ---: | ---: | ---: |
| 1619 | no | 1 | 155 | 99 |
| 1621 | yes | 28 | 43 | 26 |
| 1622 | yes | 26 | 56 | 34 |
| **1633** | **no** | **30** | **39** | **24** |

**The fix in [plan.md](./plan.md) was probably sound.** Re-apply it once #173's mechanism is known, so
the next attempt is not judged against a background of random collapses — and judge it over more than
two runs, because a ~1-in-7 flip cannot be resolved by two samples.

The revert was still the right call on what was known at the time: an unexplained change in a suite it
appeared to break. The error was the inference, not the caution.

## ⛔ The original (2026-08-10) reasoning, kept as written

The defect below is **real and reproduced**. The fix described in [plan.md](./plan.md) — adding
`isRunning` to the flush effect's dependency list — **was implemented, verified locally, merged onto
the branch, and then REVERTED**, because it caused a large `app-e2e` regression that its local
verification did not predict.

| commit | app-e2e failed | flaky | gateway requests |
| --- | ---: | ---: | ---: |
| before the fix (2eaa30e) | 1 | 5 | 155 |
| **with the fix (81e03e9), run 1621** | **28** | 0 | 43 |
| **with the fix (81e03e9), run 1622 — same sha** | **26** | 0 | 56 |

Two runs on the IDENTICAL commit, so this is the change and not run-to-run variance — the same
two-run standard used to accept a green result, applied to a red one. Every agent/dock spec failed,
including the simplest (`assistant.spec.ts:78`, "sends a message and renders the streamed reply"),
all with no assistant message at all and `flaky=0` (none recovered on retry). The stack was healthy:
the gateway started normally and answered every request it received with 200 — it simply received a
third of the usual traffic. Turns were not being sent.

**The mechanism is NOT understood.** Checked and eliminated: `assistant_not_configured` short-circuits
(zero in both runs), MCP/stack degradation (no error signature, containers healthy), and the obvious
reading that each `useAssistantRun` instance shares state (each has its own `pendingRef`).

What made this fix look safe, and why that was not enough:

* 6/6 unit tests, RED before and GREEN after, on a test double corrected to match the real
  CopilotKit context (the first double repaired the bug it was meant to catch — see below);
* 5/5 E2E with `--retries=0` against the live containerized stack, in 23.6 s versus 2.3 min;
* `refresh_rate_limited=0` alongside, so the instrument was valid.

All of that was true and none of it caught a whole-suite regression. The gap is that the local run
exercised three spec files in isolation, and the regression only appears under the full suite's
concurrency. **A local subset pass is not evidence about a change to a SHARED hook.**

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
