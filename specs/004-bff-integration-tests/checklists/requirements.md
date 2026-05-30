# Specification Quality Checklist: BFF Integration Test Replacement

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-30 (revalidated after incorporating research bundle)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Tooling has been **scrubbed** from `spec.md` to capability terms (identity provider, session store, direct-credential grant, client-side HTTP mock, token-validation / session-management / rate-limiting modules, current-user/refresh/logout/registration endpoints). Concrete tooling (Keycloak, Redis, ROPC/Direct Access Grants, `axios-mock-adapter`, `ioredis`, module/file names) lives in `plan.md` per the constitution's spec/plan separation. Retained as agnostic-and-appropriate: "BFF", "SSO session", standard token-claim names, and the `mc-user`/`mc-admin` application roles.
- Developer-infrastructure feature; no production code changes (one Keycloak config change — a test-only ROPC client). Confirmed in Clarifications/Assumptions.
- **Scope reframing vs the initially-generated draft**: the research bundle reframes this feature as **replacing the existing mock-based (`axios-mock-adapter`) auth/session/token/rate-limiter integration tests with real ones** — not the collection/movie-proxy-route gap my generated draft assumed. The research finding (the current tests verify nothing real) is the authoritative scope; the collection/movie proxy routes are **not** covered here and remain a separate potential follow-up.
- Dependency: feature **003-test-hardening** (merged) — PKCE code exchange is intentionally out of scope here because it's covered by 003's Playwright global setup; the 003 `cleanup-e2e-data.ts` script is reused/extended for orphaned `int-*` test users.
- **Verify during `/speckit-plan`/`/speckit-tasks`**: the plan requires a manual Keycloak change (a `mcm-bff-test` ROPC client with Direct Access Grants) and Redis db-1 isolation via the Jest config — both are test-environment setup, not production code.
