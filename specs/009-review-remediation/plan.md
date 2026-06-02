# Implementation Plan: Full-Repo Review Remediation

**Branch**: `009-review-remediation` | **Date**: 2026-06-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-review-remediation/spec.md`

## Summary

Remediate nine confirmed review findings (#1, #3, #4, #5, #6, #7, #8, #9, #10) plus a batch of five lower-severity confirmed gaps, spanning the Expo BFF (server + client) and the `mc-service` Rust backend. Finding #2 (cross-tenant IDOR) is **out of scope** per the 2026-06-02 clarification. Each fix is behavior-correcting (security, data-integrity, or accuracy) and is delivered test-first: a test that fails on the current behavior and passes after the fix (FR-023), with the full existing suite kept green (FR-024). No new frameworks, dependencies, or architectural layers are introduced — every fix reuses the existing validation, access-control, session, error-handling, and Specification mechanisms.

Technical approach by area:
- **BFF server** (`src/bff-server/`): correct the session Redis TTL to back the configured idle/absolute policy (#3); derive the rate-limit client identity from a configured trusted proxy else the connection address (#4); guard `JSON.parse` of cached values and clamp the password score (hardening); make concurrent-session eviction atomic (hardening).
- **BFF API routes** (`src/app/bff-api/`): authenticate before any session side effect and act only on the caller's own session (#9); add a per-source registration throttle (#8); report email-verification's true outcome (#7); validate resource identifiers at the route boundary (#10).
- **BFF client** (`src/components/`, `src/utils/`): refuse non-`http(s)` link schemes before opening (#1, defense-in-depth).
- **mc-service**: enforce the external-identifier scheme allowlist + required-field + duplicate validation on the create/update path (#1, hardening); preserve `createdAt` on movie update (#5); make set-default validate-before-mutate and atomic (#6); reject malformed pagination cursors (hardening).

## Technical Context

**Language/Version**: TypeScript (Expo SDK 56 / React Native 0.85 / React 19.2) for `mcm-app`; Rust (Edition 2021, Axum + Tokio) for `mc-service`. Both are in scope.

**Primary Dependencies**: None added. Existing only — Expo Router API routes (`@expo/server`), `ioredis`, Axios, Node `crypto`; Axum, `axum-keycloak-auth`, `medi-rs`, `mongodb` crate, `serde`. New behavior is implemented with these.

**Storage**: MongoDB (`mc_db`: `movie_collections`, `movies`) via the `mongodb` crate; Redis (BFF sessions, profile cache, rate-limit counters) via `ioredis`. Changes touch the movie-update write, the movie uniqueness/cursor reads, and the session/rate-limit key TTLs — **no schema migration** (the movie uniqueness index is untouched because #2 is out of scope).

**Testing**: Jest (mcm-app unit + integration against real Keycloak/Redis/mc-service), Playwright (web E2E), Maestro (mobile E2E); `cargo test` unit (inline `#[cfg(test)]`) + integration (`tests/integration/`, real replica-set MongoDB) via Nx. Per the constitution's TDD checkpoint format, every test task carries a Verify RED and paired Verify GREEN.

**Target Platform**: Web + Android (Expo app); Linux container (`mc-service`).

**Project Type**: Polyglot monorepo (Expo frontend + Rust backend). This is a **security/correctness remediation** feature — no new user-facing capability.

**Performance Goals**: N/A — fixes are correctness-oriented and must not regress existing latency. The createdAt fix prefers a targeted `$set` update over read-modify-write to avoid an extra round-trip and a race.

**Constraints**: Behavior-correcting but otherwise minimal-surface; fail-safe for all session/auth changes (never leave an expired session usable, never open a non-allowlisted scheme); cross-tenant access continues to return 404 (existing behavior); RFC 9457 problem responses for new client errors; no secrets/PII in logs. New server-side config: a `TRUSTED_PROXY` (BFF) env var gates whether forwarding headers are trusted; default off ⇒ connection-address rate-limit identity (documented in the CLAUDE.md Configuration table).

**Scale/Scope**: ~14 source files across both projects, each a localized change. 9 findings + 5 hardening items = 14 remediations, grouped into 6 user stories (US1–US6).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

This feature **enforces** existing constitutional principles that the current code under-satisfies. Relevant gates:

| Principle | Status | Notes |
|---|---|---|
| Security → **Input Validation** (server-side whitelist, strict format) | ✅ Strengthened | #1 adds an `http/https` scheme allowlist on the create/update path; #10 adds ObjectId-format validation at the BFF boundary; hardening adds required-field + cursor validation. |
| Security → **Output Encoding** (prevent XSS) | ✅ Strengthened | #1 client guard refuses `javascript:`/`data:` before navigation; server rejects them at persistence. |
| Security → **Authorization / Deny By Default** | ✅ Strengthened | #9 authenticates before any session side effect and acts only on the caller's own session. |
| Security → **Centralized Access Control** | ⚠️ Consistent w/ existing arch | The BFF uses per-handler `requireAuth`/`requireMcUser` inside a `withRequestContext` wrapper (Expo Router has no global pre-route middleware); #9 corrects ordering within that pattern. mc-service keeps the compliant Tower-layer model. A broader centralization is **not introduced or regressed** here — out of scope. |
| Security → **Infrastructure Hardening / Rate Limiting** (per IP) | ✅ Strengthened | #4 makes the per-IP identity non-spoofable and avoids global lockout; #8 adds the missing per-source registration throttle. |
| Security → **Session Management / Invalidation** | ✅ Strengthened | #3 makes enforced timeouts match policy while remaining fail-safe; #9 keeps logout terminating only the owner's sessions; eviction hardening enforces the concurrent-session cap. |
| Security → **Safe Error Responses** (RFC 9457, no internals) | ✅ Aligned | #10 + cursor hardening return clean client errors instead of opaque upstream 500s. |
| **Clean Architecture** (mc-service 4-layer; Specification for validation) | ✅ Aligned | #1 scheme/required-field validation lives in the Domain-Layer via Specifications, enforced by Application-Layer handlers; #5/#6 changes stay in Adapters/Application; no layer inversion. |
| **TDD (NON-NEGOTIABLE)** + checkpoint format | ✅ Aligned | FR-023/FR-024 mandate fail-first tests per finding and a green full suite; tasks.md will carry Verify RED/GREEN. |
| **Test Type Integrity** + real-dependency integration | ✅ Aligned | Session-TTL, rate-limit, and verify-email assertions go against real Redis/Keycloak (no mocking in `tests/integration/`). |
| **API-First / Specification-First** | ✅ Followed | mc-service behavioral changes (createdAt, set-default, cursor 400, validation) update `/api-specs` OpenAPI before implementation. |
| **Behavior-Descriptive Identifiers** (v1.5.0) | ✅ Aligned | New helpers/specs are named for behavior (e.g., `http-url`, `required-string`); requirement IDs go in comments only. |

**Result: PASS — no violations.** Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/009-review-remediation/
├── plan.md              # This file
├── research.md          # Phase 0 — per-finding HOW decisions
├── data-model.md        # Phase 1 — affected entities + validation/field rules
├── quickstart.md        # Phase 1 — per-finding verification runbook
├── contracts/
│   └── contract-deltas.md  # Phase 1 — behavioral contract changes per endpoint
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root) — files in scope

```text
frontend/mcm-app/src/
├── bff-server/
│   ├── cache-service.ts          # #3 session TTL = remaining absolute lifetime; FR-021 JSON.parse guard
│   ├── session-manager.ts        # FR-018 atomic concurrent-session eviction
│   ├── rate-limiter.ts           # #4 trusted-proxy + connection-IP identity (FR-007/008)
│   └── unit-tests/               # co-located unit tests for the above
├── app/bff-api/auth/
│   ├── user+api.ts               # #9 requireAuth before validateSessionTimeout (FR-004/005)
│   ├── logout+api.ts             # #9 terminate only the authenticated caller's session
│   ├── register+api.ts           # #8 per-source registration throttle (FR-009)
│   └── verify-email+api.ts       # #7 report true verification outcome (FR-016)
├── app/bff-api/collections/      # #10 validate collectionId/movieId at boundary (FR-017)
│   ├── [collectionId]/index+api.ts
│   └── [collectionId]/movies/{index,[movieId],filter-options}+api.ts
├── utils/
│   ├── validators.ts             # FR-020 password score clamp 0–4
│   └── (new) http-url.ts         # #1 shared http/https scheme guard (+ unit-tests/)
└── components/
    └── movie-detail.tsx          # #1 client openUrl scheme guard (FR-003)

backend/mc-service/src/
├── domain/
│   ├── external_id.rs            # #1 scheme allowlist constructor/validation
│   └── specifications/           # #1 http-url spec; FR-022 required-string spec (new files)
├── application/commands/
│   ├── create_movie.rs           # #1 external-id + FR-022 required-field validation
│   ├── update_movie.rs           # #1 + FR-022 validation
│   ├── set_default_collection.rs # #6 validate-before-clear, atomic
│   └── update_collection.rs      # #6 atomic set-default + update
├── api/
│   ├── collections/update.rs     # #6 ordering/atomicity at handler
│   └── movies/list.rs            # FR-019 malformed-cursor → 400
└── adapters/mongodb/
    └── movie_repository.rs       # #5 preserve createdAt on update; FR-019 cursor decode → error

api-specs/                        # Specification-First: mc-service OpenAPI deltas
```

**Structure Decision**: No new projects or layers. Changes land in the existing BFF-Layer (`bff-server`, `bff-api`), Components-Layer, Utils-Layer of `mcm-app`, and the Domain/Application/Adapters/API layers of `mc-service`. New artifacts are a shared client URL guard (`utils/http-url.ts`) and two Domain Specifications (`http-url`, `required-string`), all named for behavior per v1.5.0.

## Complexity Tracking

> No constitution violations — section intentionally empty.
