# mcm-app (Movie Collection Manager frontend)

React Native Expo app targeting **web** and **Android**, with the BFF running
server-side inside Expo Router API routes. See the repo-root
[CLAUDE.md](../../CLAUDE.md) for the full architecture, commands, and dev-infra
runbook; this file covers the **UI / design system** layer added in feature 015.

## Design system & theming (feature 015)

The UI is built on the **MCM Cinema design system** — a Tamagui-based component
+ token library shipped as the workspace package
[`@mcm/design-system`](../../packages/design-system) (dark-first, MD3-derived,
Outfit headings / Inter body, Cinematic-Blue primary, restrained orange accent).

### How it is wired

- **`tamagui.config.ts`** re-exports the design-system config. The app is wrapped
  in `<TamaguiProvider>` in [src/app/_layout.tsx](src/app/_layout.tsx).
- **Runtime-only Tamagui, again** (feature 081 US10). Tamagui 3 removed the Babel plugin the
  app used since feature 015. Its replacement, `@tamagui/metro-plugin` 3.0.x, was measured to
  lower some web modules to static class names *without emitting their CSS* (lost gaps, widths,
  radii) while saving no bytes (entry chunk 1,881,353 B with it, 1,881,066 B without), and the dev
  server serves the app without it. So no Tamagui compiler is wired; see specs/081 research
  "US10" before re-adding one.
- **Tamagui is pinned to ONE exact 3.x version** across both manifests
  (`@tamagui/core`, `@tamagui/stacks`, `@tamagui/shorthands`),
  grouped as one Renovate `tamagui` branch, and guarded by
  `scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`. Never add a range.
- **Tamagui 3 spelling.** Token and theme names have no `$` (`fontFamily="body"`,
  `outlineColor="primary"`); a state is a clause on the property it modifies
  (`opacity="hover:0.92 press:0.88"`, or `backgroundColor={{ default: a, hover: b }}`
  for a computed value) — `hoverStyle` / `pressStyle` / `focusVisibleStyle` are
  gone and an unconverted one is silently ignored. A numeric `lineHeight` on a
  Tamagui component is a **ratio**; write pixels as `"20px"`.
- **Fonts** (Outfit/Inter via `@expo-google-fonts/*`) load non-blocking in
  `_layout.tsx`; the Tamagui families fall back to `system-ui, sans-serif` so a
  font-load failure never hangs the app or flashes unstyled text (FR-017).

### Dark / light theme

- **Dark is the default.** The device-local preference is held by
  [`use-theme`](src/hooks/use-theme.tsx) and persisted under the AsyncStorage key
  **`mcm.theme`** (web: `localStorage`; native: app storage). No backend/profile
  involvement — UI state only.
- The **theme toggle** lives in the app bar
  ([navigation-bar.tsx](src/components/navigation-bar.tsx), `testID="theme-toggle"`)
  on both web and native, so it is reachable on every authenticated screen. It
  calls `useTheme().toggle()`; the `TamaguiProvider` theme follows the choice.

### Writing / re-skinning a component

- Style with **theme tokens**: `const theme = useTheme()` then `theme.<role>?.val`
  (Tamagui's `useTheme` values are optionally typed — always `?.val`).
- Import leanly: stacks from `@tamagui/stacks`, `useTheme` from `@tamagui/core`,
  `Text` and DS components from `@mcm/design-system` — **never** `from 'tamagui'`, and
  never `Text` from `@tamagui/core`: the design system's `Text` carries the body-font /
  `onBackground` defaults that Tamagui 2 applied from config (`text-defaults.test.tsx`
  fails on a core `Text` import).
- **Preserve every `testID`** — the stable selectors are a contract
  (`specs/015-apply-design-system/contracts/selectors-baseline.txt`; FR-018).
- Unit tests that render a themed component must import `render` from
  [`@/test-support/render`](src/test-support/render.tsx) (it wraps `TamaguiProvider`)
  or `useTheme()` throws.
- **Flex layouts that must align across rows** (e.g. the web movie data table):
  Tamagui's `flex={N}` prop sets only `flex-grow` and leaves `flex-basis: auto`,
  so cell widths track their content and columns drift. Use a true proportional
  item — `flexGrow={N} flexShrink={1} flexBasis={0} minWidth={0}` — on every
  aligned cell (see [movie-list.tsx](src/components/movie-list.tsx) /
  [movie-list-item.tsx](src/components/movie-list-item.tsx)).

## Docked panels: collection view options and the assistant (feature 098)

- **The collection screen's column, sort and filter controls are docked.** They sit behind one
  compact bar, `ViewOptionsDock` (`view-options-toggle`, showing the active-filter count), and appear
  only while its drop-down `ViewOptionsPanel` (`view-options-panel`) is open. The panel overlays the
  count row and the list from their container's top edge, so opening or closing it never moves or
  re-scrolls the list. It starts docked on every visit. See
  [view-options-dock.tsx](src/components/view-options-dock.tsx).
  **A test that touches a column, sort or filter control must open the panel first**:
  - web: `openViewOptions(page)` in `tests/e2e/web/movies.spec.ts`;
  - Maestro: `tapOn: id: "view-options-toggle"`.

  The open panel covers the list, so close it (`view-options-close`) before clicking a movie row.
- **One panel open at a time.** `OpenPanelProvider` ([use-open-panel.tsx](src/hooks/use-open-panel.tsx))
  is mounted in `src/app/(app)/_layout.tsx` around the stack and the assistant dock. Opening the view
  options re-docks the assistant, and the reverse. That module is in the web entry chunk, so it must
  import nothing from `@copilotkit/*`, `@ag-ui/*` or `use-assistant`: a guard test and
  `bundle-budget` both fail if it does.
- **The assistant dock follows the on-screen keyboard.** On SDK 58 / RN 0.88, Android is
  edge-to-edge, so the window is not resized for the IME, and a view pinned to the bottom edge sits
  behind the keyboard. The dock therefore adds `useKeyboardInset()`
  ([use-keyboard-inset.ts](src/hooks/use-keyboard-inset.ts)) to its `bottom`. It also caps the
  deferred panel's height to what fits below the top safe inset, and passes `{ height, keyboardInset }`
  to the panel. The props type lives in `assistant-runtime-loader.ts`, so nothing eager imports the
  panel. On web the inset is always 0.
- **On web, Tamagui drops `accessibilityRole`, `accessibilityState` and `accessible`.** A Tamagui
  control therefore needs an explicit `role`, `aria-*` state and `tabIndex`, as the DS `Button` and
  `Chip` now set; otherwise it renders as a bare `<div>` that the keyboard cannot reach. On native,
  RN folds `aria-*` into `accessibilityState`, so unit tests assert `accessibilityState`, and the web
  DOM is proven by the axe scan in `tests/e2e/web/a11y.spec.ts`.

## Design-system compliance & sanctioned deviations (feature 017)

A static Jest scan — [`tests/unit/design-system-compliance.test.ts`](tests/unit/design-system-compliance.test.ts)
— enforces that the app uses the design system intentionally. It runs in the normal
`pnpm nx test mcm-app` suite (one `it()` per rule):

| Rule | Enforces |
|---|---|
| **R1** | No hardcoded colour (`#hex` / `rgb()` / `rgba()` / `hsl()`) — every colour is a theme token. |
| **R2** | Every numeric `fontSize` is on the MD3 scale `{11,12,14,16,18,22,24,28,32,36,45,57}`. |
| **R3** | Every react-native `<Text>` StyleSheet style that sets size/weight declares an Outfit/Inter family. |
| **R4** | No bespoke `TouchableOpacity`/`Pressable` button — use DS `Button`/`IconButton`/`Chip`. |
| **R5** | No duplicated private "pill" button-style block across agent components. |
| **R6** | No synthesized font weight (`fontWeight > 700` — no Outfit/Inter face is loaded above 700). |
| **R7** | No re-invented DS surface (raw `<Modal>` — use the DS `Dialog`; full-screen form modals exempt). |

**Success colour role.** Positive/verified state uses the theme-split `success` role
(`theme.success?.val`; verified banners use `successContainer`/`onSuccessContainer`) — never a
green literal. The role meets WCAG AA in both themes (guarded by the DS
`components/success-token.test.tsx`).

**Sanctioned deviations** (a control that intentionally departs from the DS) carry a
`// ds-exempt(R<n>): <reason>` comment at the call site AND an entry in
[`specs/017-design-system-consistency/contracts/sanctioned-deviations.md`](../../specs/017-design-system-consistency/contracts/sanctioned-deviations.md)
— the single source of truth. Current sanctioned set: `NoAutoFillInput` (password-manager
suppression), `movie-form` radio selectors (native picker crashes on Android Fabric), whole-card/row
press wrappers, the bottom-LEFT assistant-dock toggle, removable list chips, the sparing orange
(`tertiary`) accents, and the web-table-vs-native-card density split.

## What the container healthcheck proves

Every BFF service in `infrastructure-as-code/docker/bff/compose{,.prod}.yaml` probes an API route
(`/bff-api/auth/init`) **and** a page (`/login`), joined by `&&`. Both are needed because they come from
different parts of the export: during the SDK 58 spike every page answered 404 while API routes kept
answering, and an API-only probe reported healthy throughout.
`scripts/__tests__/bff-healthcheck-pages.guard.test.mjs` fails if a service loses either probe.

## Failures that look healthy, and what catches each (feature 087)

Each of these looked fine to every existing check during the SDK 58 spike, so each now has its own gate:

| Failure | Gate | Its message names |
|---|---|---|
| Two copies of the styling library, which is a blank page | `scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`, counting `pnpm-lock.yaml` snapshot keys | Both keys, and `pnpm dedupe` |
| A split bundle that fits chunk by chunk but not as a whole | `pnpm nx bundle-budget mcm-app`, measuring every script the worst page loads | The page, bytes, overage and each script |
| An inline script the CSP will block | The same gate, reading `INLINE_SCRIPT_HASHES` from `web-security-headers.js`, which the CSP is also built from | The page and the `'sha256-...'` value. That value is not permission to add it |
| A page the browser refuses or crashes on | `tests/e2e/web/page-security-policy-walk.spec.ts`, in the `lifecycle` project | Each violation's directive, blocked URI and source |
| A release APK that does not launch | `scripts/android-launch-smoke.sh` in `app-e2e`, reported as the commit status `app-ci / android-launch` | Which of launch, login screen and device log failed |

## Web output mode: prerendered pages plus API routes (SDK 58)

`app.json` sets `web.output` to `"static"` and the `expo-router` plugin to
`{ "apiRoutes": true, "asyncRoutes": { "web": false } }` (feature 087). Pages are rendered to HTML at
**build** time, and the 38 API routes, which are the BFF, still run in the same Node process behind
`server.js`. So `dist/server` holds both the page HTML and the route functions, as before.

- **Why not `"server"`:** on SDK 58 that value means per-request rendering, which is a different
  runtime from the one this app was built and tested on.
- **Why `asyncRoutes.web` is written out:** SDK 58's plugin with no options turns it **on**. It stays
  off until item #938 decides otherwise.
- **A page that throws while rendering fails `expo export`**, with `Failed to statically export
  route: <name>`. That is the intended guard, not a flaky build.

## What ships in the BFF image (and what fails the build)

The image carries the exported bundle plus **only the dependency closure `node server.js` can
reach** — `express`, `expo-server`, `openai` and what those pull in. Everything else
`pnpm deploy --prod` materializes is a dependency of the WEB BUNDLE, which Metro has already
compiled into `dist/`, so it is deleted in the build by
[`scripts/prune-bff-runtime-modules.mjs`](../../scripts/prune-bff-runtime-modules.mjs).

That script also runs as a **gate** in the builder stage. Expo Router's server output can name a
package with a bare string rather than an import — `@copilotkit/runtime` reaches its provider
adapters through `createRequire(globalThis.__ExpoImportMetaRegistry.url)` — and a closure walk
cannot see a string. So the build re-derives every such specifier from the freshly exported bundle
and **fails** if one appears that the script does not account for. If a dependency bump turns the
build red with *"the exported server bundle reaches for … bare specifier(s)"*, that is this gate:
decide whether the specifier resolves from `/app/runtime` (add it to `DYNAMIC_ROOTS`) or already
does not (record it as `unresolvable`). Do not delete the check — its whole purpose is to stop a
pruned package from becoming a 500 on one route in production.

## Web E2E note (Tamagui on this machine)

Metro's **dev** web bundler OOMs building the app + Tamagui locally, so web E2E
runs against the **dev BFF container** (production-mode `expo export`, which is
memory-bounded). Rebuild the image after every source change — the container
serves a prebuilt bundle, so a stale image silently tests old code:

```bash
pnpm nx docker-build mcm-app
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d --force-recreate mcm-bff-service-nonsecure
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
```

See CLAUDE.md → "Final local E2E runs against the BFF container" for the full
matrix (dev vs prod container, mobile deltas) and the Metro reset afterwards.

## Two standing constraints the backups feature ran into (feature 073)

Both are properties of *this* server that the next feature to need them will meet too, and
neither is obvious from the code that depends on it.

### The BFF's Mongo is a STANDALONE instance — there are no transactions

`mongo-client.ts` connects to a single mongod, not a replica set. MongoDB only offers
multi-document transactions on a replica set, so **nothing here can span two documents
atomically**. This is not a configuration oversight to route around; it is the shape of the
store.

What it cost feature 073: exactly-once scheduling could not be "claim the job and write the run
record in one transaction". It is instead a single `findOneAndUpdate` on the job document alone,
whose filter is due-and-enabled-and-not-already-claimed — correctness expressed entirely within
one document, with the run record written separately and deliberately allowed to lag. A Redis
lock sits in front of it as an optimisation, but its safety rests on a TTL, so it is explicitly
*not* the guarantee.

If you need atomicity across two collections here, you need a different design, not a
transaction.

### `server.js` runs OUTSIDE the Metro bundle — it cannot import `src/`

`server.js` is CommonJS. It `require`s `expo-server/adapter/express` and hands the built
`dist/server` to `createRequestHandler`. It **cannot** `require('./src/bff-server/…')`: those
modules exist only inside the bundle, compiled and `@/`-aliased by Metro.

What it cost feature 073: the BFF had no background-work mechanism at all before it
(`grep -rn setInterval src/` returned nothing), and a scheduled backup needs one. The timer
therefore lives in `server.js` and reaches the work through a **loopback HTTP call** to a
secret-guarded internal route, rather than calling a function. That seam is real rather than a
workaround — it keeps the tick equally callable by a cron sidecar if the timer ever moves out of
the app — but the reason it exists is this constraint.

Two consequences worth knowing before you add the second background job:

- **Nothing scheduled fires under `pnpm start`.** `server.js` does not run under Metro. In dev
  you call the route directly; that is also what makes the E2E deterministic.
- **Do not remove the `__ExpoImportMetaRegistry` seeding** at the top of `server.js`. It looks
  like dead defensive code and removing it reintroduces a silent production-only hang.

Operating detail for the scheduler itself is in
[docs/runbooks/backups.md](../../docs/runbooks/backups.md).

<!-- spec 081 US1 PR 1b (T010): this comment exists so a CI-actions PR touches the app/mobile paths-filter area and proves the gated jobs RUN. Safe to delete. -->
