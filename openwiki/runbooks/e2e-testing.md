---
type: Runbook
title: E2E testing (BFF container modes & flakiness diagnosis)
description: The three BFF-fronting modes for end-to-end tests (Metro dev, dev-container HTTP, prod-container HTTPS), why the dev-container run is the deterministic baseline for flaky-vs-broken triage, and the CI integration-tier gate that now blocks a merge.
resource: docs/runbooks/e2e-testing.md
tags: [e2e, testing, playwright, ci, flakiness, runbook]
timestamp: 2026-07-21T13:45:27+00:00
---

# E2E testing (BFF container modes & flakiness diagnosis)

The same app + BFF code runs in three modes that differ only in which server fronts the BFF and the
cookie/TLS posture: **local dev** (Metro's `@expo/server`, HTTP, non-Secure cookies — the default for
iterative work), **dev container** (`mcm-bff-service-nonsecure`, HTTP, non-Secure — the standard
final local E2E run), and **prod container** (`mcm-bff-service-secure` + TLS proxy, HTTPS, Secure
cookies — reserved for a future CI/CD job, not a routine local step). See
[Testing tiers](/openwiki/invariants/testing-tiers.md) for how this E2E tier fits alongside unit,
integration, and golden tests, and how CI enforces the integration tier ahead of the E2E legs.

## Gotchas

- **Diagnose flaky-vs-broken with the dev-container run, not Metro.** Metro has JIT/long-session
  variance that produces convincing "environment" red herrings; the dev-container run is
  deterministic (~54s for the current suite). If that run is slower or fails, treat it as a real
  regression — do not reach for "flaky" first. A real historical case: a strict-validation 400 was
  repeatedly misattributed to machine/Metro degradation because the handler didn't log 4xx errors.
- **A client→BFF response can be silently lost through the exported server's pipe stack**, most often
  over the emulator's tunnel. This is usually benign for login (the session lands anyway) but can
  make a server-authorized action look client-denied for other flows — diagnose by comparing the
  BFF's own audit log against the client-visible outcome, not by re-running.
- **Bounded E2E retry is at most one retry per test, never more** — masking flakiness with additional
  retries risks hiding a real defect; a genuine regression must still fail both attempts.
- **Agent E2E flows must never assert on a specific TMDB-ranked title.** Live TMDB popularity rankings
  drift, so a hardcoded title can silently leave the candidate list entirely — assert by list
  *position*, never by name.
- **A CI agent-flow failure ships full per-service container logs and health-check JSON as the
  `agent-e2e-container-logs` artifact before teardown** — the containers are gone by the time you'd
  try to `docker logs` them post-hoc, so that artifact (not a live re-run) is the required first
  diagnostic step.
- **The prod-container (HTTPS) mode is not a routine local step** — it's kept only as a proven
  reference path for a future CI/CD job; don't reach for it in day-to-day validation.

For mobile-specific tunneling and APK-rebuild decisions, see
[Android emulator & APK builds](/openwiki/runbooks/android-emulator.md). Full container-mode
commands, the complete flakiness-diagnosis protocol, and the integration-tier CI enforcement detail:
`docs/runbooks/e2e-testing.md`.
