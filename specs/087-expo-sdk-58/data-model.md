# Data Model: Move the App to Expo SDK 58

This feature changes no stored data: no collection, document or session field moves, and rollback needs no migration.
The entities below are build and test records.

## Inline script allowlist

The set of inline scripts a page may contain.

| Field | Rule |
|---|---|
| `INLINE_SCRIPT_HASHES` | Array of `'sha256-<base64>'` strings, exported by `frontend/mcm-app/web-security-headers.js` |

- **One entry today**: `'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='`, over `globalThis.__EXPO_ROUTER_HYDRATE__=true;`.
- **Single source**: the CSP's `script-src` and the build gate both read this array.
- **Changing it** is a reviewed code change. The gate's failure message gives the new value, not permission to add it.

## Cold-load report

What `check-web-bundle-budget.mjs` reports for one export. It is computed each run and not stored. New fields extend the
existing report ([CLI contract](./contracts/web-gates.md)).

| Field | Type | Meaning |
|---|---|---|
| `coldLoad.worstPage` | string | HTML file with the largest total, relative to `dist/server` |
| `coldLoad.worstBytes` | number | Sum of that page's external scripts |
| `coldLoad.scripts` | string[] | Those scripts, by name |
| `coldLoad.pages` | number | HTML files read. Zero is a failure |
| `inlineScripts.seen` | `{ hash, pages }[]` | Each distinct inline script and how many pages carry it |
| `inlineScripts.unlisted` | `{ hash, page }[]` | Anything not on the allowlist. Non-empty is a failure |

`entryBytes`, `deferredHits`, `serverHits` and `problems` keep their meanings. `overBy` and `spare` now refer to
`coldLoad.worstBytes`, since the budget is measured there.

## Launch evidence

The record of one launch test, quoted in `tasks.md`. Required before US4 is marked done (FR-021).

| Field | Example | Source |
|---|---|---|
| Run | `app-ci` run number | CI |
| Commit | full sha of the APK's build | CI |
| SDK | `expo@58.0.x`, RN `0.88.1` | `package.json` at that commit |
| Launch | `Status: ok` | Launch smoke |
| Login screen | `login-screen` visible | Launch smoke |
| Fatal lines | `0` | Launch smoke, device log |
| Login flow | Passed | Maestro, full suite |
| Assistant flows | Passed, with count | Maestro, agent flows |

**States**: `not run` → `control recorded` (SDK 57, PR B) → `passed` (SDK 58, PR C). A failed run stays quoted, and the
story stays open.

## Commit status: `app-ci / android-launch`

| Field | Rule |
|---|---|
| `context` | Exactly `app-ci / android-launch` |
| `state` | `success` when all three checks passed, else `failure` |
| `description` | `launch=<ok\|failed> login-screen=<visible\|absent> fatal=<count>`; never a log excerpt |

It is informational and not a required context. The step's exit code is what blocks.
