# Feature Specification: Web bundle diet — take the assistant runtime off the cold-load path

**Feature Branch**: `077-web-bundle-diet`

**Created**: 2026-09-25

**Status**: Draft

**Input**: Backlog item #558 — "Web client ships as one ~4.3 MB chunk — cold-TTI headroom is now smaller than a single feature". Re-scoped after measurement (see Measured Baseline); the item's acceptance criteria are amended in the tracker to match.

## Measured Baseline *(evidence for every number in this spec)*

Measured 2026-09-25 on `origin/main` @ `47b7c6c1` (which includes feature 076), via
`npx expo export --platform web --source-maps`, with bundle bytes attributed to source
files by decoding the emitted source map's mappings.

**The web client ships as a single chunk of 4,283,369 bytes.**

Two corrections to item #558's premise, both material:

1. **The item's 076 delta is stale.** It records 076 as +247,100 bytes (+5.8%). Merged 076
   costs **+6,181 bytes** over the previous main. The large delta was measured before
   commit `39ec9640` ("keep test files out of the Expo Router tree, and guard it") landed —
   test files were being pulled into the route tree. The single-chunk problem is real; the
   "one ordinary feature exhausts the headroom" framing was substantially that leak, and it
   is already fixed.

2. **Route-level splitting cannot solve this.** The item names route splitting as the
   remedy. Attribution shows the application's own code — every route, every screen, and
   the whole `@mcm/design-system` — is **259 KB of 4,283 KB (6.0%)**. The settings,
   backups and agent screens that `/home` supposedly should not download total **68 KB
   (1.6%)**. Route splitting cannot deliver the required headroom; it is not the mechanism.

### Where the bytes are

| Bytes | Share | Package | Reachable from |
|------:|------:|---|---|
| 640 KB | 16.2% | `zod` | assistant runtime |
| 535 KB | 13.5% | `text-encoding` | assistant runtime (see below) |
| 427 KB | 10.8% | `expo-router` | root — irreducible |
| 276 KB | 7.0% | `react-native-web` | root — irreducible |
| 246 KB | 6.2% | `graphql` | assistant runtime |
| 175 KB | 4.4% | `react-dom` | root — irreducible |
| 124 KB | 3.1% | `web-streams-polyfill` | assistant runtime |
| 234 KB | 5.9% | `@copilotkit/*` | assistant runtime |
| 144 KB | 3.6% | `@ag-ui/*` | assistant runtime |
| 113 KB | 2.9% | `rxjs` | assistant runtime |
| 120 KB | 3.0% | `@tamagui/web` | root — irreducible |
| **70 KB** | **1.8%** | **`luxon`** | **a server-only module, leaking into the client** |

### Why the polyfills cannot be fixed at application level

`src/assistant-polyfills.ts` documents the CopilotKit React Native polyfills as
"No-ops on web". The *behaviour* no-ops — each polyfill guards at runtime
(`if (typeof g.TextEncoder === "undefined")`) — but the `require` is **static**, so Metro
bundles the libraries regardless.

Removing those requires on web does not help. `@copilotkit/react-native/dist/headless.mjs`
line 1 is `import "./polyfills.mjs"` — a side-effect import inside the package's own entry
point. Any import of `@copilotkit/react-native`, including `CopilotKitProvider`, drags in the
whole polyfill barrel. Measured: a web-only variant of `assistant-polyfills` that skips both
requires saved **69,207 bytes** and left `text-encoding` (535 KB) fully present.

The polyfills therefore cannot be removed in isolation — but they **leave with the assistant
runtime**, because that is the only thing that imports `@copilotkit/react-native`. This is the
central reason the chosen mechanism is deferral rather than shimming.

### Measured effect of the chosen mechanism

A throwaway probe placed the assistant runtime behind one dynamic-import boundary and
re-exported:

| Artifact | Baseline | With the boundary | Δ |
|---|---:|---:|---:|
| `entry-*.js` | 4,283,369 | **1,831,422** | **−2,451,947 (−57.2%)** |
| `assistant-*.js` (deferred) | — | 2,385,019 | — |

`text-encoding`, `zod` and `graphql` are each at **zero modules** in the reduced entry chunk.
What remains is dominated by framework code that cannot be deferred (`expo-router` 427 KB,
`react-native-web` 276 KB, `react-dom` 175 KB, `@tamagui/web` 120 KB) — plus `luxon` at
70 KB, now 4.2% of the entry chunk and its largest non-framework item.

The probe establishes that Expo's `splitChunks` emits a real second chunk for a dynamic-import
boundary in a `web.output: "server"` export, and that the export succeeds. It does **not**
establish that hydration is correct across that boundary, nor that a running app behaves; both
are verification obligations of this feature, not assumptions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A first visit to /home stops downloading the assistant (Priority: P1)

A signed-in user opens `/home` on a slow connection. The collection list becomes interactive
without the browser having downloaded the conversational assistant's runtime — the model
client, its schema validator, its GraphQL client and its React Native polyfills. The assistant
toggle is still present and still labelled; pressing it opens the assistant as it does today.

**Why this priority**: This is the entire cost. 57% of the bundle is assistant runtime that a
user who never opens the assistant never needs, and a user who does need it does not need it
*before the home screen paints*.

**Independent Test**: Export the web bundle and assert the entry chunk no longer contains the
assistant runtime's packages; then drive `/home` under the Slow-3G profile and assert the home
screen reaches interactive having transferred materially fewer JS bytes, with the assistant
still openable afterwards.

**Acceptance Scenarios**:

1. **Given** a signed-in user whose per-user assistant config is runnable, **When** they load
   `/home` cold under a Slow-3G network profile, **Then** the home screen reaches interactive,
   and the JS transferred up to that moment excludes the assistant runtime chunk.
2. **Given** that same user on `/home`, **When** they press the assistant toggle, **Then** the
   assistant panel opens and accepts input, exactly as before this change.
3. **Given** a signed-in user whose assistant config is **not** runnable, **When** they load
   any authenticated route, **Then** no assistant toggle renders and the assistant runtime
   chunk is never requested.
4. **Given** a signed-in user idle on `/home` after it has become interactive, **When** the
   browser reports idle time, **Then** the assistant runtime is fetched in the background, so
   that a later first press of the toggle opens without a download wait.
5. **Given** a user who presses the assistant toggle before the background fetch has completed,
   **When** the panel is opening, **Then** the panel shows a loading state and then opens —
   it never renders a blank panel and never drops the press.

---

### User Story 2 - Server-only code stops shipping to the browser (Priority: P2)

No module that exists to run inside the BFF is delivered to the client. Today a backups
component imports a server-side summary helper, which brings a date library into every user's
browser on every route.

**Why this priority**: It is 70 KB of the reduced entry chunk — its largest non-framework
item — and it is a correctness problem independent of size: the constitution requires the
BFF layer to "run server-side and never be included client-side". It is also cheap. It ranks
below US1 because US1 is the order-of-magnitude win.

**Independent Test**: Export the web bundle and assert no `src/bff-server/**` module and no
server-only dependency appears in any client chunk.

**Acceptance Scenarios**:

1. **Given** the web client bundle, **When** its modules are enumerated, **Then** no module
   under `src/bff-server/` is present in any client chunk.
2. **Given** the backups settings screen, **When** a user views run history, **Then** run
   summaries and their timestamps render exactly as they do today.
3. **Given** a new client-side import of a `src/bff-server/**` module, **When** the repository's
   checks run, **Then** they fail and name the importing file.

---

### User Story 3 - The headroom cannot silently erode again (Priority: P3)

The size of the cold-load path is measured on every change, against a stated budget, and a
change that consumes the headroom fails loudly and says by how much — rather than surfacing
later as an unrelated-looking timeout in a performance test.

**Why this priority**: Without it this feature buys headroom that the next few features spend
without anyone noticing, which is exactly the history recorded in item #558. It is P3 because
the headroom must exist before a budget can guard it.

**Independent Test**: Raise the budget's input above the ceiling and confirm the check fails
with the measured and permitted numbers named; restore it and confirm it passes.

**Acceptance Scenarios**:

1. **Given** the exported web bundle, **When** the budget check runs, **Then** it reports the
   entry chunk's size and passes only if it is within the stated budget.
2. **Given** an entry chunk that exceeds the budget, **When** the check runs, **Then** it fails
   naming the measured size, the budget, and the overage.
3. **Given** the performance test, **When** it runs, **Then** it still attaches its
   `perf-metrics` payload, and its recorded cold time-to-interactive for `/home` leaves at
   least 50% headroom against its own ceiling.

---

### Edge Cases

- **The deferred chunk fails to load** (network drop, cache miss, deploy mid-session): the
  assistant must surface a recoverable failure and remain re-openable, never a blank panel or
  a crashed route. The rest of the application is unaffected — the assistant is additive.
- **Server-side rendering and hydration across the boundary**: the authenticated layout is
  server-rendered. The deferred subtree must not cause a hydration mismatch, and must not
  render assistant markup on the server that the client then cannot match.
- **A user presses the toggle repeatedly while the chunk loads**: exactly one fetch, and the
  panel opens once.
- **Mobile (Android) is not web**: on native, the polyfills are required and there is no
  chunk-splitting benefit. Native behaviour and native bundle contents must not regress.
- **The E2E user has a runnable assistant config.** A boundary that loads at mount rather than
  on demand would still fetch the deferred chunk during the measured window and show no
  improvement. The measurement is only meaningful if the fetch is genuinely deferred past
  interactive.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The web client MUST deliver the conversational assistant's runtime in a separate
  chunk from the entry chunk.
- **FR-002**: Loading any authenticated route MUST NOT require the assistant runtime chunk in
  order to become interactive.
- **FR-003**: The assistant toggle MUST remain in the entry chunk, so that its presence,
  label and position on first paint are unchanged.
- **FR-004**: The assistant runtime chunk MUST be requested when either the browser reports
  idle time after the route is interactive, or the user acts to open the assistant —
  whichever happens first — and MUST be requested at most once per page session.
- **FR-005**: While the assistant runtime is loading in response to a user opening it, the
  assistant MUST show a loading state, and MUST then open without requiring a second press.
- **FR-006**: If the assistant runtime chunk fails to load, the assistant MUST surface a
  recoverable error and MUST remain openable on a subsequent attempt; the rest of the
  application MUST continue to function.
- **FR-007**: A user whose per-user assistant config is not runnable MUST NOT cause the
  assistant runtime chunk to be requested.
- **FR-008**: Server-rendering and client hydration of the authenticated layout MUST remain
  correct with the assistant runtime deferred — no hydration mismatch, and no assistant
  markup rendered server-side that the client cannot match.
- **FR-009**: No module under `src/bff-server/` MUST appear in any client chunk.
- **FR-010**: The backups run-history view MUST render run summaries and timestamps
  identically to its current behaviour.
- **FR-011**: The repository's checks MUST fail, naming the importing file, when client-side
  code imports a `src/bff-server/**` module.
- **FR-012**: The repository MUST enforce a stated maximum size for the web entry chunk, and
  that check MUST report the measured size, the budget, and any overage.
- **FR-013**: The Android/native bundle's contents and behaviour MUST NOT regress: the React
  Native polyfills MUST still load on native.
- **FR-014**: The performance test MUST continue to attach its `perf-metrics` payload, and
  MUST assert the cold time-to-interactive for `/home` against a ceiling that leaves at least
  50% headroom.

### Key Entities

- **Entry chunk**: the JavaScript the browser must download and execute before any route can
  become interactive.
- **Assistant runtime chunk**: the deferred JavaScript containing the assistant's model
  client, schema validation, transport, generative-UI tool renderers, and the React Native
  polyfills that its packages import as a side effect.
- **Entry-chunk budget**: the stated maximum size of the entry chunk, and the artifact that
  makes erosion of the headroom a loud failure.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The web entry chunk is at most **2,400,000 bytes**, down from 4,283,369 — a
  reduction of at least 44%. (The measured probe reached 1,831,422; the budget is set above
  the measured result to leave the implementation room without inviting drift.)
- **SC-002**: Cold time-to-interactive for `/home` under the Slow-3G profile is at most
  **75,000 ms** — at least 50% headroom against the performance test's 150,000 ms ceiling,
  against under 5% today.
- **SC-003**: The JS transferred before `/home` becomes interactive excludes the assistant
  runtime chunk entirely.
- **SC-004**: `zod`, `graphql`, `text-encoding` and `web-streams-polyfill` contribute zero
  modules to the entry chunk.
- **SC-005**: No module under `src/bff-server/` and no server-only dependency appears in any
  client chunk.
- **SC-006**: A change that pushes the entry chunk past its budget fails a repository check
  that names the measured size, the budget and the overage.
- **SC-007**: Every web and mobile end-to-end suite that passed before this change still
  passes, including every assistant flow.

## Assumptions

- **The remaining entry chunk is treated as irreducible for this feature.** `expo-router`,
  `react-native-web`, `react-dom` and `@tamagui/web` total ~1,000 KB and are needed to render
  any route. Reducing them is a separate concern and is out of scope; SC-001 is set
  accordingly and the constitution's 2-second 3G budget remains unmet after this feature.
  That residual deviation is tracked as **item #565**, which owns the decision between continuing
  to close it and amending the principle to a target this stack can meet.
- **Route-level splitting is out of scope.** Measurement puts its ceiling at ~68 KB. If it is
  wanted later for its own sake, it is a separate item.
- **The assistant remains additive.** Deferring its delivery changes when its code arrives,
  never whether the assistant works or what it can do.
- **A brief first-open wait on a slow connection is acceptable**, and is mitigated by the idle
  prefetch. The assistant is opt-in and the toggle is a deliberate act, so a user who opens it
  has already chosen to wait for something.
- **The end-to-end test user's assistant config stays runnable.** The existing seed is not
  changed; the design must produce its benefit *with* a runnable config, which is the harder
  case and the real one.
- **Platform-specific files follow the constitution's convention** — the unsuffixed file is
  the web default and native variants carry `.native`, not the reverse.
- **Bundle size is measured as bytes on disk of the exported chunk**, the same quantity item
  #558 and this spec's baseline use, so every number here stays comparable.
