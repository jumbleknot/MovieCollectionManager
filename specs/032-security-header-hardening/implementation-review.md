# Implementation Review — Feature 032: Security Header Hardening (DAST remediation)

**Reviewed**: 2026-07-10 · **Branch**: `032-security-header-hardening` (HEAD `b80a877` + review fixes) · **Reviewer**: Claude (Opus 4.8)

**Scope reviewed**: the branch diff vs `main` — `frontend/mcm-app/{server.js, web-security-headers.js, web-security-headers.test.js, Dockerfile}`, `src/app/bff-api/agent/run+api.ts`, the two new web E2E specs, `security/zap/allowlist.yaml`, and the SDD artifacts.

**Verdict**: Implementation is **high quality, secure, and spec-aligned**. The review introduced **no functional behavior change** — three small correctness/traceability fixes and one defensive robustness fix, all verified green.

---

## Part 1 — Code & Security Review

### Step 1 — Best practices (per tech stack)

The changed surface is entirely TypeScript / CommonJS Node (Express adapter) + Playwright/Jest. No Rust, no mc-service change. Assessment:

| Area | Finding |
|---|---|
| `web-security-headers.js` | Pure, side-effect-free, `Object.freeze`d constants, well-documented governing-requirement provenance in JSDoc, isolated unit test. Idiomatic. |
| `server.js` | CSP computed **once at boot** (not per request); single `app.use` alongside the proven `X-BFF-Source` layer; path-scoping is deterministic (no reliance on adapter merge order). Correct injection point given `@expo/server` ignores `+middleware.ts`. |
| `run+api.ts` | CORS strip is a minimal post-processing delete on the returned `Response`; streaming body untouched; happens **after** the `requireAuth`/`requireMcUser` gate. Matches the route's existing response-wrapping pattern. |
| `Dockerfile` | Correctly adds `COPY web-security-headers.js` to the runtime stage (which copies source files individually — omission would crash the container at boot on `require`). |
| Tests | Real RED→GREEN TDD; assertions bound to the contract; public-route E2E opts out of shared auth state correctly. |

**One robustness gap found and fixed** (defensive, not a live bug — env is trusted):

- `resolveKeycloakOrigin()` claimed in its JSDoc that a malformed value "never contains a broken token", but `new URL('localhost:8099')` and `new URL('file:///…')` **do not throw** — they yield the opaque origin string `"null"`, which would emit a broken `connect-src 'self' null` for a scheme-less or non-web env value. **Fix**: require an `http:`/`https:` protocol explicitly and fall back otherwise; added a unit test covering scheme-less and `file:` inputs. Aligns code with its documented contract.

**Verification**: `pnpm nx lint mcm-app` → **0 errors** (9 pre-existing warnings in unrelated test files). `pnpm nx test mcm-app` → **1127/1127 pass** (was 1126; +1 new test).

### Step 2 — Security review (`/security-review`)

Ran a dedicated security sub-agent over the full branch diff (all five code files + the pre-existing `security-headers.ts` and the DAST gate).

**Result: no high-confidence security vulnerabilities newly introduced.** Every change moves in a hardening (more-restrictive) direction:

- **CORS delete** only *removes* CopilotKit's default `Access-Control-Allow-Origin: *` — strictly more restrictive, cannot open a cross-origin path; same-origin so browsers ignore it anyway; does not touch `Set-Cookie`/`Authorization`/session/body.
- **CSP path-scoping** uses Express-normalized `req.path` (query-stripped) — no path-confusion bypass; CSP is a browser hardening directive, not an authz control.
- **Web CSP strength** — hash-only `script-src` (no `unsafe-inline`/`unsafe-eval`), `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` + `X-Frame-Options: DENY`. No exploitable XSS/clickjacking gap opened. The accepted `style-src 'unsafe-inline'` / `img-src https:` residuals are non-script Mediums.
- **`connect-src` origin** — derived from trusted env, normalized via `URL.origin` (path/query stripped), safe fallback. No injection.
- **allowlist** — scoped to `pluginId 10096` **and** `/_expo/static/.*`; gate still fails on any un-allowlisted High. No security control weakened.

### Step 3 — Unused files / directories

No unused or orphaned files were introduced. Every added file is wired: `web-security-headers.js` is `require`d by `server.js` and `COPY`ed in the Dockerfile; the two `.test.js`/`.spec.ts` files run under Jest/Playwright; the spec artifacts are standard SDD outputs. The two `HANDOFF*.md` are transient workflow docs — intentional and harmless while the merge is pending (left in place).

---

## Part 2 — Learning

### Issues encountered and fixed during this review

| # | Type | Issue | Fix |
|---|---|---|---|
| 1 | Robustness (code↔contract mismatch) | `resolveKeycloakOrigin` returned `"null"` for scheme-less / non-web origins instead of falling back — `new URL()` doesn't throw for those. | Require `http:`/`https:` protocol explicitly; added unit test. |
| 2 | Provenance typo | `server.js` comment cited **FR-004** (Referrer-Policy) as governing the `X-Powered-By` drop; correct requirement is **FR-010** (tech-disclosure). | Corrected comment to FR-010. |
| 3 | Traceability | `plan.md`/`research.md` still showed the generic starting CSP; the final hash-only `script-src` + `form-action` lived only in the contract. | Added a back-pointer in plan.md Summary to the settled contract CSP. |

No production bugs, no security flaws, no non-compliance were found in the shipped implementation — it was already CI-green and correct. The above are polish/defensive.

### Artifact improvements applied (to reach working code faster next time)

- **`data-model.md`** — the CSP validation rule said only "a malformed value falls back"; it did **not** capture the exact `new URL()` → origin `"null"` gotcha that caused issue #1. Strengthened the rule to require an `http:`/`https:` origin and to document the parser behavior, so a future re-implementation gets it right the first time. *(This is the single artifact under-specification that directly led to a code gap.)*
- **`plan.md`** — added the final-CSP back-pointer (issue #3).
- **Private memory** (`project_mcm_032_…`, `MEMORY.md`) — recorded the review outcome and the `URL`→`"null"` lesson durably.

**Not changed (assessed, no gap):** `constitution.md` (§Security Headers/CORS/HSTS fully satisfied — this feature advances it), `spec.md`/`tasks.md` (100% requirement→task coverage, TDD checkpoints, parity table all present and correct), `CLAUDE.md` (already documents the `+middleware.ts` gap and dev-container-serves-prod-bundle facts this feature relied on).

**Recommendation (non-blocking, deferred):** `docs/MCM-Architecture.md` has **no** security-header/CSP subsection despite the BFF now enforcing a site-wide CSP + strict API CSP. A short "BFF security response headers" subsection there would improve architectural discoverability. Left for a docs follow-up — out of scope for this remediation feature.

---

## Part 3 — Spec Alignment (`/speckit-analyze`)

Cross-artifact consistency analysis of `spec.md` ↔ `plan.md` ↔ `tasks.md` ↔ `constitution.md`:

- **Coverage**: 100% — all 15 FRs and 8 SCs map to ≥1 task; no unmapped tasks; no zero-coverage requirements.
- **Constitution**: no violations (TDD RED/GREEN checkpoints, Platform Parity table with justified N/A cells, behavior-descriptive identifiers).
- **Ambiguity/placeholders**: none (3 clarifications resolved in spec).
- **Findings**: 1 MEDIUM (FR-004→FR-010 comment mislabel — fixed) + 1 LOW (plan/contract traceability — fixed). 0 CRITICAL/HIGH.

**Metrics**: Requirements = 23 · Tasks = 14 · Coverage = 100% · Ambiguities = 0 · Duplications = 0 · Critical = 0.

---

## Part 4 — Summary & Final State

- **Code quality**: idiomatic, well-documented, correct injection point, deterministic path-scoping. ✅
- **Security**: no new vulnerabilities; uniformly hardening; auth path untouched. ✅
- **Unused files**: none introduced. ✅
- **Spec alignment**: 100% coverage; 2 minor inconsistencies fixed. ✅
- **Tests**: unit 1127/1127, lint 0 errors. Web E2E + DAST + mobile agent flows were validated CI-green pre-review; the review's only functional change (issue #1) is unit-covered and does not alter the shipped header values for any correctly-configured environment.

**Fixes applied on-branch during review** (uncommitted): `web-security-headers.js` (+ test), `server.js` comment, `plan.md`, `data-model.md`. These should be committed to the `032-security-header-hardening` branch before/with the pending PR #52 merge.

**No open issues.** Feature 032 is ready to merge (the only gate remains the human-authorization requirement for the self-authored-PR → auto-prod-deploy, per `HANDOFF-MERGE.md`).
