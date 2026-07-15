# Quickstart & Validation: Feature 040

Per-user-story validation. Follow the repo's Test Run Protocol (isolated → story suite → full). Agent changes (US1/US2/US4) require rebuilding the agent gateway + MCP images before containerized E2E (stale image = old code). See [CLAUDE.md](../../CLAUDE.md), [docs/agent-layer.md](../../docs/agent-layer.md), and [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md).

## Prerequisites

- Stacks up per [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md): `auth` (Keycloak+Redis) before the `mcm` app profile; MongoDB replica-set for mc-service; agent gateway + MCP servers for US1/US2/US4.
- Agent models are env-scoped (Ollama dev/test, Claude golden+prod).
- An `mc-admin` user and a plain `mc-user` in the realm for US3.

---

## US1 (P1) — Navigate to a collection reliably (Item 4)

**Setup**: user owns "Wish List", "Test Import", "Movie Collection"; start viewing "Movie Collection".

**Validate**:
1. Ask the assistant: "navigate to Test Import collection" → **the Test Import collection screen opens** (no "couldn't find … in your Movie Collection" message).
2. Ask an ambiguous "navigate to import test" → the assistant offers the collections; tap "Test Import" → **Test Import opens** (not a movie search).
3. Immediately ask another navigate → resolves on its own (not anchored to a prior collection).

**Commands**:
```bash
pnpm nx test movie-assistant   # (or: uv run pytest) unit: test_navigator, test_routing, test_search
# golden re-record for 4(b) — human-approved:
#   (record) then commit tests/golden/cassettes/us7-intent-search-navigate.json
pnpm nx e2e mcm-app -- tests/e2e/web/agent-navigate-collection.spec.ts
scripts/maestro-run.sh tests/e2e/mobile/agent-navigate-collection.yaml   # CI runs agent mobile flows
```

**Pass**: disambiguation tap → `navigate_to_collection`; "navigate to X collection" classifies as `navigate`; no in-collection search misfire.

---

## US2 (P2) — Large spreadsheet import completes (Item 3)

**Setup**: a spreadsheet of 200+ rows with ≥10 comma titles (mix of article "The …, " and genuine "Girl, Interrupted").

**Validate**:
1. Start the import; answer each comma/article clarification — including one deliberately loosely-worded answer → **the pending question is re-asked, the import is not abandoned**.
2. The import reaches the preview/approval and applies; duplicates are reported as skipped; the rest are created.
3. Force an error (e.g., a downstream failure) → **a user-facing "import failed: …" message appears** (never a blank reply).

**Commands**:
```bash
pnpm nx test movie-assistant   # unit: test_import_disambiguation_runtime, test_import_transitions, test_import_apply, test_import_runtime
pnpm nx test:integration movie-assistant   # integration: test_import_flow (real MCP + mc-service)
```

**Pass**: FR-013…FR-017 — no silent stop; unparsed answer re-asks; dedup reads un-throttled; responsive across many turns; per-row outcome on apply.

---

## US3 (P2) — Admin disables self-registration (Item 1)

**Validate (admin)**:
1. Sign in as `mc-admin` → open the admin settings screen → toggle self-registration **off**.
2. Sign out; on the login screen the **"Create Account" link is gone**.
3. A direct `POST /bff-api/auth/register` is **refused (403)** and audited; **no Keycloak user is created**.
4. Toggle back **on** → registration works again.
5. As a `mc-user`, the admin settings read/write is **refused (403)** and the admin screen is not reachable.

**Commands**:
```bash
pnpm nx test mcm-app -- --testNamePattern "admin settings|registration-status|register disabled"
pnpm nx test:integration mcm-app     # real Mongo + Keycloak; asserts user absent when refused; cleans up in afterAll
pnpm nx lint mcm-app
pnpm nx e2e mcm-app -- tests/e2e/web/admin-registration.spec.ts
scripts/maestro-run.sh tests/e2e/mobile/admin-registration-disable.yaml
```

**Pass**: SC-001…SC-004 — disabling hides the entry point and refuses registration within one refresh; non-admin blocked; default allowed.

---

## US4 (P3) — Ownership prompt + navigate on TMDB add (Item 2)

**Validate**:
1. Ask the assistant to add a movie from TMDB → **"Do you own this movie?" (Yes/No)** appears before the add.
2. Answer **No** → approve → the movie is added with **owned=false** and still in the chosen collection.
3. After the add, **the app opens that movie's detail page** automatically.
4. Answer **Yes** on another add → stored **owned=true**.
5. Cancel at the ownership prompt → **no movie added**.

**Commands**:
```bash
pnpm nx test movie-assistant   # unit: organizer add-ownership stage, proposals.to_movie_payload, approval_gate navigate emit
pnpm nx e2e mcm-app -- tests/e2e/web/agent-add-ownership.spec.ts
scripts/maestro-run.sh tests/e2e/mobile/agent-add-ownership.yaml
```

**Pass**: SC-005/SC-006 — ownership asked before create, stored per answer, detail page opened post-add.

---

## Final validation (before marking complete)

Per [CLAUDE.md](../../CLAUDE.md) Final Validation Checklist — **web E2E regression is required for every feature**:
```bash
pnpm nx test mc-service && pnpm nx test:integration mc-service     # confirm owned passthrough unaffected
pnpm nx lint mcm-app && pnpm nx test mcm-app && pnpm nx test:integration mcm-app
pnpm nx e2e mcm-app && pnpm nx e2e:mobile mcm-app
rtk gain     # >80% compression
```
Rebuild + redeploy any changed BFF/agent/MCP container before the final containerized E2E, or it validates a stale image.
