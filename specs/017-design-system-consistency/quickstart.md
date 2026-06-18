# Quickstart — Design-System Consistency Remediation (017)

UI-only feature. Gates run on Jest/Metro (unit) and the **dev-container** (web E2E — the Metro web bundler OOMs with Tamagui on this machine).

## Inner loop (per change)

```bash
# 1. Static DS-compliance scan (the RED→GREEN driver) — fast
pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern design-system-compliance

# 2. DS unit (incl. the new success-token contrast test)
pnpm nx test design-system --skip-nx-cache

# 3. Type-check + lint
cd frontend/mcm-app && pnpm exec tsc --noEmit && cd ../..
pnpm nx lint mcm-app --skip-nx-cache
pnpm nx lint design-system --skip-nx-cache

# 4. App unit (any component whose test renders it via @/test-support/render)
pnpm nx test mcm-app --skip-nx-cache
```

## Web E2E (dev-container — after app-source changes)

```bash
pnpm nx docker-build mcm-app
docker compose --profile bff-dev up -d --force-recreate mcm-bff-dev
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app           # full regression + the a11y/responsive/font-fallback audits
```

The `a11y.spec.ts` axe `color-contrast` scan (dark + light) is the SC-005 gate; it also now asserts the verified/"Yes" state renders the `success` colour.

## Final validation checklist

- [ ] `design-system-compliance` scan GREEN (R1–R5): zero hardcoded hex, zero off-scale fonts, no bespoke buttons outside the allowlist (SC-001/002/003).
- [ ] DS unit GREEN incl. success-token presence + AA contrast both themes (SC-004).
- [ ] `tsc` 0, app lint 0, DS lint 0.
- [ ] DS unit + app unit suites pass (no regression).
- [ ] Selector baseline: zero removed testIDs vs the 194-baseline (SC-006).
- [ ] Dev-container web E2E green incl. the a11y/contrast audits dark+light (SC-005/SC-007).
- [ ] `sanctioned-deviations.md` deviations verifiably unchanged (SC-008).

## Notes

- Rebuild the dev-container image after EVERY app-source change (it serves the prebuilt bundle; stale image = old code tested).
- Preserve every `testID` — forward via `...rest` when swapping a bespoke pressable for a DS component.
- Keep style objects at the bottom of component files (constitution Frontend Separation of Concerns).
- Mobile (Maestro) is not a gate for 017 — the mobile-CI harness is tracked in issue #16.
