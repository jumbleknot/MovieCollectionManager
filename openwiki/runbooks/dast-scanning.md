---
type: Runbook
title: DAST scanning (OWASP ZAP)
description: Config-as-code dynamic application security testing against BFF, mc-service, and the agent gateway — the baseline-vs-full scan split, the network-attach-not-published-ports design, and the guard that refuses a destructive active scan outside a disposable environment.
resource: docs/runbooks/dast-scanning.md
tags: [security, dast, zap, ci, runbook]
timestamp: 2026-07-08T19:30:16-04:00
---

# DAST scanning (OWASP ZAP)

One OSS OWASP ZAP scan definition runs in two modes: a non-destructive **baseline** developers can
run locally, and a destructive **full** (active) scan that the CI `dast` job runs against an
ephemeral throwaway stack, gating merges on any un-allowlisted High finding. ZAP targets the BFF
(session-cookie auth), mc-service (bearer JWT), and the agent gateway (bearer JWT, but spider +
passive only — active fuzzing there would trigger real, slow, non-deterministic LLM runs). ZAP
attaches to the shared backend network and reaches every target by DNS rather than publishing new
host ports, deliberately avoiding the prod/CI port-collision risk described in
[Published-port reservation](/openwiki/invariants/published-port-reservation.md).

## Gotchas

- **The active (destructive) scan refuses to run unless both an explicit opt-in flag is set and the
  target is a disposable environment.** This guard exists specifically to prevent an active scan from
  ever being pointed at shared or production data by mistake.
- **Credentials are reused from existing E2E test secrets, not new secret material** — the scan
  scripts fall back to the `E2E_*` equivalents when DAST-specific env vars are unset, so no new
  credential surface is introduced for this feature. See
  [Secrets management](/openwiki/invariants/secrets-management.md) for the broader posture this
  follows.
- **An unreachable target logs a warning and is skipped — it never silently produces a clean-looking
  passing report.** Treat a target-skip warning as "coverage gap," not "all clear."
  Conversely, if the BFF session itself cannot be established, the whole run fails fast rather than
  quietly falling back to an unauthenticated, low-coverage scan.
- **The CI job scans its own reports for leaked secrets before uploading the artifact.** A test
  password, ROPC client secret, or JWT appearing in a ZAP report fails that step before the report
  ever becomes a downloadable artifact.
- **The gate fails only on an un-allowlisted High finding** — Medium/Low findings are warnings, and
  a fully justified allowlist entry suppresses a finding from the *gate* only; it stays visible in the
  generated reports rather than disappearing from view.
- **`dast` is path-gated and CI tears both dependent stacks down unconditionally afterward** — a
  docs-only or Komodo-only PR skips the job entirely, and the always-on teardown exists so a stray
  DAST-spun stack can never hold a host port against a later deploy (the same incident class as
  [Published-port reservation](/openwiki/invariants/published-port-reservation.md)).

Full target/auth table, local baseline invocation, and the triage/allowlist workflow:
`docs/runbooks/dast-scanning.md`.
