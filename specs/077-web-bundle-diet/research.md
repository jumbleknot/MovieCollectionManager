# Phase 0 research — Web bundle diet

Everything below was measured on `origin/main` @ `47b7c6c1` in the dev container on
2026-09-25. Each finding names the command, so it can be re-derived rather than trusted.

## Method

```bash
cd frontend/mcm-app
npx expo export --platform web --source-maps --output-dir /tmp/dist-baseline
ls -l /tmp/dist-baseline/client/_expo/static/js/web/       # chunk sizes
```

Bundle bytes are attributed to source files by decoding the emitted source map's `mappings`:
for each generated line, the span from one segment's column to the next belongs to that
segment's source. Summing spans per source, then grouping by npm package, gives the tables
below. The attribution accounts for 3,952 KB of the 4,177 KB file — the ~5% remainder is
Metro's own module wrappers and runtime, which map to no source. The helper is in
[quickstart.md](./quickstart.md) so any reviewer can reproduce it.

**Why attribution rather than a bundle visualiser**: `expo export` emits a plain Metro bundle
with no stats JSON, and the packaged analysers for Metro all wanted a webpack-shaped input.
Decoding the map was cheaper than adapting one, and it produces the exact quantity the
acceptance criteria are written in — bytes of the shipped chunk.

## R1 — The baseline, and two corrections to item #558

**4,283,369 bytes, one chunk.** No code splitting: `expo-router`'s `require.context` over
`src/app` pulls every route into the entry graph, and nothing in the app uses a dynamic import.

Two of the item's numbers do not survive re-measurement:

- **Item #558 records 076 as +247,100 bytes (+5.8%). Merged 076 costs +6,181 bytes.** The
  large figure was taken on the 076 branch before commit `39ec9640` ("keep test files out of
  the Expo Router tree, and guard it"). Test files inside `src/app` were being swept into the
  route tree by `require.context`. The item's "one ordinary feature eats the headroom" framing
  was substantially that leak, and it is already fixed.
- **The item names route-level splitting as the remedy.** Attribution shows all application
  code — every route, screen and the whole `@mcm/design-system` — is **259 KB of 4,283 KB
  (6.0%)**; the settings/backups/agent screens total **68 KB (1.6%)**. Route splitting cannot
  produce the required headroom. The single-chunk observation is right; the proposed mechanism
  is not.

Largest single application file: `src/components/movie-form.tsx` at 16 KB.

## R2 — REJECTED: a web-only polyfill variant

`src/assistant-polyfills.ts` requires `@copilotkit/react-native/polyfills` and
`.../polyfills/crypto`. Each polyfill guards at runtime — `if (typeof g.TextEncoder === "undefined")` —
so on web none of them execute. The `require` is static, so `text-encoding` (535 KB) and
`web-streams-polyfill` (124 KB) are bundled anyway.

An `assistant-polyfills.web.ts` that skipped both requires **resolved correctly** and saved
**69,207 bytes** — `web-streams-polyfill` left, `text-encoding` stayed.

Cause: `@copilotkit/react-native/dist/headless.mjs` line 1 is

```js
import "./polyfills.mjs";
```

a side-effect import inside the package's **own entry point**. `dist/index.mjs` imports from
`headless.mjs`, so importing anything from `@copilotkit/react-native` — `CopilotKitProvider`,
`useAgent` — pulls the whole polyfill barrel. No application-level change can prevent this.

### R2 CORRECTION — the conclusion above was wrong, and so was the measurement behind it

The original text concluded: *"deferring the assistant runtime removes them from the entry chunk
anyway, with no resolver hack to maintain."* **That is false, and it was believed on a contaminated
measurement.**

`src/app/_layout.tsx` — the ROOT layout — imports `@/assistant-polyfills` eagerly. The polyfill graph
is therefore reachable without the assistant panel ever loading, so deferring the panel cannot remove
it. Measured after implementing the boundary alone:

| | Entry chunk | `text-encoding` in entry |
|---|---:|---:|
| Boundary alone | 2,379,727 B | **535 KB, present** |
| Boundary + the platform split below | **1,762,630 B** | 0 |

**Why the original probe said otherwise.** Probe 1 created `src/assistant-polyfills.web.ts`. Probe 2
was run *without deleting it*, so probe 2 measured **both** changes and its 1,831,422 B entry chunk
was attributed entirely to the boundary. Both files were removed together at the end, which is why
the mistake was invisible until the real implementation reproduced neither number. The lesson is
narrow and mechanical: a probe that changes one thing must be run from a tree that contains only that
thing, and a second probe on top of a first is measuring their sum.

**The actual fix** is a platform split, which the constitution's file convention already prescribes:
the unsuffixed `assistant-polyfills.ts` is the WEB version (no CopilotKit polyfill requires), and
`assistant-polyfills.native.ts` carries the React Native behaviour unchanged. That is cheaper and
more legible than the Metro `resolveRequest` shim considered here (the pattern used for
`@segment/analytics-node`), which remains available should a non-assistant importer ever appear.

Incidental false lead, recorded so it is not re-investigated: `@bufbuild/protobuf` appears to
require `text-encoding`, but it requires its own `./text-encoding.js`.

## R3 — CONFIRMED: the dynamic-import boundary produces a real chunk

A throwaway probe moved `AssistantProvider` + `AssistantDock` behind
`React.lazy(() => import(...))` in `(app)/_layout.tsx` and re-exported:

| Artifact | Baseline | Probe (see the correction in R2) | Δ |
|---|---:|---:|---:|
| `entry-*.js` | 4,283,369 | 1,831,422 | −2,451,947 (−57.2%) |
| `assistant-runtime-*.js` | — | 2,385,019 | deferred |

> **These probe figures conflate two changes** — the boundary *and* probe 1's web-only polyfill
> variant, which was still in the tree. See the R2 correction. The boundary alone yields 2,379,727 B.
> The implemented result, with both changes, is **1,762,630 B (−58.8%)** — recorded in R6.

Export exited 0 with no resolution errors. Expo enables `splitChunks` for web export by
default (`@expo/cli/build/src/export/exportApp.js`, `splitChunks: !env.EXPO_NO_BUNDLE_SPLITTING && … || platform === 'web'`),
and it emits a chunk per dynamic-import boundary.

Module counts in the reduced entry chunk: `text-encoding` **0**, `zod` **0**, `graphql` **0**.
Remaining composition is `expo-router` 427 KB, `react-native-web` 276 KB, `react-dom` 175 KB,
`@tamagui/web` 120 KB, `luxon` 70 KB, `axios` 65 KB.

**What the probe did NOT establish**, and what therefore stays a verification obligation:
hydration correctness across the boundary in the running server-rendered app. The export
succeeding is not the app working. The probe was reverted; no probe code is part of this feature.

**A trap this probe would have walked into if used as the design.** The boundary was placed at
`AuthedAssistant`, which mounts whenever the user's config is `runnable` — and the E2E user's
config **is** seeded runnable (`tests/e2e/web/setup/agent-config-seed.ts`). The chunk would
therefore be fetched at mount, during the measured window, in parallel with the home screen's
own bytes on a serialized Slow-3G pipe. The byte total would barely move and the change would
read as ineffective. The boundary must sit below the `runnable` gate, at the panel. This is why
the plan's D1 exists and why the perf test asserts the deferred chunk's **absence** rather than
just a smaller total.

## R4 — CONFIRMED: `Intl` replaces `luxon` in the leaked module without output drift

`src/bff-server/backup-run-summary.ts` is imported by `src/components/backups/run-history.tsx`,
a client component — so `luxon` (70 KB) ships to every user on every route. The module is pure
formatting; its own header states every input is an argument and it reads no clock or locale.
It is a Utils-Layer module filed under the BFF layer.

Its only `luxon` use is `formatNextRun`, needing a named-IANA-zone format. Compared directly:

| Input | Zone | Luxon `d LLL yyyy, HH:mm` | `Intl.DateTimeFormat('en-GB', …)` |
|---|---|---|---|
| 2026-01-03T03:00:00Z | Europe/London | `3 Jan 2026, 03:00` | `3 Jan 2026, 03:00` |
| 2026-07-03T03:00:00Z | Europe/London (DST) | `3 Jul 2026, 04:00` | `3 Jul 2026, 04:00` |
| 2026-12-25T23:05:00Z | America/New_York | `25 Dec 2026, 18:05` | `25 Dec 2026, 18:05` |
| 2026-03-09T10:30:00Z | Asia/Kolkata (half-hour) | `9 Mar 2026, 16:00` | `9 Mar 2026, 16:00` |
| 2026-11-01T00:00:00Z | Pacific/Auckland | `1 Nov 2026, 13:00` | `1 Nov 2026, 13:00` |

All match. Options: `{ timeZone, day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }`.

**One behavioural difference to handle.** On an unknown time zone Luxon returns an invalid
`DateTime` (caught by the existing `if (!dt.isValid) return 'Not scheduled'`), whereas
`Intl.DateTimeFormat` throws `RangeError`. The replacement must catch and return the same
`'Not scheduled'`, or an unknown zone turns a formatted string into an unhandled exception in
a settings screen. The existing unit tests cover the invalid cases and fail RED against a
replacement that omits the guard.

`luxon` remains a dependency: `bff-server/backup-schedule.ts` uses it server-side. Only its
presence in the client graph ends.

## R5 — Where the guards belong

Every gate in this repository is a `scripts/check-*.mjs` with a `--selftest` mode proving its
fail and clean paths, wired into `guardrails.yml`'s `naming` job via
`bash scripts/ci-log-step.sh <id> node scripts/check-*.mjs`. Scripts parse arguments through
`scripts/lib/argv-contract.mjs`, which **rejects** unknown flags rather than leaving the
default action running.

- The server-import guard is **static** — no build — so it joins the `naming` job directly.
- The budget gate needs the export artifact, so it becomes the nx target `bundle-budget` with
  `dependsOn: ["export-server"]` and joins the `affected` job's target list. That keeps it
  inside nx's cache and its affected graph rather than adding an unconditional CI build, and
  it matches the repository's "Nx as the universal task runner" invariant.


## R6 — The implemented result

Measured from the real implementation (not a probe), `npx expo export --platform web`:

| Artifact | Bytes |
|---|---:|
| `entry-*.js` | **1,762,630** |
| `assistant-panel-*.js` (deferred) | 2,384,406 |

Against the 4,283,369-byte baseline: **−2,520,739 (−58.8%)**.

Entry-chunk module counts for every package this feature set out to defer — each **0**:
`text-encoding`, `web-streams-polyfill`, `zod`, `graphql`, `@copilotkit/*`, `@ag-ui/*`, `rxjs`,
`@bufbuild/protobuf`, `luxon`.

One `src/bff-server/` module remains in the entry chunk by design: `api-client.ts`, the browser's
axios transport to the BFF, which declares itself `@client-safe` in the module. Relocating it out of
that directory is item #566.

What is left is framework code that renders any route: `expo-router` 427 KB, `react-native-web`
276 KB, `react-dom` 175 KB, `@tamagui/web` 120 KB, `axios` 65 KB, `react-native-svg` 46 KB. The
largest single application file is `src/components/movie-form.tsx` at 16 KB.

## R7 — `React.lazy` cannot satisfy FR-006

The plan's first design used `React.lazy` + `Suspense`. Measured with a throwaway probe: `lazy` calls
its factory **exactly once** and caches a rejection on the lazy object for the life of the page — the
factory is not re-invoked even on a fresh mount after an error boundary resets (`factory calls after
rejection + retry attempt: 1`).

So a failed chunk fetch would disable the assistant until a full page reload, no matter how
retry-capable the loader beneath it is. FR-006 ("remains openable on a subsequent attempt") is
unsatisfiable through `React.lazy` with a module-scope lazy component. The dock therefore holds the
loaded component in state — about twelve lines — and `loadAssistantRuntime` clears its cache on
rejection so the retry actually re-fetches.

This is worth recording because `React.lazy` is the idiomatic answer and a reviewer will ask why it
was not used. The answer is a measurement, not a preference.
