# Feature Specification: Security Header Hardening (DAST remediation)

**Feature Branch**: `032-security-header-hardening`

**Created**: 2026-07-09

**Status**: Draft

**Input**: User description: "docs/PRD-SecurityHeaderHardening.md — remediate the missing HTTP security-header and CORS findings from the feature-031 DAST baseline scan by adding a baseline set of security response headers across the whole web-served surface (HTML shell + static assets), restricting cross-origin access on the agent endpoint, removing server technology disclosure, applying HSTS at the HTTPS edge, and suppressing a confirmed scan false positive — without breaking the web app or regressing auth."

## Clarifications

### Session 2026-07-09

- Q: Is the production HSTS (HTTPS-edge) change part of this feature's Definition of Done, or a separate infra PR? → A: In scope — HSTS edge config is included and its production verification gates this feature's completion (FR-011/SC-007 stay).
- Q: How should the agent endpoint's cross-origin allowance be remediated — drop the header, or scope it to the app origin? → A: Drop the cross-origin allowance header entirely (same-origin app needs none); the acceptance test asserts the header is absent.
- Q: What is the delivered content-security-policy mode — enforcing, report-only first, or both? → A: Enforcing only. The shipped feature emits an enforcing CSP (report-only is a dev-time aid only, never the delivered state); tests assert the enforcing header.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Security headers protect the whole web surface (Priority: P1)

Every page and static asset the application serves to a browser must carry the baseline HTTP security headers (a content-security policy, anti-clickjacking protection, content-type sniffing protection, and a referrer policy) — not only the JSON API responses that already carry them. Today the application shell (the web page a user loads) and its static assets are served without these headers, leaving that surface exposed to classes of attack (cross-site scripting, clickjacking, MIME-confusion) that the headers are designed to prevent. This story closes that gap while keeping the web application fully functional.

**Why this priority**: This is the core of the remediation and the largest risk. It is the widest exposed surface (every browser load), it covers the Medium-risk findings, and getting the content-security policy right without blanking the application is the primary technical risk of the whole effort. It delivers standalone value: the moment these headers are present and the app still works, the main hardening goal is met.

**Independent Test**: Load the application root page and a static asset in a browser (or via an automated response-header check) and confirm each baseline security header is present and correctly valued, that the strict JSON-only policy on the API surface is unchanged, and that the web application still renders and operates with no policy violations reported by the browser.

**Acceptance Scenarios**:

1. **Given** a browser requests the application shell page (e.g. the app root), **When** the response returns, **Then** it includes a content-security policy appropriate for a web application, an anti-clickjacking control, a content-type-sniffing protection header, and a referrer policy.
2. **Given** a browser requests a static asset (script, style, font, image), **When** the response returns, **Then** it includes the content-type-sniffing protection header (and the applicable baseline headers).
3. **Given** the content-security policy is applied to the web surface, **When** a user exercises the existing web application flows end to end, **Then** the application renders and functions normally with no policy violations reported by the browser console.
4. **Given** a request to the JSON API surface, **When** the response returns, **Then** its existing strict content-security policy remains in force and is NOT loosened by the new web-surface policy.

---

### User Story 2 - Cross-origin access to the agent endpoint is restricted (Priority: P2)

The conversational-agent endpoint currently returns a cross-origin access policy that is more permissive than needed. Because the web client and the backend-for-frontend are the same origin, no cross-origin allowance is required. This story removes that allowance entirely so the endpoint no longer advertises any cross-origin access, while leaving the agent's streaming behavior intact.

**Why this priority**: It is a distinct Medium-risk finding on a single endpoint, isolated from the header work, and lower blast radius than the site-wide header change. It must not disturb the agent's live streaming interaction, so it is sequenced after the primary header story.

**Independent Test**: Inspect the response of the agent endpoint and confirm the cross-origin access allowance header is absent (removed entirely — no wildcard, no reflected origin), then run the agent conversation flows and confirm streaming responses still work.

**Acceptance Scenarios**:

1. **Given** a request to the agent endpoint, **When** the response returns, **Then** the cross-origin access allowance header is absent (no wildcard, no reflected origin, no scoped value — the header is not present).
2. **Given** the cross-origin allowance has been removed, **When** a user drives the agent through its normal conversation and action flows, **Then** the streaming agent interaction continues to work unchanged.

---

### User Story 3 - Reduce disclosure and finalize scan posture (Priority: P3)

Three smaller hygiene items complete the remediation: the server no longer advertises its underlying technology in a disclosure header; the transport-security (HSTS) header is present on the production HTTPS edge (where it is meaningful) and deliberately absent on the plain-HTTP dev/CI surface (where it is ignored and can misconfigure); and the one confirmed scan false positive (timestamp-shaped values inside the compiled client bundle) is suppressed in the scan gate with a documented justification so it stays visible in reports but no longer needs triage.

**Why this priority**: These are Low/Info severity or reporting-hygiene items. They are valuable to close the loop on the scan but carry the least risk and the least user-facing impact, so they come last.

**Independent Test**: Confirm the technology-disclosure header is absent from responses; confirm the transport-security header is present on the HTTPS edge and absent on the plain-HTTP surface; confirm the false-positive finding is suppressed in the scan gate (with justification recorded) yet still listed in the scan report.

**Acceptance Scenarios**:

1. **Given** any application response, **When** it is inspected, **Then** it does not include a header disclosing the underlying server framework/technology.
2. **Given** the production HTTPS edge, **When** a response is inspected, **Then** it includes a transport-security (HSTS) header; **and given** the plain-HTTP dev/CI surface, **Then** it does NOT include a transport-security header.
3. **Given** the scan gate runs, **When** the confirmed false-positive finding is encountered, **Then** it is suppressed from the pass/fail gate with a recorded justification while remaining visible in the scan report.

---

### Edge Cases

- **Content-security policy too strict**: if the policy blocks a resource the web app legitimately needs (its own scripts, injected inline styles, image/font sources, or its calls to the identity provider), the page can render blank or partially. The policy must be validated against the real application before it is enforced, and it may be introduced in a report-only observation mode first if confidence is low.
- **Header collision between surfaces**: the site-wide baseline headers and the stricter API headers set the same header names. The stricter API values must continue to win on the API surface; the baseline values must apply to the web/static surface. This precedence must be verified for both server-rendered HTML and static-asset responses.
- **Identity-provider origins differ by environment**: the set of origins the browser must be permitted to reach (e.g. the identity provider) differs between dev and production and must be derived from existing configuration, not hard-coded, so the policy is correct in every environment.
- **Agent streaming vs CORS change**: removing the cross-origin allowance must not strip or alter the headers the streaming interaction depends on.
- **Native mobile client**: browser security headers (content-security policy in particular) do not apply to the native client; the change must have no effect on mobile behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST return an **enforcing** content-security policy on every response that delivers browser-rendered HTML (the application shell), and that policy MUST permit the web application's own scripts, styles, fonts, images, and its network calls to the backend-for-frontend and the identity provider, such that the application renders and functions with no browser-reported policy violations. The delivered state MUST be an enforcing policy — a report-only policy is permitted only as a development-time discovery aid and MUST NOT be the shipped state.
- **FR-002**: The content-security policy on the browser-rendered surface MUST include an anti-clickjacking directive (frame-ancestors restriction), and the application MUST additionally return a dedicated anti-clickjacking header for older browsers.
- **FR-003**: The application MUST return a content-type-sniffing protection header on browser-rendered HTML responses and on static-asset responses.
- **FR-004**: The application MUST return a referrer policy on the browser-rendered surface.
- **FR-005**: The application MUST NOT loosen the existing strict content-security policy that governs the JSON API surface; the API surface MUST retain its current strict policy after this change.
- **FR-006**: Where the site-wide baseline headers and the API-surface headers share a header name, the API-surface value MUST take precedence for API responses and the baseline value MUST apply to the browser-rendered and static-asset surfaces. This precedence MUST hold for both server-rendered HTML responses and static-asset responses.
- **FR-007**: The set of external origins the content-security policy permits the browser to reach (e.g. the identity provider) MUST be derived from existing environment configuration rather than hard-coded, so the policy is correct across dev, CI, and production.
- **FR-008**: The agent endpoint MUST NOT advertise a cross-origin access allowance at all — the cross-origin allowance header MUST be removed entirely (the web client and backend-for-frontend are same-origin, so none is needed). It MUST NOT return a wildcard allowance nor an unconditionally reflected request origin.
- **FR-009**: Restricting the agent endpoint's cross-origin allowance MUST NOT alter or remove the headers required for the agent's streaming interaction; the streaming agent flows MUST continue to work.
- **FR-010**: The application MUST NOT return a response header that discloses the underlying server framework/technology.
- **FR-011**: The transport-security (HSTS) header MUST be present on the production HTTPS edge and MUST NOT be emitted on the plain-HTTP dev/CI surface. This HSTS edge change is in scope for this feature, and its production verification MUST be completed before the feature is considered done (it may still be delivered as a separable step, but it gates completion).
- **FR-012**: The confirmed scan false positive (timestamp-shaped values within the compiled client bundle) MUST be suppressed from the scan pass/fail gate with a recorded justification and attribution, while remaining visible in the scan report output.
- **FR-013**: This change MUST be additive hardening only — it MUST NOT change authentication, authorization, or session behavior, and the existing per-request auth on the API surface MUST remain unchanged.
- **FR-014**: The remediation MUST be verified by re-running the DAST baseline scan and confirming the remediated findings (missing content-security policy, missing anti-clickjacking header, missing content-type-sniffing header, server technology disclosure, permissive cross-origin allowance) are no longer reported, and the false positive is suppressed but still listed.
- **FR-015**: The remediation MUST be covered by an automated test that asserts the presence of the baseline security headers on a non-API (browser-rendered) response and on a static asset, and the absence of the technology-disclosure header, written to fail before the change and pass after it.

### Key Entities

- **Baseline security header set**: the group of HTTP response headers applied site-wide to browser-rendered pages and static assets — content-security policy (web-app variant), anti-clickjacking directive/header, content-type-sniffing protection, and referrer policy.
- **API strict header set**: the existing, stricter set of security headers applied to the JSON API surface (a JSON-only content-security policy), which must remain authoritative for API responses.
- **Web-served surface**: the two response classes that currently lack the baseline headers — the server-rendered application shell (HTML) and the static assets — as distinct from the JSON API surface that already carries strict headers.
- **Agent endpoint cross-origin policy**: the cross-origin access allowance header emitted by the agent endpoint, to be removed entirely (same-origin app needs none).
- **Scan allowlist entry**: the recorded suppression of the confirmed false-positive finding — its rule identifier, the scope it applies to, a justification, and attribution — kept in the scan configuration so the gate ignores it while reports still show it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the change, a re-run of the DAST baseline scan reports zero occurrences of the five remediated findings (missing content-security policy, missing anti-clickjacking header, missing content-type-sniffing header, server technology disclosure, permissive cross-origin allowance) on the scanned surface.
- **SC-002**: 100% of the existing web end-to-end regression scenarios continue to pass with the content-security policy enforced, and a manual browser load of the application produces zero content-security-policy violations in the browser console.
- **SC-003**: Every browser-rendered page response and every static-asset response carries the applicable baseline security headers (measured across the scanned surface: 0 responses missing a required header).
- **SC-004**: The JSON API surface retains its strict content-security policy — 0 API responses show a loosened policy after the change.
- **SC-005**: The agent conversation and action flows pass their end-to-end checks unchanged after the cross-origin restriction (0 regressions in the agent flows), and the agent endpoint returns no cross-origin allowance header at all.
- **SC-006**: The confirmed false-positive finding is absent from the scan gate result yet present in the scan report (suppressed, not deleted).
- **SC-007**: The transport-security header is present on the production HTTPS edge and absent on the plain-HTTP dev/CI surface (verified in both).
- **SC-008**: Mobile end-to-end flows are unaffected (0 regressions), confirming the web-only headers do not change native behavior.

## Assumptions

- The injection point for the site-wide baseline headers is the existing server-side layer that already stamps a custom marker header on every response class (static, server-rendered HTML, and API) — the mechanism proven to reach all three surfaces. Global framework middleware at the routing layer is NOT a viable mechanism in the current runtime and is deliberately not used (documented runtime gap from a prior feature).
- The web client and the backend-for-frontend are the same origin, so no permissive cross-origin allowance is functionally required by the application.
- The production edge terminates HTTPS via a reverse proxy, which is the correct and only place to emit the transport-security header; the dev/CI surface is plain HTTP, where the header is meaningless and intentionally omitted.
- The identity-provider origin(s) the browser must reach are already available in existing environment configuration and can be sourced from there for the content-security policy.
- A content-security policy may be exercised in report-only observation mode during development to discover violations, but the delivered/shipped state MUST be an enforcing policy (report-only is never the final state). See Clarifications.
- The timestamp-shaped values flagged inside the compiled client bundle are confirmed to be build artifacts, not secrets, and are therefore a legitimate false positive to suppress.
- Rewriting the already-compliant API-surface security headers is out of scope; re-attempting routing-layer middleware centralization is a separate follow-up and out of scope; active-scan-only and non-BFF (gateway/backend-service) findings are out of scope, as the passive baseline reported none of note on those surfaces.
