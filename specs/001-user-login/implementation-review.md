# Implementation Review: User Login & Registration

**Branch**: `001-user-login` | **Date**: 2026-05-16  
**Reviewer**: Post-implementation E2E test campaign (mobile + web)  
**Outcome**: All 13 mobile (Maestro) and 32 web (Playwright) tests passing

---

## Bugs Found and Fixes Applied

### 1. BFF logout did not clear Keycloak SSO session

**Root cause of `login-invalid` and `auth-guard` failures.**

The logout endpoint called `revokeToken` (OIDC token revocation) but not the Keycloak Admin API `POST /users/{userId}/logout`. OIDC revocation ends the client/token session but leaves the Keycloak SSO user session alive — Chrome's Keycloak cookie remained valid, so the next Keycloak auth flow re-authenticated silently without showing the login form.

**Fix**: Added `logoutUserSessions(userId)` in `src/bff-server/keycloak.ts` using the Admin API endpoint. Both `revokeToken` and `logoutUserSessions` run via `Promise.allSettled` in `src/app/bff-api/auth/logout+api.ts`.

---

### 2. Idle timer race condition in `logout` E2E flow

`EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS=15000` was too short. The idle timer fired at ~T+32s while the full logout assertion chain (login → navigate → confirm → assert) was still in progress, causing `assertVisible: profile-screen` to fail because navigation to the login screen had already been triggered.

**Fix**: Increased the override from 15000ms to 25000ms in `.env.local`.

**Additional finding**: Native Android Maestro taps (ADB accessibility events) do not trigger `window.addEventListener('touchstart', …)` DOM events and therefore cannot reset the idle timer. The dev override is the only lever available in E2E test environments.

---

### 3. `login-keycloak` Maestro timing race on cached page loads

`runFlow when visible "Username or email"` evaluates the condition exactly once, immediately after `waitForAnimationToEnd`. For cached Keycloak pages, `waitForAnimationToEnd` returns after only ~571ms (Chrome's opening animation), but Chrome's accessibility tree takes longer to build. The condition fired before the form was accessible, the form fill was skipped, and `extendedWaitUntil: home-route` timed out after 40s.

**Fix**: Replaced the one-shot `runFlow when visible` and coordinate header tap with `runFlow when notVisible home-route` containing `extendedWaitUntil: visible "Username or email" timeout: 10000` inside. The `notVisible home-route` discriminator correctly detects SSO vs no-SSO at any page load speed, and `extendedWaitUntil` polls until the form is actually accessible rather than checking once. (`tests/e2e/mobile/_login-helper.yaml`)

---

## Gaps in Artifacts That Led to These Bugs

### `plan.md` — Logout design missing SSO layer (Bug 1)

The BFF `/auth/logout` design says: *"Notify Keycloak (revoke refresh token)"* — but says nothing about the Keycloak SSO user session. The distinction is non-obvious: OIDC `end_session` ends the client/token session; the Admin API `POST /users/{id}/logout` ends the SSO user session tracked by Chrome's cookie. Without this in the plan, the implementation naturally stopped at token revocation. The plan should have included an explicit step:

> *Terminate Keycloak SSO user session via Admin API to prevent silent re-auth on next Keycloak redirect.*

### `spec.md` / `tasks.md` — `login-invalid` precondition not specified (Bugs 1 & 3)

The `login-invalid` user story requires that no active SSO session exists when the test runs, but neither the spec nor tasks call this out. T-080 simply says "invalid credentials → Keycloak shows login form" without specifying how SSO state must be cleared beforehand. The implicit assumption was that logout is sufficient — but that is only true if logout actually ends the SSO session. Stating this as an explicit test precondition would have surfaced the Admin API gap during task design rather than E2E debugging.

### `plan.md` / `tasks.md` — E2E tooling specified as Detox, implemented as Maestro (Bug 3)

The plan specifies *"E2E Tests (Detox)"* and T-017 is *"Install and configure Detox for E2E testing."* Maestro was used instead. This divergence was not documented as a plan deviation. More importantly, Maestro's behavioral constraints — `runFlow when` evaluates the condition exactly once, `waitForAnimationToEnd` detects the Chrome opening animation rather than page load completion, and native ADB taps do not fire DOM events — are Maestro-specific and were not captured in any artifact. A Complexity Tracking entry or test strategy note would have preserved this knowledge.

### `constitution.md` — Session Invalidation principle does not address SSO layer (Bug 1)

The constitution's Session Invalidation principle reads: *"Stateful session identifiers must be invalidated on the server immediately after logout."* This correctly covers BFF session invalidation (Redis) but does not address IAM-level SSO session invalidation. For systems using Keycloak (or any SSO provider) with browser-based auth flows, invalidating only the BFF session leaves a residual SSO session that can silently re-authenticate the user on the next auth redirect.

### `tasks.md` — Dev idle timeout not specified for E2E context (Bug 2)

No task or note specified a minimum value for `EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS` relative to E2E test flow duration. The value was set during development without accounting for the full assertion chain length of the logout flow.

---

## Recommended Artifact Improvements

| Artifact | Recommended Addition |
|---|---|
| **`plan.md`** (BFF /auth/logout design) | Add explicit step: *"Terminate Keycloak SSO user session via Admin API `POST /users/{id}/logout`. Rationale: OIDC `end_session` ends the client session only; the SSO user session (Chrome's Keycloak cookie) requires the Admin API."* |
| **`tasks.md`** (T-080 and any login-invalid test task) | Add **Precondition**: *"Keycloak SSO session must be fully terminated before the next auth attempt. Verify logout clears the SSO user session via Admin API, not just the BFF session and OIDC client token."* |
| **`plan.md`** (Testing Strategy) | Document the Detox → Maestro switch as a tracked deviation. Add a **Maestro constraints** section: `runFlow when` is one-shot (condition evaluated once); `waitForAnimationToEnd` detects animation, not page load; native ADB taps do not trigger DOM `touchstart` events. |
| **`plan.md`** (Testing Strategy) | Add note: *"`EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS` must be long enough that the complete E2E assertion chain finishes before the timer fires. 25000ms is the minimum for the current logout flow (~37s total)."* |
| **`constitution.md`** (Session Invalidation) | Extend to: *"Where an external IAM provides SSO sessions (e.g., Keycloak), logout must also terminate the IAM-level user session, not only the BFF session and OIDC client token."* |
