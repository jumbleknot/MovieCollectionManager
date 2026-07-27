---
type: Runbook
title: SAST & SCA static scanning
description: Keyless, config-as-code static application security testing (Semgrep) plus software composition analysis (cargo-audit, pnpm audit, pip-audit) across the whole dependency graph, normalized into one blocking `sast` CI gate.
resource: docs/runbooks/sast-scanning.md
tags: [security, sast, sca, ci, runbook]
timestamp: 2026-07-22T18:20:59+00:00
---

# SAST & SCA static scanning

Four scanners — Semgrep (TS/JS + Python source), cargo audit (Rust deps), pnpm audit (JS deps), and
pip-audit (Python deps) — feed one normalized findings report and one blocking `sast` CI job. It
complements [DAST scanning](/openwiki/runbooks/dast-scanning.md): DAST exercises the running app,
this scans source and the dependency graph at rest. It is also disjoint from
[infra-image scanning](/openwiki/runbooks/infra-image-scanning.md), which scans pulled third-party
container images rather than first-party code or first-party dependency graphs.

## Gotchas

- **pip-audit audits the installed venv, not a requirements file.** Resolving a requirements file in
  an ephemeral venv downloads the whole dependency graph and can hang for 11+ minutes on yanked
  versions. The orchestrator instead audits the already-synced agent venv directly — CI must `uv sync`
  the agent layer first, and a developer's venv must be synced for a local run to be meaningful.
- **Keyless and fail-closed.** All advisory data (Semgrep registry, RustSec, npm advisories, OSV) is
  fetched anonymously at scan time; if any fetch fails, that scanner fails the job rather than
  reporting a false clean. No secret is ever required — see
  [Secrets management](/openwiki/invariants/secrets-management.md) for the broader no-clear-text-secrets
  posture this fits into.
- **The SCA half runs full on every push, unconditionally** — a newly published advisory can hit an
  unchanged dependency, so it is never path-gated. This means `main` can legitimately go red on a
  dependency nobody touched; that is the gate working, not a defect, and it recurs.
- **Only runtime-scope SCA blocks the gate.** A dependency's blocking status depends on whether it is
  reachable from a runtime path across the whole workspace, not just the root package — checking scope
  by hand requires a recursive, workspace-spanning query, not a root-only one; getting this wrong has
  previously produced a false "gate bug" report.
- **A fixable High must be bumped, never allowlisted.** The allowlist is for findings with no fix yet;
  suppression is gate-only and the finding stays visible in the report regardless.
- **Rust source itself is out of Semgrep's scope** — clippy covers Rust source patterns and cargo-audit
  covers only Rust dependencies, so the mc-service Rust surface relies on clippy + review for the
  patterns Semgrep enforces elsewhere.

Full scanner matrix, local invocation, the CI gate steps, the triage/allowlist workflow, and the
step-by-step "gate went red on an untouched dep" playbook: `docs/runbooks/sast-scanning.md`.
