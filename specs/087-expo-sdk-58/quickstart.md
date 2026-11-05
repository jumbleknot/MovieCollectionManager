# Quickstart: Validating Expo SDK 58

Run these from the worktree. A worktree needs a real `CI=true pnpm install --frozen-lockfile` before any `pnpm nx` target
(about 4 minutes). A symlinked `node_modules` is not enough. Before believing a cached failure, re-run with
`--skip-nx-cache`.

Expected shapes are in the [contracts](./contracts/). Every result that a requirement asks to be quoted goes in `tasks.md`
with its run number.

## PR A: Hosting

```bash
pnpm nx test mcm-app -- tests/unit/bff-server-trust-proxy.test.ts tests/unit/bff-server-adapter.test.ts
node --test scripts/__tests__/prune-bff-runtime-modules.test.mjs scripts/__tests__/bff-healthcheck-pages.guard.test.mjs
pnpm nx docker-build mcm-app
```

| Scenario | Expected |
|---|---|
| Remove the wrapper in `server.js`, re-run the trust-proxy test | Fails on the `https` rows; restore |
| `grep -rn '@expo/server/adapter' frontend/mcm-app/server.js frontend/mcm-app/tests scripts/prune-bff-runtime-modules.mjs` | No matches |
| Real image with `htmlRoutes` emptied in a `dist` copy | `/login` 404, API 200, container `unhealthy` |
| CI web E2E on the dev container | Passes, zero unexpected skips (proves the image contains the adapter) |

**After deploy, operator:**

1. Sign in on production. Complete backup consent, confirming no `Invalid parameter: redirect_uri` appears and that it returns
   to the app.
2. Start account deletion up to the identity provider's sign-in. Do not confirm it.
3. Record both results.

## PR B: Gates

```bash
node scripts/check-web-bundle-budget.mjs --selftest
pnpm nx bundle-budget mcm-app
node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs
bash scripts/android-launch-smoke.sh --selftest
```

Introduce each defect, confirm it fails on the first run, and revert (SC-005). The healthcheck, the fourth defect, is proven
in PR A.

| Defect | Expected failure |
|---|---|
| Add a second peer context of `@tamagui/web` to a copy of the lock | Guard names both keys |
| Add an unlisted inline script to one exported HTML file | Gate prints the page and its hash |
| Pad a second referenced script past the budget | Gate names the page and each script |

Then, in CI with the label `mobile-e2e`:

| Scenario | Expected |
|---|---|
| `page-security-policy-walk.spec.ts` under `E2E_TIER=gate` | Passes, and is counted as run, not skipped. To run it alone, see [contracts/web-gates.md](./contracts/web-gates.md) |
| `app-ci / android-launch` on the PR's head (SDK 57 control) | `launch=ok login-screen=visible fatal=0` |

## PR C: SDK 58

**Before the bump:** the quiet-lock protocol and M0 to M3 in [research.md](./research.md).

```bash
CI=true pnpm install --frozen-lockfile
node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs
pnpm nx typecheck mcm-app
pnpm nx test mcm-app
pnpm nx lint mcm-app
pnpm nx bundle-budget mcm-app
jq '{html: (.htmlRoutes|length), notFound: (.notFoundRoutes|length), api: (.apiRoutes|length)}' frontend/mcm-app/dist/server/_expo/routes.json
```

| Scenario | Expected |
|---|---|
| Routes manifest | The same counts as the SDK 57 baseline, covering all 16 page files in `src/app` and 38 API routes |
| A page that throws at render, then `pnpm nx export-server mcm-app --skip-nx-cache` | Export fails; revert |
| Open a generated Android project: `android/gradle.properties` | `android.enableMinifyInReleaseBuilds=false` |
| Same project: network security config | Cleartext only for `localhost`, `127.0.0.1`, `10.0.2.2` |
| `grep decode-uri-component pnpm-lock.yaml` | No matches; the SAST gate passes with the entry deleted |
| `grep -E "unsafe-(inline\|eval)" frontend/mcm-app/web-security-headers.js` | Only in comments |
| `specs/087-expo-sdk-58/tools/measure-page-latency.mjs`, same machine as M1 | Within 25% of M1 (SC-002) |
| The new `expo-doctor` step in CI | No unresolved error; any accepted warning quoted |

In CI with the label `mobile-e2e-full`:

| Scenario | Expected |
|---|---|
| Web suite, `E2E_TIER=gate` | Passes, zero unexpected skips, walk included |
| Assistant gate tier (`E2E_REQUIRE_AGENT_STACK=1`) | Passes, including a streamed turn |
| `app-ci / android-launch` | `launch=ok login-screen=visible fatal=0` |
| Maestro login and agent flows | Pass; results quoted as launch evidence |

**After merge:**

1. Confirm `cd-deploy` `prod-apk` succeeded (FR-019).
2. Operator: install the shelf APK on a device and sign in. This is the first run of the production-URL build.
3. Watch for 7 days (SC-008). No rollback, and no behaviour-change entry in release notes.

## Rollback

| Change | Web | Android |
|---|---|---|
| PR A | Revert, redeploy | Not affected |
| PR B | Revert | Not affected |
| PR C | Revert the promotion to the previous digest. No data migration | Previous APK from the shelf |

Each PR body states these steps (FR-025).
