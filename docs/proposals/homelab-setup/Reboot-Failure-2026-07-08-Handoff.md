# Handoff — homelab did NOT come back cleanly after the 2026-07-08 validation reboot

*Paste this into a fresh Claude Code session opened in the `jumbleknot/mcm` repo. It is the debugging brief for why the prod homelab's containers did not recover after a reboot, with the evidence already gathered.*

---

## TL;DR

The host **booted fine** — SSH, Tailscale, and the **stateful/DB containers are all up** — but the **application tier and two file-bind-mount containers did NOT come back**, so prod is effectively down (Keycloak/auth, mc-service, BFF, agents, observability all Exited; **Forgejo `:3000` is down**). There are **TWO independent root causes**, both reboot-ordering / restart-policy gaps (the class feature 028 tried to solve but did not fully close).

**This is the 4th reboot incident in this arc** — see feature **028** (`docs/runbooks/prod-reboot-resilience.md`) and **029** (`specs/029-prod-ci-port-isolation/`, the port-collision + keycloak-network fix). Prod runs config-as-code via **Komodo ResourceSync** from `infrastructure-as-code/komodo/stacks.toml` (branch `main`), rootless Docker.

## State captured at incident (2026-07-08 ~00:10 UTC, ~8 min after boot)

- Host `up 8 min`; `prod@` (uid 1002) + `ci@` (uid 1001) SSH OK; Tailscale up.
- **systemd linger = yes** for both prod + ci; rootless `docker.service` (user) **enabled + active since boot** → *the daemon-on-boot path is fine, NOT the problem.*
- Container states in the **prod** daemon:
  - **UP (healthy):** `keycloak-store-postgres`, `langfuse-postgres`, `unleash-postgres`, `mcm-bff-store-mongo`, `unleash-service`, `forgejo-forgejo-db-1`, `beszel`, `dozzle`.
  - **Exited (255):** `keycloak-service`, `mc-service`, `mcm-bff-service`, `movie-assistant-gateway` + 3 `movie-assistant-mcp-*`, `langfuse-web`, `langfuse-worker`, `otel-lgtm`, `uptime-kuma`, `langfuse-minio-init`, `unleash-seed`.
  - **Exited (127):** `mc-service-store-mongo`, `vault-service`.
- **Forgejo web `:3000` = connection refused** (find + restart the forgejo *app* container — only `forgejo-forgejo-db-1` was seen up; the app container may be under `ci@` — CHECK BOTH daemons).

## Root cause #1 — file bind-mounts fail: the Komodo repo checkout is GONE after reboot (exit 127)

`mc-service-store-mongo` and `vault-service` fail to (re)create with:
```
error mounting ".../mc-service/mongo-entrypoint.sh" to rootfs at "/usr/local/bin/mongo-entrypoint.sh":
 ... not a directory: Are you trying to mount a directory onto a file (or vice-versa)?
```
Confirmed on the host:
```
MISSING  /etc/komodo/repos/mcm-repo/infrastructure-as-code/docker/mc-service/mongo-entrypoint.sh
MISSING  /etc/komodo/repos/mcm-repo/infrastructure-as-code/docker/vault/config/vault.hcl
repo checkout root exists? NO     (/etc/komodo/repos/mcm-repo)
/etc/komodo owner: (no access — root/komodo-owned; prod@ can't read)
```
**Diagnosis:** these containers **bind-mount host FILES** (`mongo-entrypoint.sh`, `vault.hcl`) from the **Komodo periphery repo checkout** at `/etc/komodo/repos/mcm-repo/…`. After reboot that checkout is **not present** (Komodo periphery had not re-synced/re-cloned it yet, or it lives on non-persistent storage). Docker's classic gotcha: a missing bind-mount *source file* is auto-created as a **directory**, so the file→file mount then fails "not a directory" (and here the whole tree is simply gone). So any container mounting a host file from `/etc/komodo/repos/…` cannot start until Komodo restores the checkout. **Likely also affects** anything else mounting host files from that path — audit-init `init-audit-user.sh`, the Keycloak realm import file, etc. (grep `compose.prod.yaml` for `:ro` file mounts).

**The Komodo periphery agent service could not be confirmed running from `prod@`** (`/etc/komodo` is root-owned) — the fresh session needs a user that can see it (sudo / the komodo user) to check whether periphery starts on boot and *when* it restores the checkout relative to the rootless containers' restart.

## Root cause #2 — the feature-028 drain unit + `restart: unless-stopped` = no auto-restart (exit 255)

The app-tier containers show **`restartCount=0`**, **clean shutdown logs** (e.g. Keycloak: `Keycloak stopped in 0.277s`), exit 255, and did **not** restart. Cause is the feature-028 host-side **graceful-shutdown drain unit** (`~/.config/systemd/user/docker-drain.service`):
```ini
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=/bin/sh -c 'cids=$(docker ps -q); if [ -n "$cids" ]; then docker stop -t 30 $cids; fi'
TimeoutStopSec=120
```
On shutdown it runs **`docker stop`** on running containers. But **`restart: unless-stopped` does NOT auto-start a container that was in a *stopped* state when the daemon restarts** (that's the literal semantics of `unless-stopped`). So every container the drain successfully stopped stays **down** after reboot — **the drain unit defeats the restart policy.** (The DBs that came back up are the ones the drain did *not* reach before shutdown killed it — `docker stop -t 30` each, `TimeoutStopSec=120`, so with ~24 containers it likely ran out of time / was interrupted, leaving a non-deterministic subset still "running" → those auto-restart.)

**Candidate fixes (verify before choosing):**
- **(a)** Switch prod compose `restart: unless-stopped` → **`restart: always`** (repo change, all `*/compose.prod.yaml`). `always` *does* restart on daemon startup even after a `docker stop`, so it survives the drain. Keeps the drain's "clean stop" benefit. **Verify the exact `always` vs `unless-stopped` daemon-start semantics on this Docker version first.**
- **(b)** Remove/rework the drain unit so it doesn't `docker stop` (e.g. rely on the runtime's own SIGTERM-on-shutdown + `unless-stopped` auto-restart). Risk: the "half-written state" the drain was meant to prevent (the 028 Mongo-keyfile / DB-consistency concern).
- **(c)** Have the drain use `docker kill --signal=SIGTERM` or `docker stop` **followed by nothing** but change the policy — same as (a).
- Whichever: it must **not** leave `unless-stopped` containers in the stopped state across a reboot.

> ⚠️ These two fixes interact with the reboot ordering: even with `restart: always`, the **#1 containers still can't start until `/etc/komodo/repos/mcm-repo` exists** (Komodo checkout restored). Both must be solved for a truly clean hands-off reboot.

## Immediate recovery (get prod back NOW — separate from root-causing)

Prod auth + app are DOWN. Fastest restore = a **Komodo ResourceSync / redeploy of all stacks** (Komodo re-clones `/etc/komodo/repos/mcm-repo`, recreates every container with correct file mounts, and starts them) — same mechanism as the 029 cutover. Do it from the Komodo UI (operator). After sync, verify:
- `docker ps` in the prod daemon: keycloak-service `Up (healthy)` on `0.0.0.0:19099`, mc-service/bff/gateway up, `mc-service-store-mongo` + `vault-service` up (127 gone), `otel-lgtm`/`langfuse-web` up.
- `curl -sf http://homelab.<tailnet>:3000` (Forgejo) — if still down, find + start the forgejo app container (check `ci@` daemon too).
- App login works; `https://auth.<BASE_DOMAIN>/realms/grumpyrobot/.well-known/openid-configuration` returns the issuer.

## Access & context for the fresh session

- **Prod host:** `ssh prod@homelab.<tailnet-host>` (uid 1002, its own rootless docker; `docker …` works directly). **`/etc/komodo/…` is root-owned** — prod@ can't read it; you need sudo or the komodo user to inspect the periphery service + checkout.
- **CI host (same box):** `ssh ci@homelab.<tailnet-host>` (uid 1001, second rootless daemon — the Forgejo runner). Forgejo itself may live here.
- **Komodo** is the deploy control plane (config-as-code from `stacks.toml`, branch `main`); prod deploys ONLY through it — do not hand-edit `/etc/komodo` state.
- **CI-monitor token** (read-only Forgejo API): `C:\Users\Steve\.mcm\forgejo-ci-token` — but **Forgejo is down**, so the API is unavailable until it's restored.
- **Topology discipline:** never commit the real base domain / tailnet host / Tailscale IP (topology-scrub + secret-scan gates). Use placeholders.
- **Relevant history:** feature **028** = reboot-resilience (`docs/runbooks/prod-reboot-resilience.md`; the drain unit is a 028 *host-side* fix — NOT in git); feature **029** = prod/CI shared-host port isolation + `keycloak-network` compose-managed (`specs/029-prod-ci-port-isolation/`). Prod admin ports are now **19099** (Keycloak), **19030** (LangFuse), **19002** (Grafana).

## Suggested investigation order (fresh session)

1. **Restore service** (Komodo sync) — confirm the redeploy brings everything up (validates that a *sync* fixes it, isolating the reboot-only gap).
2. **Confirm root cause #2:** `docker inspect <app-container> --format '{{.HostConfig.RestartPolicy.Name}}'` = `unless-stopped`; read `docker-drain.service`; verify on this Docker version whether `unless-stopped` vs `always` restarts a drain-stopped container across a daemon restart (a controlled `docker stop x && systemctl --user restart docker && docker ps` test).
3. **Confirm root cause #1:** who owns/creates `/etc/komodo/repos/mcm-repo`, is it persistent across reboot, does the Komodo periphery systemd service restore it on boot, and does it run *before* the rootless containers try to restart? (needs sudo/komodo user.) Decide: order periphery-before-containers, OR stop bind-mounting host files from the ephemeral checkout (bake them into images / use named volumes / config), OR make containers tolerant of a late mount.
4. **Then design the durable fix** (likely: `restart: always` in the prod composes + a Komodo-checkout-before-containers ordering, or removing host-file bind-mounts) and follow SDD — this is a candidate **feature 030 (reboot-resilience v2)**, extending the 028 runbook.
5. Re-run a validation reboot as the acceptance test (the step that failed here).
