# Feature Specification: E2E Tests Against the BFF Docker Container

**Feature Branch**: `007-e2e-bff-container`

**Created**: 2026-06-01

**Status**: Draft

**Input**: User description: "docs\PRD-E2ETestsAgainstBFFDevContainer.md — During local dev the Expo BFF is served by Metro; in higher environments the BFF must be hosted in a Docker container. Build/deploy the Dev BFF container, validate the client uses the container (not Metro), run all E2E (web+mobile) green; update test instructions so the final E2E run uses the containerized BFF (other tests fall back to Metro); ensure the Prod BFF container build/deploy works, validate the client uses Prod (not Dev/Metro), run all E2E green (may require Expo prod-server login streaming + token-refresh/SSO-logout reconciliation + HTTPS/Secure-cookie security review); then switch back to local dev and clean up unused BFF containers."

## Clarifications

### Session 2026-06-01

- Q: What distinguishes the Dev BFF container from the Prod BFF container? → A: **Dev = relaxed development config** (e.g. non-Secure cookies, plain HTTP) so E2E runs over localhost HTTP with minimal reconciliation; **Prod = full production hardening** (Secure cookies, HTTPS, full token/transport hardening). US1 (dev) is the easy path; US3 (prod) carries the hardened-parity + security reconciliation.
- Q: For the Prod-container E2E, how is the Secure-cookie-over-HTTP problem solved without weakening hardening? → A: **Serve the Prod container over HTTPS** (TLS — self-signed cert trusted in the E2E run, or a TLS-terminating proxy), so `Secure` cookies stay intact and are sent over HTTPS. No security attribute is disabled for tests.
- Q: Is the containerized final E2E a local step or also a CI job? → A: **Local validation only.** It is a documented local step (build/deploy container → run web+mobile E2E → green); CI is unchanged (the existing APK-build workflow). No CI E2E job is added.
- Q: For mobile, does "client uses the container, not Metro" mean the whole app is Metro-free? → A: **BFF-only containerization.** Only the BFF (`/bff-api`) is the container; the mobile debug APK still loads its JS bundle from Metro (via `adb reverse`). Validation confirms the app's **BFF calls** hit the container, not a Metro-served BFF. (Web is fully container-served — client + BFF — so Metro is entirely out of the web path.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - E2E suites pass against the Dev BFF container (Priority: P1)

A developer builds and deploys the Backend-for-Frontend as a Docker container in its **development** configuration (locally), confirms the client is genuinely talking to that container rather than the Metro dev server, and runs the complete web and mobile E2E suites against it — all green. This proves the application's critical flows work when the BFF is hosted as a container, not just under Metro.

**Why this priority**: This is the core deliverable — the first proof that E2E flows pass against a containerized BFF. It is the foundation the prod-container and instruction-update stories build on. Delivered alone it already de-risks "the BFF works in a container."

**Independent Test**: Build + deploy the Dev BFF container, assert via an observable signal that the client request path runs through the container (not Metro), run both E2E suites, and confirm every test passes.

**Acceptance Scenarios**:

1. **Given** the Dev BFF container is built and deployed and Metro is not serving the app, **When** the client performs each critical flow (login, browse/manage collections, browse/search/manage movies, logout), **Then** each flow succeeds against the containerized BFF.
2. **Given** the running stack, **When** the test operator checks which server is handling client/BFF requests, **Then** there is an unambiguous signal that it is the Docker container, not Metro.
3. **Given** the Dev BFF container is serving, **When** the full web E2E suite and the full mobile E2E suite are run, **Then** every test passes (subject to the existing bounded ≤1 environmental retry).

---

### User Story 2 - Final E2E run uses the containerized BFF; other tests stay on Metro (Priority: P2)

The team's testing instructions make clear that the **final** end-to-end validation runs against the deployed BFF container, while all faster, more frequent tests (unit, integration, iterative E2E) continue to use Metro for developer speed. A new operator can follow the instructions and reproduce the containerized E2E run.

**Why this priority**: Without documented, reproducible instructions the containerized E2E run is a one-off. It is independently valuable (a reader can follow it) but secondary to actually achieving green.

**Independent Test**: Follow the updated instructions from a clean state to build/deploy the container and run the final E2E suites; confirm the instructions are sufficient and correct, and that they direct only the final run (not iterative testing) to the container.

**Acceptance Scenarios**:

1. **Given** the project testing documentation, **When** it is read, **Then** it specifies building/deploying the BFF container before the final E2E run and using Metro for all other test phases.
2. **Given** a new operator follows the instructions, **When** they execute them, **Then** they reproduce a green containerized E2E run without undocumented steps.

---

### User Story 3 - E2E suites pass against the Prod BFF container (Priority: P2)

The Backend-for-Frontend is built and deployed in its **production** configuration as a Docker container; the client is confirmed to be talking to that production container (not the Dev container and not Metro); and the complete web and mobile E2E suites pass against it. Achieving this requires reconciling production-only behaviors that previously blocked container E2E: the production server's login response handling, token refresh, single-sign-out (SSO logout), and the production cookie/transport hardening (Secure cookies / HTTPS). A security review confirms the production posture is not weakened to make tests pass.

**Why this priority**: Production parity is the higher-assurance goal, but it builds on US1 and carries the known hard problems (documented in prior project memory), so it follows the dev-container success. It is independently testable against the prod container.

**Independent Test**: Build + deploy the Prod BFF container, assert the client request path runs through the prod container (distinct from Dev and Metro), run both E2E suites green, and run the security review confirming no production hardening was disabled merely to pass tests.

**Acceptance Scenarios**:

1. **Given** the Prod BFF container is deployed, **When** the operator checks the request path, **Then** there is an unambiguous signal it is the **production** container (not the Dev container, not Metro).
2. **Given** the production container, **When** a user logs in, stays active past the access-token lifetime, and logs out, **Then** login completes, the session refreshes transparently, and logout fully terminates the session (including the IdP SSO session).
3. **Given** the production container, **When** the full web and mobile E2E suites run, **Then** every test passes.
4. **Given** the production container passes E2E, **When** the security review is performed, **Then** production hardening (cookie security attributes, transport security, token validation) is intact — not relaxed to make tests pass — with any High/Critical findings resolved before completion.

---

### User Story 4 - Return to local dev and clean up (Priority: P3)

After the containerized E2E validation, the developer switches the workflow back to local Metro-based development and removes the now-unused BFF containers, leaving the environment in its normal day-to-day state with no orphaned containers consuming resources.

**Why this priority**: Housekeeping that prevents resource leaks and confusion, but it only matters after the validation work; lowest priority.

**Independent Test**: After running the containerized E2E, execute the documented teardown; confirm the BFF containers are removed, the persistent data/stack the rest of dev needs is untouched, and normal Metro-based dev works.

**Acceptance Scenarios**:

1. **Given** the containerized E2E run is complete, **When** the teardown is executed, **Then** the BFF containers are stopped/removed and no orphaned BFF containers remain.
2. **Given** teardown is done, **When** the developer starts normal local dev (Metro), **Then** the app runs as usual with the rest of the infrastructure intact.

---

### Edge Cases

- **Client silently falls back to Metro**: if Metro is still running on the same port, the client could use it instead of the container, giving a false-green. The validation must positively confirm the container is the request path (not merely "something answered on the port").
- **Login response never completes against the production server** (the prior `Premature close` / stream-destroyed symptom): the prod-container login flow must be reconciled so a session is actually established.
- **Access token expires mid-suite**: the cookie's max-age elapses (~15 min) and the client must transparently refresh against the container; if refresh fails, the suite cascades into auth failures.
- **Secure cookies over plain HTTP**: production-hardened cookies (`Secure`) are not sent by the browser over HTTP; the prod-container E2E must resolve this **without** disabling the security attribute purely for tests (e.g., serve over a trusted transport).
- **Issuer mismatch (browser vs container host)**: the browser authenticates against the public IdP URL while the container reaches the IdP internally — token issuer validation must accept the correct issuer (already addressed in feature 006; must remain intact).
- **Cleanup wipes shared/persistent data**: teardown must remove only the BFF containers, not the persistent stack (IdP DB, domain DB, session store data) other work depends on.
- **Mobile app JS still via Metro**: since only the BFF is containerized for mobile, the app's JS bundle is still Metro-served — the "not Metro" check applies to the BFF endpoint, and the validation must not be fooled by the app bundle's Metro origin.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The BFF MUST be built and deployed as a Docker container in a **development** configuration (relaxed for local use — e.g. non-Secure cookies, plain HTTP) suitable for running the E2E suites locally with minimal reconciliation.
- **FR-002**: There MUST be an unambiguous, observable way to confirm the client is exercising the BFF **in the container** rather than the Metro dev server before E2E results are trusted. For **web**, the container serves both the client bundle and the BFF (Metro is fully out of the path). For **mobile**, only the BFF is containerized — the debug APK still loads its JS bundle from Metro — so the signal MUST confirm the app's `/bff-api` calls reach the container, not a Metro-served BFF.
- **FR-003**: With the Dev BFF container serving, the complete web E2E suite and the complete mobile E2E suite MUST pass (subject only to the existing bounded ≤1 environmental retry, which must not mask a real regression).
- **FR-004**: The project testing instructions MUST be updated to require building/deploying the BFF container before the **final** (local) E2E run, while all other test phases (unit, integration, iterative E2E) continue to use Metro. This containerized final E2E is a **local** validation step; CI remains unchanged (the existing APK-build workflow — no CI E2E job is added by this feature).
- **FR-005**: The BFF MUST be built and deployed as a Docker container in a **production** configuration (full hardening: Secure cookies, served over **HTTPS**), and there MUST be an unambiguous way to confirm the client is exercising the **production** container (distinct from the Dev container and from Metro).
- **FR-006**: With the Prod BFF container serving, the complete web and mobile E2E suites MUST pass, including the full authenticated lifecycle: login completes and establishes a session, the session refreshes transparently when the access token expires, and logout terminates the session (including the IdP SSO session).
- **FR-007**: Any production-only behavior that blocks container E2E (production server login-response handling, token refresh, SSO logout, Secure-cookie/transport hardening) MUST be reconciled so the suites pass **without weakening the production security posture** — security attributes MUST NOT be disabled merely to make tests pass. The Secure-cookie requirement MUST be satisfied by serving the production container over **HTTPS** (a trusted/self-signed TLS endpoint for the E2E run), not by disabling the `Secure` attribute.
- **FR-008**: A security review MUST be performed on the changes enabling prod-container E2E; all High/Critical findings MUST be resolved before completion, and Medium/Low findings triaged and documented (resolved or explicitly accepted with rationale).
- **FR-009**: The feature MUST NOT change any end-user-facing application behavior or weaken the security posture relative to before; it changes test/deployment validation and supporting reconciliation only.
- **FR-010**: After the containerized E2E validation, the workflow MUST be returned to normal local (Metro) development and the unused BFF containers MUST be removed, leaving the persistent stack and data the rest of dev depends on intact.
- **FR-011**: The full pre-existing test suite (unit, integration, mc-service) MUST continue to pass, confirming no regression from the reconciliation work.

### Key Entities

*Not applicable — this feature changes test/deployment validation and BFF runtime configuration; it introduces no new domain data entities.*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the Dev BFF container deployed and Metro not serving, 100% of the web E2E suite and 100% of the mobile E2E suite pass, with a recorded signal proving the request path was the container.
- **SC-002**: A new operator can follow the updated testing instructions and reproduce a green containerized final E2E run with zero undocumented steps.
- **SC-003**: The testing instructions explicitly scope the containerized BFF to the **final** E2E run and Metro to all other test phases.
- **SC-004**: With the Prod BFF container deployed, 100% of the web and mobile E2E suites pass, including a test that exercises login → token-expiry refresh → logout end to end.
- **SC-005**: The security review reports zero unresolved High/Critical findings; production cookie/transport/token-validation hardening is confirmed intact (not disabled for tests); Medium/Low documented.
- **SC-006**: Zero end-user-facing behavior changes; the pre-existing unit/integration/mc-service suites all still pass.
- **SC-007**: After teardown, zero orphaned BFF containers remain, the persistent stack/data is intact, and normal Metro-based dev runs unchanged.

## Assumptions

- The supported verification clients are web (browser E2E) and Android (mobile E2E) — the project's current targets; iOS is out of scope.
- "All E2E green" refers to the existing web and mobile E2E suites already defined for the app, run with the existing bounded ≤1 environmental retry; no new test *types* are introduced, though new tests may be added (e.g., an explicit token-expiry-refresh-then-logout flow for the prod lifecycle).
- The issuer split between the browser's public IdP URL and the container's internal IdP URL was already reconciled in feature 006 (runtime `KEYCLOAK_URL` / `KEYCLOAK_PUBLIC_URL`); this feature relies on that and must keep it intact.
- The **Dev** BFF container uses a relaxed development configuration (non-Secure cookies, plain HTTP) so US1 is achievable over localhost HTTP with minimal reconciliation; the **Prod** BFF container uses full production hardening and is served over **HTTPS** for the E2E run (trusted/self-signed TLS), keeping `Secure` cookies intact rather than disabling them.
- The known prod-container blockers (production server login-response streaming, token refresh, SSO logout, Secure cookies over plain transport) are real and in scope for the prod-container story, per prior project memory; the Secure-cookie/transport one is resolved via HTTPS (above).
- "Switch back to local dev" means returning to the Metro-served BFF for day-to-day work; only the BFF containers are removed, while the shared infrastructure (IdP, domain DB, session store) the rest of dev needs remains running.
- The full backend stack (IdP, session store, domain service + DB) is available for the E2E runs, as it is for the existing suites.
- The containerized final E2E is a **local** validation step (not a CI job); CI remains the existing APK-build workflow. For mobile, only the BFF is containerized while the app JS bundle continues from Metro; for web, the container serves both client and BFF.
