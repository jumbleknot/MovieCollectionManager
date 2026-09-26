# Implementation Plan: Web bundle diet — take the assistant runtime off the cold-load path

**Branch**: `077-web-bundle-diet` | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/077-web-bundle-diet/spec.md`

## Summary

The web client ships one 4,283,369-byte chunk. 57% of it is the conversational assistant's
runtime, which reaches the browser on every authenticated route even for a user who never
opens the assistant — and which drags in 659 KB of React Native polyfills that cannot execute
on web at all, because `@copilotkit/react-native`'s own entry point imports them as a side
effect.

Put the assistant runtime behind one dynamic-import boundary, leaving the toggle eager.
Separately, stop a server-only formatting module (and its date library) from shipping to the
browser, and add two durable guards so neither problem can return quietly.

Measured on the implementation: entry chunk 4,283,369 → **1,762,630 bytes (−58.8%)**, with `zod`,
`graphql`, `text-encoding`, `@copilotkit/*`, `@ag-ui/*`, `rxjs` and `luxon` all at zero entry-chunk
modules. See [research.md](./research.md) for the method, so any number here can be re-derived.

**Two changes are required, not one — the original plan missed this.** Deferring the panel alone
leaves the entry chunk at 2,379,727 B, because `src/app/_layout.tsx` imports the CopilotKit polyfill
loader at the ROOT, eagerly, so that graph is reachable whether or not the panel loads. The loader
must also be split by platform. R2 of research.md records why the original probe hid this: it was run
on a tree that still held an earlier probe's change, so one measurement was credited to the wrong
cause.

## Technical Context

**Language/Version**: TypeScript 5.x, React 19.2.3, React Native 0.85.3, Expo SDK 56

**Primary Dependencies**: `expo-router` ~56.2.8 (file-based routing, `web.output: "server"`),
Metro (bundler, `splitChunks` enabled for web export), `@copilotkit/react-native` 1.70.1 +
`@ag-ui/*` (assistant runtime), Tamagui 2.x + `@mcm/design-system` (UI), `luxon` (server-side
scheduling only, after this change)

**Storage**: N/A — no data-model change

**Testing**: Jest + Expo Testing Library (unit), Playwright (web E2E), Maestro (mobile E2E),
`node --test` (gate-script unit tests)

**Target Platform**: Web (primary target of this change) and Android (must not regress)

**Project Type**: Universal Expo app with an embedded BFF (`frontend/mcm-app`)

**Performance Goals**: web entry chunk ≤ 2,000,000 bytes (SC-001; measured 1,762,630); Slow-3G cold
TTI for `/home` ≤ 75,000 ms, i.e. ≥50% headroom against the perf test's previous 150,000 ms ceiling
(SC-002)

**Constraints**: the assistant's behaviour and capabilities must not change; SSR hydration of
the authenticated layout must stay correct across the new boundary; native must keep its
polyfills

**Scale/Scope**: 3 user stories, 14 functional requirements. ~8 source files changed, 2 modules
moved, 2 new gate scripts, 1 new nx target, 2 CI wirings.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Note |
|---|---|---|
| **Frontend UI & UX — Performance Budgeting** ("JavaScript bundles must be lazy-loaded") | **Served; the 2-second clause carries an accepted exception** | This feature is the first lazy-loading of a JS bundle in the app, which the principle explicitly requires. The same principle's 2-second-3G figure is **not achievable** on this stack and now carries a bounded **accepted exception** at constitution **v2.5.0** (item #565), granted by the operator on the measured evidence in this feature. The exception covers residual framework weight only, is capped by the committed entry-chunk budget, and leaves the lazy-loading clause fully in force. |
| **Frontend Separation of Concerns — BFF-Layer "must run server-side and never be included client-side"** | **Violation being fixed** | `src/bff-server/backup-run-summary.ts` is imported by a client component today. US2 moves it to the Utils-Layer, where its pure-formatting nature already belongs, and adds a guard. |
| **Frontend Separation of Concerns — Components-Layer / Hooks-Layer split** | Respected | The loader is a stateless Utils-Layer module; the idle-prefetch side effect is a Hooks-Layer hook; no UI is returned from a hook. |
| **Platform Specific Code** ("a default version without a platform-specific extension is required — the default must be for web") | Respected | No `.web.*` file is introduced. Had the polyfill route been viable it would have needed `.native.*`; it is not viable (research.md R2), so the question does not arise. |
| **Test-Driven Development (NON-NEGOTIABLE)** | Respected | Every task pair in tasks.md carries a Verify RED with expected failure output and a Verify GREEN. |
| **Test Type Integrity (NON-NEGOTIABLE)** | Respected | The bundle-composition assertions run against a real `expo export` artifact, never a fixture. The E2E measurement drives the real app. No mocking is introduced anywhere. |
| **Frontend App Quality Standards — Platform Parity Table** | Respected | tasks.md carries the table; the web/mobile split is justified per scenario (the chunking behaviour is web-only by construction). |
| **Nx as the universal task runner** | Respected | The budget check is an nx target (`bundle-budget`) depending on `export-server`, so it is cached and rides `nx affected`. |
| **Design System** | Respected | The only new UI is the assistant panel's loading state, composed from `@mcm/design-system`. |
| **Code Coverage ≥70% for new features** | Respected | Both new gate scripts get `node --test` unit tests plus a `--selftest` mode. |

No unjustified violations. One accepted limitation is recorded in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/077-web-bundle-diet/
├── plan.md              # This file
├── spec.md              # Feature specification (incl. Measured Baseline)
├── research.md          # Phase 0 — how every number was measured, and the two rejected approaches
├── quickstart.md        # Phase 1 — how to reproduce the measurement locally
├── contracts/
│   └── bundle-budget.md # The budget gate's contract: inputs, exit codes, failure text
└── tasks.md             # Phase 2 (/speckit-tasks output)
```

No `data-model.md`: this feature changes no entity, no schema and no API surface.

### Source Code (repository root)

```text
frontend/mcm-app/
├── src/
│   ├── app/(app)/
│   │   └── _layout.tsx                        # CHANGED: mounts the dock only; no assistant runtime import
│   ├── components/
│   │   ├── agent/
│   │   │   ├── assistant-dock.tsx             # CHANGED: keeps ONLY the toggle + the lazy boundary
│   │   │   ├── assistant-panel.tsx            # NEW: the panel + tool renderers + AssistantProvider
│   │   │   └── assistant-panel-fallback.tsx   # NEW: the loading / failed-to-load states
│   ├── assistant-polyfills.ts                  # NOW THE WEB VARIANT: no CopilotKit polyfill requires
│   ├── assistant-polyfills.native.ts           # MOVED from assistant-polyfills.ts; behaviour unchanged
│   │   └── backups/
│   │       └── run-history.tsx                # CHANGED: imports the util, not the bff-server module
│   ├── hooks/
│   │   └── use-assistant-runtime.ts           # NEW: idle prefetch + load state (Hooks-Layer)
│   ├── utils/
│   │   ├── assistant-runtime-loader.ts        # NEW: the single-flight dynamic import (Utils-Layer)
│   │   └── backup-run-summary.ts              # MOVED from src/bff-server/; luxon → Intl
│   ├── bff-server/
│   │   └── backup-run-summary.ts              # DELETED (moved)
│   └── ...
├── tests/e2e/web/
│   └── perf.spec.ts                           # CHANGED: headroom ceiling + excludes deferred chunk
├── project.json                               # CHANGED: new `bundle-budget` target
└── ...

scripts/
├── check-web-bundle-budget.mjs                # NEW: entry-chunk budget gate (FR-012)
├── check-no-server-imports.mjs                # NEW: static bff-server leak gate (FR-011)
└── __tests__/
    ├── check-web-bundle-budget.test.mjs       # NEW
    └── check-no-server-imports.test.mjs       # NEW

.forgejo/workflows/
├── guardrails.yml                             # CHANGED: naming job runs check-no-server-imports
└── app-ci.yml                                 # CHANGED: affected job adds the bundle-budget target
```

**Structure Decision**: the existing `frontend/mcm-app` layout is kept exactly. Each new file
lands in the constitution's layer for its responsibility — the dynamic import is a standalone
util, its idle-prefetch side effect is a hook, the loading state is a component, and the moved
formatter goes to the Utils-Layer it always belonged in.

## Design

### D1 — Where the boundary goes, and why not one line higher

`(app)/_layout.tsx` renders `<AuthedAssistant/>`, which already returns `null` unless the
per-user config is `runnable`. The tempting one-line change is to make *that* lazy. It is
wrong: the E2E user's config **is** runnable, so the chunk would be requested at mount, in
parallel with the home screen's own bytes, on a serialized Slow-3G pipe — measurably worse
than useless, and the perf test would still count those bytes.

The boundary goes one level lower, at the panel:

- `assistant-dock.tsx` keeps only the toggle — `View`, `TouchableOpacity`, `AssistantAvatar`,
  `useTheme`. It imports nothing from `@copilotkit/*` or `@ag-ui/*`, so it stays in the entry
  chunk and the toggle's first paint is unchanged (FR-003).
- `assistant-panel.tsx` (new) holds everything else the dock file holds today — the panel, the
  tool renderers, `useAssistantRun` — **and** `AssistantProvider`, which moves out of
  `(app)/_layout.tsx`. That matters: `AssistantProvider` imports `CopilotKitProvider` from
  `@copilotkit/react-native`, which is the side-effect import that drags in the polyfills. If
  the provider stays in the layout, nothing is deferred.
- The existing `{open && <AssistantPanel/>}` becomes the lazy boundary, so the condition that
  already gates the panel is the condition that gates the download.

Nothing renders assistant markup on the server that the client then has to match: the panel is
behind `open`, which starts `false` (FR-008).

### D2 — One loader, two triggers

`utils/assistant-runtime-loader.ts` holds the module-scoped promise:

```
let inFlight: Promise<AssistantPanelModule> | null = null;
export function loadAssistantRuntime() { return (inFlight ??= import('@/components/agent/assistant-panel')); }
export function resetAssistantRuntimeForTest() { inFlight = null; }
```

Single-flight by construction, so repeated toggle presses and a racing idle prefetch produce
exactly one fetch (FR-004). `React.lazy(loadAssistantRuntime)` and the prefetch call the same
function, so the prefetch genuinely warms what the render path will use.

On failure the promise rejects and `inFlight` is cleared, so a later attempt retries rather
than replaying a rejected promise for the rest of the page session (FR-006). This is the part
most likely to be got wrong by the obvious `??=` alone, and it has its own test.

### D3 — The idle prefetch

`hooks/use-assistant-runtime.ts` calls `loadAssistantRuntime()` from `requestIdleCallback`,
scheduled after mount, with a `setTimeout` fallback where `requestIdleCallback` is absent
(it is absent on native and in older Safari; native does not need the prefetch at all, and the
fallback keeps the hook's contract platform-independent). The callback is cancelled on unmount.

Because the fetch starts only once the browser is idle, it starts **after** `/home` is
interactive — which is what keeps it out of the perf test's measured window (FR-002, SC-003).

### D4 — The loading and failure states, and why NOT `React.lazy`

This section originally specified `React.lazy` + `Suspense` + an error boundary. **Measured, that
cannot satisfy FR-006**: `React.lazy` calls its factory exactly once and caches a rejection on the lazy
object for the life of the page — a probe confirmed the factory is not re-invoked even on a fresh mount
after the boundary resets. A failed chunk fetch would disable the assistant until a page reload,
however retry-capable the loader beneath it is (research.md R7).

So the dock holds the loaded component in `useState` and drives three explicit states — loading,
failed, loaded. `assistant-panel-fallback.tsx` supplies the loading and recoverable-error UI from
`@mcm/design-system`, with a Retry that re-enters `loadAssistantRuntime` (which cleared its own cache
on rejection). The toggle stays interactive throughout, so the panel can always be closed. About twelve
lines of state, in exchange for a Retry that works.

### D5 — The server-module leak

`src/bff-server/backup-run-summary.ts` is pure formatting with no server dependency — its own
header says "NOTHING HERE READS A CLOCK, a device locale or a stored preference. Every input
is an argument." It is a Utils-Layer module filed in the wrong layer, and moving it to
`src/utils/backup-run-summary.ts` is the fix, together with its unit tests.

Its single `luxon` use is `formatNextRun`, which needs a named-IANA-zone format. `Intl.DateTimeFormat`
with `{ timeZone, day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }`
and the `en-GB` locale reproduces Luxon's `d LLL yyyy, HH:mm` **exactly** — verified across
DST-on and DST-off London, a negative offset, a half-hour zone and a far-future southern
zone (research.md R4). Invalid input must keep returning `'Not scheduled'`: `Intl` throws
`RangeError` on an unknown time zone where Luxon returned an invalid `DateTime`, so the
replacement catches and returns the same string. The existing unit tests move unchanged and
are the contract; they fail RED against a naive replacement that drops either guard.

`luxon` stays a dependency — `bff-server/backup-schedule.ts` still uses it server-side. Only
its presence in the *client* graph ends.

### D6 — The two guards

**`check-no-server-imports.mjs`** (static, no build): walks client-reachable source under
`frontend/mcm-app/src` — everything except `src/bff-server/**` and `src/app/**/*+api.ts` — and
fails on any import of `@/bff-server/…` or a relative path resolving into `src/bff-server/`,
naming the importing file and the specifier. Static, so it costs nothing and runs in the
`guardrails` → `naming` job beside the other gates, with the `--selftest` mode that job's
convention requires (FR-011).

**`check-web-bundle-budget.mjs`** (needs the export): reads the exported
`dist/client/_expo/static/js/web/entry-*.js`, compares its size to the budget, and prints
measured / budget / overage. It also asserts the deferred packages contribute zero modules to
the entry chunk by reading the emitted source map's `sources` (SC-004) — that assertion is
what stops a future change from quietly re-importing `@copilotkit/react-native` at the root
while staying under the byte budget. Exposed as the nx target `bundle-budget`
(`dependsOn: ["export-server"]`) and added to the `affected` job's target list, so it is
cached and only runs when mcm-app is affected (FR-012).

Both use `scripts/lib/argv-contract.mjs`, the repository's shared rejecting parser — an
unrecognised flag raises rather than leaving the default action running.

### D7 — The perf test

`perf.spec.ts` keeps its `perf-metrics` attachment and its byte/TTI measurement. Two changes:
its TTI ceiling becomes the headroom ceiling (75,000 ms), and it asserts the deferred chunk is
absent from the responses observed up to the interactive mark — so the test proves the
deferral rather than merely benefiting from it (FR-014, SC-002, SC-003). The
byte-sanity ceiling drops from 8,000 KB to a value consistent with the new entry chunk.

## Phasing

| Phase | Content | Why this order |
|---|---|---|
| **1** | US2 — move the module, `luxon` → `Intl`, add `check-no-server-imports` | Independent of the boundary work and lowest risk. Landing it first means the US1 measurement is taken against a tree where the 70 KB leak is already gone, so the two effects do not have to be disentangled. |
| **2** | US1 — extract the panel, the loader, the hook, the fallback states | The feature's substance. |
| **3** | US3 — the budget gate, the nx target, the CI wirings, the perf-test update | Must come last: the budget can only be set from the measured post-change size, and the perf assertion can only pass once the deferral exists. |

## Risks

| Risk | Mitigation |
|---|---|
| **SSR hydration mismatch across the lazy boundary.** The probe proved the export succeeds; it did not prove the running app hydrates. | The web E2E suite drives the real server-rendered app. The assistant dock specs open the panel and are the direct test. Treated as a verification obligation, not an assumption — spec Edge Cases names it. |
| **The E2E user's runnable config makes the deferral invisible.** | D1 puts the boundary below the `runnable` gate. The perf test asserts the deferred chunk's absence explicitly, so a regression here fails loudly rather than reading as a modest improvement. |
| **The idle prefetch lands inside the measured window** on a slow pipe, eating the gain. | The prefetch is scheduled on idle after mount, i.e. after interactive. The perf test's explicit absence assertion is the check; if it fires, the trigger moves to the toggle's press-in and FR-004 is amended. |
| **A hidden second importer of `@copilotkit/react-native`** keeps the polyfills in the entry chunk. | The budget gate's zero-modules assertion names the packages, so a stray root import fails the gate with the package named rather than as an opaque size regression. |
| **Native regression** — the polyfills are genuinely needed on Android. | Nothing about the native polyfill path changes: `assistant-polyfills.ts` is untouched and no platform-specific file is introduced. The Maestro agent flows cover the native assistant. |
| **`Intl` formatting drift** between the CI container's ICU data and the dev container's. | The moved unit tests assert exact strings and run in both places; a drift fails them. Node 24 ships full ICU. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| The constitution's "no page shall exceed a 2-second time-to-interactive on simulated 3G" is not met after this feature (~35 s of transfer for the entry chunk alone). **Resolved as an accepted exception at constitution v2.5.0** (item #565), granted on this feature's measured evidence — not carried as an open deviation. | The residue is `expo-router` (427 KB), `react-native-web` (276 KB), `react-dom` (175 KB) and `@tamagui/web` (120 KB) — the cost of rendering any route at all in this stack. Meeting 2 s would mean replacing the rendering stack, which is neither what item #558 asks for nor affordable here. The exception is **bounded** by the committed entry-chunk budget, so it cannot quietly widen, and it covers framework weight only — the same principle's lazy-loading clause is in force and enforced. | Route-level splitting was measured at a ~68 KB ceiling (6% of the bundle is app code) and cannot close the gap. Deferring framework code is not possible — it is needed for first paint. Leaving the deviation merely "documented" was rejected too: a MUST with no resolution is how a gap becomes permanent, so it is either closed or formally excepted with a ceiling. It is now the latter. |
