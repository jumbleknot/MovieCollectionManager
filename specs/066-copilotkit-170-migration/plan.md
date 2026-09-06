# Implementation Plan: the assistant dock renders CopilotKit 1.70's streaming tool calls

**Branch**: `265-copilotkit-170-migration` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

## Summary

Move `@copilotkit/react-native` and `@copilotkit/runtime` from `1.67.1` / `1.59.5` to `1.70.1`, and
absorb the two breaking changes that arrive with them: the removal of `useRenderToolRegistry`, and a
`render` props union whose `args` may be partial while the model is still writing them.

The design turns on one measurement (spec.md, *Context*): `status` is pinned at `inProgress` for
every MCM tool, so it cannot be the completeness signal. **Each tool's already-declared parameter
schema becomes the completeness gate** — `safeParse` the incoming `args`; on success render the
component with the parsed, fully-typed value; on failure render a defined incomplete state. This
satisfies the type union without a cast (FR-007), reuses the contract the model is already given so
the two cannot drift (FR-005), and keeps the incomplete branch a real, testable code path (FR-008).

## Technical Context

**Language/Version**: TypeScript 6.0 (`tsc --noEmit`), React 19.2, React Native / react-native-web

**Primary Dependencies**: `@copilotkit/react-native@1.70.1`, `@copilotkit/runtime@1.70.1`,
`@ag-ui/client@0.0.59` (already pinned), `zod` (already the schema library at every render site)

**Storage**: N/A

**Testing**: Jest (`jest-expo`) + `@testing-library/react-native` for unit; Playwright `app-e2e` for
the assistant flows

**Target Platform**: web (react-native-web) and Android, one codebase

**Project Type**: mobile + web universal app with an embedded BFF

**Constraints**: Universal Generative UI — one component renders identically on both platforms; no
`as`-cast or `!` to satisfy the union (FR-007)

**Scale/Scope**: 11 registered render sites in `frontend/mcm-app/src/components/agent/`, plus the
dock's `buildDockItems`, plus two dependency pins

## Constitution Check

| Principle | Status |
| --- | --- |
| Universal Generative UI — one RN component for web + Android | **Pass** — no platform branch is added; the incomplete state is the same component tree on both. |
| Standard library bridges, not bespoke per-event translation | **Pass** — `useRenderToolCall` is the framework's own read side; the alternative (reading `copilotkit.renderToolCalls` directly) is rejected below precisely because it reimplements library internals. |
| Tests before implementation (RED→GREEN) | **Pass** — every task below records both. |
| No secrets, no new network surface | **Pass** — client-side rendering only. |

No deviations; Complexity Tracking is empty.

## Key decisions

### D1 — `useRenderToolCall`, not a hand-rolled registry read

`useRenderToolRegistry` is gone because the RN package no longer keeps a registry; renderers land in
react-core's `copilotkit.renderToolCalls`. Two options:

1. **`useRenderToolCall()`** — the framework's supported read side. Returns
   `({toolCall, toolMessage}) => ReactElement | null`, handles partial-JSON parsing, memoises per
   tool call, and resolves agent-scoped renderers.
2. Read `copilotkit.renderToolCalls` through `useCopilotKit()` and keep `buildDockItems`'s current
   hardcoded `status: 'complete'`.

**Option 1 is chosen.** Option 2 preserves today's behaviour with a smaller diff, but it
reimplements the library's dispatch (exact-name match → agent-scoped → wildcard), reintroduces
argument parsing the library already does, and — decisively — asserts `complete` for arguments that
may genuinely be partial, which is the very bug FR-003 exists to prevent. It also re-creates the
drift the 1.70 release notes say the RN-local registry caused.

The consequence to accept: `status` arrives as `inProgress` (measured). Nothing branches on it
(FR-004), so this is inert.

### D2 — the parameter schema is the completeness gate

Each `useRenderTool` call already declares `parameters: z.object({…})`. The render becomes:

```tsx
render: ({ args }) => {
  const parsed = renderMovieCardParameters.safeParse(args);
  return parsed.success ? <RenderMovieCard {...parsed.data} /> : <ToolCallPending label="…" />;
},
```

Why the schema rather than a hand-written field check: it is the same object already handed to the
model, so a field added to one is a field required by the other — there is no second list to forget.
`parsed.data` is fully typed, so the spread satisfies the props type with no cast (FR-007).

Accepted limitation (spec.md, *Edge Cases*): a truncated string value satisfies `z.string()`. Every
schema here requires several fields, so the object does not validate until nearly complete, and the
residue is a one-frame flicker of partial text — which is the progressive drawing the change exists
to enable.

### D3 — one shared incomplete component

A single `ToolCallPending` in `components/agent/`, taking a short label, rather than eleven bespoke
skeletons. Keeps the incomplete state visually consistent, gives the tests one testID
(`tool-call-pending`) to assert against, and makes "did this site get migrated?" greppable.

### D4 — UI-action tools gate the EFFECT, not just the render

`ui-action-tools.tsx` renders effects, not cards: `UiActionEffect` performs a `router.push` on mount.
An incomplete `navigate_to_collection` must therefore render **nothing at all** rather than a pending
placeholder that still fires — FR-006. `download_export` is the one site that currently *compiles*
its way around this via `String(args.handle)`, which yields the literal `"undefined"`; that is
measured error #7 and is fixed by the same gate.

### D5 — the `AgentsConfig` cast stays

`@copilotkit/runtime@1.70.1` depends on `@ag-ui/client@0.0.59`, exactly the app's pin, so the nominal
`AbstractAgent` mismatch behind `as unknown as AgentsConfig` in `run+api.ts` is probably gone. It is
**not** touched here: PR #369 (item #284) is open against that same file and the same region, and the
PR-batching rule's split test — "if CI goes red, could I tell which change caused it?" — answers no.
Filed as its own backlog item.

## Project Structure

### Documentation (this feature)

```text
specs/066-copilotkit-170-migration/
├── spec.md
├── plan.md      # this file
└── tasks.md
```

### Source Code

```text
frontend/mcm-app/
├── package.json                                   # FR-001: both pins → 1.70.1
└── src/components/agent/
    ├── tool-call-pending.tsx                      # NEW (D3) — the shared incomplete state
    ├── assistant-dock.tsx                         # useRenderToolCall; buildDockItems reworked
    ├── render-movie-card.tsx                      # schema gate
    ├── render-collection-summary.tsx              # schema gate
    ├── disambiguation-options.tsx                 # schema gate
    ├── multi-select-options.tsx                   # schema gate
    ├── selection-options.tsx                      # schema gate (missed by item #265)
    ├── render-import-report.tsx                   # schema gate (compiled, silently exposed)
    ├── request-import-file.tsx                    # schema gate (compiled, silently exposed)
    └── ui-action-tools.tsx                        # effect gate ×4 (D4)
```

**Structure Decision**: no new directory. The one new file sits beside the render tools it serves.

## The instrument warning for this feature

Two of this repository's recorded traps apply directly:

- **A test double that returns a fresh object per render can repair the bug it was meant to catch**
  (feature 053). `assistant-dock-tools.test.tsx` mocks `useCopilotKit`; 1.70's `useRenderToolCall`
  reads `copilotkit.renderToolCalls` and `executingToolCallIds` from it and subscribes through
  `useSyncExternalStore`. The double must be **stable across renders**, or a RED will not be real.
- **A local subset pass is not evidence about a change to a shared hook** (feature 053). This change
  touches the dock, which every assistant E2E goes through. `app-e2e` on the PR is the evidence;
  a green `nx test mcm-app` is not.

## Complexity Tracking

No constitution violations.
