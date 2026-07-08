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
$ ls -l /dev/kvm        # expect group "kvm", crw-rw----+
```

(The `ci` service user is added in Phase 5; KVM passthrough into its rootless containers is configured in Phase 6.)

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

### 5.4 KVM into the CI containers (the one rootless caveat)

The Maestro emulator job must get `/dev/kvm`. Because `ci` is in the `kvm` group, its rootless containers can receive the device when the job adds:

```yaml
# in the Android-E2E job's container/run options
--device /dev/kvm --group-add kvm
```

If rootless device passthrough proves fragile on your kernel, fall back to running **only the Android-E2E runner** as a dedicated low-privilege *system* user with direct kvm access, while every other CI workload stays fully rootless. Prod is never affected.

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

Nothing automated uses it — it exists only to POST `workflow_dispatch` while `cd-deploy` isn't on `main`.

1. If you still need to trigger `cd-deploy` now (e.g. the web-login rebuild), do that first.
2. Forgejo → **Settings → Applications → Manage Access Tokens** → `claude-cicd-debug` → **Delete**.
3. Re-mint on demand later (fresh `write:repository` token → drop in `~/.mcm/forgejo-write-token` → use →
   delete). After 022→`main` merges, `cd-deploy` fires on push to `main`, so manual dispatch is rare.

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
    --label ubuntu-latest:docker://node:22-bookworm
```
The runner should flip to **Idle/Online** in the Runners list. `Ctrl-C` once confirmed.

> **KVM for the Android-emulator job (feature 023 `app-ci`).** The workflow's emulator job runs on
> `ubuntu-latest` (single runner), so `/dev/kvm` must be passed into the job *container* rather than
> using a separate `kvm:host` label. (a) add `ci` to the `kvm` group (`sudo usermod -aG kvm ci`;
> `/dev/kvm` should be group `kvm`, mode 660); (b) generate a runner config and set the device on job
> containers:
> ```bash
> ci$ ./forgejo-runner generate-config > config.yaml   # then under container: set
> #   options: "--device /dev/kvm"
> ```
> (c) add `--config /home/ci/runner/config.yaml` to the daemon `ExecStart=`, `daemon-reload`,
> restart. Verify: `docker run --rm --device /dev/kvm node:22-bookworm ls -l /dev/kvm`. The `app-ci`
> workflow **fails loud** if `/dev/kvm` is absent — it never silently skips the mobile suite.

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
ExecStart=/home/ci/runner/forgejo-runner daemon --url http://server.tailnet.ts.net:3000/ --uuid <UUID_FROM_UI> --token-url file:///home/ci/runner/runner-token --label ubuntu-latest:docker://node:22-bookworm
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

## Phase 8 — Self-hosted Nx remote cache (MinIO + custom cache server)

Speeds polyglot affected-builds across runs without Nx Cloud.

> **Do NOT use `@nx/s3-cache` / `@nx/shared-fs-cache` etc.** — Nx's first-party self-hosted
> cache packages were **deprecated 2026-05-21** over an unpatchable CVE (CVE-2025-36852).
> The current method is Nx's built-in **custom remote cache server** (OpenAPI spec, Nx ≥ 20.8):
> the client needs only two env vars pointing at a server that implements the spec. We run the
> open-source Rust [`nx-cache-server`](https://github.com/nxcite/nx-cache-server) (<4 MB RAM, zero
> telemetry) backed by MinIO. All on the **prod** daemon.

**Stage 1 — MinIO + auto-created bucket** (`/home/prod/minio/`):

```bash
prod$ mkdir -p ~/minio && cd ~/minio
prod$ printf 'MINIO_ROOT_USER=nxcache\nMINIO_ROOT_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
prod$ chmod 600 .env
```

```yaml
# compose.yaml
services:
  minio:
    image: quay.io/minio/minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ROOT_USER}
      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
    ports: ["9000:9000", "9001:9001"]
    volumes: [minio-data:/data]
  createbucket:                      # mc sidecar — recent MinIO consoles can't create buckets
    image: quay.io/minio/mc
    depends_on: [minio]
    restart: "no"
    environment:
      - MINIO_ROOT_USER=${MINIO_ROOT_USER}
      - MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
    entrypoint: >
      /bin/sh -c "until mc alias set local http://minio:9000 $${MINIO_ROOT_USER} $${MINIO_ROOT_PASSWORD}; do sleep 2; done; mc mb -p local/nx-cache; echo bucket ready;"
volumes:
  minio-data:
```
```bash
prod$ docker compose up -d
prod$ docker compose logs createbucket     # ends with "bucket ready"
```

**Stage 2 — the cache server** (binary + systemd-user, like the runner):

```bash
prod$ mkdir -p ~/nx-cache && cd ~/nx-cache
# latest linux-x86_64 binary:
prod$ curl -s https://api.github.com/repos/nxcite/nx-cache-server/releases/latest \
     | grep -oP '"browser_download_url":\s*"\K[^"]+' | grep 'linux-x86_64'
prod$ curl -L -o nx-cache-aws "<paste the linux-x86_64 url>" && chmod +x nx-cache-aws

# token clients will use, + env file (pulls MinIO creds from minio/.env):
prod$ source ~/minio/.env
prod$ TOKEN=$(openssl rand -hex 32); echo "SAVE THIS ACCESS TOKEN: $TOKEN"
prod$ cat > ~/nx-cache/nx-cache.env <<EOF
S3_BUCKET_NAME=nx-cache
SERVICE_ACCESS_TOKEN=$TOKEN
AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER
AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD
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

**Wiring for CD (Phase 15):** in Komodo, log into the Forgejo registry (Phase 6.4 token), define
a **Stack** per prod compose file (the MCM app with its profiles) and note the stack's webhook URL.

> **Komodo's webhook is a git-style redeploy, not a digest body.** It validates the branch in a
> GitHub-shaped payload + `X-Hub-Signature-256` (HMAC with the **global** `KOMODO_WEBHOOK_SECRET`
> already in `compose.env` — that value is the CI `KOMODO_WEBHOOK_AUTH`), then redeploys the
> branch's compose. It will **not** consume a posted image digest. So promote by digest through
> **git**: CI resolves the immutable `…@sha256:` digest, writes it to a tracked env var
> (`MCM_BFF_IMAGE` in a committed `.env.deploy`, separate from gitignored `.env.prod`), pushes,
> then fires the signed webhook. There is no rollback endpoint — rollback = redeploy the prior
> digest (capture it before promoting). Known bug: Stack env vars set in the **UI** aren't always
> injected on webhook deploys (#1209), which is the other reason to carry the digest in git.

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
- **Hostname (v2 semantics).** `KC_HOSTNAME=https://auth.${BASE_DOMAIN}`, `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, `KC_HTTP_ENABLED=true`, `KC_PROXY_HEADERS=xforwarded`, `command: start`. Admin isolated to the tailnet: `KC_HOSTNAME_ADMIN=http://server.tailnet.ts.net:8099` with the host port bound to the tailscale IP only (`<ts-ip>:8099:8080`). Attach `keycloak-service` to **`edge-network`** so cloudflared resolves it by name.
- **Realm import (the gap, now closed).** The `grumpyrobot` realm is committed as `prod-realm.json` (carrying the `${BASE_DOMAIN}` placeholder), rendered at deploy to the gitignored `prod-realm.rendered.json` that `--import-realm` mounts (kept separate from the throwaway `ci-realm.json`; `PROD_REALM_FILE` points at the rendered file). Sanitize before committing: strip dev redirect URIs (`localhost:*`, `10.0.2.2`, the old `app.` host), real client secrets, dev SMTP, **all users**, and the embedded signing keys (`components."org.keycloak.keys.KeyProvider"` — so prod mints fresh keys).
  > **Gotcha — `${BASE_DOMAIN}` is rendered by hand right now** on the host: `sed 's|${BASE_DOMAIN}|<domain>|g' prod-realm.json > prod-realm.rendered.json` (sed, not envsubst — it touches ONLY the literal `${BASE_DOMAIN}` and leaves Keycloak's `${role_*}`/`${client_*}` i18n placeholders intact).
  > **Gotcha — removing a client means removing ALL its references.** Dropping a client from the export (e.g. the test-only `mcm-bff-test`) requires deleting its `roles.client[<id>]` entry (and any `scopeMappings`) too — not just the client object. A dangling reference makes `--import-realm` abort in production mode with `App doesn't exist in role definitions: <id>` and crash-loop `keycloak-service`.
- **Cloudflare route.** Add a published application on the `homelab-prod` tunnel: `auth.${BASE_DOMAIN}` → `http://keycloak-service:8080` (scheme **http**, container port **8080** — not the 8099 admin binding). This auto-creates the proxied CNAME. Verify end-to-end: `curl https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` → issuer `https://auth.${BASE_DOMAIN}/realms/grumpyrobot`.
  > **Gotcha — the admin console needs the public auth route reachable.** The console served on the tailnet still sends its OIDC + session-check ("3rd party check") iframe to `KC_HOSTNAME` (`auth.${BASE_DOMAIN}`). Until that route resolves, opening `http://homelab…:8099` fails with *"Timeout when waiting for 3rd party check iframe message."* If Chrome third-party-cookie blocking keeps it flaky after the route is up (console on http-tailnet, iframe on https-public), serve admin over HTTPS on the tailnet (`tailscale serve --bg http://localhost:8099`) and set `KC_HOSTNAME_ADMIN=https://server.tailnet.ts.net`.
- **Admin hardening.** `KC_BOOTSTRAP_ADMIN_*` is first-boot only. Log in once, create a named admin with **2FA**, and delete the bootstrap `admin` user. After that the bootstrap creds are **inert** (Keycloak only consults them when no admin exists) — but **keep them** in the committed compose + Komodo env: they're a managed secret (never in git), the `${…:?}` fail-fast form requires the value on every redeploy, and a **fresh DB deploy needs them to create the first admin** (removing the lines would lock you out of a rebuilt Keycloak). For extra hygiene, *rotate* the Komodo value to a fresh random string rather than removing the mechanism. SMTP stays stubbed (Mailpit removed) — wire a real provider before opening registration.

### 11.B BFF prod — `mcm.${BASE_DOMAIN}` (pending Phase 15)

The BFF is a CI-built image (`mcm-bff`); the prod container `mcm-bff-service` listens on **3000** (the dev `:8082` is a host port). It can't deploy until Phase 15 produces an image. Author now, deploy after:

1. **Build the prod APK against the public host.** The production `build-apk.mjs` run must bake `mcm.${BASE_DOMAIN}` (HTTPS) as the BFF URL — not an IP, not `:8082`.
2. **BFF config.** Set the BFF `ROOT_URL`/issuer to the public `auth.` origin, and the session-cookie domain to `mcm.${BASE_DOMAIN}` with `Secure`+`HttpOnly`. CORS allows the app origin only. Wire the Redis session store; attach to `edge-network` (cloudflared reaches `mcm-bff-service:3000` by name); no public port mapping.
3. **Client redirect URIs.** On the `movie-collection-manager` client, add the production **valid redirect URIs**: the web origin (`https://mcm.${BASE_DOMAIN}/*`) and the **mobile app link / custom-scheme deep link** for the OAuth callback. Without the mobile entry, on-device login fails after the browser redirect.
4. **Cloudflare route.** Add the second published application: `mcm.${BASE_DOMAIN}` → `http://mcm-bff-service:3000`. These two (`auth.` + `mcm.`) are the **only** public hostnames; everything else stays tailnet / Cloudflare Access.
5. **Off-network device login test**, then **re-export the final realm** and park client secrets in **Komodo/Vault**, never git.

---

## Phase 12 — Extended hardening

Beyond Phases 2–5:

> **Status 2026-07-05 — hardening pass done.**
> - ✅ **Public SSH closed** — ufw `OpenSSH` rule removed (v4+v6); only `tailscale0 ALLOW IN` remains, so the sole public inbound path is the Cloudflare tunnel.
> - ✅ **2FA** on Forgejo + Cloudflare + Komodo (Komodo has native TOTP/passkey since v2.0.0). Admin UIs tailnet-only.
> - ✅ **CrowdSec goal met at the edge instead.** With no reverse proxy (direct edge-TLS, 10.C skipped) there's no access log to parse, so protection lives where the traffic actually enters: Cloudflare free **Managed Ruleset** (auto-on), **Bot Fight Mode**, and one per-IP **rate-limit rule** (URI-Path `*`, ~300 req/10s → block 1 min; note the free plan's rate-limit builder can't match the Hostname field). Plus **Keycloak realm brute-force detection** for credential-stuffing on the IdP itself.
> - ✅ **Trivy** image scanning in CI (fail on fixable CRITICAL). **Renovate** in progress repo-side (scheduled `.forgejo/workflows/renovate.yml` + `renovate.json`; needs a least-privilege `renovate` PAT as `RENOVATE_TOKEN`).
> - ✅ **NTP** confirmed (systemd-timesyncd; chrony optional).
> - ✅ **Performance isolation** via host cgroup caps on the CI user slice: `systemctl set-property user-<ci-uid>.slice CPUQuota=1000% MemoryHigh=24G MemoryMax=30G CPUWeight=50 IOWeight=50`, and `user-<prod-uid>.slice CPUWeight=200 IOWeight=200` so prod wins under contention.
> - ⚠️ **Deferred (accepted risk):** the **docker-socket-proxy** (Komodo is tailnet-only + registration-disabled, and Periphery needs broad write access anyway) and **Vault** (secrets are already out-of-git, masked Komodo Variables, behind 2FA-tailnet Komodo, in encrypted restore-verified backups — deemed adequate for single-tenant; Vault's unseal-on-reboot burden isn't worth the marginal gain).
> - ⚠️ **Still open:** UPS + NUT (Phase 14).

- **Close public SSH entirely.** With Tailscale (`--ssh`), remove the `OpenSSH` ufw rule and administer only over the tailnet. Your sole inbound internet path becomes the Cloudflare tunnel.
- **Protect the Docker sockets.** Komodo (and anything mounting `docker.sock`) effectively has root over that daemon. Front it with a **docker-socket-proxy** (Tecnativa) allowing only the API calls it needs; never mount the prod socket into an internet-exposed container.
- **Gate admin UIs.** Forgejo, Komodo, Grafana, Cockpit → tailnet-only or behind **Cloudflare Access**. Never expose Keycloak admin or **any** CI-daemon service publicly — only `mcm.` and `auth.` face the internet.
- **CrowdSec** (container) — modern fail2ban with shared blocklists; wire it to the reverse proxy to auto-ban scanners on the public hostnames.
- **2FA** on Forgejo, Cloudflare, Komodo.
- **Secrets in Vault.** Use the stack's Vault for prod secrets instead of env files; CI secrets live in Forgejo Actions secrets. No clear-text secret reaches git — EVER (features 021/022/023): tracked-compose credentials are fail-fast `${VAR:?}` refs (no inline literal, no `:-literal` default), real dev values minted by `node scripts/gen-dev-secrets.mjs` into gitignored `stacks/*.env`, and the rule extends to scripts/tests/docs (read env, skip-if-unset). Two CI gates enforce it on every push/PR: `naming-gate.yml` (`check-no-inline-secrets.mjs`) and `secret-scan.yml` (`secret-scan.mjs`, whole tree) — port both to the Forgejo pipeline.
- **Image hygiene.** Pin images by digest; **Trivy**-scan images in CI (fail on criticals); run **Renovate** (Forgejo-compatible) to keep base images patched.
- **NTP/chrony.** Keep the clock tight — JWT `exp`/`nbf` validation breaks on clock skew.
- **Performance isolation.** Set CPU/memory limits on the CI compose stacks (especially the KVM Android emulator) so a runaway build can't starve prod. (Rootless daemons isolate *security*; cgroup limits isolate *performance*.)

---

## Phase 13 — Monitoring & alerting (prod daemon)

The architecture's `otel-lgtm` (Grafana/Prometheus/Loki/Tempo), LangFuse, and OpenSearch are agent-layer/Control-Tower and profile-gated. Add a lean **infra** monitoring profile:

```
node-exporter   → host CPU/RAM/disk/temp
cAdvisor        → per-container resource usage
Prometheus      → scrape node-exporter, cAdvisor, and mc-service /metrics  (reuse otel-lgtm)
Grafana         → dashboards (reuse otel-lgtm)
Uptime Kuma     → black-box probes of https://mcm. , https://auth. , /health  → phone alerts
Dozzle          → real-time container log viewer for quick triage
Scrutiny        → SMART health on the single NVMe (your biggest hardware SPOF)
```

Uptime Kuma is the one that actually pages you (Telegram/Discord/email) when the public app or `/health` goes down. If you'd rather not run the full Prometheus stack, **Beszel** is an excellent all-in-one lightweight alternative (host + container metrics + alerts).

> **Deployed 2026-07-05 (as-built — differs from the plan above).** All on the prod rootless daemon, published on the **tailnet IP only** (`<ts-ip>:port`):
> - **Uptime Kuma** (`<ts-ip>:3011`) — HTTP-keyword probes of the public BFF health path (`ok`) and the Keycloak well-known (`issuer`); **Gmail app-password SMTP** alerts. This is the pager. (Port 3011 because the pre-existing `otel-lgtm` Grafana already holds the host's 3002.)
> - **Beszel** hub + agent (`<ts-ip>:8090`) — chosen over the node-exporter/cAdvisor/Prometheus/Grafana assembly: rootless-friendly, host + container metrics + built-in threshold alerting. Hub↔agent communicate over a shared **unix socket** (`/beszel_socket/beszel.sock`), so there's no host-networking friction under rootless.
> - **Dozzle** (`<ts-ip>:8081`) — live per-container log viewer.
> - **otel-lgtm** already runs for app/agent telemetry (Grafana/Prometheus/Loki/Tempo).
> - **Disk SMART → host-level `smartd`, NOT a container.** Raw NVMe SMART needs root device access that rootless containers can't get, so Scrutiny doesn't fit. Instead `smartmontools` runs on the **host** with `msmtp-mta` + `bsd-mailx` routing failure alerts through Gmail (`DEVICESCAN -a -m <you> -M exec /usr/share/smartmontools/smartd-runner`). Enable the unit as `smartmontools.service` (Ubuntu ships `smartd.service` only as a linked alias, which `systemctl enable` refuses).

---

## Phase 14 — Backups, disaster recovery & UPS

**The most important phase — one 1 TB SSD is a single point of failure.**

- **Backups (restic or Borg), scheduled + encrypted + offsite (3-2-1):**
  - `mongodump` the replica set; `pg_dump` each Postgres (Forgejo, Keycloak, agent-db, Komodo).
  - Snapshot Forgejo's data volume (repos + registry), Komodo config, and the **prod Keycloak realm export**.
  - Push at least one copy offsite (Backblaze B2 / S3 — cheap).
  - **Test restores on a schedule** — a backup you haven't restored isn't a backup.
- **UPS + NUT.** A small UPS with **NUT** triggers a clean shutdown on power loss (prevents Mongo/Postgres corruption) and pairs with the BIOS "always on" so the box self-recovers.
- **Retention/disk-fill guards.** Set Loki/OpenSearch retention and a scheduled `docker image prune` on the CI daemon, or Android builds + image layers will fill the SSD.

> **As-built 2026-07-05 — implemented + hardened after a reboot exposed gaps.**
>
> **Backups.** `restic` → rclone remote, run by `/home/prod/backup/backup.sh` on a `prod`-user systemd timer (`homelab-backup.timer`, nightly 03:30). It stages dumps into a temp dir that restic captures, then prunes (7 daily / 4 weekly / 6 monthly). Dumps:
> - **Forgejo** via `forgejo dump` (repos + registry + DB + config → one `forgejo-dump.tar.gz`).
> - **Komodo** `pg_dumpall`.
> - **Keycloak** Postgres (`pg_dump -d keycloak`) and **agent-db** Postgres (`pg_dump -d agent_db`) — `docker exec … pg_dump` over the container's local socket.
> - **mc-service Mongo** (`mongodump` of `mc_db`, the movie data) and **BFF Mongo** (`bff_db`) — `docker exec … mongodump` inside each Mongo container. The Mongo connection URIs (which carry creds) are read **live from the running app containers** at backup time via a `cenv()` helper, so **no secret is stored in the script** (host rewritten to `127.0.0.1`).
> - Each app-DB dump is best-effort and drops a `DUMP-FAILED-<name>` marker in the snapshot on error, so an incomplete backup is visible instead of silent.
> - **Intentionally NOT dumped:** langfuse / unleash / audit-opensearch (telemetry), redis caches, MinIO nx-cache (all rebuildable).
> - ⚠️ **Gotcha that bit us:** the *original* `backup.sh` dumped only Forgejo + Komodo + the minio/nx-cache **dirs** — it did **not** dump the app databases. A reboot corrupted Forgejo's Postgres and Forgejo happened to be the only thing with a real backup. **Whenever a stateful service is added, add its dump to `backup.sh`.**
>
> **Restore (Forgejo Postgres — proven 2026-07-05).** Only the PG volume was corrupt; repos/registry live on a separate, intact volume. Extract `forgejo-db.sql` from the `forgejo dump` archive in restic, reset the DB (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` on a fresh volume), then **load the SQL twice, ignoring errors** — the `forgejo dump` SQL is xorm-generated and **not dependency-ordered**, so pass 1 creates tables + data with some index/`setval`-before-table errors, and pass 2 fills the missing indexes/sequences while re-`INSERT`s bounce off primary keys (no duplicate data). Forgejo runs migrations on boot and self-heals.
>
> **Graceful shutdown (root-cause fix for the corruption).** On reboot the rootless containers were **SIGKILL'd** (the user-manager teardown races the container processes), so DBs never flushed. Fix: a per-user drain unit `~/.config/systemd/user/docker-drain.service` — `Type=oneshot`, `RemainAfterExit=yes`, `After=docker.service`, `BindsTo=docker.service`, with `ExecStop=/bin/sh -c 'cids=$(docker ps -q); [ -n "$cids" ] && docker stop -t 30 $cids'`. On shutdown it stops **before** `docker.service`, so every container gets a clean SIGTERM + flush while the daemon is still up. Keeps `live-restore=true` (daemon restarts still don't bounce containers). Enable through the user bus: `machinectl shell prod@ /usr/bin/systemctl --user enable --now docker-drain.service` (plain `sudo -iu prod systemctl --user` can't reach the bus).
>
> **UPS + NUT (APC Smart-UPS, USB).** `apt install nut`; `nut-scanner -U` auto-detects (driver **`usbhid-ups`**, `port=auto`). Standalone config: `MODE=standalone` in `nut.conf`; `[apcups] driver=usbhid-ups port=auto` in `ups.conf`; a monitor user `[upsmon] password=<gen> upsmon primary` in `upsd.users` (chmod **640 root:nut**); `MONITOR apcups@localhost 1 upsmon <pw> primary` + `SHUTDOWNCMD "/sbin/shutdown -h +0"` in `upsmon.conf`. **NUT 2.8.4 uses `nut-driver-enumerator`, not `nut-driver-enabler`** — after editing `ups.conf`, `systemctl restart nut-driver-enumerator.service`, then start `nut-driver.target nut-server.service nut-monitor.service`; verify `upsc apcups` → `ups.status: OL`. If the driver won't attach right after install, `udevadm control --reload-rules && udevadm trigger` re-applies USB perms to the already-plugged UPS. On low battery: `upsmon` → `shutdown -h` → the **drain unit** → clean flush (same path as a manual reboot). *(Optional future tuning: shut down after N minutes on battery rather than near-empty; have the UPS cut its own output so mains-return auto-power-cycles the box.)*

---

## Phase 15 — Wire the pipeline

> **✅ CD architecture — final hardened state (2026-07-03).** Phase 15 is complete; the pipeline below
> was hardened during bring-up. The current shape (authoritative — see also the CLAUDE.md CI/CD section):
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
>   Step A–E history: `docs/proposals/homelab-setup/Phase-15-Operator-Checklist.md`.

### 10.1 Provision the Keycloak realm (unblocks the stack — PRD §4.3)

1. From your working local stack, export the realm with users + secrets:

```bash
# feature 020 unified the container_name to the role id; it's `keycloak-service` (not mcm-keycloak-service-1)
docker exec keycloak-service /opt/keycloak/bin/kc.sh \
  export --realm grumpyrobot --users realm_file --file /tmp/realm.json
```

2. Copy it out, sanitize anything you don't want committed, and commit as `infrastructure-as-code/docker/keycloak/ci-realm.json` (throwaway CI secrets are fine to commit; **not** prod secrets). The whole-tree `secret-scan.yml` gate will fail the build if a real credential is left in it.
3. Wire Keycloak with `--import-realm` + a mount in the CI bring-up, and add a "provision env" workflow step that materializes the secrets (features 021/022/023): run `node scripts/gen-dev-secrets.mjs` to mint the gitignored per-stack `stacks/*.env` files (`auth.env` — now incl. `KC_DB_PASSWORD`, feature 022: single source for both Postgres + Keycloak, no more `keycloak_db_password.txt`/`.env.local`; `mcm.env`, plus `audit.env`/`observability.env` if those stacks run) from the committed `*.env.example` templates, and `node scripts/gen-ci-env.mjs` to write `frontend/mcm-app/.env.docker` from the Forgejo Actions secrets. Do **not** commit any of these generated files.

### 10.2 Port `android-e2e.yml` → Forgejo Actions

Copy `.github/workflows/android-e2e.yml` to `.forgejo/workflows/android-e2e.yml` and adjust:

- `runs-on:` → your runner labels (`ubuntu-latest`; add `kvm` for the emulator job).
- Swap any GitHub-marketplace `uses:` steps for `act_runner`-compatible equivalents (most `actions/checkout`, `actions/cache`, `setup-*` work; verify niche ones).
- Registry login/push → `server.tailnet.ts.net:3000/jumbleknot/...` with the Forgejo token secret.
- Add a final step: build + push images, then `curl -XPOST <komodo-stack-webhook>` to trigger prod redeploy.
- Trigger on `push` to a working branch first; flip to `pull_request` only after first green.

### 10.3 Migrate secrets

Set in **Forgejo → repo → Settings → Actions → Secrets**: `ANTHROPIC_API_KEY`, `E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `FORGEJO_REGISTRY_TOKEN`, `NX_CACHE_*`, `KEYCLOAK_*` client secrets, `COOKIE_SECRET`. Prod-only secrets live in **Komodo**, not git.

### 10.4 First run + expected iteration

Push to the working branch and watch the run in Forgejo. Expect to clear the known first-time failure points in order (each a few minutes apart): `assembleRelease` signing/bundle, fixture-seeding via `global-setup` at `:8082`, then the first Maestro agent flow on the KVM emulator. Then add the image-push + Komodo trigger and confirm prod redeploys.

---

## Phase 16 — Verification checklist

> **Verified 2026-07-05** except where noted (`[~]` = partial/deferred, `[ ]` = open).

- [x] `kvm-ok` passes; `/dev/kvm` accessible; `ci` is in `kvm`. *(Nit: `/dev/kvm` is mode 666, not 660 — tighten via a udev rule if desired.)*
- [x] `sudo -iu ci docker info` and `sudo -iu prod docker info` both report **rootless**, distinct data roots (`/home/ci` vs `/home/prod`).
- [x] The rootful `docker.service` is **disabled** and inactive.
- [x] Firewall: **no** public inbound except the Cloudflare tunnel — SSH is now tailnet-only (`ufw` shows only `tailscale0 ALLOW IN`); all UIs over Tailscale.
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
- [x] A backup runs on schedule **and a test restore succeeds** ✅ (Phase 14 — now covers app DBs too); **UPS/NUT** ✅ (APC Smart-UPS + graceful-shutdown drain unit, 2026-07-05).

---

## Phase 17 — Reboot resilience, as-built fixes & deferred repo work (2026-07-05)

A kernel-upgrade reboot on 2026-07-05 hard-killed the rootless containers and exposed several issues. Root causes + fixes below. The graceful-shutdown and backup fixes are in **Phase 14**; the items under "Deferred" are **repo/Komodo-side** so they persist across deploys.

### Fixed on the host

- **DB corruption on reboot** → the drain unit (Phase 14, *Graceful shutdown*).
- **App-DB backup gap** → `backup.sh` now dumps every app DB (Phase 14, *Backups*).
- **Monitoring UIs unreachable after reboot (tailnet-IP bind race).** ROOT CAUSE: the rootless Docker daemon starts at boot **before `tailscaled`**, so rootlesskit never learns the tailnet IP and cannot bind published ports to it (`docker ps` shows the container `Up` but with an **empty Ports** column; `ss` shows nothing listening). `0.0.0.0` binds work — that's why Forgejo (`0.0.0.0:3000`) stayed reachable but every `<ts-ip>:port`-bound UI did not. A container restart does **not** fix it (the daemon's host-IP view is stale); only `0.0.0.0` or a full rootless-daemon restart. **Fixed** on the host by rebinding the three standalone monitoring composes (`/home/prod/{uptime-kuma,dozzle,beszel}/compose.yaml`) to `0.0.0.0` (ufw still keeps them tailnet-only). The durable, box-wide fix is under *Deferred*.

### Reboot-recovery playbook (if a future reboot leaves services down)

- **Forgejo Postgres crash-loop** (`could not locate a valid checkpoint record`) = WAL corruption → restore from backup (Phase 14 restore procedure). The repos/registry volume is unaffected.
- **mc-service Mongo crash-loop** (`/tmp/mongo-keyfile: Permission denied`) = the `0400` replica-set keyfile persisted in the container's `/tmp` across a *restart*, and the entrypoint can't overwrite a read-only file. Fix = **recreate**, not restart: `docker rm -f mc-service mc-service-store-mongo` then Komodo redeploy. (Permanent fix is repo-side — see *Deferred*.)
- **Keycloak lost its `backend-network` attachment** → mc-service can't resolve `keycloak-service` for OIDC (`dns error … Try again`) → the app shows *"failed to load collections."* Quick fix: `docker network connect backend-network keycloak-service` then `docker restart mc-service`. Durable fix = Komodo `prod-auth` redeploy (see *Deferred*).
- **Services that depend on Keycloak** (BFF / agents / mc-service) may crash-loop until Keycloak is healthy; they self-heal via their restart policy once it is.

### Deferred to Claude Code (repo / Komodo-side)

These require changes in the `jumbleknot/mcm` repo (config-as-code) or a Komodo redeploy, so they survive future deploys:

1. **Tailnet-IP bind survivability, box-wide.** Either bind all prod-stack published ports to `0.0.0.0` (not `<ts-ip>:port`) in the repo composes, **or** add systemd ordering so the rootless `docker`/user-manager starts **after `tailscaled`**. Only the 3 standalone monitoring composes are patched so far (host-side, non-durable). Also affects Keycloak admin `:8099`.
2. **Grafana / otel-lgtm** unreachable after reboot — bind `0.0.0.0` in `infrastructure-as-code/docker/observability/compose.prod.yaml` (Komodo `prod-observability`).
3. **mc-service Mongo keyfile idempotency** — make `mongo-entrypoint.sh` `rm -f /tmp/mongo-keyfile` before writing (or generate it fresh) so a plain restart doesn't crash-loop.
4. **Keycloak `backend-network` durability** — ensure the `prod-auth` compose declares `backend-network`; redeploy via Komodo so the attachment replaces the manual `docker network connect`.
5. **Renovate** — the planned scheduled `.forgejo/workflows/renovate.yml` + `renovate.json` (needs a least-privilege `renovate` PAT stored as the `RENOVATE_TOKEN` Actions secret).

After 1–4 land, do a single **validation reboot** to confirm the box comes back fully clean, hands-off (Phase 16).

---

## Appendix — quick reference

| Service | Daemon | URL (over Tailscale) |
|---|---|---|
| Cockpit (host admin) | host | `https://server.tailnet.ts.net:9090` |
| Forgejo (SSOT + registry) | prod | `http://server.tailnet.ts.net:3000` |
| Komodo (CD) | prod | `http://server.tailnet.ts.net:9120` |
| MinIO (Nx cache) | prod | `http://server.tailnet.ts.net:9001` |
| CI Forgejo runner | ci | (no UI — status in Forgejo) |
| MCM production stack | prod | named stacks under `stacks/` (feature 020): `auth` + `mcm` (+ `audit`/`observability`), `up-auth` → `up-mcm` |
| Public app (BFF) | prod | `https://mcm.${BASE_DOMAIN}` (Cloudflare Tunnel) |
| Public auth (Keycloak) | prod | `https://auth.${BASE_DOMAIN}` (Cloudflare Tunnel) |
| Caddy (reverse proxy/TLS) | prod | internal ingress — not directly exposed |
| otel-lgtm (Grafana/Prom/Loki/Tempo) | prod | `http://server.tailnet.ts.net:3002` (app telemetry) |
| Beszel (host + container metrics) | prod | `http://server.tailnet.ts.net:8090` |
| Uptime Kuma (alerts) | prod | `http://server.tailnet.ts.net:3011` |
| Dozzle (container logs) | prod | `http://server.tailnet.ts.net:8081` |
| Disk SMART alerts | host | `smartd` (smartmontools) → Gmail via msmtp; no UI |

> Pin every image to a specific tag/digest in production compose files; let Komodo manage promotion. Keep CI's throwaway stack on the `ci` daemon so a failed/poisoned build can never reach prod data.
