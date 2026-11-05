# Contract: Web gates (PR B)

## `scripts/check-web-bundle-budget.mjs`

Arguments stay as they are, parsed by the shared rejecting parser. An unrecognised argument exits 2.

| Exit | Meaning |
|---|---|
| 0 | All assertions passed, or selftest passed |
| 1 | Any failure below, or selftest broken |
| 2 | Bad arguments |

**Assertions, in addition to the existing three**:

| Condition | Result | The message names |
|---|---|---|
| No `dist/server/**/*.html` | Fail | The directory |
| A page references no `/_expo/` script | Fail | The page |
| A referenced script is missing on disk | Fail | The page and the file |
| Worst page's scripts exceed the budget | Fail | The page, bytes, budget, overage, each script |
| An inline script is not on the allowlist | Fail | The page and its `'sha256-...'` value |

`--budget` now applies to the cold-load total rather than to the entry chunk. The `entry-*` checks for deferred packages
are unchanged.

**Selftest must prove each of these fails**: two chunks that fit the budget apart but not together; a page with an
unlisted inline script; a page referencing a missing file; a tree with no HTML. And that a clean tree passes.

**Nx**: `bundle-budget` declares `inputs` including the script, so changing the gate alone re-runs it.

## One-instance guard

Added to `scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`:

- `tamaguiInstances(lockText)` returns the distinct `snapshots:` keys for `@tamagui/core` and `@tamagui/web`, peer suffix
  included.
- The repo's lock must give exactly one key for each. Zero also fails, so a parser that stops matching cannot pass.
- A synthetic lock with two peer contexts must give two.
- The failure message names both keys and says to run `pnpm dedupe`.

## Browser walk

`tests/e2e/web/page-security-policy-walk.spec.ts`, tagged `@gate`, in the `lifecycle` project. Runs in `E2E_TIER=gate`.

| Step | Assertion |
|---|---|
| Preconditions | Page response has a CSP, and `X-BFF-Source` names a container. Otherwise visible skip locally, failure under `CI` |
| Instrument | An injected inline script records a violation; the list is then cleared |
| Sign-in | Own session through the identity provider, landing on `/home` |
| Reload | Hard reload of `/home` |
| Deep link | Direct load of a collection it created through the BFF |
| Navigation | In-app navigation to Settings |
| Every step | Zero `securitypolicyviolation`, zero `pageerror` |
| Public | `/no-such-page` answers 404. A page's `Cache-Control` has no `immutable` |

A failure lists each violation's directive, blocked URI and source, or the page error's message.

**Running it alone**: `lifecycle` depends on `chromium`, so a file filter still runs all 210 tests (measured). Use the
official Playwright image recipe in `docs/runbooks/e2e-testing.md` with
`tests/e2e/web/page-security-policy-walk.spec.ts --project=lifecycle --no-deps`.

**Negative control**: empty `INLINE_SCRIPT_HASHES` in `web-security-headers.js`, recreate the dev BFF container from that
file, run the walk, then restore the file and recreate the container. Nothing else may change.

## Assistant path

The existing `@gate` test `navigate → the assistant opens the named collection screen`
(`assistant-navigate.spec.ts`) uses the same watch with this one exception:

```text
effectiveDirective is script-src (or script-src-elem), blockedURI === 'eval', at most 1 per document
```

Anything else fails. The exception is declared at that call site and is not a default in the fixture.
