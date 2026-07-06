# Claude Code handoff — MCM prod reboot-resilience follow-ups

*Paste the section below into a fresh Claude Code session opened in the `jumbleknot/mcm` repo.*

---

You are picking up follow-up work on the self-hosted **production** environment for the Movie Collection Manager (MCM) app. Prod is **config-as-code in this repo**, deployed to a rootless-Docker homelab via **Komodo ResourceSync** from `infrastructure-as-code/komodo/stacks.toml` (branch `main`). On 2026-07-05 a kernel-upgrade reboot hard-killed the rootless containers and exposed several issues. The **host-side** fixes are already done (a graceful-shutdown drain unit, expanded DB backup coverage, and UPS/NUT). The tasks below are the **repo / Komodo-side** fixes that must land in git so they survive future deploys.

## Ground rules
- **No secrets or real topology in git.** CI gates (`naming-gate` / `secret-scan`, and `scripts/check-topology-scrub.mjs`) block the real base domain, tailnet host, and Tailscale IP. Real values live only in Komodo Variables, referenced as `[[VAR]]` in the TOML/compose. Run the topology-scrub + secret-scan checks before committing infra files.
- Prod deploys **only** through Komodo — do not hand-edit host state. Open changes as PRs; `main` requires the `guardrails*` + `app-ci*` status checks.
- Verify file paths/service names against the actual repo before editing (the paths below are from memory and may differ slightly).

## Tasks

### 1. Tailnet-IP port-bind race (highest value)
**Root cause:** the rootless Docker daemon starts at boot *before* `tailscaled`, so rootlesskit never learns the tailnet IP and **silently fails to bind any published port scoped to `<tailnet-ip>:port`** — the container shows `Up` but with an empty Ports column and nothing actually listening. Ports bound to `0.0.0.0` are unaffected (that's why Forgejo on `0.0.0.0:3000` stayed reachable while every tailnet-IP-bound admin UI did not). A container restart does not fix it; only `0.0.0.0` or a full rootless-daemon restart.

Pick and implement ONE (recommend **a** for the repo):
- **(a)** In `infrastructure-as-code/docker/*/compose.prod.yaml`, change every published port scoped to the tailnet IP (e.g. `[[TS_ADMIN_IP]]:HOST:CONTAINER` or `${...}:HOST:CONTAINER`) to a plain `HOST:CONTAINER` (i.e. `0.0.0.0`). ufw already default-denies all non-tailnet inbound, so these stay tailnet-only. Fully in-repo.
- **(b)** Provide a documented host systemd drop-in that orders the rootless user manager `After=tailscaled.service` (host change — deliver as a runbook step, not committed host state).

### 2. Grafana / otel-lgtm unreachable after reboot
A specific instance of #1. In `infrastructure-as-code/docker/observability/compose.prod.yaml` (Komodo stack `prod-observability`), bind the Grafana port (`3002`) to `0.0.0.0`.

### 3. mc-service Mongo keyfile crash-loop
On a plain container **restart** (not recreate), the mc-service Mongo entrypoint fails with `/tmp/mongo-keyfile: Permission denied` and crash-loops — because the prior run left a `0400` keyfile in the container's `/tmp` and the entrypoint can't overwrite a read-only file. Make the entrypoint **idempotent**: `rm -f /tmp/mongo-keyfile` before (re)writing it, or write to a fresh path, or use `install -m 400`. Location: the mc-service store-mongo service under `infrastructure-as-code/docker/mc-service/…` (compose + `mongo-entrypoint.sh`).

### 4. Keycloak `backend-network` durability
After the reboot, `keycloak-service` came back attached only to `edge-network` + `keycloak-network`, **missing `backend-network`** — which broke mc-service's OIDC discovery of `keycloak-service` (`dns error … Try again`, app showed "failed to load collections"). Confirm the Keycloak (`prod-auth`) compose at `infrastructure-as-code/docker/keycloak/compose.prod.yaml` declares `backend-network` (external) and attaches `keycloak-service` to it. If it already does, the durable fix is just a Komodo `prod-auth` redeploy (flag this for the operator, replacing the temporary manual `docker network connect`); if not, add the attachment.

### 5. Renovate (was previously deferred)
Add a scheduled `.forgejo/workflows/renovate.yml` (nightly cron; `container: renovate/renovate`; env `RENOVATE_PLATFORM=forgejo` — use `gitea` if the pinned Renovate predates native Forgejo support — `RENOVATE_ENDPOINT` = the Forgejo API base, `RENOVATE_REPOSITORIES=jumbleknot/mcm`, `RENOVATE_AUTODISCOVER=false`, `RENOVATE_TOKEN=${{ secrets.RENOVATE_TOKEN }}`), plus a repo-root `renovate.json` extending `config:recommended` + `docker:pinDigests` with a `packageRules` entry that **disables** updates to our own registry images (match the private registry host) so it doesn't fight `cd-deploy`'s digest-by-git promotion. The operator will mint a least-privilege `renovate` Forgejo PAT (`read:repository` + `write:repository`) and store it as the `RENOVATE_TOKEN` Actions secret.

## Done criteria
Each change is deployable via the existing Komodo ResourceSync, passes the no-secrets-in-git gates, and lands via PR. After tasks 1–4 are merged and synced, the operator will perform a single **validation reboot** to confirm the box comes back fully clean and hands-off (no manual network reconnects, no unreachable UIs, no DB crash-loops).
