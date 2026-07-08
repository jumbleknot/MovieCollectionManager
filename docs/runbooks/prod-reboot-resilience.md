# Runbook — Prod Reboot-Resilience

Feature **028**. After a host reboot the rootless-Docker prod homelab must come back **fully clean and hands-off** — no unreachable admin/observability UIs, no data-store crash-loop, no manual network reconnects. This runbook records the full recovery posture: the host-side remediations (done outside this repo), the repo/deploy-side fixes (in git, so they survive every Komodo ResourceSync deploy), the one operator redeploy step, and a single **validation-reboot checklist**.

Context: a 2026-07-05 kernel-upgrade reboot hard-killed the rootless containers and exposed the defects fixed here. Prod is config-as-code, deployed via **Komodo ResourceSync** from `infrastructure-as-code/komodo/stacks.toml` (branch `main`).

> **Topology discipline** — this file uses placeholders only. `<tailnet-host>` is the prod host's `*.ts.net` name; `${BASE_DOMAIN}` the public base domain; `100.x.y.z` a Tailscale IP. Never commit the real values (topology-scrub + secret-scan gates enforce this).

Related: feature 025 Control Tower → [prod-control-tower.md](prod-control-tower.md); feature 026 data-tier auth → [prod-data-tier-auth.md](prod-data-tier-auth.md). Spec/plan/validation for this feature: [specs/028-prod-reboot-resilience/](../../specs/028-prod-reboot-resilience/) (see `quickstart.md` §D for the acceptance run).

## Part 1 — Host-side remediations (already complete, documented for durability)

These were applied on the prod host directly (they are host state, not committed config). Recorded here so the recovery posture is not lost.

| Control | What it does | Verify |
| --- | --- | --- |
| Graceful-shutdown drain unit | A systemd unit that, on shutdown/reboot, drains (stops) the rootless containers cleanly before the runtime is killed — avoids half-written state (e.g. the Mongo keyfile crash-loop conditions). | `systemctl status <drain-unit>` shows enabled; reboot leaves containers `Exited (0)`, not hard-killed. |
| Expanded DB backup coverage | Scheduled backups now cover **all** data volumes (Keycloak Postgres, both Mongos, LangFuse Postgres/ClickHouse, Unleash Postgres), not just a subset. Snapshots land in `~/mongo-backups` / the backup target. | Backup timer enabled; a recent dated snapshot exists per volume. |
| UPS / NUT | Uninterruptible power + Network UPS Tools trigger an orderly shutdown on sustained power loss (so a brownout no longer becomes a hard kill). | `upsc <ups>` reports online; a test on-battery event initiates NUT shutdown. |

**Optional defense-in-depth (host, not committed):** order the rootless user manager after Tailscale so the daemon never starts before the tailnet interface —

```ini
# ~/.config/systemd/user/docker.service.d/after-tailscaled.conf  (illustrative)
[Unit]
After=tailscaled.service
Wants=tailscaled.service
```

This is **not required** given the repo-side `0.0.0.0` bind fix below (which removes the dependency on tailnet-IP timing entirely), but it is a belt-and-braces option if tailnet-scoped binds are ever reintroduced.

## Part 2 — Repo/deploy-side fixes (in git — survive every Komodo deploy)

### 2a. Tailnet-IP port-bind race → bind `0.0.0.0` (US1)

**Root cause.** The rootless Docker daemon starts at boot **before** `tailscaled`, so rootlesskit never learns the tailnet IPv4. A published port scoped to `<tailnet-ip>:host:container` then **silently fails to bind** — the container shows `Up` with an **empty Ports column** and nothing listening. A container restart does not fix it; only a `0.0.0.0` bind or a full rootless-daemon restart (after tailscaled is up) does. Ports already on `0.0.0.0` were unaffected (that is why Forgejo on `0.0.0.0:3000` stayed reachable while every tailnet-IP-bound admin UI did not).

**Fix (committed).** The three (and only) tailnet-IP-scoped published ports bind `0.0.0.0` — on **prod-reserved ports** (see the 🚨 update below):

| Service | File | Port |
| --- | --- | --- |
| Keycloak admin | `infrastructure-as-code/docker/keycloak/compose.prod.yaml` | `19099:8080` |
| LangFuse web | `infrastructure-as-code/docker/observability/compose.prod.yaml` | `19030:3000` |
| Grafana / otel-lgtm | `infrastructure-as-code/docker/observability/compose.prod.yaml` | `19002:3000` |

**Exposure is unchanged.** The host **`ufw` default-deny on all non-tailnet inbound** is what keeps these ports tailnet-only — a `0.0.0.0` bind is still only reachable over the tailnet. This ufw posture is now **load-bearing**; do not relax it. (Verify: `sudo ufw status verbose` shows default deny incoming + the tailnet allow rule.)

> **🚨 Superseded by feature 029 (2026-07-06 outage follow-up).** Binding `0.0.0.0:8099` collided with a fatal blind spot: **prod and the CI runner share one host**, under two rootless daemons publishing into the **same host port space**. The CI app-e2e Keycloak publishes `127.0.0.1:8099`; a `0.0.0.0:8099` prod bind overlaps it, so whenever a CI Keycloak was up (a leftover CI stack held it for 6h) prod keycloak couldn't bind on redeploy → crash-loop → **prod-auth down**. Feature 029 moved the three prod admin ports into the **prod-reserved range `19000–19099`** (Keycloak `19099`, LangFuse `19030`, Grafana `19002`) — disjoint from every CI/dev port, enforced by `scripts/check-prod-ci-port-collision.mjs` (a required guardrail). Keep `0.0.0.0` + ufw. The admin console is now `http://<tailnet-host>:19099` (`KC_HOSTNAME_ADMIN`); the public issuer is unchanged. CI now tears down its stacks on every run (`app-ci.yml` `app-e2e`, `if: always()`) so a leftover can't hold a port.

**Retired variables.** `KC_ADMIN_BIND_IP` is removed (it was only the bind prefix; the admin **URL** still uses the separate `KC_HOSTNAME_ADMIN`). `TS_ADMIN_IP` is no longer referenced by any compose bind and **may be retired** as a Komodo Variable (harmless if left).

### 2b. Mongo keyfile crash-loop → idempotent entrypoint (US2)

**Root cause.** `infrastructure-as-code/docker/mc-service/mongo-entrypoint.sh` writes the replica-set keyfile at `0400`. On a plain container **restart** (not recreate) the prior run's read-only file persists, and mongod runs **non-root** — so the entrypoint's redirect cannot reopen the file for write (`Permission denied`, `EACCES`) and the container crash-loops under `restart: unless-stopped`.

**Fix (committed).** The entrypoint now `rm -f "$KEYFILE_PATH"` before the `umask`-guarded write (idempotent: a no-op on a fresh start; removal needs only directory-write permission, which the non-root user has on `/tmp`). Covered by `mongo-entrypoint.test.sh` (RED before the fix, GREEN after — run it as a **non-root** uid; root masks the bug).

### 2c. Restart-policy coverage (US1/SC-007)

Every service in every `*/compose.prod.yaml` declares a restart policy (27/27 at time of writing); the one-shot init containers idle on `sleep infinity` after an idempotent init so they too stay eligible.

> **🚨 CORRECTED by feature 030 (2026-07-08 reboot failure).** The claim that `restart: unless-stopped` means "every prod container returns automatically after a reboot" is **false on this stack**, and it is the direct cause of the 2026-07-08 failure. `unless-stopped` does **not** restart a container that was in a *stopped* state when the daemon (re)starts — and the **Part-1 drain unit stops every container to `Exited (0)` on shutdown**, so the two remediations defeat each other: the drain marks containers stopped, and `unless-stopped` then declines to bring them back on boot. Proven on Docker **29.6.0** (see feature 030): a `docker stop` + `systemctl --user restart docker` leaves an `unless-stopped` container `Exited`, while an otherwise-identical `restart: always` container comes back `Up`. Feature 030 switches **all** prod compose services (and the host-managed composes) to `restart: always`. See Part 5.

## Part 3 — Operator step: durable Keycloak `backend-network` re-attach (US3)

**Symptom (post-reboot).** `keycloak-service` came back attached only to `edge-network` + `keycloak-network`, **missing `backend-network`** — which broke `mc-service`'s OIDC/JWKS discovery of `keycloak-service` (`dns error … Try again`; the app showed "failed to load collections").

**Durable remediation — a Komodo `prod-auth` redeploy (NOT a manual `docker network connect`).** The `prod-auth` compose **already** declares `keycloak-service` on `backend-network` (`external: true`) — verified via `docker compose config`. The re-attach gap was a rootless runtime re-attach quirk on reboot, not a declaration gap. A ResourceSync redeploy recreates the container with the **full declared network set**, which is durable across future reboots; a manual `docker network connect` is a one-off that the next reboot can lose.

```text
# In Komodo: execute the ResourceSync (or the prod-auth stack redeploy).
# Then confirm the attachment:
docker inspect -f '{{json .NetworkSettings.Networks}}' keycloak-service   # must include backend-network
```

> **🚨 Hardened by feature 029.** The 2026-07-06 outage showed the recreate race worse than a *partial* re-attach: keycloak-service came back **detached from ALL networks** (a failed `0.0.0.0:8099` port bind rolled back its networking), so it couldn't even resolve its own Postgres (`UnknownHostException`). Feature 029 makes the intra-stack DB link **`keycloak-network` compose-managed** (was `external: true`) in `keycloak/compose.prod.yaml`, so compose creates+attaches it **atomically on every `up`** → Keycloak can always reach its Postgres even if the external nets (`backend`/`edge`) race. **Cutover (one-time, part of the clean redeploy after 029 merges):** after `prod-auth` Destroy, remove the now-orphaned external net so compose can own it — `docker network rm keycloak-network` — then Deploy (compose creates `prod-auth_keycloak-network`). The `keycloak-store-postgres-data` volume is external → data preserved.

## Part 4 — Validation-reboot checklist (operator, after merge + Komodo sync)

Perform **once** after this feature merges to `main` and Komodo syncs. This is the end-to-end acceptance (US1–US3). Do **not** manually start anything after boot — the whole point is hands-off recovery.

1. **Redeploy `prod-auth`** via Komodo (Part 3) and confirm `keycloak-service` is on `backend-network`.
2. **Reboot** the prod host once (`sudo reboot`).
3. After boot, **without any manual intervention**, verify every row:

| # | Check | Expected | Criterion |
| --- | --- | --- | --- |
| 1 | Keycloak admin over the tailnet — `http://<tailnet-host>:8099` | reachable | SC-001 |
| 2 | LangFuse web over the tailnet — `http://<tailnet-host>:3030` | reachable | SC-001 |
| 3 | Grafana over the tailnet — `http://<tailnet-host>:3002` | reachable | SC-001 |
| 4 | `docker ps` Ports column for the three above | shows `0.0.0.0:PORT->…`, **not** empty | SC-001 |
| 5 | `mc-service-store-mongo` | `healthy`, **zero** crash-loop restarts (`docker inspect -f '{{.RestartCount}}'`) | SC-002 |
| 6 | App loads collections end-to-end (`https://mcm.${BASE_DOMAIN}`) | works, **zero** manual `docker network connect` | SC-003 |
| 7 | The three ports probed from **off-tailnet** | refused (ufw default-deny) | SC-004 |
| 8 | `docker ps -a` for every prod container | came back via its restart policy | SC-007 |

**Pass = all eight rows pass on the first reboot.** Any failing row is a defect to fix before closing the feature.

## Part 5 — Feature 030: Reboot-Resilience v2 (2026-07-08 failure)

A validation reboot on 2026-07-08 came back **not** clean: the DB tier was up but the **whole app tier + Komodo periphery + Forgejo were down**, and Komodo could not redeploy. Two independent root causes, both gaps 028 missed.

### RC#1 — Komodo periphery root was on an ephemeral tmpfs (host change, applied)

**Cause.** Komodo periphery's `root_directory` was the stock default `/etc/komodo` (never overridden in `Server-Setup-Runbook.md` Phase 9). Under **rootless Docker, `/etc` is copy-up'd to a per-daemon tmpfs** (RootlessKit `--copy-up=/etc`), so everything periphery writes under `/etc/komodo` — the cloned `mcm-repo` checkout that every stack's relative bind-mounts (`./mongo-entrypoint.sh`, `./config/vault.hcl`, `./init-audit-user.sh`, `../../opa/policies`) resolve against — is **wiped on every reboot**. After reboot the checkout is gone; Docker then auto-creates each missing bind-mount *source file* as a **directory**, so `mc-service-store-mongo` and `vault-service` fail to start with `not a directory … mount a directory onto a file` (exit **127**). This is structural, not a race — it recurs every reboot.

**Fix (host state — not committed; Komodo bootstrap lives on the host).** Point the periphery root at persistent disk:

```bash
# /home/prod/komodo/compose.env  and  /home/prod/komodo/.env  (both — .env is the compose-interpolation copy)
PERIPHERY_ROOT_DIRECTORY=/home/prod/komodo/periphery-root      # was /etc/komodo
# then:
prod$ mkdir -p /home/prod/komodo/periphery-root
prod$ docker compose -p komodo -f ferretdb.compose.yaml up -d  # recreates periphery with the persistent root
```

Verify: `docker exec komodo-periphery-1 sh -c 'df -h /home/prod/komodo/periphery-root | tail -1'` shows the real `ext4` LVM disk (not `tmpfs`), and `docker logs komodo-periphery-1` shows `root_directory: "/home/prod/komodo/periphery-root"` + `Logged in to Komodo Core`. **Also update `Server-Setup-Runbook.md` Phase 9** so a rebuild does not reintroduce `/etc/komodo`.

### RC#2 — `unless-stopped` never survives a daemon shutdown here → `restart: always`

See the corrected §2c above. **Fix:** every prod compose service is now `restart: always` (committed, all 7 `*/compose.prod.yaml`), and every **host-managed** compose is set to `restart: always` too (host state — see below). The drain unit is retained but reworked (below); with `always` the drain no longer needs to leave anything running to survive.

**Host-managed composes** (not in git — the sync does not manage them; edit each file's `restart:` to `always` and `docker compose … up -d`):

| Stack | File |
| --- | --- |
| Forgejo (forge + db) | `/home/prod/forgejo/compose.yaml` |
| Komodo (core/periphery/ferretdb/postgres) | `/home/prod/komodo/ferretdb.compose.yaml` |
| cloudflared (public tunnel) | `/home/prod/cloudflared/compose.yaml` |
| beszel, dozzle, minio, uptime-kuma | `/home/prod/<name>/compose.yaml` |

> **Interim runtime hardening** (already applied, survives until each container is next *recreated*): `docker update --restart always $(docker ps -q)`. The committed compose `always` values + host-compose edits are what make it durable across recreates/rebuilds.

### Reworked drain unit (host state)

`~/.config/systemd/user/docker-drain.service` previously ran `docker stop -t 30 $(docker ps -q)` **sequentially** — with ~40 containers it exceeded `TimeoutStopSec=120` and was SIGKILL'd mid-drain, stopping a non-deterministic subset. Rework it to stop **in parallel** so the graceful drain actually completes within the timeout (its only remaining job — `restart: always` now guarantees the return):

```ini
ExecStop=/bin/sh -c 'docker ps -q | xargs -r -P 20 -I{} docker stop -t 20 {}'
```

### Recovery ordering blind spot (why the UI was stuck)

Komodo **periphery** is itself a rootless container — on the failed reboot it was down (drain victim), so **Komodo Core had no agent and the UI showed no stacks / could not sync**. And **Komodo clones the repo from Forgejo on every sync**, so Forgejo must be up first. Manual recovery order when a reboot lands dirty: **(1)** `docker start komodo-periphery-1` (Core reconnects), **(2)** `docker start forgejo-forgejo-1` (git source), **(3)** Komodo **Execute Sync** (re-clones to the persistent root, recreates + starts every stack).

### Revised validation-reboot checklist (supersedes Part 4)

Ports are the feature-029 prod-reserved values. Do **not** manually start anything after boot.

| # | Check | Expected |
| --- | --- | --- |
| 1 | `docker ps -a` — every prod container **and** host-managed container (Forgejo, Komodo core+**periphery**, cloudflared) | `Up` via `restart: always` |
| 2 | `mc-service-store-mongo` + `vault-service` | `Up`, **zero** exit-127 (checkout on persistent disk) |
| 3 | `docker exec komodo-periphery-1 df -h /home/prod/komodo/periphery-root` | real disk, **not** tmpfs; `repos/mcm-repo/.git` present |
| 4 | Keycloak admin `http://<tailnet-host>:19099`, LangFuse `:19030`, Grafana `:19002` | reachable; Ports column non-empty |
| 5 | Forgejo `http://<tailnet-host>:3000` | HTTP 200 |
| 6 | App end-to-end `https://mcm.${BASE_DOMAIN}` + `auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` | 200, zero manual intervention |

**Pass = all rows on the first reboot, no manual `docker start`.**

## Rollback

All Part-2/Part-5 **committed** changes are ordinary config in git — revert the feature-028/030 commits and re-sync via Komodo to return to the prior bind/entrypoint/restart behavior. The Part-5 **host** changes (periphery root, host-compose `restart: always`, reworked drain) are host state: restore `/home/prod/komodo/{compose.env,.env}.bak-*` and re-`up -d` to revert the periphery root; the compose/drain edits are per-file reverts. There is no data migration.
