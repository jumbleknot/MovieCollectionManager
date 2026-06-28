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
  compose.env
prod$ echo "KOMODO LOGIN: admin / $ADMINPASS"   # save it
prod$ mkdir -p /home/prod/komodo/backups
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
a **Stack** per prod compose file (the MCM app with its profiles), set it to **pull the latest
tag and redeploy on webhook**, and note the stack's webhook URL — the CI job calls it after
pushing images. Promote by digest; keep the prior digest for rollback.

---

## Phase 10 — Public ingress, TLS & DNS

Goal: reach production from the Android app **outside the LAN**, with real TLS, on your `${BASE_DOMAIN}` domain, despite having **no static IP** (and possibly CGNAT). Pick one ingress model.

> **Confirmed model (Phase 11 Work Order):** **direct edge-TLS** — Cloudflare terminates TLS at the
> edge and `cloudflared` dials the containers over plain HTTP on the shared external `edge-network`,
> **no Caddy** (cloudflared → `keycloak-service:8080` / `mcm-bff:8082` by name). That is 10.A below.
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
   - `mcm.${BASE_DOMAIN}`  → `http://mcm-bff:8082` (BFF)
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
  reverse_proxy mcm-bff:8082
}
auth.${BASE_DOMAIN} {
  reverse_proxy keycloak-service:8080
}
```

Keep databases, agent-gateway, MCP servers on internal Docker networks with **no published ports**. Internal service-to-service traffic stays plain HTTP on the Docker network; only ingress needs TLS.

> If Cloudflare Tunnel terminates TLS at the edge, Caddy can serve plain HTTP internally and you skip the DNS-01 cert. Choose one place to own certs, not both.

---

## Phase 11 — Keycloak & BFF production config for the public hostname

**This is the step that makes external mobile login actually work.** Because the APK bakes the BFF URL at build time and auth is OAuth, the public origin must be wired through Keycloak and the BFF — otherwise the login redirect loops or JWT validation fails.

1. **Build the prod APK against the public host.** The production `build-apk.mjs` run must bake `mcm.${BASE_DOMAIN}` (HTTPS) as the BFF URL — not an IP, not `:8082`.
2. **Keycloak hostname + proxy.** Run Keycloak in production mode with:
   - `KC_HOSTNAME=auth.${BASE_DOMAIN}`, `KC_HTTP_ENABLED=true` behind the proxy, and proxy-header handling (`KC_PROXY_HEADERS=xforwarded`) so issuer/redirect URLs match what the client sees.
   - Real database (already have Postgres) and a **real SMTP** provider (Mailpit is dev-only — registration/verification/password-reset emails need real mail in prod).
   - Brute-force detection ON; strong admin credentials + admin 2FA; the **admin console must not be publicly exposed** (tailnet/Cloudflare Access only).
3. **Client redirect URIs.** On the `movie-collection-manager` client, add the production **valid redirect URIs**: the web origin (`https://mcm.${BASE_DOMAIN}/*`) and the **mobile app link / custom-scheme deep link** used for the OAuth callback. Without the mobile entry, on-device login fails after the browser redirect.
4. **BFF config.** Set the BFF `ROOT_URL`/issuer to the public `auth.` origin, and the session-cookie domain to `mcm.${BASE_DOMAIN}` with `Secure`+`HttpOnly` (requires the end-to-end HTTPS from Phase 10). Confirm CORS allows the app origin only.
5. **Export this prod realm config** (separately from the throwaway `ci-realm.json`) and keep its secrets in **Vault/Komodo**, never in git.

---

## Phase 12 — Extended hardening

Beyond Phases 2–5:

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

---

## Phase 15 — Wire the pipeline

### 10.1 Provision the Keycloak realm (unblocks the stack — PRD §4.3)

1. From your working local stack, export the realm with users + secrets:

```bash
# feature 020 unified the container_name to the role id; it's `keycloak-service` (not mcm-keycloak-service-1)
docker exec keycloak-service /opt/keycloak/bin/kc.sh \
  export --realm grumpyrobot --users realm_file --file /tmp/realm.json
```

2. Copy it out, sanitize anything you don't want committed, and commit as `infrastructure-as-code/docker/keycloak/ci-realm.json` (throwaway CI secrets are fine to commit; **not** prod secrets). The whole-tree `secret-scan.yml` gate will fail the build if a real credential is left in it.
3. Wire Keycloak with `--import-realm` + a mount in the CI bring-up, and add a "provision env" workflow step that materializes the secrets (features 021/022/023): run `node scripts/gen-dev-secrets.mjs` to mint the gitignored per-stack `stacks/*.env` files (`auth.env` — incl. `KC_DB_PASSWORD`, feature 022; `mcm.env`, plus `audit.env`/`observability.env` if those stacks run) from the committed `*.env.example` templates, and `node scripts/gen-ci-env.mjs` to write `frontend/mcm-app/.env.docker` from the Forgejo Actions secrets. Do **not** commit any of these generated files.

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

- [ ] `kvm-ok` passes; `/dev/kvm` group is `kvm`; `ci` is in `kvm`.
- [ ] `sudo -iu ci docker info` and `sudo -iu prod docker info` both report **rootless**, distinct data roots.
- [ ] The rootful `docker.service` is **disabled**.
- [ ] Firewall: only SSH inbound from outside the tailnet; all UIs reachable only over Tailscale.
- [ ] Forgejo reachable; repo pushed; **push-mirror to GitHub** shows a successful sync.
- [ ] `docker login server.tailnet.ts.net:3000` works from both daemons; a test image pushes/pulls.
- [ ] Forgejo runner shows **Idle**; a trivial workflow runs green.
- [ ] Nx remote cache: a second CI run shows cache hits (faster affected build).
- [ ] Keycloak imports `ci-realm.json`; the stack stands up; **web E2E 104/104** green in CI.
- [ ] Android agent Maestro flows run on the KVM emulator and pass.
- [ ] On green, images push to the registry and **Komodo redeploys prod**; the two daemons remain isolated.
- [ ] `mcm.${BASE_DOMAIN}` and `auth.${BASE_DOMAIN}` resolve, serve valid TLS, and **only those two** are reachable from the public internet.
- [ ] On-device Android login works **off-network** end to end (Keycloak redirect URIs + prod APK baked to the public host).
- [ ] Public SSH is closed; admin UIs are tailnet-only or behind Cloudflare Access; the Docker socket is proxied.
- [ ] Uptime Kuma probes `mcm.`/`auth.`/`/health` and pushes an alert to your phone on failure.
- [ ] A backup runs on schedule **and a test restore succeeds**; UPS triggers a clean shutdown on power loss.

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
| Grafana / Prometheus (infra mon) | prod | `http://server.tailnet.ts.net:3001` |
| Uptime Kuma (alerts) | prod | `http://server.tailnet.ts.net:3002` |
| Dozzle (logs) / Scrutiny (SMART) | prod | tailnet-only |

> Pin every image to a specific tag/digest in production compose files; let Komodo manage promotion. Keep CI's throwaway stack on the `ci` daemon so a failed/poisoned build can never reach prod data.
