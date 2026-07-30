---
type: Process
title: Feature branch test scope
description: The user-story to web-spec-file and mobile-flow mapping used during iteration on a feature branch, and the rule that only the touched story's suites run during iteration while the rest are deferred to final validation.
tags: [testing, ci, process, e2e]
timestamp: 2026-07-30T13:49:05-04:00
---

# Feature branch test scope

Run only the suites for areas touched on the current branch during iteration; defer the rest to
final validation. This mapping (from `CLAUDE.md`'s "Feature Branch Test Scope" section) is the
lookup table for which Playwright spec file and which Maestro mobile flow(s) correspond to each
user story, so the correct narrow suite can be run instead of the full regression while iterating.
The full-suite requirement belongs to the final validation checklist, not here — see
[Testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md) for what runs in CI
and gates a merge, and [the Expo/React Native app](/openwiki/projects/expo-app.md) for the project
these web/mobile suites live in.

## User Story → Test Mapping

| User Story | Web Test File | Mobile Flow |
|---|---|---|
| 001-US1: Registration | auth.spec.ts | registration-navigation.yaml, registration-full.yaml, registration-validation.yaml |
| 001-US2: Login | auth.spec.ts | login-keycloak.yaml, login-screen.yaml, login-invalid.yaml, login-verified-banner.yaml |
| 001-US3: Profile / access control | auth.spec.ts | auth-guard.yaml, home-screen.yaml |
| 001-US4: Logout | auth.spec.ts | logout.yaml |
| 001: Session timeout | session-timeout.spec.ts | session-timeout.yaml, session-timeout-absolute.yaml |
| 002-US1: Browse collections | collections.spec.ts | collection-browse.yaml |
| 002: Manage collections | collections.spec.ts | collection-create.yaml, collection-edit.yaml, collection-delete.yaml |
| 002-US2: Manage movies | movies.spec.ts | movie-add.yaml, movie-edit.yaml, movie-delete.yaml |
| 002: Search / filter movies | movies.spec.ts | movie-browse.yaml, movie-search-filter.yaml |
| 002-US3: Default collection | movies.spec.ts | N/A (web routing behavior) |
| 002-US4: Column visibility | movies.spec.ts | N/A (native layout, no column toggle) |

## Gotchas

- **This table only covers the two user stories present when the rule was written (001, 002).**
  It is not exhaustive across every feature in the repository — later features that need this same
  scoping discipline should extend the table with their own story-to-suite rows rather than
  assuming the rule doesn't apply.
- **The rule is about iteration, not completion.** Running only the touched story's suites is
  correct while a feature is in progress; every feature must still run the full final validation
  checklist (`pnpm nx e2e mcm-app`, `pnpm nx e2e:mobile mcm-app`, etc.) before being marked
  complete, including backend-only changes, because only the full E2E run proves the change works
  end-to-end through the BFF from the client's perspective.
- **`N/A` rows still need a justification, not a blank cell** — "web routing behavior" and "native
  layout, no column toggle" are the recorded reasons those stories have no mobile equivalent; a new
  `N/A` row without a stated reason is a gap, not a covered case.
