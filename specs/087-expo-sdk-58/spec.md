# Feature Specification: Move the App to the Next App Framework Release

**Feature Branch**: `087-expo-sdk-58`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "Move the MCM app to Expo SDK 58 following the chosen approach in docs/proposals/MCM-Expo-SDK-58-Approach.md: web.output static with apiRoutes, BFF stays inside Expo, R8 and web async routes off for the first release, adapter change and gates land on SDK 57 first. Seed acceptance criteria from section 7 of the proposal. The Android launch test is a required task with evidence quoted in tasks.md, since no SDK 58 APK has been launched."

## Context

MCM runs on its app framework's current release, and the runtime underneath that release leaves upstream support when the
next one ships. This feature moves web and Android to the next release **with no change members can see**.

The research, evidence and rejected options are in
[the approach proposal](../../docs/proposals/MCM-Expo-SDK-58-Approach.md). This spec does not repeat them, and the
[plan](./plan.md) names the products and versions behind each term used here. The operator made these decisions on
2026-11-05:

| Decision | Choice |
|---|---|
| Web pages | Stay prerendered at build time, with API routes in the same server |
| Backend-for-frontend location | Stays inside the app framework's server. No split |
| Android code shrinking | Off for the first release on the new framework version |
| Splitting web pages into separately loaded scripts | Off for the first release on the new framework version |
| Order | The hosting change and new gates land on the current framework version first |
| Launch check before this spec | Not run. It is a required, evidenced task inside this feature |

Three failures the spikes measured shape the requirements below. Each one looked healthy to an existing check:

- **The new hosting layer ignores the trusted proxy's scheme.** Backup consent and account deletion would send the
  identity provider an `http://` callback, which it refuses (item #843). The test guarding this uses a stand-in, so it
  would stay green.
- **The old hosting layer on the new version serves API routes but 404s every page.** The container healthcheck requests
  an API route, so it passes.
- **A second copy of the styling library renders every page blank.** The build and the API still succeed, and the existing
  guard compares versions rather than copies.

## Clarifications

### Session 2026-11-05

- Q: Which rendering approach? → A: Prerendered pages with API routes, keeping the backend-for-frontend in the framework.
- Q: Test the Android launch before specifying? → A: No. A CI build with shrinking off succeeded (`cd-deploy` run 6802,
  commit `100f3077`). No app on the new version has been launched, so the launch check is a required task here.
- Q: Are turning on code shrinking and script splitting part of this feature? → A: No. They are separate later changes
  (see Out of Scope).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Identity round trips keep working through a new hosting layer (Priority: P1)

A member behind the production proxy grants backup consent, or confirms account deletion. The identity provider accepts the
callback and returns them to the app, exactly as today. The supported hosting layer replaces the outdated one **while still
on the current framework version**, so this risk is proven and reversible before any version move.

**Why this priority**: This is the one failure measured to break a production security flow silently, and every later story
depends on the new hosting layer.

**Independent Test**: Boot the real server with the real hosting layer and send requests with and without a trusted proxy,
then complete a backup-consent round trip in production after deploy. It delivers value on the current version alone, because
it retires an unmaintained dependency.

**Acceptance Scenarios**:

1. **Given** the server trusts one proxy hop, **When** a request arrives marked as forwarded over HTTPS, **Then** the
   application sees an `https` request URL.
2. **Given** no trusted proxy is configured, **When** a client sends a forwarded-scheme header, **Then** the header is
   ignored and the request URL stays `http`.
3. **Given** any configuration, **When** a request carries a forwarded-host header, **Then** the request's origin does
   not change.
4. **Given** the fix is removed, **When** the suite runs against the real hosting layer, **Then** it fails.
5. **Given** the change is deployed to production, **When** the operator completes backup consent and starts account
   deletion through to the identity provider's sign-in, **Then** neither is refused for its callback address.

---

### User Story 2 - Failures that look healthy are caught before merge (Priority: P1)

A developer changes a dependency or the renderer. If the change would blank the app, block a script under the security
policy, or quietly grow the first download, a gate fails the pull request with a message naming the cause. These gates
land **on the current version first**, so they are proven against the current app and are in place to catch mistakes in the
upgrade.

**Why this priority**: The blank-page failure was produced by an ordinary upgrade step, and no current gate sees it. The
upgrade pull request is exactly where it would recur.

**Independent Test**: Introduce each defect deliberately (a second copy of the styling library, an unlisted inline script,
a split bundle over budget, pages failing while the API answers) and confirm the matching gate fails, then passes when it
is reverted.

**Acceptance Scenarios**:

1. **Given** the workspace resolves more than one copy of the styling library's core, **When** the gates run, **Then** they
   fail and name the copies.
2. **Given** a built page contains an inline script not on the allowlist, **When** the gates run, **Then** the build fails and
   prints that script's hash.
3. **Given** the first page needs several scripts, **When** the budget gate runs, **Then** it counts all of them, not just
   the entry script.
4. **Given** pages are failing while API routes still answer, **When** the container healthcheck runs, **Then** it reports
   unhealthy.
5. **Given** a signed-in member walks through sign-in, a deep link and in-app navigation, **When** any security-policy violation
   or uncaught page error occurs, **Then** the required browser test fails.
6. **Given** each new keyless gate, **When** its selftest runs, **Then** it proves the gate can fail as well as pass.

---

### User Story 3 - Web members notice nothing after the move (Priority: P1)

A member uses the web app after the upgrade. Pages load as fast as before, sign-in and deep links work, and the assistant
responds. Pages are still prerendered at build time, so a page that cannot render fails the build instead of failing for
members.

**Why this priority**: This is the feature's main outcome. Web carries the production backend-for-frontend, which the Android
app also depends on.

**Independent Test**: Deploy the upgraded image to a test environment and run the full web browser suite and the assistant's
gate tier, comparing response time and memory with the baseline on the current version.

**Acceptance Scenarios**:

1. **Given** a build, **When** it completes, **Then** it contains prerendered output for all 16 page routes and serves all 38
   API routes.
2. **Given** a page that throws while rendering, **When** the build runs, **Then** the build fails.
3. **Given** the web app in a browser, **When** any page loads, **Then** it hydrates under the existing strict script policy,
   with no permission for inline or evaluated code added.
4. **Given** a signed-in member with the assistant configured, **When** they send a message, **Then** a streamed reply arrives.
5. **Given** a request for an address that does not exist, **When** the server answers, **Then** the status is 404.
6. **Given** the release is bad, **When** the operator rolls back, **Then** the previous image serves members again with no
   data migration needed.

---

### User Story 4 - The Android app launches and works on a real release build (Priority: P1)

A member installs the release app, opens it, signs in and uses their collections as before. **No app on the new version has
been launched yet**, so this story requires quoted evidence, not an assumption from a green build.

**Why this priority**: The native toolchain moves further in this upgrade than any other part, and a build passing says nothing
about whether the app runs. The equivalent check in the previous upgrade (feature 081, T028) was left unticked and has never
been recorded.

**Independent Test**: Install a CI-built release app on an emulator, confirm launch with no fatal errors, then run the existing
mobile flows.

**Acceptance Scenarios**:

1. **Given** a CI-built release app, **When** it is installed and started on an emulator, **Then** launch completes and the login
   screen appears.
2. **Given** that launch, **When** the device log is read, **Then** it contains no fatal exception and no missing-class or
   missing-method error.
3. **Given** the app is running, **When** the existing login flow runs, **Then** it completes through the system browser.
4. **Given** the login succeeded, **When** the existing assistant mobile flows run, **Then** they pass.
5. **Given** either CI path builds the app, **When** the native build runs, **Then** it has the raised memory limit and fails
   fast on running out of memory instead of hanging.
6. **Given** the release configuration, **When** native projects are generated, **Then** code shrinking is off, and a guard fails
   if it is turned on outside its own change.
7. **Given** the task list, **When** this story is marked done, **Then** the launch and flow results are quoted in the task list,
   with run numbers.

---

### Edge Cases

- **Lockfile carries an old resolution.** A stale entry for an open-range peer dependency can survive the upgrade and create a second
  copy of the styling library. The upgrade must regenerate resolutions, and User Story 2's gate must catch any that remain.
- **Partial workspace alignment.** The UI runtime and its overrides are pinned in several manifests. A partial update fails the build
  with a version-mismatch error. All pins move together.
- **Security-policy hash changes.** A future renderer change to the inline script causes a violation and a client-side render, not a
  blank page. The gate must fail it anyway, because it silently loses hydration.
- **Route data loaders are adopted later.** Loader data is embedded in the same inline script, so its hash would vary. The allowlist gate
  will fail, which is the intended prompt for a design decision.
- **Bundle budget.** With script splitting off, the entry script measured 1,925,703 bytes against a 2,000,000-byte budget. If it goes
  over, raising the budget is a deliberate change quoting before-and-after figures.
- **Emulator not available to the session.** The dev sandbox has no hardware virtualization and cannot build the Android app. That makes
  the story a CI or operator step, never a skip.
- **Test skips.** A skipped assistant, integration or browser test is not a pass. Skip counts must be reported and zero where this spec
  says so.
- **Security allowlist.** The upgrade clears the URL-decoding library's advisory. Its allowlist entry is deleted in the upgrade change,
  not renewed. If the upgrade has not merged by 2026-12-01, the entry must be renewed first.

## Requirements *(mandatory)*

### Functional Requirements

**Hosting and identity (lands on the current version)**

- **FR-001**: The server MUST use the hosting layer the framework supports, and the outdated one MUST be removed from manifests, the
  runtime-pruning roots and test stand-ins.
- **FR-002**: The application MUST see the public scheme when, and only when, a trusted proxy is configured. A forwarded-host header
  MUST never change the origin.
- **FR-003**: At least one test MUST exercise FR-002 through the real hosting layer, not a stand-in, and MUST fail if the fix is removed.
- **FR-004**: The shipped image MUST contain the hosting layer at runtime, proven by building the image and running it.
- **FR-005**: The container healthcheck MUST report unhealthy when pages fail, even if API routes still answer.

**Gates (land on the current version)**

- **FR-006**: A keyless gate MUST fail when more than one copy of the styling library's core resolves across the workspace.
- **FR-007**: A keyless gate MUST fail when any built page contains an inline script outside an explicit allowlist.
- **FR-008**: The bundle budget MUST measure every script the first page requires.
- **FR-009**: A required browser test MUST fail on any security-policy violation or uncaught page error across sign-in, a deep link and
  in-app navigation.
- **FR-010**: Every new keyless gate MUST have a selftest proving it can fail.

**The upgrade**

- **FR-011**: The web and Android app, and every workspace package, MUST move together to the target framework release and its supporting
  runtimes, with overrides and test tooling aligned.
- **FR-012**: Pages MUST stay prerendered at build time, with API routes served by the same process, and a render error MUST fail the build.
- **FR-013**: Splitting web pages into separately loaded scripts MUST be off for this release.
- **FR-014**: The script security policy MUST NOT gain any permission for inline or evaluated code.
- **FR-015**: Sessions, cookies, API behaviour, and security headers MUST stay unchanged for members, apart from the hosting layer's internals.
- **FR-016**: Typecheck MUST report zero errors. Unit tiers MUST report zero failures and zero skips, including both suites that exercise the
  server's hosting layer.
- **FR-017**: The test framework major MUST move as the target release requires, and the corresponding holds (item #792) MUST be lifted.
- **FR-018**: The upgrade change MUST delete the URL-decoding library's security allowlist entry and confirm through the security scan that it
  is no longer needed.

**Android**

- **FR-019**: Release builds MUST succeed in both CI paths, with the raised memory limit and fail-fast setting in each, on the native build tool
  version the target release's template requires, including the version baked into the dev container image.
- **FR-020**: Android code shrinking MUST be off for this release, and a guard MUST assert it.
- **FR-021**: A launch check on a CI-built release app MUST run and pass, and its results MUST be quoted in the task list before the Android story
  is marked done. The task MUST NOT be left open at merge, as T028 was in feature 081.
- **FR-022**: The existing login and assistant mobile flows MUST pass on that app.
- **FR-023**: The custom cleartext configuration MUST keep cleartext limited to local development hosts.

**Governance**

- **FR-024**: The constitution MUST be amended in the same change as the version move, with human approval: the framework baseline, and the
  backend-for-frontend's stated output mode, whose current text would mean per-request rendering on the new version.
- **FR-025**: Each change in the sequence MUST be able to land and revert alone, and each pull request MUST state its rollback steps for web and,
  where relevant, Android.
- **FR-026**: Knowledge sources that describe the hosting layer, output mode and Android build MUST be updated in the same change as the behaviour
  they describe.

### Key Entities

- **Inline script allowlist**: The set of permitted inline-script hashes, shared by the security policy and the build gate, with one entry today.
- **Launch evidence**: The record in the task list of a launch check: run number, app commit, launch result, device-log result and flow results.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Backup consent completes, and account deletion reaches the identity provider's sign-in, in production after the hosting change, with
  zero callback refusals.
- **SC-002**: Page response time and server memory stay within 25% of the baseline on the current version, measured the same way (baseline: 11.8 ms
  median, 138 MB after load).
- **SC-003**: First-page download is no more than 2,000,000 bytes, counting every script it needs.
- **SC-004**: Zero security-policy violations and zero uncaught page errors across the authenticated browser walk.
- **SC-005**: Each deliberately introduced defect from User Story 2 fails its gate on the first run, 4 of 4.
- **SC-006**: The Android release app launches with zero fatal errors, and 100% of the login and assistant mobile flows pass, with the results quoted.
- **SC-007**: The full web browser suite and the assistant's gate tier pass with zero unexpected skips.
- **SC-008**: Members report or experience no change: no behaviour-change entries are needed in release notes, and no production rollback happens within
  7 days of the deploy.
- **SC-009**: A bad web release can be rolled back through the existing deploy process with no data migration.

## Assumptions

- The app has no route data loaders, root HTML file or per-route metadata today (measured), so no migration is needed for them.
- Client-side authentication remains, so server-rendered pages would carry no member data, and prerendering loses nothing.
- CI's emulator runner or the operator's dev container with hardware virtualization is available for the launch check. The daily sandbox cannot run it.
- The test environment keeps using its current Android API level for the emulator image, so newer API behaviour remains untested, as it is today.
- Spike figures are ratios from one unconstrained sandbox process, not capacity numbers.

## Out of Scope

- **Turning Android code shrinking on.** A separate later change (item #937), with size measured and a mapping file retained.
- **Turning script splitting on.** A separate later change (item #938), once the corrected budget gate shows a gain.
- **Moving the backend-for-frontend out of the framework, and any client-only output.** Evaluated in the proposal and not chosen.
- **Per-request rendering, route data loaders, or script nonces.**
- **iOS release work.** MCM has no iOS release, so the new version's iOS changes are not exercised here.
- **Moving the dev container's Android API level.**
