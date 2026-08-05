# Two agent web E2E specs have been failing on `main`, masked by a skip

**Raised**: 2026-08-05, during 047 PR B's T098 re-run · **Status**: proposal, not yet specced

## What

Two specs fail on `main` and have almost certainly been failing for some time:

| Spec | Failure |
|---|---|
| `agent-navigate-movie.spec.ts` — US6-AC1, "navigate → opens the named movie detail, resolved across collections" | `page.waitForURL` times out after 180 s; the movie detail is never reached |
| `agent-add-external-link.spec.ts` — US5-AC1/AC2, external-ID link on the movie card | `expect(locator).toBeVisible()` — element(s) not found |

**Verified pre-existing by bisect**, not inferred: `main` (56ed701) was checked out, `mcm-bff:latest`
and `agent-gateway:latest` were rebuilt from it, and both specs failed **identically**. Neither
spec, nor the code each exercises, is touched by 047 PR B.

## Why nobody noticed

The recorded regression command is `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`. It sets no
`E2E_AGENT_PRODUCTION=1`, and all 13 `agent-*.spec.ts` gate on that flag — **without it they skip,
and the suite reports green**. So the gate meant to catch agent regressions has been running with
every agent spec switched off.

`E2E_REQUIRE_AGENT_STACK=1` (added by 047 PR A) converts those skips into hard failures. Setting it
is what surfaced these.

## What is NOT the cause

Ruled out during the investigation, so the next person does not repeat it:

- **Not stale images.** Both were rebuilt and probed before each run.
- **Not the 047 navigator rewrite.** The bounded `list_movies(collectionId, filter.search)` lookup
  resolves correctly against the live stack — probed directly: `term='zephyrine protocol'` → 1 item
  → `_match_movie` matched.
- **Not the `useAgent` subscription narrowing.** That was a real PR B bug and it is fixed; it
  explained the third failure (`agent-card-navigate`), which now passes. These two did not change.

The gateway log shows the turn classified as **search** and reaching `agent=search tool=list_movies`,
after which no `navigate_to_movie` UI action follows — so the next place to look is the search node's
single-result path and what 013's "New Scope 1" (1+ results → buttons, never auto-navigate) means
for a spec that waits for an automatic URL change.

## Proposed work

1. Fix the regression command everywhere it is recorded so agent specs cannot silently skip again —
   the durable half of this.
2. Diagnose the two specs: decide per spec whether the SPEC encodes stale expectations (013 changed
   auto-navigate to buttons) or the BEHAVIOUR regressed, and fix whichever is wrong.
