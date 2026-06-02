# Quickstart: MCM Maintainability Hardening — Runbook

Operator runbook. PowerShell shell (Bash also available). RTK active. Baseline: feature 007 merged to `main`, all suites green; the repo is in Metro-only dev mode (BFF containers down, shared stack up).

## 1. Confirm the rename inventory (US1)

```bash
# Files named after spec IDs in first-party src (expect exactly one: utils/fr009.ts):
find frontend/mcm-app/src backend/mc-service/src -type f | grep -iE '/(fr|sc|us|t)[-_]?[0-9]+' | grep -vE '\.test\.|/tests/'
# Exported identifiers named after spec IDs (expect none):
grep -rnE 'export (async )?(function|const|class|type|interface|enum) +(FR|SC|US|T)[-_]?[0-9]' frontend/mcm-app/src backend/mc-service/src | grep -v '\.test\.'
# Importers of the ID-named module (expect 3):
grep -rn "from '@/utils/fr009'" frontend/mcm-app/src
```

## 2. Rename (US1) — behavior-preserving

```bash
git mv frontend/mcm-app/src/utils/fr009.ts frontend/mcm-app/src/utils/default-collection-auto-nav.ts
# Update the 3 import specifiers: @/utils/fr009 -> @/utils/default-collection-auto-nav
#   frontend/mcm-app/src/hooks/use-auth.tsx
#   frontend/mcm-app/src/screens/home/home-screen.tsx
#   frontend/mcm-app/src/screens/home/home-screen.test.tsx
# Ensure the module JSDoc retains the FR-009 reference (traceability). Do NOT rename the
# exported functions (already behavior-named) or the 'mcm_auto_nav_done' storage key (FR-005).
```

## 3. Constitution amendment (US2)

```text
Run /speckit-constitution to add, under "AI Assistant Constraints", a principle:
  "Behavior-Descriptive Identifiers: code identifiers (files, modules, exported symbols)
   MUST describe behavior. Requirement/spec IDs belong in comments/JSDoc for traceability,
   never in identifiers." + a one-line rationale + the traceability-comment carve-out.
Version bump: MINOR -> v1.5.0. The skill updates the version history + dependent templates.
```

## 4. Verify — full final-validation gate (SC-003, clarified to the full suite)

```bash
# Fast suites + lint/format (catch any broken import/reference deterministically):
pnpm nx test mcm-app && pnpm nx test:integration mcm-app
pnpm nx test mc-service && pnpm nx test:integration mc-service
pnpm nx lint mcm-app ; cd frontend/mcm-app && pnpm exec tsc --noEmit ; cd ../..
pnpm nx lint mc-service   # cargo clippy

# Full containerized E2E (feature-007 procedure) — the required gate:
pnpm nx docker-build mcm-app ; docker compose --profile bff-dev up -d
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app          # expect 93/93
#   mobile: adb reverse tcp:8081+8082+8099; .env.local native URLs -> localhost:8082 / localhost:8099;
#           Metro --reset-cache; pnpm nx e2e:mobile mcm-app (revert .env.local after)

# Reset to Metro-only (do NOT use --profile down):
docker compose rm -sf mcm-bff-dev caddy mcm-bff
```

## 5. Maintainability code review (US3)

```text
Run the project code review over the branch (e.g. /code-review or /code-review ultra).
Resolve all High/Critical findings; triage Medium/Low with a rationale.
```

## Definition of Done (maps to Success Criteria)

- [x] Repo scan finds **zero** ID-named files/modules/exported identifiers, except FR-005-annotated external contracts (SC-001)
- [x] Renamed module retains FR-009 traceability in JSDoc (SC-002)
- [x] Full suite green — unit + integration + containerized web + mobile E2E (SC-003)
- [x] Constitution has the naming principle; version bumped to v1.5.0; templates consistent (SC-004)
- [x] Code review: 0 unresolved High/Critical (SC-005)
- [x] Each renamed artifact's purpose is clear from its name alone (SC-006)
- [x] `rtk gain` per-test-run compression >80%
