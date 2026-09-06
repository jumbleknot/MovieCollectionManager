# Tasks: 066 — the assistant dock renders CopilotKit 1.70's streaming tool calls

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Item**: #265

Every test task records **Verify RED** then **Verify GREEN**
(`openwiki/process/test-authoring-conventions.md`).

**Instrument warnings for the RED runs on this feature.**

- `npx jest <path>` is the safe form here. Do **not** use the
  `node --test <file> --test-name-pattern` shape — everything after the script path becomes the
  script's own `argv` and the filter silently does nothing (CLAUDE.md).
- The dock tests mock `useCopilotKit`. 1.70's `useRenderToolCall` reads `renderToolCalls` and
  `executingToolCallIds` off that value and subscribes via `useSyncExternalStore`. **The double must
  return a stable object across renders** — a fresh one per render re-runs the subscription and can
  manufacture a green (feature 053). If a test passes on its first run against unmigrated code,
  suspect the double before believing it.
- A compile error is **not** an acceptable RED for behaviour that already exists. Where a task's
  behaviour is already correct, the RED is a mutation: delete the branch, observe the failure,
  restore it.

## Phase 0 — the dependency bump and the measured baseline

- **T001** `frontend/mcm-app/package.json`: `@copilotkit/react-native` and `@copilotkit/runtime`
  → `1.70.1` (FR-001). `pnpm install`.
- **T002** Record the baseline: `npx tsc --noEmit` in `frontend/mcm-app`. Expect the measured **7**
  errors across 7 files (spec.md, *Context*). This is the feature's RED for SC-001 — if the count
  differs, the spec's measurement is stale and must be re-taken before proceeding.

## Phase 1 — the shared incomplete state (US2, FR-003, D3)

- **T003** [RED] `src/components/agent/tool-call-pending.test.tsx`: `ToolCallPending` renders its
  label under testID `tool-call-pending`. RED = the module does not exist; write the assertions
  alongside T004 rather than committing a collection error.
- **T004** [GREEN] `src/components/agent/tool-call-pending.tsx` — one presentational component,
  design-system tokens, no platform branch (constitution: Universal Generative UI).

## Phase 2 — the dock reads through `useRenderToolCall` (US1, FR-002, D1)

- **T005** [RED] `assistant-dock-tools.test.tsx`: keep the existing "renders a movie card inline"
  and "unique item keys" assertions and re-point them at the new `buildDockItems` signature. RED is
  the TS2305 on `useRenderToolRegistry` plus the failing assertions once it is removed.
- **T006** [GREEN] `assistant-dock.tsx`: drop the `useRenderToolRegistry` import; call
  `useRenderToolCall()`; change `buildDockItems`'s second parameter from the `Map` to the returned
  `({toolCall, toolMessage}) => ReactElement | null`. Delete the local `JSON.parse` of
  `tc.function.arguments` and the hardcoded `status: 'complete'` — the library owns both now.
- **T007** [GREEN, regression] the duplicate-tool-call-id key test still passes: item ids stay
  `${messageIndex}:${toolCallId}`. This guard exists because a duplicate FlatList key is a blocking
  LogBox RedBox on Android — do not let the rewrite quietly change the id scheme.
- **T008** [GREEN, regression] every other existing assistant-dock test passes unchanged (SC-002).

## Phase 3 — the schema gate at each card render site (US1 + US2, FR-003/FR-005/FR-007, D2)

Each task: `safeParse` the args against the site's existing `parameters` schema, render the component
from `parsed.data` on success and `ToolCallPending` on failure. No `as`, no `!` (FR-007).

- **T009** [RED→GREEN] `render-movie-card.tsx` (measured error #4) — **and the FR-008 test**:
  `render-movie-card.test.tsx` asserts (a) complete args render the card, (b) `{}` renders
  `tool-call-pending` and no card. RED for (b) against the unmigrated spread.
- **T010** [RED→GREEN] `render-collection-summary.tsx` (measured error #3).
- **T011** [RED→GREEN] `disambiguation-options.tsx` (measured error #2).
- **T012** [RED→GREEN] `multi-select-options.tsx` (measured error #1 by file order).
- **T013** [RED→GREEN] `selection-options.tsx` (measured error #5 — **absent from item #265's list**;
  the item was written against 1.69.0).
- **T014** [RED→GREEN] `render-import-report.tsx` — compiles today because of its `??` defaults, so
  this RED is a **mutation RED**: assert that `{}` yields `tool-call-pending`, and observe it fail
  against the current `?? 0 / ?? []` fallbacks, which silently render an empty report as though the
  import had reported nothing.
- **T015** [RED→GREEN] `request-import-file.tsx` — `prompt` is genuinely optional, so the gate here
  is that the affordance still renders with no prompt. Assert it; do not "fix" a non-defect.

## Phase 4 — the UI-action effect gate (US2, FR-006, D4)

- **T016** [RED] `ui-action-tools.test.tsx`: a `navigate_to_collection` tool call with **no**
  `collectionId` performs **no** `router.push`. RED against today's
  `router.push('/collections/undefined')`.
- **T017** [GREEN] `ui-action-tools.tsx`: all four sites (`navigate_to_collection`,
  `navigate_to_movie`, `prefill_add_movie`, `download_export`) render **nothing** — not
  `ToolCallPending` — when their args do not validate. An effect component that renders a
  placeholder still mounts and still fires; that is the whole point of D4.
- **T018** [GREEN] `download_export` (measured error #7): the `String(args.handle)` /
  `typeof args.filename === 'string'` improvisation is replaced by the schema gate. Assert that an
  incomplete call triggers no download.
- **T019** [GREEN, regression] a complete call for each of the four still performs its effect
  exactly once — `uiActionKey` de-duplication is unchanged.

## Phase 5 — tiers and the record

- **T020** `npx tsc --noEmit` → **0 errors** (SC-001). Confirm by grep that no `as ` cast or `!`
  non-null assertion was added to any touched file (FR-007).
- **T021** `pnpm nx run-many -t typecheck lint test -p mcm-app --skip-nx-cache` → green (SC-004).
  Lint must gain **no** new warnings.
- **T022** Derive the remaining tiers from the diff, not from memory
  (`openwiki/invariants/testing-tiers.md`). The diff is `frontend/mcm-app` only — no Rust, no Python,
  no infrastructure — so `mcm-app` is the affected project and `app-e2e` is the gate.
- **T023** `app-e2e` on the pull request (SC-005). Per plan.md's instrument warning, a green
  `nx test mcm-app` is **not** evidence about a change to the dock — every assistant spec routes
  through it. Watch the SKIP COUNT, not just the pass count.
- **T024** Close item #265 only once SC-001…SC-005 are each verified, and say in the closing comment
  that the migration went to `1.70.1` rather than `1.69.0`, that the error set was 7 rather than the
  5 the item listed, and that `status` cannot be the completeness signal here — the item's own
  acceptance criterion was written on a premise the measurement disproved.
