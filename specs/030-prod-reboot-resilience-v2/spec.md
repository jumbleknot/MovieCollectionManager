# Feature 030 — Prod Reboot-Resilience v2

**Status:** in progress (2026-07-08)
**Supersedes/corrects:** feature 028 (`specs/028-prod-reboot-resilience/`) §2c and its "unless-stopped ⇒ auto-return" assumption.
**Related:** 029 (prod/CI port isolation), 026 (data-tier auth), 025 (control tower).

## Problem

The 2026-07-08 validation reboot — the acceptance step that was supposed to *close* 028 — did **not** come back clean. The DB tier was up but the **entire application tier, Komodo periphery, and Forgejo were down**, and Komodo could not redeploy (the UI showed no stacks). This is the 4th reboot incident in the arc; 028's fixes were necessary but not sufficient.

Two independent root causes, both proven on the host (Docker 29.6.0, rootless):

### RC#1 — Komodo periphery root is on an ephemeral tmpfs
Periphery's `root_directory` was the stock default `/etc/komodo`. Under rootless Docker, `/etc` is copy-up'd to a per-daemon tmpfs (RootlessKit `--copy-up=/etc`), so the cloned `mcm-repo` checkout — which every prod stack's **relative** bind-mounts (`./mongo-entrypoint.sh`, `./config/vault.hcl`, `./init-audit-user.sh`, `../../opa/policies`) resolve against — is wiped on **every** reboot. After reboot Docker auto-creates each missing bind-mount source *file* as a *directory*, and `mc-service-store-mongo` + `vault-service` fail with `not a directory` (exit 127). Structural, recurs every reboot.

### RC#2 — `restart: unless-stopped` does not survive a daemon shutdown on this stack
028 assumed `unless-stopped` returns every container after reboot. It does not: `unless-stopped` will not restart a container that was in a *stopped* state when the daemon (re)starts, and 028's own Part-1 **drain unit** stops every container to `Exited (0)` on shutdown. The two remediations defeat each other. Proven: `docker stop X && systemctl --user restart docker` leaves an `unless-stopped` container `Exited` while an identical `restart: always` container returns `Up`. On a real reboot the up/down split is just non-determinism (whatever the daemon/drain didn't finish stopping before SIGKILL was still "running" → returns).

### Compounding blind spot
Komodo **periphery** is itself a rootless container — down on the failed reboot (drain victim) — so Core had no agent and the UI could not sync. And Komodo clones from **Forgejo**, which was also down. Recovery is therefore impossible via the UI until periphery + Forgejo are manually started.

## Success criteria

- **SC-030-1:** After an unattended reboot, **every** prod container *and* every host-managed container (Forgejo, Komodo core+periphery, cloudflared, beszel, dozzle, minio, uptime-kuma) returns to `Up` with **zero** manual intervention.
- **SC-030-2:** `mc-service-store-mongo` + `vault-service` return with **zero** exit-127 — their bind-mount checkout is on persistent disk.
- **SC-030-3:** The Komodo periphery root is on real disk (not tmpfs); `repos/mcm-repo/.git` is present after reboot.
- **SC-030-4:** App works end-to-end after reboot (`mcm.${BASE_DOMAIN}` 200, `auth.${BASE_DOMAIN}` well-known 200) with no manual `docker start`, `docker network connect`, or Komodo sync.
- **SC-030-5:** The false 028 §2c claim is corrected in git so the wrong mental model does not persist.

## Scope

**In (committed):** `restart: unless-stopped` → `restart: always` in all 7 `infrastructure-as-code/docker/*/compose.prod.yaml`; runbook corrections + v2 section; this spec/plan.

**In (host state — documented, not committed; Komodo bootstrap + host composes live on the host):** persistent `PERIPHERY_ROOT_DIRECTORY`; host-managed composes → `restart: always`; reworked (parallel) drain unit; interim `docker update --restart always`.

**Out:** removing host-file bind-mounts entirely (baking configs into images / named volumes) — a larger refactor; deferred. `restart: always` + persistent periphery root closes the reboot gap without it.

## Non-goals / accepted residuals
- The one-shot `*-rs-init` / `createbucket` containers stay `restart: no` (they exit 0 by design; their effect is persisted in volumes).
- Host-side changes remain host state (the Komodo bootstrap is not self-managed config-as-code); durability is via the runbook, matching 028's Part-1 convention.
