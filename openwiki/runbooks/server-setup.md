---
type: Runbook
title: Homelab server setup (CI/CD + production host)
description: The phase-ordered from-scratch bring-up runbook for the single physical homelab host running two segregated rootless Docker daemons (CI and prod), Forgejo as source-of-truth forge with its own OCI registry, and Komodo for CD to production — summarized phase by phase, with the load-bearing gotchas.
resource: docs/runbooks/Server-Setup-Runbook.md
tags: [infrastructure, homelab, rootless-docker, forgejo, komodo, runbook]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-29T01:49:10.027Z
sources:
  - id: openwiki-source-80b643ca97b6e7e300789088
    resource: repo://.forgejo/workflows/cd-deploy.yml
  - id: openwiki-source-fd77a504cc309a02ead6fecf
    resource: repo://.forgejo/workflows/guardrails.yml
  - id: openwiki-source-0bf17bd5484fe4c2f5eafbab
    resource: repo://docs/runbooks/Server-Setup-Runbook.md
  - id: openwiki-source-839571d2c51f49a930537d1b
    resource: repo://infrastructure-as-code/komodo/stacks.toml
  - id: openwiki-source-c84c5149aa3c4f5090fd8fae
    resource: repo://scripts/__tests__/prod-apk-disk-step.guard.test.mjs
  - id: openwiki-source-9f8c81d3ba3b64fe38ae7e7d
    resource: repo://scripts/cd/publish-apk.mjs
  - id: openwiki-source-5a48ade99311698ed1a02a08
    resource: repo://scripts/check-prod-ci-port-collision.mjs
  - id: openwiki-source-6f10e821d1ec074deb438a3e
    resource: repo://scripts/check-topology-scrub.mjs
generated: { by: "openwiki/0.6.0", at: "2026-09-29T01:49:10.027Z" }
---

# Homelab server setup (CI/CD + production host)

The end-to-end runbook for provisioning the single physical headless host that backs this project's CI
and production: OS install and hardening, Tailscale-only remote access, two segregated rootless Docker
daemons (one per service user — `ci` and `prod` — each with its own socket, data root, networks, and
volumes so a breakout in one cannot reach the other or the host as root), Forgejo as the
source-of-truth forge with its own OCI registry (push-mirrored to GitHub), and Komodo driving CD to
production. Every literal in the source is a placeholder, and the topology-scrub gate forbids the real
ones from entering git.

This document was relocated here from `docs/proposals/homelab-setup/` because it is a live operator
reference, not pre-specification ideation — see the
[proposal → spec → plan → tasks → implementation lifecycle](../process/spec-driven-development.md)
for why that distinction matters and why proposals themselves are out of scope for this wiki.

## Phase map — what each phase achieves

The source is genuinely a from-scratch, **phase-ordered** procedure: each phase assumes the prior
phase's state (the two service users and their networks/volumes must exist before Forgejo or the app
stacks are deployed), so a partial rebuild cannot skip ahead. The phases, in order:

- **0 — BIOS/firmware.** AMD SVM (hardware virtualization, required for the KVM-backed Android
  emulator) and IOMMU enabled, power-on behavior set to "Always On" so the headless box self-recovers
  after a power blip.
- **1 — OS install.** Ubuntu Server LTS, minimized footprint, OpenSSH enabled, full-disk LVM. Two
  traps: the guided installer caps the root logical volume at roughly 100 GB of a 1 TB drive and
  leaves the rest of the volume group unallocated (extend it online — the symptom is `df -h /` and
  Komodo agreeing on ~98 GB), and the old `qemu-kvm` transitional package is gone, so the `kvm` binary
  now arrives with `qemu-system-x86`.
- **2 — Hardening.** SSH key-only (verify key login *before* disabling passwords, and confirm the
  effective `sshd -T` output, because an installer/cloud-init drop-in often re-enables password auth),
  `ufw` default-deny inbound with only OpenSSH allowed, unattended-upgrades, fail2ban.
- **3 — Remote management.** Tailscale with `--ssh`, plus the `ufw allow in on tailscale0` rule —
  without it, Phase 2's default-deny blocks every admin UI (Cockpit, Forgejo, Komodo, Grafana) even
  over the tailnet. Cockpit for browser-based host admin.
- **4 — KVM.** Put the (future) `ci` user in the `kvm` group so the emulator job can receive
  `/dev/kvm`.
- **5 — Two segregated rootless Docker daemons.** The core of the design: two unprivileged service
  users, each running its own rootless `dockerd` at its own socket with data under its own home, plus
  per-daemon `daemon.json` (log rotation, `live-restore`), KVM device passthrough into CI containers,
  and the pre-created external networks/volumes the prod stacks expect. This phase owns the
  daemon-installation, subordinate-UID and cgroup-delegation gotchas below.
- **6 — Forgejo (source of truth) + OCI registry + GitHub push mirror.** Runs on the prod daemon with
  Postgres behind it; `packages` (the registry) and `actions` are enabled by env, the GitHub mirror is
  a push mirror so Forgejo stays SSOT, and every automated consumer gets its own minimally-scoped
  named access token. The same phase documents the generic package registry that carries the release
  APK.
- **7 — Forgejo Actions runner.** `forgejo-runner` v12 as a **binary** under the `ci` user's
  systemd-user manager (a container runner would fight container↔Forgejo networking), registered with
  the UUID + secret the web UI hands out — the older registration-token flow is deprecated. The runner
  label is where `ubuntu-latest` becomes a plain Node image.
- **8 — Self-hosted Nx remote cache.** MinIO plus the open-source Rust `nx-cache-server` on the prod
  daemon; the first-party `@nx/s3-cache` / `@nx/shared-fs-cache` packages are deprecated over an
  unpatchable CVE. Client wiring is entirely env-driven, so local runs without the token fall back to
  the local cache and no remote-cache config leaks into the repo.
- **9 — Komodo (CD to the prod daemon).** Core + Periphery agent + database, deployed from Komodo's
  own compose files with two changes: Periphery repointed at the rootless socket, and **FerretDB
  instead of MongoDB** (the unpinned Mongo image crash-loops on this new-kernel + rootless
  combination).
- **10 — Public ingress, TLS and DNS.** Pick exactly one ingress model. The confirmed one is direct
  edge-TLS — the tunnel terminates TLS at the edge and dials the containers over plain HTTP on a
  shared external network, with no Caddy — and only two hostnames are public; everything else stays
  tailnet or behind an access gate.
- **11 — Keycloak and BFF production config.** The step that makes off-network login actually work:
  the public origin wired through Keycloak and the BFF, shipped as config-as-code in Komodo stacks
  rather than hand-run compose, with secrets as masked Komodo Variables materialized into a gitignored
  env file (see [Secrets management](../invariants/secrets-management.md)). Also where the realm
  sanitizing/rendering and client-reference gotchas live.
- **12 — Extended hardening.** Close public SSH entirely, gate admin UIs to the tailnet, 2FA, image
  pinning + scanning + Renovate, NTP, and **performance** isolation between the CI and prod user
  slices via host cgroup caps — rootless daemons isolate security, not CPU/memory contention.
- **13 — Monitoring and alerting.** A lean infra profile on the prod daemon. As built, one probe
  service is the pager, and disk SMART runs as host-level `smartd` rather than in a container (raw
  NVMe SMART needs root device access a rootless container cannot get).
- **14 — Backups, disaster recovery and UPS.** An encrypted, offsite, scheduled snapshot of every
  stateful service on a timer, a *proven* restore procedure, a graceful-shutdown drain unit that stops
  containers cleanly before the runtime is killed, and UPS + NUT for power loss. The runbook warns
  explicitly that this host-level DR is not the same thing as the application's per-user collection
  backups.
- **15 — Wire the pipeline.** The trigger ordering, digest-by-git promotion and Komodo ResourceSync
  deploy; the current shape is documented in
  [CI/CD pipeline](../projects/ci-cd-pipeline.md) and
  [Infrastructure stacks](../projects/infrastructure-stacks.md), with the bring-up history in
  [Phase 15 operator checklist](./phase-15-operator-checklist.md).
- **16 — Verification checklist.** The acceptance list for the whole build-out, including the two
  daemons reporting rootless with distinct data roots.
- **17 — Reboot resilience.** The post-reboot fixes; the *current* reboot procedure is
  [Prod reboot resilience](./prod-reboot-resilience.md).

## Gotchas

- **Two rootless daemons, one host, one port space.** CI and prod are isolated at the daemon and
  filesystem level, but they still publish into the same host's port space — this is the origin of the
  collision class documented in
  [Published-port reservation](../invariants/published-port-reservation.md); a port assigned here
  without checking that convention can silently starve a prod redeploy later.
  - **A `machinectl shell <user>@` session is required to install rootless Docker for a service user,
    not `sudo -iu`/`su`.** The setup tool needs a real systemd user session to install its auto-start
    unit; the wrong session type silently falls back to a manual-start mode that looks successful but
    does not survive a reboot. Ordering the rootless user manager after the tailnet daemon is an
    optional defense-in-depth extra, not a substitute.
  - **Subordinate UID/GID ranges must be exactly one, non-overlapping line per user.** `useradd -m`
    already assigns one, so normally there is nothing to do but verify; adding a second range manually
    creates an overlap that breaks rootless Docker's user-namespace mapping with an opaque `newuidmap`
    error.
  - **Cgroup delegation must be enabled at the systemd `user@.service` level, or rootless Docker only
    enforces memory/pids limits**, silently ignoring CPU/IO limits — required for the CI-vs-prod
    resource isolation above.
- **The forge's Actions-artifact API is a missing route, not an empty result.** `GET
  /api/v1/repos/.../actions/artifacts` answers `404 page not found` on this build
  (15.0.3+gitea-1.22.0), so `upload-artifact` APKs are reachable only by a human clicking through the
  run page and only until they expire. The `cd-deploy` `prod-apk` job therefore publishes every
  release APK to the **generic package registry** (`mcm-app-android` package, version
  `<expo.version>-<sha7>`) via `scripts/cd/publish-apk.mjs`, alongside the artifact. Use a
  `read:package` token to fetch it; the download recipe uses `/api/packages` (not `/api/v1`) and pulls
  a `.apk.sha256` sidecar written in `sha256sum -c` format — see §6.7 of the runbook.
  - **APK retention is count-based, not time-based.** The measured release APK size is **109 MB** (run
    #6036, `114,365,972` bytes — universal build), and every deploy produces one, so unbounded
    accumulation is a disk-exhaustion path on this host. `publish-apk.mjs` prunes to the newest **5
    versions** by `created_at` — **not** a 30-day window, because a quiet month would delete every
    installable APK while a busy week would keep far more than the disk affords (5 × 109 MB ≈ 550 MB
    ceiling). **To pin a build so it survives pruning**, re-upload it under `<version>-keep`; pinned
    versions are kept and do not consume a retention slot.
  - **The pruning logic has three non-obvious properties.** Listing is paginated because the forge
    orders packages by name and defaults to page 1 at 30 items — an unpaginated call silently degrades
    retention to a no-op with no error. Sorting is by `created_at`, never by name, since `1.10.0` sorts
    before `1.9.0` as a string and would prune the newest build first. And a version whose `created_at`
    will not parse is *kept*, because deleting on a parse failure is the destructive direction. A
    re-upload of an existing version is a `409`, handled as "already published" rather than a failure.
  - **The script always exits 0 and is `continue-on-error` on the workflow step.** `prod-apk` is
    non-blocking by design; a registry hiccup must not turn a deploy red. Every failure path emits
    `::error::` so it is visible in the job log without failing the job.
- **`ubuntu-latest` on this forge is `node:22-bookworm` — GitHub-hosted-runner recipes do not transfer
  (item #457).** The runner label maps `ubuntu-latest` to a plain Node image, not a GitHub-hosted
  Ubuntu runner. Two consequences bite copied workflow snippets:
  - **There is no `sudo`.** The container process is already root, so `sudo` is absent and
    unnecessary. A copied `sudo …` line dies on its first word with `sudo: command not found`. If the
    step carries the customary `|| true`, it goes **green having done nothing**. That is what
    `cd-deploy`'s `prod-apk` "Free disk space" step did on every run it ever made. (The `kvm` runner is
    the same story for a different reason: it runs on the host as the unprivileged `ci` user, which
    also has no sudo.)
  - **Dropping `sudo` is WORSE than the no-op.** Measured 2026-09-15 with `docker run --rm
    node:22-bookworm`: `/usr/share/dotnet`, `/opt/ghc`, `/usr/local/.ghcup`, `/usr/share/swift`, and
    `/usr/local/share/powershell` do not exist. The one sizeable removable directory,
    `/usr/local/lib/node_modules` (19 MB), holds `corepack` and `npm`, which `pnpm/action-setup`
    needs — so "just drop the `sudo`" turns a harmless no-op into a broken job. Deleting files from an
    image's lower layers also writes whiteouts to the container layer, so host usage goes UP. **To free
    real disk from a job, prune the rootless daemon** (`docker image prune -af`), which needs no
    privileges and is what `app-e2e`, `dast`, and `build-deploy` all do. `prod-apk` has no Docker CLI
    and builds no images, so it has nothing to prune.
  - **The rewritten disk step is pinned in all three directions.**
    `scripts/__tests__/prod-apk-disk-step.guard.test.mjs` fails *any* workflow step that invokes
    `sudo` (no runner here provides it); fails the disk step if it deletes
    `/usr/local/lib/node_modules`; and fails it if it attempts any `rm` at all or carries a `|| true`.
    The step must state in its own output that "No reclamation is attempted here", and its *name* must
    not promise a reclamation — otherwise a cosmetic fix reintroduces the false green.
  - **Doing nothing leaves no trace, so the measurement is published to the commit.** On a green run
    nobody can read a job log (this forge exposes no run/jobs/logs endpoint and `cd-deploy` posts no
    statuses), so a recorder step posts the disk figures as a commit status under
    `cd-deploy/prod-apk-disk`. It is `always()` + `continue-on-error` so a *failed* `prod-apk` still
    leaves the record, it never posts a non-success state, and it is asserted to match none of `main`'s
    required status globs — observability, never a second gate.
- **Never commit the real forge hostname, production domain, or tailnet address.** Every literal in
  this runbook is a placeholder; the topology-scrub and secret-scan gates block a real value from
  landing in git, matching the redaction posture in
  [Secrets management](../invariants/secrets-management.md).

Full phase-by-phase commands (BIOS/firmware through registry/token hygiene), the exact package lists,
the token inventory, the restore procedures, and every troubleshooting aside:
`docs/runbooks/Server-Setup-Runbook.md`.
