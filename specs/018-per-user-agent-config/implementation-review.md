# Feature 018 — Implementation Review

**Date**: 2026-06-19 · **Branch**: `018-per-user-agent-config` · **Reviewer**: Claude (Opus 4.8)

Scope: a full implementation review of the per-user agent config feature (opt-in, bring-your-own-credentials assistant; AES-256-GCM per-user BFF→Mongo store; per-run credential injection into the LangGraph gateway + MCP servers). This is the **second** review pass — the feature had already been through a high-effort review (Phase 11, 10 fixes) and a Vault rescoping. This pass found **one new HIGH security finding** (an SSRF bypass) plus a handful of best-practice polish items, all fixed below.

## Verdict

Production-quality. No Critical/High **correctness** bugs. One **HIGH security** finding (SSRF metadata-block bypass via IPv4-mapped IPv6) — **fixed**. The auth/scoping, crypto (AES-GCM + AAD), secret redaction, ContextVar isolation, header-smuggling, and NoSQL-injection surfaces all verified secure.

## Part 1 — Code & Security Review

### Step 1 — Best practices (per project)

Reviewed via stack-specific parallel passes: TS/BFF + React Native, and Python (LangGraph gateway + web-api-mcp). Baseline gates were green before and after: `tsc` clean, `nx lint mcm-app` 0 errors (9 pre-existing warnings), `ruff` clean, secret-scan green.

| # | Severity | Location | Finding | Fix |
|---|---|---|---|---|
| BP-1 | Medium | `movie-assistant-config.tsx` `handleSave` | A non-numeric personal cost limit (`Number('abc')` → `NaN` → JSON `null`) silently **wiped** the saved limit to "use default" with no field error. | Added a local numeric guard before save: non-empty + non-finite/≤0 → inline `costLimitUsd` field error, no PUT. |
| BP-2 | Medium | `movie-assistant-config.tsx` / `use-assistant-config.tsx` | `save()` collapsed 401/500 into the same opaque "could not save" banner. | Added `saveErrorMessage(outcome)` branching on `status` (401 → "session expired, sign in again"; ≥500 → "server problem"; else the per-field message). |
| BP-3 | Low/Nit | `agent-config-service.ts` `validateAndSave` | A malformed-type field (e.g. `{ anthropicKey: 123 }`) threw on `.trim()` → surfaced as a 500 rather than a clean per-field 400. | typeof-guard `anthropicKey`/`tmdbKey` before `.trim()`; strict-boolean `enabled` so a non-boolean can't coerce the assistant on. |
| BP-4 | Nit | `agents/.../state.py`, `token_leak_scan.py` | The SC-004 leak-scan markers are intentionally **container-level** (`agent_config`), not leaf-level (`tmdbKey`/`anthropicKey`) — correct today but a future flatten would slip a leaf past. | Added a clarifying comment documenting the container-level intent + the marker to add if `agent_config` is ever flattened. |

Items reviewed and **confirmed correct** (no change): Mongo `findOneAndUpdate` `$set`/`$setOnInsert` (no path conflict, removes read-after-write race); `validateAndSave` effective-config patch logic for every field; `runtime_env` provider-switch pin-dropping (no stale model id or stale `ANTHROPIC_API_KEY` survives); ContextVar set/reset discipline across all five scopes (no cross-request/task leak); TMDB-key scoping airtight (curator whole-node, search only around `web_search`; never to movie-mcp); `isBillableAgentRun` default-deny.

Not changed (deliberate, documented decisions): `escalation_or_base` latent guard; `import/first` lint warnings in `agent-rate-limiter.test.ts` (idiomatic `jest.mock`-before-import; matches the codebase's tolerated-warning baseline); `costWindowSeconds` coupling to the session timeout; the one-turn cost-ceiling off-by-one (estimate-based budget, intentional).

### Step 2 — Security review (`/security-review`)

Ran the multi-agent security review over the branch diff. **One HIGH-confidence finding**, fixed:

**SSRF — cloud-metadata block bypass via IPv4-mapped IPv6** (`agent-config-ssrf.ts`, confidence 9/10).
The guard must *always* block link-local/cloud-metadata (the one block the locked "bring-your-own-Ollama" policy still requires). It string-matched `URL.hostname`, but WHATWG `new URL()` canonicalizes `http://[::ffff:169.254.169.254]/` to hostname `::ffff:a9fe:a9fe` (hex), which the `/^::ffff:169\.254\./` regex never matches — so the IMDS/metadata endpoint was reachable by the BFF save/probe path with **no DNS prerequisite**. Verified empirically (`new URL('http://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'`).

- **Fix**: `isBlockedHost` now de-maps IPv4-mapped IPv6 (both the dotted `::ffff:a.b.c.d` and the canonical hex `::ffff:HHHH:HHHH`) to the embedded IPv4 before the link-local range check. Added regression tests (mapped metadata blocked; mapped loopback `[::ffff:127.0.0.1]` still allowed). `agent-config-ssrf` + `agent-config-probes` 14/14 green.
- **Residual (documented follow-up, not fixed here)**: enforcement is at the BFF save/probe only. The assistant runtime's Ollama fetch (Python `ChatOllama(base_url=…)`) does not re-run this guard, and the check does not resolve DNS — so a hostname that resolves into a blocked range (DNS rebinding) or a post-save DNS flip is not caught at run time. Fully closing this needs resolving + pinning the connect IP (or a Python-side guard). The `AGENT_OLLAMA_ALLOWED_HOSTS` allow-list is the multi-user mitigation today. Recorded in spec FR-026, SC-009, and `CLAUDE.md`.

**Verified secure (no finding):** auth/IDOR on every route (owning `userId` always from the validated session, never the body/query); AES-256-GCM with random 12-byte IV per op + 32-byte key + AAD bound to `${userId}:${field}` (cross-user/cross-field blobs fail authentication); secret redaction in `logger.ts` and the Python leak scan; the `X-Agent-Config`/`X-TMDB-Key`/`X-UI-Snapshot` headers are BFF-constructed server-side and not client-smugglable (gateway is on a private network); no NoSQL operator injection (`_id` is a session-derived string, patch fields are server-built); no-shared-fallback fail-closed (`resolve_anthropic_key`, `_tmdb_key()`).

### Step 3 — Unused files / directories

- `mcp-servers/web-api-mcp/src/secrets.py` + `tests/unit/test_secrets.py` + the `hvac` dep were already cleanly deleted (no-fallbacks/Vault-rescope commit `2168b62`); **no dangling imports** remain.
- The agent's own `agents/movie-assistant/src/secrets.py` survives intentionally (still used by `token_exchange.py` for `AGENT_GATEWAY_CLIENT_SECRET`).
- No tracked unused files. The only orphan is a gitignored, ephemeral `__pycache__/secrets.cpython-314.pyc` of the deleted module (not tracked, regenerated/cleaned by tooling, not importable as a sourceless `__pycache__` entry) — left as-is.

### Tests after fixes (all green)

`tsc` clean · `nx lint mcm-app` 0 errors · `nx test mcm-app` **1104 passed** · web-api-mcp unit passed · `movie-assistant` unit **833 passed / 2 skipped** · `ruff` clean · `secret-scan --selftest` + full scan green. (Integration + web/mobile E2E require live infra/CI — unchanged by these edits; the SSRF + service fixes are covered by the unit suites.)

## Part 2 — Learning

**What broke / was non-compliant, and why:**

1. **SSRF canonicalization gap (the only real flaw).** Root cause: the guard reasoned over the *raw hostname string* rather than the *canonicalized IP*. The artifacts correctly required blocking metadata (FR-026/SC-009) but never stated the **canonicalization requirement** — and FR-026 over-claimed enforcement "on the runtime call" when only the BFF save/probe is guarded. A spec that had said "check the canonicalized address; account for IPv4-mapped IPv6; the runtime fetch is/ isn't in scope" would have caught both the bug and the over-claim at design time.
2. **UI input-validation gaps (cost limit, save-error UX) and a missing body type-guard** were minor robustness misses, not artifact gaps — the kind of polish a second review is for.

**Artifact improvements applied:**

- **`spec.md`** — FR-026 reworded: require the check on the **canonicalized** address (de-map IPv4-mapped IPv6), scope enforcement honestly to the BFF save/probe, and record the runtime/DNS-rebinding residual as a follow-up. SC-009 extended to name the mapped-IPv6 case.
- **`tasks.md`** — Completion Checklist extended with **SC-009/SC-010/SC-011** (added to the spec in the post-review pass but never traced into the checklist — the one `/speckit-analyze` finding).
- **`CLAUDE.md`** — new durable "Non-Obvious Design Decisions" entry: *SSRF host checks must use the canonicalized IP, not the hostname string* (with the `::ffff:` canonicalization gotcha and the BFF-only/no-DNS scope), so the next URL-allowlist author doesn't repeat it.

No `constitution.md` or `MCM-Architecture.md` change needed — the lessons are feature-level, and the constitution's Secrets/Encryption/Access-Control principles already cover the feature (plan's Constitution Check is all-PASS).

## Part 3 — Spec Alignment (`/speckit-analyze`)

100% requirement→task coverage (FR-001…030, SC-001…011); no unmapped tasks; all T001–T112 checked. No constitution violations (the one ⚠️ is the pre-existing Expo-Router middleware gap with its CI-enforced `AGENT_ROUTES` compensating control). Findings: **one MEDIUM traceability gap** — tasks.md Completion Checklist omitted SC-009/010/011 — **fixed**; the FR-026 runtime-call wording inconsistency was resolved by the Part 2 spec edit. No code changes; tests remain green.

## Residual / follow-ups (not blocking PR)

1. **SSRF runtime-path + DNS** (above): guard the Python `ChatOllama` fetch and/or resolve-and-pin the connect IP to fully satisfy FR-026 against DNS rebinding. `AGENT_OLLAMA_ALLOWED_HOSTS` mitigates for multi-user today.
2. **Mobile E2E (SC-007 leg)**: four Maestro flows authored + registered; green run gated on mobile-CI provisioning (**issue #16**).
3. **`AGENT_CONFIG_ENC_KEY` from Vault**: the BFF reads the master key from env; Vault-injected-env at deploy is the recommended prod-hardening (documented in `docs/PRD-Vault.md`, decision deferred to prod hardening).
4. Optional: unify the `testStored` result keys (`ollama`/`anthropic`/`tmdb`) with the `ProbeField` vocabulary (`ollamaBaseUrl`/`anthropicKey`/`tmdbKey`).

## Addendum — dedicated BFF MongoDB instance (Decoupling remediation, 2026-06-19)

A follow-up architecture pass (triggered by reviewing the MCM-Architecture diagram) found the BFF persisting `user_agent_config` to **mc-service's `mc-db` instance** (reused for convenience). That is **direct database access across a service boundary — a constitution §Decoupling violation** ([constitution.md:147](../../.specify/memory/constitution.md#L147)) — and couples the BFF's deploy/scaling to a backend service's database. The architecture diagram had also never been updated to show the BFF's store at all.

**Fix**: the BFF now owns a **dedicated, standalone `mcm-bff-db` MongoDB instance** (host port `27018`, db `bff_db`), separate from `mc-db` — mirroring the BFF's already-separate Redis cache. It is a plain `mongod` (no replica set, no `directConnection`) because the BFF store does single-doc upserts only; this also **retires the `directConnection=true` gotcha** that existed solely because of reusing `mc-db`'s replica set. Changes: `mcm-bff-db` compose service + external volume + `depends_on` (T113); `env.ts`/`.env*` repointed to `27018`/`bff_db` (T114); plan.md (Storage + §Decoupling Constitution row + Complexity Tracking), tasks.md (Phase 12), research.md (R1 revised), data-model/quickstart/HANDOFF, and the MCM-Architecture diagram (new `mcm_bff_db` node + edge + the two-instance MongoDB Collections section) + local-dev runbook all updated.

**Verification**: dedicated instance up + healthy; **full agent-config integration suite 7/7 (38 tests) GREEN** against Metro :8081 + `mcm-bff-db` (store CRUD/encryption/FR-014, validate-on-save with real probes, test-connection, IDOR scoping, revoked-credential safe-failure, route-auth, probes); BFF unit **1104**, `tsc` clean. (Routing those suites at the dev container surfaces an unrelated host/container Ollama-reachability artifact — run them against Metro on the host.)

## Files changed in this review

- `frontend/mcm-app/src/bff-server/agent-config-ssrf.ts` — de-map IPv4-mapped IPv6 (SSRF fix)
- `frontend/mcm-app/src/bff-server/agent-config-ssrf.test.ts` — mapped-IPv6 regression tests
- `frontend/mcm-app/src/bff-server/agent-config-service.ts` — typeof guards + strict boolean `enabled`
- `frontend/mcm-app/src/components/agent/movie-assistant-config.tsx` — cost-limit validation + `saveErrorMessage`
- `agents/movie-assistant/src/state.py` — clarifying comment on the container-level leak-scan guard
- `specs/018-per-user-agent-config/spec.md` — FR-026/SC-009 wording
- `specs/018-per-user-agent-config/tasks.md` — SC-009/010/011 added to the Completion Checklist
- `CLAUDE.md` — SSRF-guard canonicalization decision
