# Implementation Plan: Clean Expo Router

**Branch**: `010-clean-expo-router` | **Date**: 2026-06-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/010-clean-expo-router/spec.md`

## Summary

Three boundary-hardening changes in the **mcm-app frontend/BFF only** (no mc-service changes):

1. **US1 — Routing correctness**: guarantee `GET …/movies/filter-options` is served by its dedicated handler, never by the dynamic `[movieId]` handler, and lock it with a regression test. Keep the permissive `validateObjectId` whitelist.
2. **US2 — Observable error boundary**: extend `handleMcApiError` to emit a structured `warn` log for every 4xx (not only 401/403), preserving the existing 401/403 audit events and redaction.
3. **US3 — Centralized access-control gate**: introduce an Expo Router `src/app/+middleware.ts` server middleware that rejects unauthenticated requests to protected `/bff-api/*` routes before any handler runs — bringing the BFF into line with the constitution's **Centralized Access Control** principle. Begins with a viability spike (alpha API); descopes cleanly to a follow-up if the capability proves unsuitable (US1/US2 unaffected).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 24 LTS (BFF runtime)

**Primary Dependencies**: Expo SDK 56, `expo-router` ~56.2.8 (incl. `expo-router/server` middleware — alpha, gated by `unstable_useServerMiddleware`), Axios (mc-service client), existing `@/bff-server/logger`, `@/bff-server/security-headers`, `@/bff-server/auth`

**Storage**: N/A (no new persistence; Redis session store is reused as-is by the gate's auth check)

**Testing**: Jest (unit + BFF integration via `jest.integration.config.js`), Playwright (web E2E). No new mobile (Maestro) flow (per clarification — gate verified server-side).

**Target Platform**: Web (React Native Web served by `@expo/server`) + Android; BFF runs server-side in the Node container and under Metro in dev.

**Project Type**: Universal frontend app (mcm-app) with an Expo Router API-route BFF.

**Performance Goals**: No measurable added latency on the request path; the gate is an O(1) cookie/token presence + signature check already performed today per-handler.

**Constraints**: `+middleware.ts` runs **web/server HTTP only**, the request object is **immutable** (cannot mutate headers or inject downstream context), and the capability is **alpha** (`unstable_*`). The gate is therefore a deny-by-default guard, not a context provider; per-handler `requireAuth`/`requireMcUser` remain for user-object derivation and resource authorization.

**Scale/Scope**: ~4 BFF proxy route files (US1 guard surface), 1 shared error handler (US2), 1 new middleware file + config (US3), plus tests. No data model, no API-spec (OpenAPI) change — the affected routes are BFF routes, not mc-service `/api/v1` endpoints.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
| --- | --- | --- |
| **Security → Authorization → Centralized Access Control** | ✅ Advanced toward compliance | The constitution states per-handler opt-in auth is non-compliant ("a handler added without the opt-in is silently unprotected"). Today the BFF relies solely on per-handler `requireAuth` — non-compliant. US3's `+middleware.ts` gate makes protected `/bff-api/*` deny-by-default **without** per-handler code, satisfying the test: "remove all auth code from a handler → still inaccessible unauthenticated." |
| **Security → Input Validation (whitelist)** | ✅ Preserved | US1 keeps the safe-character `validateObjectId` whitelist (FR-004); no reversion to strict format. |
| **Security → Safe Error Responses** | ✅ Preserved | US2 adds internal logging only; external responses still carry no internals (unchanged response bodies). |
| **Logging & Monitoring → Sensitive Data Prohibition / Structured / Severity** | ✅ Compliant | New 4xx logs are structured `warn` via `@/bff-server/logger` (auto-redaction), carry `action`/`statusCode`/`requestId`, and exclude tokens/PII (FR-008). 401/403 remain `audit`. |
| **TDD (NON-NEGOTIABLE)** | ✅ Planned | Every change is RED→GREEN; tasks.md will carry Verify RED/GREEN. |
| **Test Type Integrity** | ✅ Planned | Gate enforcement verified by a real-dependency BFF integration test (no mocking the gate); routing guard by unit/integration; no `jest.mock` of the gate in `tests/integration/`. |
| **Specification-First (API-specs)** | ✅ N/A justified | No mc-service `/api/v1` contract changes; the touched routes are BFF Expo Router routes (not in `/api-specs`). Recorded in research R4. |
| **AI Constraints → Behavior-Descriptive Identifiers** | ✅ Compliant | New symbols named behaviorally (e.g., `isPublicBffRoute`, `requireAuthenticatedRequest`); requirement IDs live in JSDoc only. The file name `+middleware.ts` is a framework-mandated external contract (exempt, annotated). |
| **Frontend Separation of Concerns (BFF-Layer)** | ✅ Compliant | Gate logic and the public-route allowlist live under `src/bff-server/`; `+middleware.ts` (App-Layer entry) is a thin delegator into a `bff-server` helper. |

**Result**: PASS. US3 net-improves constitution compliance; no violations to justify. Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/010-clean-expo-router/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (no new entities — records why)
├── quickstart.md        # Phase 1 output (verification runbook)
├── contracts/
│   └── contract-deltas.md   # Behavioral contract deltas (routing, error logging, gate)
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── app.json                                    # US3: add expo-router plugin { unstable_useServerMiddleware: true }
├── src/
│   ├── app/
│   │   ├── +middleware.ts                       # US3: NEW — server-side pre-route gate (delegates to bff-server)
│   │   └── bff-api/
│   │       └── collections/[collectionId]/movies/
│   │           ├── filter-options+api.ts        # US1: dedicated handler (target of routing guarantee)
│   │           ├── [movieId]+api.ts             # US1: must NOT receive "filter-options"
│   │           └── index+api.ts                 # (sibling; unaffected)
│   └── bff-server/
│       ├── mc-api-error.ts                      # US2: log all 4xx, not only 401/403
│       ├── bff-route-access.ts                  # US3: NEW — public-route allowlist + gate decision helper
│       └── auth.ts                              # US3: reused for the gate's token check
└── tests/
    ├── app/bff-api/collections/
    │   └── filter-options-routing.test.ts       # US1: regression guard (filter-options not shadowed)
    ├── unit-tests or app/                       # US2: handleMcApiError 4xx-logging unit test
    └── integration/
        ├── bff-gate.integration.test.ts         # US3: unauthenticated protected route rejected at gate; public route passes
        └── bff-gate-coverage.integration.test.ts# US3: safeguard — fails if gate disabled / stops matching /bff-api/*
```

**Structure Decision**: Frontend-only change confined to `frontend/mcm-app`. The gate's entry point is the framework-mandated `src/app/+middleware.ts` (App-Layer), but all decision logic lives in `src/bff-server/` (BFF-Layer) per the constitution's separation of concerns — `+middleware.ts` is a thin delegator so the policy is unit-testable without the framework.

## Phase 0 — Research

See [research.md](research.md). Resolves: the route-shadowing mechanism (R1), the 4xx-logging design (R2), the `+middleware.ts` gate design and its alpha/immutability constraints (R3), and the no-API-spec-change justification (R4).

## Phase 1 — Design & Contracts

- [data-model.md](data-model.md) — confirms no new entities; documents the in-memory "gate decision" and "public-route allowlist" as transient constructs only.
- [contracts/contract-deltas.md](contracts/contract-deltas.md) — the three behavioral contracts: filter-options routing, 4xx error-boundary logging, and the centralized gate (request/response behavior + allowlist).
- [quickstart.md](quickstart.md) — how to verify each user story locally (Metro + dev container), including the gate spike checklist.
- Agent context: the `<!-- SPECKIT … -->` block in `CLAUDE.md` is updated to point at this plan.
