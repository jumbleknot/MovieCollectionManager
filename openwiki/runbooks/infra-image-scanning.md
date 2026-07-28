---
type: Runbook
title: Infra-image CVE scanning
description: Keyless vulnerability scanning of pulled third-party server images (Keycloak, Postgres, Redis, Mongo, Vault, and the rest of infrastructure-as-code) — the coverage gap left by SAST/SCA and the built-image scanner, gated on fixable Critical findings only.
resource: docs/runbooks/infra-image-scanning.md
tags: [security, cve, trivy, ci, runbook]
timestamp: 2026-07-11T09:00:36-04:00
---

# Infra-image CVE scanning

Trivy scans every third-party image the project pulls but does not build — everything under
`infrastructure-as-code/**` except the project's own built images and any `${..}`-interpolated
reference. It is deliberately disjoint (enforced by a unit test) from the `cd-deploy` scan of the
project's own built images, and from [SAST/SCA scanning](/openwiki/runbooks/sast-scanning.md), which
covers first-party source and first-party dependency graphs, not pulled base images. Renovate keeps
base images current; this scan catches a freshly published CVE against an already-pinned image, which
currency alone cannot.

## Gotchas

- **Not path-gated on the authoritative run.** A weekly full sweep is the scan of record precisely
  because a new advisory can land against an image nobody changed — an on-change check on
  infrastructure edits exists only for fast feedback, not as the source of truth.
- **Only a fixable Critical blocks the gate.** An unfixable Critical (no upstream patched version yet)
  is a report-only warning, since a version bump can't clear it and it must not wedge the gate
  indefinitely.
- **Keyless and fail-closed**, matching the posture in
  [Secrets management](/openwiki/invariants/secrets-management.md) and
  [SAST/SCA scanning](/openwiki/runbooks/sast-scanning.md) — a Trivy/pull/parse failure fails the job
  rather than producing a clean-looking report.
- **The allowlist is baseline, not permanent.** Suppression is gate-only; findings stay visible in the
  report, and a suppressed entry must be deleted once the underlying image is actually bumped — leaving
  a stale entry hides a regression rather than tracking a real accepted risk.
- **Trivy is not available on every developer machine** (notably not the Windows dev box), so
  enumeration-only checks work everywhere, but the actual scored scan is CI-authoritative — don't treat
  a local `--list` run as equivalent to a real scan result.
- **Adding this as a required PR check is a manual operator step** — the agent cannot configure branch
  protection itself; the weekly scheduled run is a safety net, not a merge gate, until an operator wires
  the PR-triggered context into branch protection.

Full scanner-vs-scanner coverage table, allowlist entry shape, baseline-seeding steps, and remediation
ownership: `docs/runbooks/infra-image-scanning.md`.
