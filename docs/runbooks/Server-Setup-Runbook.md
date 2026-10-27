# Homelab Server Setup Runbook — MCM CI/CD + Production

**Target host:** Beelink SER9 MAX (Ryzen 7 "H 255", 8C/16T, 64 GB DDR5, 1 TB NVMe), headless.
**Goal:** Ubuntu 26.04 LTS host running **two segregated rootless Docker daemons** — `ci` (Forgejo Actions build/test) and `prod` (production hosting) — with Forgejo as the source-of-truth forge (push-mirrored to GitHub), Forgejo's OCI registry, and Komodo handling CD to prod.
**Companion doc:** `PRD-CI.md`.

> Conventions: `$` = run as your normal sudo user; `ci$` / `prod$` = run as that service user (`sudo -iu ci` / `sudo -iu prod`). Replace `server.tailnet.ts.net`, passwords, and secrets with your own. Treat every secret here as a placeholder.

---

## Phase 0 — BIOS / firmware

1. Boot into BIOS (Del/F7 on Beelink).
2. Enable **AMD SVM Mode** (hardware virtualization) — required for KVM/the Android emulator.
3. Enable **IOMMU** (leave at Auto/Enabled).
4. Set power-on behavior to **"Always On"** (or "Last State") so the headless box recovers after a power blip.
5. Disable any "boot on lid/standby" sleep; confirm the NVMe is the first boot device.
6. Update BIOS to the latest Beelink release if your unit shipped older (newer AMD APUs benefit from AGESA fixes).

---

## Phase 1 — OS install (Ubuntu Server 26.04 LTS, headless)

1. Flash **Ubuntu Server 26.04 LTS** to USB (Rufus/balenaEtcher). Use *Server*, not Desktop.
2. Install with: minimized footprint, **OpenSSH server enabled**, no extra snaps, full-disk LVM (optionally LUKS — 26.04 supports TPM-backed FDE if you want headless unlock).
3. Create your admin user (e.g. `steve`) during install.
4. First boot, update:

```bash
$ sudo apt update && sudo apt full-upgrade -y
$ sudo apt install -y curl ca-certificates uidmap dbus-user-session \
    slirp4netns fuse-overlayfs cpu-checker qemu-system-x86 unattended-upgrades \
    fail2ban ufw git
# Note: on 24.04+/26.04 the old `qemu-kvm` transitional package is gone — the kvm
# binary now ships in `qemu-system-x86`. (The Android emulator bundles its own QEMU;
# the host only needs the kvm module + `kvm` group membership, verified by kvm-ok.)
$ sudo reboot
```

5. Verify kernel + virtualization:

```bash
$ uname -r            # expect 7.x
$ kvm-ok              # expect "KVM acceleration can be used"
```

6. **Disk wasn't fully allocated — extend the root LV.** Even with "use entire disk
   with LVM," Ubuntu's guided installer caps the root logical volume (~100 GB) and leaves
   the rest of the VG unallocated. Symptom: `df -h /` and Komodo report ~98 GB total on a
   1 TB drive. Check and fix (online, no downtime):

```bash
$ df -h /                  # if total is ~98G, not ~1T, you're affected
$ sudo vgs                 # VFree shows the unused space (~800-900G)
$ sudo lvs                 # confirm the root LV name/path
$ sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv   # -r resizes the fs too (ext4)
# XFS instead of ext4: drop -r, then `sudo xfs_growfs /`
$ df -h /                  # now ~1T; Komodo clears on its next stats poll
```

---

## Phase 2 — Hardening & base security

1. **SSH key-only.** Goal: confirm key login works, then disable password logins.

   **a. Put your public key on the server** (skip if already done). If you imported your
   key from GitHub during the Ubuntu install, it's already in `~/.ssh/authorized_keys` —
   nothing to do. Otherwise, from your workstation: `ssh-copy-id steve@<server-ip>`.
   (Windows' built-in SSH client has no `ssh-copy-id`; import via GitHub or paste the key
   into `~/.ssh/authorized_keys` manually instead.)

   **b. From your workstation, verify key login works BEFORE locking down:**
   ```bash
   ssh steve@<server-ip>     # should log in without asking for your ACCOUNT password
                             # (a key passphrase prompt is fine — that's the key, not the account)
   ```

   **c. On the SERVER, disable password + root login and restart ssh:**
   ```bash
   $ sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
   $ sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
   $ sudo systemctl restart ssh
   ```

   **d. Confirm the effective config** (Ubuntu's installer/cloud-init often drops an
   override that re-enables passwords):
   ```bash
   $ sudo sshd -T | grep -iE 'passwordauthentication|permitrootlogin'
   # want: passwordauthentication no / permitrootlogin no
   # if passwordauthentication is still 'yes', edit the offending file in
   # /etc/ssh/sshd_config.d/ (e.g. 50-cloud-init.conf), set it to no, restart ssh again.
   ```

   > Keep your current SSH session open and test a fresh connection in a second window
   > before closing it. The Beelink's own console (monitor + keyboard) is your fallback if
   > you ever lock yourself out.

2. **Firewall** — default-deny inbound; allow SSH only (more ports come in later via Tailscale, so they need not be public):

```bash
$ sudo ufw default deny incoming
$ sudo ufw default allow outgoing
$ sudo ufw allow OpenSSH
$ sudo ufw enable
```

3. **Automatic security updates** + **fail2ban** (already installed):

```bash
$ sudo dpkg-reconfigure -plow unattended-upgrades   # choose Yes
$ sudo systemctl enable --now fail2ban
```

---

## Phase 3 — Remote management

### 3.1 Tailscale (private access, no public ports)

```bash
$ curl -fsSL https://tailscale.com/install.sh | sh
$ sudo tailscale up --ssh
$ tailscale status        # note this host's REAL name + 100.x.y.z IP
$ tailscale ip -4
```

Find your real tailnet name/IP with the commands above — wherever this runbook shows
`server.tailnet.ts.net`, substitute your actual name (e.g. `beelink.<tailnet>.ts.net`) or
the `100.x` IP. **Also install Tailscale on any device you'll browse from** (your Windows
PC, phone) and sign into the same tailnet, or `.ts.net`/`100.x` addresses won't resolve.

**Open the firewall to the tailnet** (Phase 2's `default deny incoming` otherwise blocks
every admin UI — Cockpit, Forgejo, Komodo, Grafana — even over Tailscale):

```bash
$ sudo ufw allow in on tailscale0     # trusts the encrypted tailnet; nothing public is opened
$ sudo ufw status
```

From now on reach web UIs over Tailscale instead of opening public ports.

### 3.2 Cockpit (browser-based host admin)

```bash
$ sudo apt install -y cockpit
$ sudo systemctl enable --now cockpit.socket
```

Reach it at `https://server.tailnet.ts.net:9090`. Use it for host metrics, logs, storage, and updates. (Container management is handled by Komodo, below.)

---

## Phase 4 — KVM for the Android emulator

1. Add yourself and the future `ci` user to the `kvm` group; verify the device:

```bash
$ sudo usermod -aG kvm steve
$ ls -l /dev/kvm        # expect group "kvm"; this host shows crw-rw-rw- (666, measured 2026-10-12)
```

(The `ci` service user is added in Phase 5. The emulator job does not get KVM passed into a container: it runs on the host as `ci` through the `kvm:host` runner label, set up in 5.4 and Phase 7.)

---

## Phase 5 — Two segregated rootless Docker daemons

The core of the segregation: **two unprivileged users**, each running its **own rootless dockerd** with its own socket, data root, networks, and volumes. A breakout in CI cannot reach prod, and neither can touch the host as root.

### 5.1 Create the service users

```bash
$ sudo useradd -m -s /bin/bash ci
$ sudo useradd -m -s /bin/bash prod
$ sudo usermod -aG kvm ci                       # CI needs the emulator
$ sudo loginctl enable-linger ci                # daemons run without an active login
$ sudo loginctl enable-linger prod
```

Subordinate UID/GID ranges (rootless needs them). **`useradd -m` already assigns each new
user a clean, non-overlapping range — normally you do nothing here but verify.** Do NOT add
a second range with `usermod --add-subuids`; that creates an *overlap* and rootless Docker
fails with `newuidmap: write to uid_map failed: Invalid argument`.

```bash
$ grep -E '^(ci|prod):' /etc/subuid /etc/subgid
# Expect EXACTLY ONE line per user per file, non-overlapping, e.g.:
#   /etc/subuid:ci:165536:65536
#   /etc/subuid:prod:231072:65536
```

Only act if a user is **missing** a range (add a single one that collides with nothing),
or if you see **two lines / overlapping ranges** for a user (remove the extra):

```bash
# missing → add ONE range:
$ sudo usermod --add-subuids 165536-231071 --add-subgids 165536-231071 ci
# overlapping/duplicate → delete the offending extra range so one clean line remains:
$ sudo usermod --del-subuids 200000-265535 --del-subgids 200000-265535 ci
```

> If `usermod` says *"user ci is currently used by process …"*, linger has started ci's
> `systemd --user` manager. Stop it first, fix the range, then re-enable linger:
> `sudo loginctl terminate-user ci` → run the `usermod` → `sudo loginctl enable-linger ci`.

### 5.2 Install rootless Docker for each user

Install the Docker packages once (system), but run the **rootless setup per user**:

```bash
$ curl -fsSL https://get.docker.com | sh        # installs engine + CLI
$ sudo systemctl disable --now docker.service docker.socket   # we do NOT use the rootful daemon
```

Then set up rootless Docker for **each** service user. **Important:** enter the account with
`machinectl shell`, NOT `sudo -iu`/`su`. The setup tool needs a real `systemd --user` session
to install the unit that auto-starts the daemon; `sudo -iu` doesn't provide one and the tool
silently falls back to a "manual start" mode (tell-tale sign: it prints *"systemd not detected"*
and sets `XDG_RUNTIME_DIR=/home/<user>/.docker/run` instead of `/run/user/<uid>`).

```bash
# prerequisite (once): provides `machinectl shell`
$ sudo apt install -y systemd-container

# --- ci ---
$ sudo machinectl shell ci@           # NOT `sudo -iu ci`
ci$ echo $XDG_RUNTIME_DIR             # sanity: must be /run/user/<uid>, not /home/ci/.docker/run
ci$ dockerd-rootless-setuptool.sh install     # must NOT say "systemd not detected"
ci$ systemctl --user enable --now docker
ci$ echo 'export DOCKER_HOST=unix:///run/user/'"$(id -u)"'/docker.sock' >> ~/.bashrc
ci$ docker context use rootless 2>/dev/null; docker info | grep -i rootless
ci$ exit

# --- prod ---
$ sudo machinectl shell prod@
prod$ dockerd-rootless-setuptool.sh install
prod$ systemctl --user enable --now docker
prod$ echo 'export DOCKER_HOST=unix:///run/user/'"$(id -u)"'/docker.sock' >> ~/.bashrc
prod$ exit
```

> If `machinectl shell <user>@` errors, the fallback is to set the session env manually before
> re-running: `export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`
> (requires linger enabled so the user manager is running).
>
> If a *prior failed run* left a stale `rootless` context pointing at
> `/home/<user>/.docker/run/docker.sock` (symptom: `docker info` → "failed to connect ... no
> such file or directory"), repoint it at the real systemd socket:
> `docker context update rootless --docker host=unix:///run/user/$(id -u)/docker.sock`.

Each user now has an independent daemon at `/run/user/<uid>/docker.sock` with data under `~/.local/share/docker`. They share nothing.

> **Enable cgroup delegation** so container CPU/IO limits actually work (rootless Docker
> otherwise warns `No cpuset support` / `No io.* support`, and only memory/pids limits are
> enforced). This is required for the CI-vs-prod resource isolation in Phase 12. Run once as
> your sudo user, then reboot:
> ```bash
> $ sudo mkdir -p /etc/systemd/system/user@.service.d
> $ sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null <<'EOF'
> [Service]
> Delegate=cpu cpuset io memory pids
> EOF
> $ sudo systemctl daemon-reload && sudo reboot
> ```
> After reboot, `docker info` (in a `machinectl shell <user>@` session) should no longer print
> the "No cpuset/io support" warnings.

### 5.3 Per-daemon `daemon.json` (log rotation, live-restore)

For each user, create `~/.config/docker/daemon.json`:

```json
{
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

Then `systemctl --user restart docker` as that user. (Note: `live-restore` + `userns-remap` don't combine; rootless already provides the user-namespace isolation, so omit `userns-remap`.)

### 5.4 KVM for the emulator job (the one rootless caveat)

The Maestro emulator job must get `/dev/kvm`, and it can't get a working setup from a rootless job
container: besides KVM, the E2E job needs `localhost:8082` (web E2E → dev BFF) and `10.0.2.2:8082`
(emulator → host) to resolve like a single host, plus the `ci` Docker daemon. So the emulator job
(`app-ci`'s `app-e2e`, and the other Docker-building jobs) runs **directly on the host** as the
unprivileged `ci` user through a host-type runner label (`kvm:host`, Phase 7) — which is why `ci` is
in the `kvm` group (5.1). Passing `--device /dev/kvm --group-add kvm` into a job container was the
setup until commit `235f2f4c` (feature 023). Every other CI workload stays in rootless containers on
the `ci` daemon. Prod is never affected.

### 5.5 Create the app's external networks/volumes (per the repo's first-time setup) on the **prod** daemon

`MCM-Architecture.md` / `docs/runbooks/local-dev.md` expect these to pre-exist. The names below
are the **feature-019/020 canonical** resource names (one role id per resource, no `mcm_`/`localdev-`
project prefix). Create them under the daemon that will run the stack (prod for production; the CI
daemon creates its own throwaway copies during the workflow):

```bash
prod$ docker network create backend-network
prod$ docker network create keycloak-network
prod$ docker network create movie-assistant-mcp-network
prod$ docker volume create mc-service-store-mongo-data          # mc-service domain DB (was mc-service_mc-db-data)
prod$ docker volume create keycloak-store-postgres-data         # Keycloak DB (was localdev-auth_keycloak-db-data)
prod$ docker volume create mcm-bff-cache-redis-data             # BFF session store (was mcm-redis-data)
prod$ docker volume create mcm-bff-store-mongo-data             # BFF agent-config store (feature 018)
prod$ docker volume create movie-assistant-store-postgres-data  # agents profile (LangGraph checkpointer)
prod$ docker volume create agent-audit-opensearch-data          # audit stack only
```

---

## Phase 6 — Forgejo (source of truth) + registry + GitHub mirror

Run Forgejo on the **prod** daemon (it's a long-lived service, not a build artifact). Use a dedicated compose project.

### 6.1 Deploy Forgejo + database

`/home/prod/forgejo/compose.yaml`:

```yaml
services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:15      # current stable LTS (Apr 2026); no `latest` tag exists
    restart: unless-stopped
    environment:
      - FORGEJO__database__DB_TYPE=postgres
      - FORGEJO__database__HOST=forgejo-db:5432
      - FORGEJO__database__NAME=forgejo
      - FORGEJO__database__USER=forgejo
      - FORGEJO__database__PASSWD=CHANGE_ME_DB
      - FORGEJO__server__DOMAIN=server.tailnet.ts.net
      - FORGEJO__server__ROOT_URL=http://server.tailnet.ts.net:3000/
      - FORGEJO__packages__ENABLED=true          # enables the OCI registry
      - FORGEJO__actions__ENABLED=true           # enables Forgejo Actions
    volumes:
      - forgejo-data:/data
    ports:
      - "3000:3000"      # web/API (reach over Tailscale)
      - "2222:22"        # git over ssh
    depends_on: [forgejo-db]
  forgejo-db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=forgejo
      - POSTGRES_PASSWORD=CHANGE_ME_DB
      - POSTGRES_DB=forgejo
    volumes:
      # NOTE: Postgres 18+ stores data under /var/lib/postgresql (version subdir),
      # NOT /var/lib/postgresql/data — using the old path makes PG18 refuse to start.
      - forgejo-db-data:/var/lib/postgresql
volumes:
  forgejo-data:
  forgejo-db-data:
```

```bash
prod$ cd ~/forgejo && docker compose up -d
```

Open `http://server.tailnet.ts.net:3000`, complete the install wizard, create your admin user, and **disable open registration** (Site Admin → Settings) since this is single-tenant.

### 6.2 Create the repo as SSOT and push your monorepo

Create the `mcm` repo in Forgejo, then from your workstation:

```bash
# your existing clone
$ git remote rename origin github            # keep GitHub reachable as a named remote
$ git remote add origin http://server.tailnet.ts.net:3000/jumbleknot/mcm.git
$ git push -u origin --all && git push origin --tags
```

### 6.3 Push-mirror to GitHub (broadcast)

In Forgejo: **Repo → Settings → Mirror Settings → Push Mirror**. Add the GitHub URL with a GitHub PAT (repo scope), set the interval (e.g. 8h) and enable "sync on push". Forgejo is now SSOT; GitHub is a downstream mirror.

### 6.4 The OCI registry

Already enabled via `FORGEJO__packages__ENABLED=true`. Images push to `server.tailnet.ts.net:3000/jumbleknot/<image>` (the `jumbleknot` owner namespace, matching the `jumbleknot/mcm` repo). Create a Forgejo access token (Settings → Applications) for registry login from CI and Komodo:

```bash
# test from any daemon
$ echo "<forgejo-token>" | docker login server.tailnet.ts.net:3000 -u steve --password-stdin
```

> If you keep the registry on plain HTTP over Tailscale, add `"insecure-registries": ["server.tailnet.ts.net:3000"]` to the `ci` and `prod` `daemon.json`, or front Forgejo with TLS (Caddy/Tailscale serve) and skip that.

### 6.5 Forgejo access-token inventory (least-privilege)

Every automated consumer authenticates to Forgejo with a **named personal access token**. Keep them
**one-token-per-consumer, minimally scoped** so a leak/rotation is contained. Token *names* are not
secrets (this table is fine to commit); the token *values* live only in the consumer (Komodo Provider
config, a daemon `docker login`, a `~/.mcm/*` file, or the workstation credential manager) — never in git.

Current inventory (rotated + split to least-privilege 2026-07-01; `actions-cd-push` added 2026-07-03):

| Token name | Scope | Consumer | Purpose |
|---|---|---|---|
| `actions-ci-push` | `write:package` | Forgejo Actions CI — repo → Settings → Actions → secret `REGISTRY_TOKEN` | Push images (CI `docker push` in `cd-deploy`) |
| `actions-cd-push` | `write:repository` | Forgejo Actions CD — repo → Settings → Actions → secret `CD_PUSH_TOKEN` | Digest-promote push to **protected** `main` + `app-ci`→`cd-deploy` dispatch (owner `jumbleknot`, on `main`'s push allowlist) |
| `komodo-git-read` | `read:repository` | Komodo (Settings → Providers → Git) | Clone the repo on every Stack/ResourceSync deploy |
| `komodo-registry-read` | `read:package` | prod daemon `docker login` that Komodo's `compose up` pulls with | Pull images from the registry to deploy to prod |
| `workstation-git` | `write:repository` | The workstation's git credential manager (`origin` remote) | Local `git push`/`pull` — used by **all** git on the box, incl. Claude Code's pushes, not just interactive use |
| `claude-ci-monitor` | `read:repository` | Claude Code (read-only), `~/.mcm/forgejo-ci-token` | Poll `/actions/tasks` for CI status |
| `claude-cicd-debug` | `write:repository` | Claude Code (debug), not stored on the box by default | POST `workflow_dispatch` to trigger `cd-deploy`; standing full-write → **revoke when not actively debugging** (if Claude needs it, drop it in `~/.mcm/forgejo-write-token` for the session, then revoke) |

**Least-privilege properties (maintained):**

1. **Registry push and pull are split.** `actions-ci-push` (`write:package`) is used **only** as the CI
   push secret; `komodo-registry-read` (`read:package`) is used **only** for the prod daemon's pull. So a
   compromised prod box can't push images, and rotating the CI push token can't break prod pulls.
2. **CD's git-write is its own token, NOT the auto `GITHUB_TOKEN`** (`actions-cd-push`, added 2026-07-03).
   `cd-deploy`'s digest-by-git promote pushes a `[skip ci]` commit straight to **protected** `main`. The
   runner's auto `GITHUB_TOKEN` is **not** a user on `main`'s push allowlist, so Forgejo's pre-receive
   hook **declines** it (`Internal Server Error … pre-receive hook declined`). `actions-cd-push` is a
   `write:repository` PAT owned by `jumbleknot` (who **is** on the push allowlist), so its direct push is
   accepted — while PR merges stay gated by required status checks (Forgejo enforces status checks on
   *merges*, not on a whitelisted user's *direct* push). The same token authorizes `app-ci`'s `trigger-cd`
   job to dispatch `cd-deploy`. Scoped to CD only; rotate with the others (§6.6).
3. **`claude-cicd-debug` is revoked when idle.** It's a full repo-write token whose *only* job is to POST
   the manual `workflow_dispatch` (operator-triggered deploys/mints). Automatic deploys do **not** use it —
   `app-ci`→`trigger-cd` dispatches `cd-deploy` with `actions-cd-push`. Mint on demand, revoke after (§6.6 B).
4. **The two `read:repository` tokens stay distinct** (`komodo-git-read` for Komodo, `claude-ci-monitor`
   for CI polling) — one per consumer.
5. **Nothing Komodo does needs write** — it only reads the repo (`komodo-git-read`), pulls images
   (`komodo-registry-read`), and receives the signed webhook (HMAC, not a token).

### 6.6 Token remediation — split the registry token + revoke the dispatch token

> ✅ **Completed 2026-07-01** — all tokens rotated and the registry token split (`actions-ci-push` /
> `komodo-registry-read`), per the §6.5 inventory. Kept here as the **repeatable rotation procedure**.

Two least-privilege changes from §6.5. Do them in a maintenance window; neither disrupts running
containers (they only affect future *pulls*/*pushes*/*dispatches*). Forgejo user is `steve`; registry
host is `<tailnet-host>:3000`.

**A. Split the registry token → `actions-ci-push` (write:package, CI push) + `komodo-registry-read` (read:package, prod pull)**

1. **Create the read token (Forgejo UI).** Log in → avatar → **Settings → Applications → Manage Access
   Tokens → Generate New Token**. Name `komodo-registry-read`; set **package = Read** (every other scope
   = *No Access*). Generate and **copy the value** (shown once).
2. **Point the prod pull at it** — whichever your setup uses:
   - **Komodo Registry Account:** Komodo UI → **Settings → Providers → Registry Accounts** → edit the
     account for `<tailnet-host>:3000` (user `steve`) → replace the token with the `komodo-registry-read`
     value → Save.
   - **prod daemon `docker login` (rootless):** on the prod host —
     ```bash
     ssh prod@<host>                                    # or: sudo -iu prod
     export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
     REG=<tailnet-host>:3000
     printf '%s' '<komodo-registry-read value>' | docker login "$REG" -u steve --password-stdin
     ```
     (overwrites the stored cred in `~/.config/docker/config.json`).
3. **Verify pull still works** with the read token (use a current digest from `bff/.env.deploy`):
   ```bash
   docker pull "$REG/jumbleknot/mcm-bff@sha256:<current MCM_BFF_DIGEST>"
   ```
4. **Confirm the write token is now CI-only.** Forgejo → repo `jumbleknot/mcm` → **Settings → Actions →
   Secrets** → `REGISTRY_TOKEN` holds the `write:package` token (used by `cd-deploy`'s `docker push`).
   It must no longer appear in Komodo / the prod daemon (step 2 replaced it there).
5. **Rotate the write token** (do this whenever it may have been shared/exposed): Forgejo → Settings →
   Applications → regenerate **`actions-ci-push`** (package = *Read and Write*), then update the Actions
   secret `REGISTRY_TOKEN` with the new value. The old value is then dead.
6. **Verify CI push** still works: dispatch `cd-deploy` (`deploy=false`) and confirm the push step is green.

**B. Revoke `claude-cicd-debug` (write:repository) when not debugging**

Nothing automated uses it — it exists only to POST an operator's manual `workflow_dispatch`.
Automatic deploys don't need it: `cd-deploy` is `workflow_dispatch`-only, and `app-ci`'s `trigger-cd`
job dispatches it (`deploy=true`) with `actions-cd-push` once `main` is green (Phase 15), so manual
dispatch is rare.

1. If you still need a manual `cd-deploy` run now (e.g. a `deploy=false` mint or a `build_apk=true`
   APK), do that first.
2. Forgejo → **Settings → Applications → Manage Access Tokens** → `claude-cicd-debug` → **Delete**.
3. Re-mint on demand later (fresh `write:repository` token → drop in `~/.mcm/forgejo-write-token` → use →
   delete).

### 6.7 The generic package registry — where the prod APK lives

**Why the APK is here and not in an artifact.** This forge build (`15.0.3+gitea-1.22.0`) exposes **no
Actions-artifact API**: `GET /api/v1/repos/jumbleknot/mcm/actions/artifacts` answers `404 page not
found` — a **missing route**, not an empty result. So an `upload-artifact` APK is reachable only by a
human clicking through the run page, and only until it expires; nothing scriptable can fetch it. The
**generic** registry (Forgejo has no Android/APK package type) is the channel that *is* readable by API,
the same one CI failure bundles use. `cd-deploy`'s `prod-apk` job publishes to it on every
`deploy=true` or `build_apk=true` run, via `scripts/cd/publish-apk.mjs`, **and** keeps the
`upload-artifact` step as the in-UI convenience path.

| | |
|---|---|
| Package | `mcm-app-android` (owner `jumbleknot`, type `generic`) |
| Version | `<app.json expo.version>-<sha7>`, e.g. `1.0.0-a1b2c3d` — unique per commit |
| Files | `MovieCollectionManager-<version>-release-<sha7>.apk` + a `.apk.sha256` sidecar |
| Credential to publish | the existing `actions-ci-push` / `REGISTRY_TOKEN` (`write:package`) — **no new token, no widened scope** (§6.5 is unchanged by this) |
| Credential to download | any `read:package` token — e.g. `claude-ci-monitor` if you grant it that scope, or a fresh read-only one |

**Signing:** the release APK is signed with the **debug keystore** Expo's prebuild points the release
`signingConfig` at. Good enough for internal distribution; it is **not** a Play-Store upload key.

**List what is published:**

```bash
FORGE=http://<tailnet-host>:3000
curl -fsS -H "Authorization: token $READ_PACKAGE_TOKEN" \
  "$FORGE/api/v1/packages/jumbleknot?type=generic&q=mcm-app-android&limit=50" \
  | jq -r '.[] | "\(.version)  \(.created_at)"' | sort -k2 -r
```

**Pull a specific version and verify it (this is the whole AC2 recipe — download, then prove the
bytes):**

```bash
VER=1.0.0-a1b2c3d
FILE=MovieCollectionManager-1.0.0-release-a1b2c3d.apk
BASE="$FORGE/api/packages/jumbleknot/generic/mcm-app-android/$VER"   # NOTE: /api/packages, NOT /api/v1
curl -fsSL -H "Authorization: token $READ_PACKAGE_TOKEN" "$BASE/$FILE"         -o "$FILE"
curl -fsSL -H "Authorization: token $READ_PACKAGE_TOKEN" "$BASE/$FILE.sha256"  -o "$FILE.sha256"
sha256sum -c "$FILE.sha256"     # -> "$FILE: OK"
adb install -r "$FILE"
```

The sidecar is written in `sha256sum -c` format precisely so the check is the stock tool and not a
by-eye comparison of two hex strings.

**Retention — and why it is not optional.** **Measured on run #6036:** the universal release APK is
**114,365,972 bytes (109 MB)** — more than twenty times a `ci-failures` digest bundle's 5 MB cap — and
**every deploy produces one**. Unbounded accumulation is a disk-exhaustion path on this host, not
untidiness. `publish-apk.mjs` therefore prunes at publish time, opportunistically (there is no
scheduled job for it):

- keep the newest **5** versions by `created_at` — a **count**, not the 30-day window `ci-failures`
  uses, because a quiet month would delete every installable APK and a busy week would keep far more
  than the disk affords. At the measured size that caps the shelf at **≈ 550 MB**; `RETAIN_VERSIONS`
  in `scripts/cd/publish-apk.mjs` is the one knob;
- **plus** anything pinned: a version whose name ends in **`-keep`** is never pruned *and* does not
  consume one of the 5 slots. To pin a build, re-upload it under `<version>-keep` — that, not a bigger
  shelf, is how a build outlives the window;
- a version whose `created_at` will not parse is kept — deleting on a parse failure is the destructive
  direction;
- a prune failure is logged and swallowed. `prod-apk` is non-blocking (nothing `needs:` it) and a
  registry hiccup must never turn a deploy red — the publish step is `continue-on-error` *and* the
  script always exits 0, printing `::error::` on every failure path so it stays visible in the job log.

**Upload limits — measured, not assumed.** Nothing in §6.1's compose sets
`FORGEJO__packages__LIMIT_SIZE_GENERIC` or `LIMIT_TOTAL_OWNER_SIZE`, so both sit at the Forgejo default
(unlimited); and run **#6036 proved it end-to-end** by pushing the full 109 MB APK and reading it back
byte-identical (`sha256sum -c` → `OK`). Each run logs the exact APK size next to the upload, so if a
limit is ever introduced the refused size is recorded beside the error. **If a limit does block it,
that is a host-config change and belongs here — not silently in a workflow file.**

---

## Phase 7 — Forgejo Actions runner (on the CI daemon)

Run the **Forgejo Runner v12** (`forgejo-runner`) as a **binary under the `ci` user's systemd-user
manager**, executing jobs on the `ci` rootless daemon. The binary approach (vs a container) avoids
container→Forgejo networking issues, since it uses the host's Tailscale DNS directly.

> **Forgejo 15 / runner v12 changed the registration flow.** The old `forgejo-runner register`
> + registration-token path is **deprecated** ("registration token not found" if you try it).
> Instead you create the runner in the **web UI**, which gives you a **UUID + secret**, and the
> daemon authenticates with those.

**1. Download the runner binary (as `ci`):**
```bash
$ sudo machinectl shell ci@
ci$ mkdir -p ~/runner && cd ~/runner
# get the latest linux-amd64 download URL from the release API, then fetch it:
ci$ curl -s https://code.forgejo.org/api/v1/repos/forgejo/runner/releases/latest \
     | grep -oP '"browser_download_url":\s*"\K[^"]+' | grep 'linux-amd64'
ci$ curl -L -o forgejo-runner "<paste the linux-amd64 URL>"
ci$ chmod +x forgejo-runner && ./forgejo-runner --version
```

**2. Create the runner in Forgejo:** Site Administration → Actions → Runners → **Create new
Runner** → name (`ci-homelab`) + optional description. Forgejo shows a setup screen with the
**`--url`, `--uuid`, and a secret** — that screen is authoritative for your version.

**3. Save the secret and test in the foreground:**
```bash
ci$ echo -n "<SECRET_FROM_UI>" > ~/runner/runner-token && chmod 600 ~/runner/runner-token
ci$ export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
ci$ ./forgejo-runner daemon \
    --url http://server.tailnet.ts.net:3000/ \
    --uuid <UUID_FROM_UI> \
    --token-url file://$HOME/runner/runner-token \
    --label ubuntu-latest:docker://node:22-bookworm \
    --label kvm:host
```
The runner should flip to **Idle/Online** in the Runners list. `Ctrl-C` once confirmed.

> **`ubuntu-latest` here is `node:22-bookworm`, so GitHub-hosted-runner recipes do not transfer**
> (item #457). The label above maps `ubuntu-latest` to a plain Node image — **not** a
> GitHub-hosted Ubuntu runner. Two consequences bite copied workflow snippets:
>
> * **There is no `sudo`.** The container process is already root, so `sudo` is both absent and
>   unnecessary. A copied `sudo …` line dies on its first word with `sudo: command not found`, and
>   if it carries the customary `|| true` the step goes **green** having done nothing. That is
>   exactly what `cd-deploy`'s `prod-apk` "Free disk space" step did on every run it ever made,
>   for as long as it existed. (The `kvm` runner is the same story for a different reason: it
>   executes on the host as the unprivileged `ci` user, which also has no sudo.)
> * **The GitHub-hosted payloads are not there to delete.** Measured 2026-09-15 with
>   `docker run --rm node:22-bookworm`: `/usr/share/dotnet`, `/opt/ghc`, `/usr/local/.ghcup`,
>   `/usr/share/swift` and `/usr/local/share/powershell` do not exist. The one sizeable removable
>   directory, `/usr/local/lib/node_modules` (19 MB), holds `corepack` and `npm` — which
>   `pnpm/action-setup` needs — so "just drop the `sudo`" turns a harmless no-op into a broken job.
>   To free real disk from a job, prune the **daemon** (`docker image prune -af`), which needs no
>   privileges and is what `app-e2e`, `dast` and `build-deploy` all do.
>
> `scripts/__tests__/prod-apk-disk-step.guard.test.mjs` fails any workflow step that invokes `sudo`.

> **The `kvm` label — host execution for the emulator and image-building jobs (feature 023 `app-ci`).**
> Besides `ubuntu-latest`, the runner must also register a **host-type** label defined as
> **`kvm:host`** (`runs-on: kvm` uses the label *name*). Jobs on it execute **directly on the `ci`
> host** as the `ci` user, with no job container: `app-ci`'s `app-e2e` and `dast`, and `cd-deploy`'s
> `build-deploy` (every `nx build` there is a Docker *image* build plus a `docker push`, which the
> `node:22-bookworm` container can't do — it has no Docker CLI/daemon). Why the emulator job can't run
> in a container is in Phase 5.4. Requirements on the host: (a) `ci` in the `kvm` group
> (`sudo usermod -aG kvm ci`; `/dev/kvm` is group `kvm`, and on this host mode 666, measured 2026-10-12 as `crw-rw-rw- root kvm`, so 660 via a udev rule is the tighter option and the group membership is what keeps the job working if it is applied); (b) `ci`'s rootless daemon
> reachable at `DOCKER_HOST=unix:///run/user/1001/docker.sock` (the jobs set it; adjust `1001` if
> `id -u ci` differs). The jobs install the Docker CLI themselves if the host lacks one. The `app-ci`
> workflow **fails loud** if `/dev/kvm` is absent — it never silently skips the mobile suite.
>
> Until commit `235f2f4c` the emulator job ran on `ubuntu-latest` with `/dev/kvm` passed into the job
> *container* via a runner `config.yaml` (`./forgejo-runner generate-config > config.yaml`, then
> `options: "--device /dev/kvm"` under `container:`, plus `--config /home/ci/runner/config.yaml` on the
> daemon `ExecStart=`; check: `docker run --rm --device /dev/kvm node:22-bookworm ls -l /dev/kvm`). A
> runner provisioned that way still has that config, which is harmless — but it must also carry the
> `kvm:host` label.

**4. Make it a persistent systemd-user service:**
```bash
ci$ mkdir -p ~/.config/systemd/user
ci$ cat > ~/.config/systemd/user/forgejo-runner.service <<'EOF'
[Unit]
Description=Forgejo Actions runner
Wants=docker.service
After=docker.service

[Service]
Environment=DOCKER_HOST=unix:///run/user/1001/docker.sock
WorkingDirectory=/home/ci/runner
ExecStart=/home/ci/runner/forgejo-runner daemon --url http://server.tailnet.ts.net:3000/ --uuid <UUID_FROM_UI> --token-url file:///home/ci/runner/runner-token --label ubuntu-latest:docker://node:22-bookworm --label kvm:host
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
ci$ systemctl --user daemon-reload
ci$ systemctl --user enable --now forgejo-runner
ci$ systemctl --user status forgejo-runner --no-pager       # active (running)
```
Logs: `journalctl --user -u forgejo-runner -f`. Linger (Phase 5.1) keeps it running headless
and across reboots. Replace `1001` with `id -u ci` if different.

---

## Phase 8 — Self-hosted Nx remote cache (RustFS + custom cache server)

Speeds polyglot affected-builds across runs without Nx Cloud.

> **Do NOT use `@nx/s3-cache` / `@nx/shared-fs-cache` etc.** — Nx's first-party self-hosted
> cache packages were **deprecated 2026-05-21** over an unpatchable CVE (CVE-2025-36852).
> The current method is Nx's built-in **custom remote cache server** (OpenAPI spec, Nx ≥ 20.8):
> the client needs only two env vars pointing at a server that implements the spec. We run the
> open-source Rust [`nx-cache-server`](https://github.com/nxcite/nx-cache-server) (<4 MB RAM, zero
> telemetry) backed by an S3 object store — **RustFS** since feature 080. All on the **prod** daemon.

**Stage 1 — RustFS + auto-created bucket** (`/home/prod/rustfs/`):

The same pinned image every git-tracked RustFS instance uses
(`infrastructure-as-code/docker/observability/compose.prod.yaml` carries the pin; Renovate does not see
this host-managed file, so copy the digest from there when it moves). It runs as the image's own uid
(10001) with **no `user:`**, logs to stdout, has its **console disabled**, and publishes **only** the S3
port — the old store's `0.0.0.0:9001` console publish is gone (contract S1–S8 of feature 080).

```bash
prod$ mkdir -p ~/rustfs && cd ~/rustfs
prod$ printf 'RUSTFS_ACCESS_KEY=nxcache\nRUSTFS_SECRET_KEY=%s\n' "$(openssl rand -hex 24)" > .env
prod$ chmod 600 .env
```

```yaml
# compose.yaml
services:
  rustfs:
    image: rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c
    restart: always
    environment:
      RUSTFS_ACCESS_KEY: ${RUSTFS_ACCESS_KEY:?set in .env}
      RUSTFS_SECRET_KEY: ${RUSTFS_SECRET_KEY:?set in .env}
      RUSTFS_OBS_LOG_DIRECTORY: ""
      RUSTFS_CONSOLE_ENABLE: "false"
    ports: ["9000:9000"]
    volumes: [data:/data]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://localhost:9000/health/ready"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
  createbucket:                      # same image (it ships curl); PUT of an existing bucket is 200
    image: rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c
    depends_on:
      rustfs: {condition: service_healthy}
    restart: "no"
    environment:
      S3_ACCESS_KEY: ${RUSTFS_ACCESS_KEY:?set in .env}
      S3_SECRET_KEY: ${RUSTFS_SECRET_KEY:?set in .env}
    entrypoint:
      - /bin/sh
      - -c
      - |
        printf 'user = "%s:%s"\n' "$$S3_ACCESS_KEY" "$$S3_SECRET_KEY" \
          | curl -fsS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -o /dev/null -X PUT http://rustfs:9000/nx-cache \
          && echo bucket ready
volumes:
  data:
    external: true                   # created by the migration tool's copy (below), or empty on a new host
    name: nx-cache-rustfs-data
```
```bash
# NEW host only (no previous cache store): create the volume empty. Otherwise see "Migrating" below.
prod$ docker volume create nx-cache-rustfs-data
prod$ docker compose up -d
prod$ docker compose logs createbucket     # ends with "bucket ready"
```

**Migrating the existing store (feature 080, contract M8).** Until this is done the host still runs
the previous store from `/home/prod/minio/` on the volume `minio_minio-data`. The data is rebuildable
(a cold cache costs time, not correctness), so recreating empty is an accepted alternative — but the
default is the same in-place, verified copy as Langfuse. From a checkout of this repository, with the
wrapper described in [prod-control-tower.md](prod-control-tower.md):

```bash
prod$ export MIGRATION_DIR=$HOME/080-nx-cache
prod$ systemctl --user stop nx-cache                             # M1 — the only writer
prod$ read -rs S3_SECRET_KEY && export S3_SECRET_KEY S3_ACCESS_KEY=nxcache   # the OLD store's secret, from /home/prod/minio/.env
prod$ scripts/object-store-migration.sh manifest --endpoint <old store service URL, port 9000> \
        --network <the old compose project's network> --out manifest.json                 # M2
prod$ (cd /home/prod/minio/ && docker compose stop)                                      # M3
prod$ scripts/object-store-migration.sh inventory --volume minio_minio-data --out inventory.json
prod$ scripts/object-store-migration.sh copy --from minio_minio-data --to nx-cache-rustfs-data --out copy.json --apply
prod$ cd ~/rustfs && docker compose up -d                                                # Stage 1, on the copy
# update the two credential lines in ~/nx-cache/nx-cache.env to the NEW pair (Stage 2), then:
prod$ systemctl --user start nx-cache
prod$ read -rs S3_SECRET_KEY && export S3_SECRET_KEY S3_ACCESS_KEY=nxcache   # the NEW store's secret, from ~/rustfs/.env
prod$ scripts/object-store-migration.sh verify --endpoint http://rustfs:9000 --network rustfs_default \
        --manifest manifest.json --out parity.json                                       # M5
```

Read the old store's service name and network with `docker ps` / `docker network ls` first (they are
host state, not in git): confirm the volume by ownership **and** contents (feature 070 trap 1). Then
run one CI build twice and look for `Nx read the output from the remote cache` (SC-010). Rollback:
`systemctl --user stop nx-cache`, `docker compose up -d` in `/home/prod/minio/`, restore the old
credential lines, start `nx-cache`. `backup.sh` captures each store's **config directory** (never its
data volume) in its `restic backup` path list, so add `"$HOME/rustfs"` to that list. The previous store's
directory, `/home/prod/minio/`, stays on the list until the deferred cleanup (spec 080 T047) deletes it;
take it off the list in that same step. Take each store's secret from its own `.env` with `sed -n
's/^<KEY>=//p' <file>` rather than typing it into a `read -rs` inside a pasted block, which consumes the
next pasted line as its input; and list env-file keys with `^[A-Z0-9_]+=`, not `^[A-Z_]+=`, which silently
skips every `S3_…` line.

<!-- history:begin -->
**Done on prod 2026-10-21** (spec 080 T044): copy, not recreate; `verify` pass 1360 → 1360 objects. Host
facts that are not in git: the old store was the compose project `minio` (container `minio-minio-1`,
network `minio_default`, service `minio`, S3 on `0.0.0.0:9000`, console on `0.0.0.0:9001`) on the volume
`minio_minio-data`, its secret `MINIO_ROOT_PASSWORD` in `/home/prod/minio/.env`, access key `nxcache`.
`~/nx-cache/nx-cache.env` already carried `S3_ENDPOINT_URL=http://127.0.0.1:9000` and
`S3_BUCKET_NAME=nx-cache`, so only the two `AWS_*` credential lines changed. `backup.sh` line 47 became
`"$HOME/forgejo" "$HOME/komodo" "$HOME/minio" "$HOME/rustfs" "$HOME/nx-cache"`.
<!-- history:end -->

**Stage 2 — the cache server** (binary + systemd-user, like the runner):

```bash
prod$ mkdir -p ~/nx-cache && cd ~/nx-cache
# latest linux-x86_64 binary:
prod$ curl -s https://api.github.com/repos/nxcite/nx-cache-server/releases/latest \
     | grep -oP '"browser_download_url":\s*"\K[^"]+' | grep 'linux-x86_64'
prod$ curl -L -o nx-cache-aws "<paste the linux-x86_64 url>" && chmod +x nx-cache-aws

# token clients will use, + env file (pulls the store's creds from rustfs/.env):
prod$ source ~/rustfs/.env
prod$ TOKEN=$(openssl rand -hex 32); echo "SAVE THIS ACCESS TOKEN: $TOKEN"
prod$ cat > ~/nx-cache/nx-cache.env <<EOF
S3_BUCKET_NAME=nx-cache
SERVICE_ACCESS_TOKEN=$TOKEN
AWS_ACCESS_KEY_ID=$RUSTFS_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=$RUSTFS_SECRET_KEY
AWS_REGION=us-east-1
S3_ENDPOINT_URL=http://127.0.0.1:9000
PORT=3010
BIND_ADDRESS=0.0.0.0
EOF
prod$ chmod 600 ~/nx-cache/nx-cache.env
```
```bash
prod$ mkdir -p ~/.config/systemd/user
prod$ cat > ~/.config/systemd/user/nx-cache.service <<'EOF'
[Unit]
Description=Nx remote cache server
After=default.target
[Service]
EnvironmentFile=/home/prod/nx-cache/nx-cache.env
ExecStart=/home/prod/nx-cache/nx-cache-aws
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
prod$ systemctl --user daemon-reload && systemctl --user enable --now nx-cache
prod$ curl http://127.0.0.1:3010/health      # expect: OK
```

**Client wiring (done, env-driven — feature 023).** The Nx cache client is wired entirely via
environment variables; there is **no `nx.json` literal**. The CI workflow sets:
- `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://server.tailnet.ts.net:3010`  (a **Forgejo variable**)
- `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=<TOKEN>`  (a **Forgejo secret**)

Because it is env-driven, **local runs without the token fall back to the local cache** — no
remote-cache config leaks into the repo. Requires Nx ≥ 20.8 in the repo. The pnpm store is cached
separately via the workflow's cache step.

---

## Phase 9 — Komodo (CD to the prod daemon)

Komodo (v2.x, GPL-3.0) gives a web UI to pull images and redeploy prod compose stacks. It's
**Core + a Periphery agent + a database**; deploy from Komodo's official compose files on the
**prod** daemon, with two adaptations: the rootless Docker socket, and **FerretDB instead of
MongoDB**.

> **Use the FerretDB variant, not MongoDB.** On a new kernel (7.x) + rootless, the unpinned
> `mongo` image (MongoDB 8) crash-loops (repeated "Unclean … shutdown detected", 100s of
> restarts). Komodo's docs flag this exact case. FerretDB gives the Mongo wire protocol on top
> of **Postgres** — no loop, lighter RAM, and aligns with the Postgres you already run.

```bash
prod$ mkdir -p ~/komodo && cd ~/komodo
prod$ wget -O ferretdb.compose.yaml https://raw.githubusercontent.com/moghtech/komodo/main/compose/ferretdb.compose.yaml
prod$ wget https://raw.githubusercontent.com/moghtech/komodo/main/compose/compose.env
```

**Edit `compose.env`** (generate hex secrets to avoid shell-special chars):
```bash
prod$ DBPASS=$(openssl rand -hex 24); ADMINPASS=$(openssl rand -hex 16)
prod$ WEBHOOK=$(openssl rand -hex 32); JWT=$(openssl rand -hex 32)
prod$ sed -i \
  -e "s|^KOMODO_DATABASE_PASSWORD=.*|KOMODO_DATABASE_PASSWORD=$DBPASS|" \
  -e "s|^KOMODO_HOST=.*|KOMODO_HOST=http://server.tailnet.ts.net:9120|" \
  -e "s|^KOMODO_INIT_ADMIN_PASSWORD=.*|KOMODO_INIT_ADMIN_PASSWORD=$ADMINPASS|" \
  -e "s|^KOMODO_WEBHOOK_SECRET=.*|KOMODO_WEBHOOK_SECRET=$WEBHOOK|" \
  -e "s|^KOMODO_JWT_SECRET=.*|KOMODO_JWT_SECRET=$JWT|" \
  -e "s|^KOMODO_DISABLE_USER_REGISTRATION=.*|KOMODO_DISABLE_USER_REGISTRATION=true|" \
  -e "s|^COMPOSE_KOMODO_BACKUPS_PATH=.*|COMPOSE_KOMODO_BACKUPS_PATH=/home/prod/komodo/backups|" \
  -e "s|^PERIPHERY_ROOT_DIRECTORY=.*|PERIPHERY_ROOT_DIRECTORY=/home/prod/komodo/periphery-root|" \
  compose.env
prod$ echo "KOMODO LOGIN: admin / $ADMINPASS"   # save it
prod$ mkdir -p /home/prod/komodo/backups /home/prod/komodo/periphery-root
prod$ cp compose.env .env && chmod 600 .env     # so `${...}` interpolation works without --env-file on every command
```

**Repoint Periphery at the rootless socket**, then deploy:
```bash
prod$ sed -i 's|/var/run/docker.sock:/var/run/docker.sock|/run/user/1002/docker.sock:/var/run/docker.sock|' ferretdb.compose.yaml
prod$ docker compose -p komodo -f ferretdb.compose.yaml up -d
prod$ docker compose -p komodo -f ferretdb.compose.yaml ps        # all Up, ferretdb healthy
prod$ docker compose -p komodo -f ferretdb.compose.yaml logs core --tail 20
```
> Core may log one `connection refused` on first boot (it races Postgres) and auto-restart —
> the next attempt connects and logs "Successfully created init admin user" + "Server starting".

Open `http://server.tailnet.ts.net:9120`, log in as `admin`, and confirm the **`Local`**
server shows connected (Periphery driving the prod rootless daemon).

**Wiring for CD (Phase 15):** in Komodo, log into the Forgejo registry (the `komodo-registry-read`
token, §6.5) and register the `komodo-git-read` token as the Git provider. The prod stacks are not
defined by hand: a **ResourceSync** reconciles them from `infrastructure-as-code/komodo/stacks.toml`
(`branch = main`) — `prod-auth`, `prod-mc-service`, `prod-mcm-bff`, `prod-movie-assistant`,
`prod-audit`, `prod-observability`, `prod-vault`. Note the sync's **"Execute Sync" webhook** URL; it
is the Forgejo Actions variable `KOMODO_WEBHOOK_URL`.

> **Komodo's webhook is a git-style redeploy, not a digest body.** It validates the branch in a
> GitHub-shaped payload + `X-Hub-Signature-256` (HMAC with the **global** `KOMODO_WEBHOOK_SECRET`
> already in `compose.env` — that value is the CI `KOMODO_WEBHOOK_AUTH`), then redeploys the
> branch's compose. It will **not** consume a posted image digest. So promote by digest through
> **git**: CI resolves the immutable `…@sha256:` digest, writes it to a tracked env var
> (`MCM_BFF_DIGEST` in the committed `infrastructure-as-code/docker/bff/.env.deploy`, separate from
> gitignored `.env.prod`), pushes, then fires the signed webhook. There is no rollback endpoint —
> rollback = redeploy the prior digest: on a failed health probe `cd-deploy` reverts the promotion
> commit and re-fires the webhook (`scripts/cd/rollback.sh`). Known bug: Stack env vars set in the
> **UI** aren't always injected on webhook deploys (#1209), which is the other reason to carry the
> digest in git.

> **Operational gotcha — `systemctl --user restart docker` bounces every rootless container.**
> A daemon restart (e.g. to apply an `insecure-registries` change) restarts all containers on
> that daemon at once and can leave some in `Exited (128)` if a `docker compose` command races
> the daemon bringing them back. Let the daemon settle (~15s) before running compose; recover a
> stuck container with `docker rm -f <name>` (volumes are untouched) then `… up -d`.

---

## Phase 10 — Public ingress, TLS & DNS

Goal: reach production from the Android app **outside the LAN**, with real TLS, on your `${BASE_DOMAIN}` domain, despite having **no static IP** (and possibly CGNAT). Pick one ingress model.

> **Confirmed model (Phase 11 Work Order):** **direct edge-TLS** — Cloudflare terminates TLS at the
> edge and `cloudflared` dials the containers over plain HTTP on the shared external `edge-network`,
> **no Caddy** (cloudflared → `keycloak-service:8080` / `mcm-bff-service:3000` by name). That is 10.A below.
> 10.C (Caddy) is the **optional alternative** if you'd rather own certs internally — don't run both
> cert owners (see the note at the end of 10.C). Whichever you pick, attach `cloudflared` and the two
> public services to `edge-network` (`docker network create edge-network`).

### 10.A Cloudflare Tunnel (recommended for public / multi-user access)

No port-forwarding, CGNAT-proof, real auto-renewing certs, DDoS protection. `cloudflared` runs on the **prod** daemon and dials out to Cloudflare's edge.

1. Move `${BASE_DOMAIN}`'s DNS to Cloudflare (free plan). No A record will point at your home IP.
2. Create a tunnel and route hostnames to internal services:

```yaml
# /home/prod/cloudflared/compose.yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=CHANGE_ME_TUNNEL_TOKEN   # from Cloudflare Zero Trust dashboard
    networks:
      - edge-network            # shared external net so cloudflared resolves the services by name
networks:
  edge-network:
    external: true              # docker network create edge-network
```

3. In the Cloudflare Zero Trust dashboard, map public hostnames **directly to the services** over
   `edge-network` (the confirmed direct edge-TLS model):
   - `mcm.${BASE_DOMAIN}`  → `http://mcm-bff-service:3000` (BFF)
   - `auth.${BASE_DOMAIN}` → `http://keycloak-service:8080` (Keycloak)
   (If you instead chose the optional 10.C Caddy path, point both at `http://caddy:80`.)
4. **Expose only `mcm.` and `auth.`** Everything else (Forgejo, Komodo, Grafana, Cockpit, the entire CI daemon) stays private — reachable only over Tailscale or behind **Cloudflare Access** (email/SSO gate).

> CopilotKit uses WebSocket/SSE — Cloudflare passes both; no extra config needed.

### 10.B Tailscale only (recommended if the app is just for you / trusted users)

Install the **Tailscale app on the Android device**; production is reachable over the tailnet from anywhere with **zero public attack surface**. Use `tailscale cert` for TLS on the `*.ts.net` name, or front with Caddy (10.C). Simpler and more private than a public tunnel, but every user needs Tailscale installed. (Tailscale *Funnel* can publish publicly but is HTTPS-only and bandwidth-limited — prefer Cloudflare Tunnel for genuine public hosting.)

### 10.C Reverse proxy + TLS (use with either of the above, or standalone)

Run **one** reverse proxy as the sole ingress on the prod daemon; it terminates TLS and routes by hostname. Caddy with the **Cloudflare DNS-01 challenge** issues Let's Encrypt certs with no inbound port 80 (works behind CGNAT and for internal/tailnet access too).

```caddyfile
# /home/prod/caddy/Caddyfile  (needs the cloudflare DNS plugin build)
{
  acme_dns cloudflare {env.CF_API_TOKEN}
}
mcm.${BASE_DOMAIN} {
  reverse_proxy mcm-bff-service:3000
}
auth.${BASE_DOMAIN} {
  reverse_proxy keycloak-service:8080
}
```

Keep databases, agent-gateway, MCP servers on internal Docker networks with **no published ports**. Internal service-to-service traffic stays plain HTTP on the Docker network; only ingress needs TLS.

> If Cloudflare Tunnel terminates TLS at the edge, Caddy can serve plain HTTP internally and you skip the DNS-01 cert. Choose one place to own certs, not both.

---

## Phase 11 — Keycloak & BFF production config for the public hostname

**This is the step that makes external mobile login actually work.** Because the APK bakes the BFF URL at build time and auth is OAuth, the public origin must be wired through Keycloak and the BFF — otherwise the login redirect loops or JWT validation fails. Shipped as **config-as-code in `jumbleknot/mcm`, deployed through Komodo** — not hand-run compose on prod.

### 11.A Keycloak prod — `auth.${BASE_DOMAIN}` (DONE 2026-06-28)

Keycloak `quay.io/keycloak/keycloak:26.5.5`, deployed as Komodo Stack **`prod-auth`** from `infrastructure-as-code/docker/keycloak/compose.prod.yaml`. What actually worked:

- **Komodo Stack in Git Repo mode.** Put the git config on the Stack itself (provider/account/repo/branch) — a separate Repo resource isn't needed. Run directory `infrastructure-as-code/docker/keycloak`, file `compose.prod.yaml`, Server `Local` (prod rootless daemon). Register the Forgejo PAT under **Settings → Providers → Git** for `server.tailnet.ts.net:3000` (repo is private) and add `"insecure-registries": ["server.tailnet.ts.net:3000"]` to the prod (and ci) rootless `~/.config/docker/daemon.json` for plain-HTTP image pulls.
- **Secrets via the Stack's Environment field, not files.** Komodo clones into its own run dir each deploy, so gitignored files (`.env.prod`) aren't present. Put `KC_DB_PASSWORD` (+ initial `KC_BOOTSTRAP_ADMIN_PASSWORD`) in the Stack **Environment** field (mask via Komodo secret variables) and set **Env File Path = `.env.prod`** so Komodo materializes them where `env_file: - .env.prod` expects. The Docker-secret file was dropped — DB password lives in `.env.prod` only, and Postgres reads `POSTGRES_PASSWORD: ${KC_DB_PASSWORD}`.
- **Hostname (v2 semantics).** `KC_HOSTNAME=https://auth.${BASE_DOMAIN}`, `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, `KC_HTTP_ENABLED=true`, `KC_PROXY_HEADERS=xforwarded`, `command: start`. Admin isolated to the tailnet: `KC_HOSTNAME_ADMIN=http://server.tailnet.ts.net:19099` (set in `.env.prod`), host port `"19099:8080"` bound `0.0.0.0` and kept tailnet-only by ufw default-deny — the prod-reserved 19000–19099 range (features 028/029, Phase 17). Until then it was `:8099`, bound to the tailscale IP only (`<ts-ip>:8099:8080`); 8099 collided with the CI `app-e2e` Keycloak's `127.0.0.1:8099`, and a tailnet-IP bind does not survive a reboot. Attach `keycloak-service` to **`edge-network`** so cloudflared resolves it by name.
- **Realm import.** The `grumpyrobot` realm is committed as `prod-realm.json` (carrying the `${BASE_DOMAIN}` placeholder), rendered at deploy to the gitignored `prod-realm.rendered.json` that `--import-realm` mounts (kept separate from the throwaway `ci-realm.json`; `PROD_REALM_FILE` points at the rendered file). Sanitize before committing: strip dev redirect URIs (`localhost:*`, `10.0.2.2`, the old `app.` host), real client secrets, dev SMTP, **all users**, and the embedded signing keys (`components."org.keycloak.keys.KeyProvider"` — so prod mints fresh keys).
  > **Gotcha — `${BASE_DOMAIN}` is rendered by hand right now** on the host: `sed 's|${BASE_DOMAIN}|<domain>|g' prod-realm.json > prod-realm.rendered.json` (sed, not envsubst — it touches ONLY the literal `${BASE_DOMAIN}` and leaves Keycloak's `${role_*}`/`${client_*}` i18n placeholders intact).
  > **Gotcha — removing a client means removing ALL its references.** Dropping a client from the export (e.g. the test-only `mcm-bff-test`) requires deleting its `roles.client[<id>]` entry (and any `scopeMappings`) too — not just the client object. A dangling reference makes `--import-realm` abort in production mode with `App doesn't exist in role definitions: <id>` and crash-loop `keycloak-service`.
- **Cloudflare route.** Add a published application on the `homelab-prod` tunnel: `auth.${BASE_DOMAIN}` → `http://keycloak-service:8080` (scheme **http**, container port **8080** — not the 19099 admin binding). This auto-creates the proxied CNAME. Verify end-to-end: `curl https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` → issuer `https://auth.${BASE_DOMAIN}/realms/grumpyrobot`.
  > **Gotcha — the admin console needs the public auth route reachable.** The console served on the tailnet still sends its OIDC + session-check ("3rd party check") iframe to `KC_HOSTNAME` (`auth.${BASE_DOMAIN}`). Until that route resolves, opening `http://homelab…:19099` fails with *"Timeout when waiting for 3rd party check iframe message."* If Chrome third-party-cookie blocking keeps it flaky after the route is up (console on http-tailnet, iframe on https-public), serve admin over HTTPS on the tailnet (`tailscale serve --bg http://localhost:19099`) and set `KC_HOSTNAME_ADMIN=https://server.tailnet.ts.net`.
- **Admin hardening.** `KC_BOOTSTRAP_ADMIN_*` is first-boot only. Log in once, create a named admin with **2FA**, and delete the bootstrap `admin` user. After that the bootstrap creds are **inert** (Keycloak only consults them when no admin exists) — but **keep them** in the committed compose + Komodo env: they're a managed secret (never in git), the `${…:?}` fail-fast form requires the value on every redeploy, and a **fresh DB deploy needs them to create the first admin** (removing the lines would lock you out of a rebuilt Keycloak). For extra hygiene, *rotate* the Komodo value to a fresh random string rather than removing the mechanism. SMTP stays stubbed (Mailpit removed) — wire a real provider before opening registration.

### 11.B BFF prod — `mcm.${BASE_DOMAIN}` (DONE — shipped in Phase 15)

The BFF is a CI-built image (`mcm-bff`), deployed by Komodo ResourceSync as stack **`prod-mcm-bff`** from `infrastructure-as-code/docker/bff/compose.prod.yaml`, pinned by the digest `cd-deploy` promotes into `bff/.env.deploy`. The prod container `mcm-bff-service` listens on **3000** with no published port (the dev `:8082` is a host port). What the bring-up required:

1. **Build the prod APK against the public host.** The production `build-apk.mjs` run must bake `mcm.${BASE_DOMAIN}` (HTTPS) as the BFF URL — not an IP, not `:8082`.
2. **BFF config.** Set the BFF `ROOT_URL`/issuer to the public `auth.` origin, and the session-cookie domain to `mcm.${BASE_DOMAIN}` with `Secure`+`HttpOnly`. CORS allows the app origin only. Wire the Redis session store; attach to `edge-network` (cloudflared reaches `mcm-bff-service:3000` by name); no public port mapping.
3. **Client redirect URIs.** On the `movie-collection-manager` client, add the production **valid redirect URIs**: the web origin (`https://mcm.${BASE_DOMAIN}/*`) and the **mobile app link / custom-scheme deep link** for the OAuth callback. Without the mobile entry, on-device login fails after the browser redirect.
4. **Cloudflare route.** Add the second published application: `mcm.${BASE_DOMAIN}` → `http://mcm-bff-service:3000`. These two (`auth.` + `mcm.`) are the **only** public hostnames; everything else stays tailnet / Cloudflare Access.
5. **Off-network device login test**, then **re-export the final realm** and park client secrets as masked **Komodo Variables** ([ADR-0001](../decisions/ADR-0001-prod-secrets-management.md)), never git.

---

## Phase 12 — Extended hardening

Beyond Phases 2–5. Status as of the 2026-07-05 hardening pass:

- ✅ **Public SSH closed.** With Tailscale (`--ssh`), the ufw `OpenSSH` rule is removed (v4+v6); only `tailscale0 ALLOW IN` remains, so administration is tailnet-only and the sole public inbound path is the Cloudflare tunnel.
- ✅ **Gate admin UIs.** Forgejo, Komodo, Grafana, Cockpit → tailnet-only (or behind **Cloudflare Access**). Never expose Keycloak admin or **any** CI-daemon service publicly — only `mcm.` and `auth.` face the internet.
- ✅ **2FA** on Forgejo + Cloudflare + Komodo (Komodo has native TOTP/passkey since v2.0.0).
- ✅ **CrowdSec's goal, met at the edge.** CrowdSec (modern fail2ban with shared blocklists) would need a reverse proxy's access log to auto-ban scanners on the public hostnames; with no reverse proxy (direct edge-TLS, 10.C skipped) there's no access log to parse, so protection lives where the traffic actually enters: Cloudflare free **Managed Ruleset** (auto-on), **Bot Fight Mode**, and one per-IP **rate-limit rule** (URI-Path `*`, ~300 req/10s → block 1 min; note the free plan's rate-limit builder can't match the Hostname field). Plus **Keycloak realm brute-force detection** for credential-stuffing on the IdP itself.
- ✅ **Image hygiene.** Pin images by digest; **Trivy** scans images in CI (an un-allowlisted fixable CRITICAL blocks the push); **Renovate** (Forgejo-compatible) keeps base images patched — `.forgejo/workflows/renovate.yml` + `renovate.json`, authenticating with a least-privilege `renovate` PAT as `RENOVATE_TOKEN` (Phase 17, [renovate.md](renovate.md)).
- ✅ **NTP** confirmed (systemd-timesyncd; chrony optional). Keep the clock tight — JWT `exp`/`nbf` validation breaks on clock skew.
- ✅ **Performance isolation** via host cgroup caps on the CI user slice: `systemctl set-property user-<ci-uid>.slice CPUQuota=1000% MemoryHigh=24G MemoryMax=30G CPUWeight=50 IOWeight=50`, and `user-<prod-uid>.slice CPUWeight=200 IOWeight=200` so prod wins under contention — a runaway build (especially the KVM Android emulator) can't starve prod. (Rootless daemons isolate *security*; cgroup limits isolate *performance*.)
- ✅ **UPS + NUT** — Phase 14.
- **Secrets in Komodo Variables, not Vault.** Prod secrets are masked **Komodo Variables** (`[[NAME]]` in `infrastructure-as-code/komodo/stacks.toml`), materialized into each stack's gitignored `.env.prod` at deploy — the sanctioned mechanism per [ADR-0001](../decisions/ADR-0001-prod-secrets-management.md); the `prod-vault` stack stays deployed **dormant** and agent-layer-scoped only. CI secrets live in Forgejo Actions secrets. No clear-text secret reaches git — EVER (features 021/022/023): tracked-compose credentials are fail-fast `${VAR:?}` refs (no inline literal, no `:-literal` default), real dev values minted by `node scripts/gen-dev-secrets.mjs` into gitignored `stacks/*.env`, and the rule extends to scripts/tests/docs (read env, skip-if-unset). Two jobs of `.forgejo/workflows/guardrails.yml` enforce it on every push/PR: `naming` (`check-no-inline-secrets.mjs`) and `secret-scan` (`secret-scan.mjs`, whole tree) — ported from the GitHub-era `naming-gate.yml` / `secret-scan.yml`.
- ⚠️ **Deferred (accepted risk) — docker-socket-proxy.** Komodo (and anything mounting `docker.sock`) effectively has root over that daemon; a **docker-socket-proxy** (Tecnativa) allowing only the API calls it needs would narrow that. Deferred because Komodo is tailnet-only + registration-disabled, and Periphery needs broad write access anyway. Never mount the prod socket into an internet-exposed container.
- ⚠️ **Deferred (accepted risk) — Vault** as the secrets store: secrets are already out-of-git, masked Komodo Variables, behind 2FA-tailnet Komodo, in encrypted restore-verified backups — deemed adequate for single-tenant; Vault's unseal-on-reboot burden isn't worth the marginal gain.

---

## Phase 13 — Monitoring & alerting (prod daemon)

The architecture's `otel-lgtm` (Grafana/Prometheus/Loki/Tempo), LangFuse, and OpenSearch are agent-layer/Control-Tower and profile-gated; `otel-lgtm` already runs for app/agent telemetry. On top of it sits a lean **infra** monitoring set, deployed 2026-07-05 — all on the prod rootless daemon as standalone composes (`/home/prod/{uptime-kuma,dozzle,beszel}/compose.yaml`), published on `0.0.0.0` and kept tailnet-only by ufw (a `<ts-ip>:port` bind does not survive a reboot — Phase 17):

- **Uptime Kuma** (`:3011`) — black-box HTTP-keyword probes of the public BFF health path (`ok`) and the Keycloak well-known (`issuer`); **Gmail app-password SMTP** alerts. This is the pager — the one that actually tells you (Telegram/Discord/email) when the public app or `/health` goes down. (Port 3011 because the `otel-lgtm` Grafana held the host's 3002 at the time; Grafana is now on **19002** — see the appendix.)
- **Beszel** hub + agent (`:8090`) — host + container metrics + built-in threshold alerting, chosen over the planned node-exporter (host CPU/RAM/disk/temp) / cAdvisor (per-container usage) / Prometheus / Grafana assembly: rootless-friendly and lighter. Hub↔agent communicate over a shared **unix socket** (`/beszel_socket/beszel.sock`), so there's no host-networking friction under rootless.
- **Dozzle** (`:8081`) — real-time per-container log viewer for quick triage.
- **Disk SMART → host-level `smartd`, NOT a container.** SMART health on the single NVMe matters most (your biggest hardware SPOF), but raw NVMe SMART needs root device access that rootless containers can't get, so Scrutiny doesn't fit. Instead `smartmontools` runs on the **host** with `msmtp-mta` + `bsd-mailx` routing failure alerts through Gmail (`DEVICESCAN -a -m <you> -M exec /usr/share/smartmontools/smartd-runner`). Enable the unit as `smartmontools.service` (Ubuntu ships `smartd.service` only as a linked alias, which `systemctl enable` refuses).

---

## Phase 14 — Backups, disaster recovery & UPS

**The most important phase — one 1 TB SSD is a single point of failure.**

> **Not the same thing as the in-app backups.** This phase is the **operator's host-level disaster
> recovery**: a restic snapshot of every service's data (Forgejo, Komodo, Keycloak, agent-db and both
> Mongos) to a remote the operator controls. Feature 073's **per-user collection backups**
> ([backups.md](backups.md)) are an application feature: each user exports their own collections to
> S3-compatible or WebDAV storage *they* own, scheduled by the BFF and restorable only as new
> collections. Neither replaces the other — a user's own backup does not protect the host, and the
> host snapshot cannot be restored per user.

- **Backups (restic or Borg), scheduled + encrypted + offsite (3-2-1):**
  - `mongodump` the replica set; `pg_dump` each Postgres (Forgejo, Keycloak, agent-db, Komodo).
  - Snapshot Forgejo's data (repos, DB, config; the registry is rebuildable and excluded, see As-built below), Komodo config, and the **prod Keycloak realm export**.
  - Push at least one copy offsite (Backblaze B2 / S3 — cheap).
  - **Test restores on a schedule** — a backup you haven't restored isn't a backup.
- **UPS + NUT.** A small UPS with **NUT** triggers a clean shutdown on power loss (prevents Mongo/Postgres corruption) and pairs with the BIOS "always on" so the box self-recovers.
- **Retention/disk-fill guards.** Set Loki/OpenSearch retention and a scheduled `docker image prune` on the CI daemon, or Android builds + image layers will fill the SSD.

> **As-built — the source of truth is [`infrastructure-as-code/backup/`](../../infrastructure-as-code/backup/)** (moved into the repository by spec 084 on 2026-10-27; before that it lived only on the host). Install, update and verify it with that directory's [README](../../infrastructure-as-code/backup/README.md). The operator's one-line check that the host runs what the repo says is `cd ~ && sha256sum -c <checkout>/infrastructure-as-code/backup/INSTALLED.sha256`.
>
> **Backups.** `restic` → rclone remote (`rclone:nas:homelab/restic`), run by `~/backup/backup.sh` from the `prod`-user `homelab-backup.timer` (nightly 03:30, `Persistent=true`). A whole run takes 8–10 min (measured 2026-10-22..26).
> - **Staging is on disk**, in `~/backup/stage.XXXXXX`, removed on exit. `/tmp` on this host is a 29 G **tmpfs** (RAM): the forge dump outgrew it, which started the outage below. The script refuses tmpfs staging, and `backup.sh --check-staging` shows the filesystem without backing anything up.
> - **Dumps.** Each runs through `run_dump`. A failure leaves a `DUMP-FAILED-<name>` marker, **the remaining dumps and the upload still run**, and the run exits 1.
>
>   | Dump | How | Format check | Minimum |
>   |---|---|---|---|
>   | `forge` | `forgejo dump --type tar.gz --skip-package-data --skip-repo-archives` | `tar -tzf` | 10 MiB |
>   | `komodo` | `pg_dumpall` (credentials read from `~/komodo/compose.env`) | ends `-- PostgreSQL database cluster dump complete` | 1 MiB |
>   | `keycloak` | `docker exec … pg_dump` over the container socket | ends `-- PostgreSQL database dump complete` | 50 KiB |
>   | `agent-db` | the same | the same | **1 byte** — `agent_db` has no tables by design (the gateway checkpoints in memory) |
>   | `mc-service-mongo` | `docker exec … mongodump --archive --gzip`, URI read live from the app container | `gzip -t` | 100 KiB |
>   | `bff-mongo` | the same | `gzip -t` | 1 KiB |
>
> - **`dump-manifest.tsv`** (name, file, bytes, minimum, format, previous bytes, verdict) is written into the staging dir, so it travels **inside** the snapshot. A copy becomes `~/backup/state/last-good.tsv` after a fully good run.
> - **Shrink check.** A dump under **50 %** of its size in the last good run raises a `shrink` alert naming both sizes; the snapshot is still uploaded. When a shrink is expected (data deliberately deleted, a new exclusion), acknowledge it **before** the next run with `~/backup/backup.sh --ack-shrink <dump>`. An acknowledgement covers one run, and the threshold is never raised instead.
> - **Config directories, not data:** the `restic backup` line also takes `$HOME/forgejo`, `$HOME/komodo`, `$HOME/rustfs` and `$HOME/nx-cache` — compose files and `.env`s, about 120 M in total (measured 2026-10-27), enough to stand each service back up.
> - **Excluded on purpose, and how to restore without it:**
>   - **The forge's package registry** (`--skip-package-data`; 109 G on 2026-10-26): the six app images and the dev-container image are rebuilt from git by `cd-deploy` and `devcontainer-image`. After a restore, re-run `cd-deploy` (deploy=false) once, then redeploy. Rollback to a digest older than the restore is not available until it has been rebuilt.
>   - **Repository archives** (`--skip-repo-archives`): the forge regenerates them on demand.
>   - langfuse / unleash / audit-opensearch (telemetry), redis caches, the RustFS nx-cache store's **data volume** — all rebuildable.
> - **Retention:** `restic forget --prune --tag homelab --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6`. **Group by tag, never by path:** the staging dir's name is random, so restic's default `host,paths` grouping put every snapshot in a group of one and pruned nothing (41 snapshots on 2026-10-22, 11 after the fix).
> - ⚠️ **Gotcha that bit us (2026-07):** the *original* `backup.sh` dumped only Forgejo + Komodo + the object-store/nx-cache **dirs** — it did **not** dump the app databases. A reboot corrupted Forgejo's Postgres and Forgejo happened to be the only thing with a real backup. **Whenever a stateful service is added, add its dump to `backup.sh`** — with a minimum and a format check.
>
> **Alerting (spec 084).** Every backup problem lands on **one** backlog item, titled `Prod backup: failed or stale` (`type/bug`, `priority/p1`). It is opened the first time; every later event comments on it, and only a human closes it.
> - **A failed run** exits 1, and `OnFailure=homelab-backup-alert@%n.service` runs `backup-alert.sh failed homelab-backup.service`, attaching the journal tail with credentials redacted.
> - **A hung run** hits `TimeoutStartSec=2h`, which systemd treats as a failure; it is reported as `hung`.
> - **A run that never happens**, or an upload that silently did nothing, fires no `OnFailure`. `homelab-backup-staleness.timer` (every 6 h, `Persistent=true`) runs `backup-staleness.sh`. It reads the newest `homelab` snapshot **from the repository itself** and alerts `stale` past **36 h**, or `staleness-unreadable` if it cannot tell. "Could not tell" is never "fresh".
> - **A fully good run** comments `recovered` on the open item, if there is one.
> - The alert needs `~/backup/forge-issue-token` (mode 600, an **issues-only** token for this host alone) and `MCM_FORGE_URL` in `~/backup/alert.env`. An undeliverable alert exits 3 (not configured) or 4 (forge API failed) and says `alert NOT delivered` in the journal. The staleness check is the independent second path.
> - **Accepted gap:** if the whole host, or the `prod` user's systemd manager, is down, both timers stop. That also stops the forge, the app and CI, so it is not silent.
>
> **Case study — the backup failed every night for ~3 months (2026-07-27 → 2026-10-22).** Dumps were staged in a temp dir on the RAM-backed `/tmp`. The forge dump, then still including the 100 G+ registry, outgrew it (`write /dev/stdout: no space left on device`). The forge dump was the **only** step with no fallback, so under `set -e` it took every database dump and the off-site upload down with it. Every night the journal recorded `Failed with result 'exit-code'`, and nothing read it. The last good snapshot was 2026-07-26 03:31; the failure was found by chance on 2026-10-22. On 2026-10-22/23 the host was fixed (on-disk staging, registry and archives skipped, tag-grouped retention). Spec 084 then brought the script into the repository and added what would have caught it on night one: per-dump isolation, format, minimum and shrink checks, the `OnFailure` alert, the hang timeout and the independent staleness check.
>
> **Restore (Forgejo Postgres — proven 2026-07-05).** Only the PG volume was corrupt; repos/registry live on a separate, intact volume. Extract `forgejo-db.sql` from the `forgejo dump` archive in restic, reset the DB (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` on a fresh volume), then **load the SQL twice, ignoring errors** — the `forgejo dump` SQL is xorm-generated and **not dependency-ordered**, so pass 1 creates tables + data with some index/`setval`-before-table errors, and pass 2 fills the missing indexes/sequences while re-`INSERT`s bounce off primary keys (no duplicate data). Forgejo runs migrations on boot and self-heals.
>
> **Graceful shutdown (root-cause fix for the corruption).** On reboot the rootless containers were **SIGKILL'd** (the user-manager teardown races the container processes), so DBs never flushed. Fix: a per-user drain unit `~/.config/systemd/user/docker-drain.service` — `Type=oneshot`, `RemainAfterExit=yes`, `After=docker.service`, `BindsTo=docker.service`, with `ExecStop=/bin/sh -c 'cids=$(docker ps -q); [ -n "$cids" ] && docker stop -t 30 $cids'`. On shutdown it stops **before** `docker.service`, so every container gets a clean SIGTERM + flush while the daemon is still up. Keeps `live-restore=true` (daemon restarts still don't bounce containers). Enable through the user bus: `machinectl shell prod@ /usr/bin/systemctl --user enable --now docker-drain.service` (plain `sudo -iu prod systemctl --user` can't reach the bus).
>
> **UPS + NUT (APC Smart-UPS, USB).** `apt install nut`; `nut-scanner -U` auto-detects (driver **`usbhid-ups`**, `port=auto`). Standalone config: `MODE=standalone` in `nut.conf`; `[apcups] driver=usbhid-ups port=auto` in `ups.conf`; a monitor user `[upsmon] password=<gen> upsmon primary` in `upsd.users` (chmod **640 root:nut**); `MONITOR apcups@localhost 1 upsmon <pw> primary` + `SHUTDOWNCMD "/sbin/shutdown -h +0"` in `upsmon.conf`. **NUT 2.8.4 uses `nut-driver-enumerator`, not `nut-driver-enabler`** — after editing `ups.conf`, `systemctl restart nut-driver-enumerator.service`, then start `nut-driver.target nut-server.service nut-monitor.service`; verify `upsc apcups` → `ups.status: OL`. If the driver won't attach right after install, `udevadm control --reload-rules && udevadm trigger` re-applies USB perms to the already-plugged UPS. On low battery: `upsmon` → `shutdown -h` → the **drain unit** → clean flush (same path as a manual reboot). *(Optional future tuning: shut down after N minutes on battery rather than near-empty; have the UPS cut its own output so mains-return auto-power-cycles the box.)*

---

## Phase 15 — Wire the pipeline

> **✅ CD architecture — final hardened state (2026-07-03).** Phase 15 is complete; the pipeline below
> was hardened during bring-up. The current shape (authoritative — see also
> [openwiki/projects/ci-cd-pipeline.md](../../openwiki/projects/ci-cd-pipeline.md)):
>
> - **Trigger is event-driven, not polled.** `cd-deploy.yml` is **`workflow_dispatch`-only** (no `push`
>   trigger, no `ci-gate`). `app-ci.yml`'s **`trigger-cd`** job `needs:` its CI jobs and dispatches
>   `cd-deploy(deploy=true)` once green on `main`. (The original `ci-gate` polled commit statuses with an
>   80-min wall clock and timed out while `app-e2e` sat queued on the single kvm runner — ordering is now
>   a dependency edge.)
> - **Promote pushes to protected `main` via a whitelisted-user PAT.** The digest-by-git `[skip ci]`
>   promote uses **`secrets.CD_PUSH_TOKEN`** (token `actions-cd-push`, §6.5). The auto `GITHUB_TOKEN` is
>   not push-whitelisted → the pre-receive hook declines it. (Forgejo enforces required status checks on
>   **merges**, not on a whitelisted user's **direct push**.)
> - **Prod deploy = Komodo ResourceSync** (config-as-code from `infrastructure-as-code/komodo/stacks.toml`,
>   `branch = main`). `cd-deploy` fires the **single "Execute Sync" webhook** (`KOMODO_WEBHOOK_URL`) →
>   reconcile + redeploy every affected stack in `after` order. This replaced the per-stack redeploy
>   webhooks (which left mc-service/agents on stale images = drift).
> - **`app-e2e` is path-gated** (a `changes` dorny/paths-filter job) so Komodo/deploy-config-only changes
>   skip the ~23-min suite; `trigger-cd` tolerates a *skipped* app-e2e but blocks on a *failed* one.
> - Branch protection on `main`: required checks `guardrails*` + `app-ci*` (globs). Operator runbook +
>   Step A–E history (a completed historical log): [Phase-15-Operator-Checklist.md](Phase-15-Operator-Checklist.md).
>
> The subsections below (15.1–15.4) are what a rebuild of the pipeline needs: the CI realm, the jobs,
> the secrets, and the known first-run failure points.

### 15.1 Provision the Keycloak realm (unblocks the stack — PRD §4.3)

1. From your working local stack, export the realm with users + secrets:

```bash
# feature 020 unified the container_name to the role id; it's `keycloak-service` (not mcm-keycloak-service-1)
docker exec keycloak-service /opt/keycloak/bin/kc.sh \
  export --realm grumpyrobot --users realm_file --file /tmp/realm.json
```

2. Copy it out, sanitize anything you don't want committed, and commit as `infrastructure-as-code/docker/keycloak/ci-realm.json` (throwaway CI secrets are fine to commit; **not** prod secrets). The whole-tree `secret-scan` job of `guardrails.yml` will fail the build if a real credential is left in it.
3. Keycloak boots with `--import-realm` + a mount of it in the CI bring-up, and `app-e2e`'s "provision env" steps materialize the secrets (features 021/022/023): `node scripts/gen-dev-secrets.mjs` mints the gitignored per-stack `stacks/*.env` files (`auth.env` — incl. `KC_DB_PASSWORD`, the single source for both Postgres + Keycloak since feature 022 retired `keycloak_db_password.txt`/`.env.local`; `mcm.env`, plus `audit.env`/`observability.env` if those stacks run) from the committed `*.env.example` templates, and `node scripts/gen-ci-env.mjs` writes `frontend/mcm-app/.env.docker` from the Forgejo Actions secrets. Do **not** commit any of these generated files.

### 15.2 The E2E and APK jobs (ported from `android-e2e.yml`)

The GitHub-era `.github/workflows/android-e2e.yml` was ported in feature 023 and `.github/` no longer
exists. Its emulator + web E2E work is the **`app-e2e`** job of `.forgejo/workflows/app-ci.yml`; the
prod APK build is `cd-deploy.yml`'s **`prod-apk`** job (§6.7). What the port changed, and what still
holds for any job added later:

- `runs-on:` → this runner's labels: `ubuntu-latest` (a `node:22-bookworm` container — Phase 7) or
  `kvm` (host execution, `kvm:host`) for the emulator and Docker-image-building jobs.
- GitHub-marketplace `uses:` steps → `act_runner`-compatible equivalents (most `actions/checkout`,
  `actions/cache`, `setup-*` work; verify niche ones — e.g. `upload-artifact@v4`/`download-artifact@v4`
  fail with `GHESNotSupportedError`).
- Registry login/push → `server.tailnet.ts.net:3000/jumbleknot/...` with the `REGISTRY_TOKEN` secret.
- Prod redeploy is not a per-stack `curl -XPOST <komodo-stack-webhook>`: `cd-deploy` builds + pushes
  the images, promotes the digest by git, then fires the signed Komodo "Execute Sync" webhook (above).
- `app-ci` runs on `push` to `main` (merges) and on `pull_request` for feature branches.

### 15.3 Secrets

Set in **Forgejo → repo → Settings → Actions → Secrets** (one per consumer; names are not secret):
`E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `REGISTRY_TOKEN` (`actions-ci-push`), `CD_PUSH_TOKEN`
(`actions-cd-push`), `KOMODO_WEBHOOK_AUTH`, `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`,
`KEYCLOAK_CLIENT_SECRET` / `KEYCLOAK_SERVICE_CLIENT_SECRET` / `AGENT_SUBJECT_TOKEN_CLIENT_SECRET`,
`COOKIE_SECRET`, `AGENT_CONFIG_ENC_KEY`, `TMDB_API_KEY`, `CI_DIGEST_TOKEN`, `RENOVATE_TOKEN` /
`RENOVATE_GITHUB_COM_TOKEN`, and the per-job Anthropic keys `ANTHROPIC_API_CI_E2E`,
`ANTHROPIC_API_CI_DAST`, `ANTHROPIC_API_CD_GOLDEN`, `ANTHROPIC_API_WIKI_MAINTAIN` (each job maps its
own to `ANTHROPIC_API_KEY` at the point of use) plus `FIREWORKS_API_WIKI_MAINTAIN`. Non-secret topology goes in Actions **variables**:
`REGISTRY`, `REGISTRY_USER`, `NS`, `BASE_DOMAIN`, `KOMODO_WEBHOOK_URL`,
`NX_SELF_HOSTED_REMOTE_CACHE_SERVER`, `MODEL_PROVIDER`. Prod-only secrets live in **Komodo**, not git.

### 15.4 First run + expected iteration

On a freshly built pipeline, open a PR and watch the run in Forgejo. Expect to clear the known
first-time failure points in order (each a few minutes apart): `assembleRelease` signing/bundle,
fixture-seeding via `global-setup` at `:8082`, then the first Maestro agent flow on the KVM emulator.
Once `main` is green, confirm `trigger-cd` dispatches `cd-deploy` (`deploy=true`) and Komodo
redeploys prod.

---

## Phase 16 — Verification checklist

> **Verified 2026-07-05** except where noted (`[~]` = partial/deferred, `[ ]` = open).

- [x] `kvm-ok` passes; `/dev/kvm` accessible; `ci` is in `kvm`. *(Nit: `/dev/kvm` is mode 666, not 660 — tighten via a udev rule if desired.)*
- [x] `sudo -iu ci docker info` and `sudo -iu prod docker info` both report **rootless**, distinct data roots (`/home/ci` vs `/home/prod`).
- [x] The rootful `docker.service` is **disabled** and inactive.
- [x] Firewall: **no** public inbound except the Cloudflare tunnel — SSH is tailnet-only (`ufw` shows only `tailscale0 ALLOW IN`); all UIs over Tailscale.
- [x] Forgejo reachable; repo pushed; **push-mirror to GitHub** sync confirmed.
- [x] `docker login server.tailnet.ts.net:3000` works from both daemons; images push/pull (exercised by every deploy).
- [x] Forgejo runner shows **Idle**; workflows run green.
- [x] Nx remote cache in use (env-driven; second run hits cache).
- [x] Keycloak imports the realm; the stack stands up; **web E2E** green in CI.
- [x] Android agent Maestro flows run on the KVM emulator and pass.
- [x] On green, images push and **Komodo (ResourceSync) redeploys prod**; the two daemons remain isolated.
- [x] `mcm.${BASE_DOMAIN}` and `auth.${BASE_DOMAIN}` resolve, serve valid TLS, and **only those two** are public. *(`curl -I` returns 405 on the BFF health path because HEAD is unsupported; a GET returns 200.)*
- [x] On-device Android login works **off-network** end to end.
- [~] Public SSH closed ✅ and admin UIs tailnet-only ✅; **Docker socket proxy — consciously deferred** (Komodo tailnet-only mitigates).
- [x] Uptime Kuma probes the public app + auth and pages your phone (Gmail) on failure.
- [x] A backup runs on schedule **and a test restore succeeds** ✅ (Phase 14 — including the app DBs); **UPS/NUT** ✅ (APC Smart-UPS + graceful-shutdown drain unit, 2026-07-05).

---

## Phase 17 — Reboot resilience & as-built fixes (2026-07-05)

A kernel-upgrade reboot on 2026-07-05 hard-killed the rootless containers and exposed several issues. Root causes + fixes below. The graceful-shutdown and backup fixes are in **Phase 14**; the items under "Repo / Komodo-side fixes" are **config-as-code** (features 028–030) so they persist across deploys, and [prod-reboot-resilience.md](prod-reboot-resilience.md) is the current reboot runbook.

### Fixed on the host

- **DB corruption on reboot** → the drain unit (Phase 14, *Graceful shutdown*).
- **App-DB backup gap** → `backup.sh` dumps every app DB (Phase 14, *Backups*).
- **Monitoring UIs unreachable after reboot (tailnet-IP bind race).** ROOT CAUSE: the rootless Docker daemon starts at boot **before `tailscaled`**, so rootlesskit never learns the tailnet IP and cannot bind published ports to it (`docker ps` shows the container `Up` but with an **empty Ports** column; `ss` shows nothing listening). `0.0.0.0` binds work — that's why Forgejo (`0.0.0.0:3000`) stayed reachable but every `<ts-ip>:port`-bound UI did not. A container restart does **not** fix it (the daemon's host-IP view is stale); only `0.0.0.0` or a full rootless-daemon restart. **Fixed** on the host by rebinding the three standalone monitoring composes (`/home/prod/{uptime-kuma,dozzle,beszel}/compose.yaml`) to `0.0.0.0` (ufw still keeps them tailnet-only). The durable, box-wide fix is under *Repo / Komodo-side fixes*.

### Reboot-recovery playbook (if a future reboot leaves services down)

- **Forgejo Postgres crash-loop** (`could not locate a valid checkpoint record`) = WAL corruption → restore from backup (Phase 14 restore procedure). The repos/registry volume is unaffected.
- **mc-service Mongo crash-loop** (`/tmp/mongo-keyfile: Permission denied`) — only on a container from before feature 028, whose entrypoint can't overwrite the `0400` replica-set keyfile left in the container's `/tmp` across a *restart* (the current entrypoint removes it first — *Repo / Komodo-side fixes* item 3). Fix = **recreate**, not restart: `docker rm -f mc-service mc-service-store-mongo` then Komodo redeploy.
- **Keycloak lost its `backend-network` attachment** → mc-service can't resolve `keycloak-service` for OIDC (`dns error … Try again`) → the app shows *"failed to load collections."* Fix = Komodo `prod-auth` redeploy (the compose declares the network — *Repo / Komodo-side fixes* item 4); in a pinch, `docker network connect backend-network keycloak-service` then `docker restart mc-service`.
- **Services that depend on Keycloak** (BFF / agents / mc-service) may crash-loop until Keycloak is healthy; they self-heal via their restart policy once it is.

### Repo / Komodo-side fixes

These live in the repo (config-as-code) or are applied by a Komodo redeploy, so they survive future deploys:

1. ✅ **Tailnet-IP bind survivability, box-wide** (feature 028, ports moved by feature 029). Every published prod port in `infrastructure-as-code/docker/*/compose.prod.yaml` binds `0.0.0.0` (plain `HOST:CONTAINER`, tailnet-only via ufw default-deny) and sits in the prod-reserved 19000–19099 range: Keycloak admin **19099** (was 8099), LangFuse **19030**, Grafana **19002**. Ordering the rootless user manager after `tailscaled` is optional defense-in-depth only — see [prod-reboot-resilience.md](prod-reboot-resilience.md) Part 1.
2. ✅ **Grafana / otel-lgtm** — `infrastructure-as-code/docker/observability/compose.prod.yaml` binds `"19002:3000"` (Komodo `prod-observability`).
3. ✅ **mc-service Mongo keyfile idempotency** — `infrastructure-as-code/docker/mc-service/mongo-entrypoint.sh` runs `rm -f "$KEYFILE_PATH"` before writing the keyfile (feature 028), covered by `mongo-entrypoint.test.sh`.
4. ✅ **Keycloak `backend-network` durability** — the `prod-auth` compose declares `backend-network` (and `edge-network`) on `keycloak-service`; the re-attach is a Komodo `prod-auth` redeploy, not a manual `docker network connect` ([prod-reboot-resilience.md](prod-reboot-resilience.md) Part 3).
5. ✅ **Renovate** — `.forgejo/workflows/renovate.yml` + `renovate.json` are live, authenticating with the least-privilege `renovate` PAT stored as the `RENOVATE_TOKEN` Actions secret; operated per [renovate.md](renovate.md).

The first **validation reboot** (2026-07-08) did not come back clean and exposed two further root causes, fixed by feature 030 (`restart: always` on every prod service, a parallel drain unit). The validation-reboot checklist and both rounds of fixes are in [prod-reboot-resilience.md](prod-reboot-resilience.md) Parts 4–5.

---

## Appendix — quick reference

| Service | Daemon | URL (over Tailscale) |
|---|---|---|
| Cockpit (host admin) | host | `https://server.tailnet.ts.net:9090` |
| Forgejo (SSOT + registry) | prod | `http://server.tailnet.ts.net:3000` |
| Komodo (CD) | prod | `http://server.tailnet.ts.net:9120` |
| RustFS (Nx cache) | prod | no UI — console disabled; S3 API on `:9000`, consumed on loopback by `nx-cache` (feature 080) |
| CI Forgejo runner | ci | (no UI — status in Forgejo) |
| MCM production stack | prod | Komodo ResourceSync stacks from `infrastructure-as-code/komodo/stacks.toml`: `prod-auth` → `prod-mc-service` → `prod-mcm-bff` → `prod-movie-assistant` (+ `prod-audit`/`prod-observability`/`prod-vault`); local-dev equivalent: named stacks under `stacks/` (feature 020), `auth` + `mcm` (+ `audit`/`observability`), `up-auth` → `up-mcm` |
| Public app (BFF) | prod | `https://mcm.${BASE_DOMAIN}` (Cloudflare Tunnel) |
| Public auth (Keycloak) | prod | `https://auth.${BASE_DOMAIN}` (Cloudflare Tunnel) |
| Caddy (reverse proxy/TLS) | — | not deployed: cloudflared reaches the services directly (10.A; 10.C is the optional alternative) |
| otel-lgtm (Grafana/Prom/Loki/Tempo) | prod | `http://server.tailnet.ts.net:19002` (app telemetry; prod-reserved range, feature 029) |
| Beszel (host + container metrics) | prod | `http://server.tailnet.ts.net:8090` |
| Uptime Kuma (alerts) | prod | `http://server.tailnet.ts.net:3011` |
| Dozzle (container logs) | prod | `http://server.tailnet.ts.net:8081` |
| Disk SMART alerts | host | `smartd` (smartmontools) → Gmail via msmtp; no UI |

> Pin every image to a specific tag/digest in production compose files; let Komodo manage promotion. Keep CI's throwaway stack on the `ci` daemon so a failed/poisoned build can never reach prod data.
