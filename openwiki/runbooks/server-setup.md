---
type: Runbook
title: Homelab server setup (CI/CD + production host)
description: The from-scratch bring-up runbook for the single physical homelab host running two segregated rootless Docker daemons (CI and prod), Forgejo as source-of-truth forge, and Komodo for CD to production.
resource: docs/runbooks/Server-Setup-Runbook.md
tags: [infrastructure, homelab, rootless-docker, forgejo, komodo, runbook]
timestamp: 2026-08-14T00:00:00Z
---

# Homelab server setup (CI/CD + production host)

The end-to-end runbook for provisioning the single physical host that backs this project's CI and
production: OS install and hardening, Tailscale-only remote access, two segregated rootless Docker
daemons (one per service user — `ci` and `prod` — each with its own socket, data root, networks, and
volumes so a breakout in one cannot reach the other or the host as root), Forgejo as the
source-of-truth forge with its own OCI registry (push-mirrored to GitHub), and Komodo driving CD to
production. This document was relocated here from `docs/proposals/homelab-setup/` because it is a live
operator reference, not pre-specification ideation — see the
[proposal → spec → plan → tasks → implementation lifecycle](/openwiki/process/spec-driven-development.md)
for why that distinction matters and why proposals themselves are out of scope for this wiki.

## Gotchas

- **Two rootless daemons, one host, one port space.** CI and prod are isolated at the daemon and
  filesystem level, but they still publish into the same host's port space — this is the origin of the
  collision class documented in
  [Published-port reservation](/openwiki/invariants/published-port-reservation.md); a port assigned
  here without checking that convention can silently starve a prod redeploy later.
  - **A `machinectl shell <user>@` session is required to install rootless Docker for a service user,
    not `sudo -iu`/`su`.** The setup tool needs a real systemd user session to install its
    auto-start unit; the wrong session type silently falls back to a manual-start mode that looks
    successful but does not survive a reboot.
  - **Subordinate UID/GID ranges must be exactly one, non-overlapping line per user.** Adding a second
    range manually creates an overlap that breaks rootless Docker's user-namespace mapping with an
    opaque `newuidmap` error — verify with a single grep before troubleshooting further.
  - **Cgroup delegation must be enabled at the systemd `user@.service` level, or rootless Docker only
    enforces memory/pids limits**, silently ignoring CPU/IO limits — required for CI-vs-prod resource
    isolation.
- **The forge's Actions-artifact API is a missing route, not an empty result.** `GET /api/v1/repos/.../actions/artifacts` answers `404 page not found` on this build (15.0.3+gitea-1.22.0), so `upload-artifact` APKs are reachable only by a human clicking through the run page and only until they expire. The `cd-deploy` `prod-apk` job therefore publishes every release APK to the **generic package registry** (`mcm-app-android` package, version `<expo.version>-<sha7>`) via `scripts/cd/publish-apk.mjs`, alongside the artifact. Use a `read:package` token to fetch it; see §6.7 of the runbook for the list/download/verify recipe.
  - **APK retention is count-based, not time-based.** The measured release APK size is **109 MB** (run #6036 — universal build). Unbounded accumulation is a disk-exhaustion path on this host. `publish-apk.mjs` prunes to the newest **5 versions** by `created_at` — not 30-day window because a quiet month would delete every installable APK and a busy week would keep far more than the disk can hold (5 × 109 MB ≈ 550 MB ceiling). **To pin a build so it survives pruning**, re-upload it under `<version>-keep`; pinned versions are kept and do not consume a retention slot.
  - **The script always exits 0 and is `continue-on-error` on the workflow step.** `prod-apk` is non-blocking by design; a registry hiccup must not turn a deploy red. Every failure path emits `::error::` so it is visible in the job log without failing the job.
- **Never commit the real forge hostname, production domain, or tailnet address.** Every literal in
  this runbook is a placeholder; the topology-scrub and secret-scan CI gates block a real value from
  landing in git, matching the redaction posture in
  [Secrets management](/openwiki/invariants/secrets-management.md).
- **This is genuinely a from-scratch, phase-ordered runbook** — phases assume the prior phase's state
  (e.g. the two service users and their networks/volumes must exist before Forgejo or the app stacks are
  deployed). Do not skip ahead based on a partial rebuild.

Full phase-by-phase commands (BIOS/firmware through registry/token hygiene), the exact package lists,
and every troubleshooting aside: `docs/runbooks/Server-Setup-Runbook.md`.
