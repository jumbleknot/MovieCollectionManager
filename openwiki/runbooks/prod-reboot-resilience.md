---
type: Runbook
title: Prod reboot resilience
description: Why a rootless-Docker production homelab did not come back clean after a host reboot, and the two rounds of fixes (bind-address, restart policy, periphery storage location) that made recovery fully hands-off.
resource: docs/runbooks/prod-reboot-resilience.md
tags: [production, reboot, resilience, rootless-docker, komodo, runbook]
timestamp: 2026-07-26T13:44:06+00:00
---

# Prod reboot resilience

Records the recovery posture for the rootless-Docker production homelab after a host reboot: host-side
remediations applied outside the repo, repo/deploy-side fixes committed to compose files (so they
survive every Komodo ResourceSync deploy), one operator redeploy step, and a validation-reboot
checklist. It exists because a kernel-upgrade reboot exposed several defects at once, and a second
reboot later exposed further defects that the first round of fixes had missed — this is a two-round
history, not a single fix.

## Gotchas

- **A tailnet-IP-scoped published port silently fails to bind if the container engine starts before
  the tailnet interface is up** — the container shows running with an empty ports column, and only a
  rebind or a full daemon restart (after the tailnet interface is up) recovers it, not a plain container
  restart. The fix was moving affected published ports to a broad bind behind the host firewall's
  default-deny-inbound posture, landing them in the
  [published-port reservation range](/openwiki/invariants/published-port-reservation.md) to avoid
  colliding with the CI runner sharing the same host.
  - **This is the second time the same physical ports moved** — a first change was itself superseded
    by a follow-up feature after those ports collided with the CI runner's own use of the same host's
    port space; treat the current reserved-range assignment as authoritative, not the original bind fix.
- **`restart: unless-stopped` does not bring a container back after a reboot on this stack.** A
  graceful-shutdown drain unit stops every container cleanly on shutdown, and `unless-stopped`
  deliberately declines to restart a container that was already stopped when the daemon starts — the
  two remediations defeat each other. Every prod and host-managed compose service was switched to
  `restart: always` to close this; do not reintroduce `unless-stopped` on a prod service expecting a
  reboot to bring it back.
- **A crash-looping non-root Mongo keyfile entrypoint is a permissions bug, not a data bug** — a plain
  container restart (not recreate) can leave a prior run's read-only keyfile in place, and the non-root
  mongod process cannot overwrite it. The entrypoint fix removes the file before rewriting it on every
  start, making the operation idempotent; the regression test for this must run as a non-root uid, since
  running it as root masks the bug entirely.
- **A durable network re-attach after reboot is a Komodo redeploy, not a manual `docker network
  connect`.** A manual reconnect is a one-off that the next reboot can lose; only a redeploy recreates
  the container with its full declared network set from the compose file.
- **Komodo's own periphery agent can be a recovery dependency, not just a deployed workload.** If
  periphery itself is a rootless container that gets stopped on shutdown, Komodo Core loses its agent on
  reboot and cannot redeploy anything — including itself — until periphery, and the git source it
  depends on, are manually started first. Persistent storage for periphery's own working directory
  matters for the same reason: an ephemeral filesystem under it silently loses the git checkout that
  every stack's relative bind-mounts resolve against, on every reboot.
- **A host-level throughput bug can look exactly like a network outage and isn't.** A segmentation-offload
  default on the tailnet interface capped one direction of tailnet transfer while leaving small-packet
  latency, loss, and every conventional network diagnostic looking clean — the tell was that no plausible
  network condition could explain the observed throughput number. The fix must be bound to interface
  recreation (a systemd unit keyed to the device), not just applied once, since both a reboot and a
  tailnet daemon restart reset it.

Full host-side remediation table, the complete tailnet-throughput diagnostic narrative, the exact port
migration history, and the row-by-row validation-reboot checklist for both rounds of fixes:
`docs/runbooks/prod-reboot-resilience.md`.
