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
- **Runtime-only Tamagui.** The Tamagui babel/metro compiler plugins are **not**
  installed — only the runtime. This keeps the (fragile, Windows) Android build,
  the `@segment` metro shim, and the Reanimated worklets babel plugin untouched.
  Bundle/TTI cost is accepted in exchange (measured in the feature-015 PR).
- **Pin Tamagui to v1 (`^1.144`).** The design system is authored against the
  Tamagui **v1** API; `expo install tamagui` pulls a breaking v2 by default. Keep
  the v1 pin on any future install. Migrating the DS to v2 is a separate effort.
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
- Import leanly: stacks from `@tamagui/stacks`, `Text`/`useTheme` from
  `@tamagui/core`, DS components from `@mcm/design-system` — **never** `from 'tamagui'`.
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

## What ships in the BFF image (and what fails the build)

The image carries the exported bundle plus **only the dependency closure `node server.js` can
reach** — `express`, `@expo/server`, `openai` and what those pull in. Everything else
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

`server.js` is CommonJS. It `require`s `@expo/server/adapter/express` and hands the built
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
