# Runbook: Containerized Dev Environment (feature 037)

> Daily-use and operational reference for the disposable Linux **dev container** the AI coding
> assistant runs inside. The portable asset is the committed [`.devcontainer/`](../../.devcontainer/)
> directory; this runbook is the how-to. Feature spec chain: [specs/037-containerized-dev-env/](../../specs/037-containerized-dev-env/).

## Why this exists (one line)

Give Claude Code a throwaway Linux container to run inside, so the agent's blast radius is the
container — **not** the Windows host's files, credentials, or SSH keys.

## Security posture — stated honestly (FR-011 / SC-008)

This environment provides **two different strengths** of isolation. Do not conflate them:

- **Host-filesystem / credential / SSH isolation: STRONG.** The container mounts no Windows user
  profile, no host `~/.ssh`, no host credential store, and no host Docker socket. On the
  **named-volume path** (recommended) source lives on a Linux volume with nothing from `E:\`
  reachable; on the **bind-mount path** (plain "Reopen in Container") only the project folder is
  exposed — never the rest of `E:\`, the user profile, or credentials. Either way a compromised
  dependency or errant agent command cannot read or write the host beyond (at most) the project it
  is already working on.
- **Container-engine isolation: MODERATE.** In-container Docker (the `docker-in-docker` feature)
  requires the container to run **`privileged`**. A privileged-container escape can reach the
  shared Docker Desktop WSL2 virtualization layer and thus the host engine. This is the true
  ceiling on Windows + Docker Desktop and is accepted deliberately.
- **Network egress: default-DENY with an allowlist.** [`init-firewall.sh`](../../.devcontainer/init-firewall.sh)
  drops all outbound traffic except DNS, the host/bridge subnet, and an allowlist (Anthropic API,
  GitHub, npm, and the container-image registries DinD pulls from). This shrinks the exfiltration
  blast radius even inside the container.

**This environment runs with elevated privileges (`privileged`, for DinD). We do not claim
otherwise.** Strong engine isolation (a rootless nested engine such as Sysbox) is Linux-host-only
and out of scope on this workstation; revisit only if the environment moves to the homelab Linux
host.

> Docker Desktop **Enhanced Container Isolation (ECI) must stay OFF** — it is incompatible with the
> `docker-in-docker` feature ([devcontainers/features#1319](https://github.com/devcontainers/features/issues/1319)):
> ECI + DinD fails with `mount: /sys/kernel/security: permission denied`.

## Prerequisites

- Windows 11 + **Docker Desktop** running (WSL2 backend), ECI off.
- VS Code + **Dev Containers** extension (`ms-vscode-remote.remote-containers`) — the daily driver.
- Host Node ≥ 18 to install the headless/portability runner: `npm install -g @devcontainers/cli`.
- A host-only sentinel for the isolation proof: `C:\Users\Steve\HOST-ONLY-MARKER.txt` (must NOT be
  readable inside the container).

### Two VS Code-client tweaks required on Docker Desktop + WSL2 (validated 2026-07-11)

The VS Code Dev Containers extension injects two host-side conveniences that **break a privileged
DinD container** on this setup. Neither shows up under the headless `@devcontainers/cli` (which is
why they only surfaced in VS Code). One is a user setting; the other is already fixed in the
committed config.

1. **Wayland socket mount → set `"dev.containers.mountWaylandSocket": false`** in VS Code **User**
   settings. VS Code otherwise bind-mounts the WSLg Wayland socket from the `Ubuntu` WSL distro
   (`\\wsl.localhost\Ubuntu\...`); if Docker Desktop's WSL integration for that distro is off, the
   `docker run` is refused with `accessing specified distro mount service: stat
   /run/guest-services/distro-services/ubuntu.sock: no such file or directory`, and the container
   never starts. (Alternative: enable Docker Desktop → Settings → Resources → WSL Integration →
   **Ubuntu**.) We don't need GUI forwarding, so disabling the mount is the clean fix.
2. **Docker credential helper (fixed in-config).** VS Code writes
   `"credsStore": "dev-containers-<id>"` into `~/.docker/config.json`, but that helper is a
   host-side binary absent in the container — so the **in-container** `docker pull` fails with
   `error getting credentials - err: exit status 255`. The committed config sets
   `containerEnv.DOCKER_CONFIG=/home/coder/.docker-dind` (a clean dir) so the inner DinD docker CLI
   ignores that helper. No action needed; just don't remove it.

## Daily use

### Open (interactive — the daily driver)

Two ways to open, with different speed/source trade-offs:

**A. Named-volume path (recommended — fast file watching, FR-003).** Command Palette →
**Dev Containers: Clone Repository in Named Container Volume** → this repo's forge URL, and pick
**Create a new volume**. VS Code clones the repo into a Linux **named volume** and opens it. The
config does **not** hardcode a `workspaceMount`, so VS Code manages the volume for this flow.
Reopen the *cloned-in-volume workspace* (not the local `E:\` folder) to stay on the volume.

> **On this path the named volume is the between-session source of truth** — your working copy is
> not on `E:\`; git runs inside the container; unpushed work lives in the volume. **`git push` is
> your durable backup**; a full teardown (removing the volume) discards unpushed work.

**B. Bind-mount path (works anywhere, incl. an unmerged branch — slower watch).** Open the local
folder → **Dev Containers: Reopen in Container**. This bind-mounts your existing checkout (so it
works even when `.devcontainer/` isn't on the forge's default branch yet). File watching over NTFS
is slower, and `verify-host-isolation.sh` will flag the mount — expected on this path.

> ⚠️ **node_modules caveat (bind mount only).** If you bind-mount your **main Windows working tree**
> (`E:\...\MovieCollectionManager`), the container sees the host's `node_modules` (Windows
> binaries). `postCreate`'s `pnpm install` will reconcile it to Linux binaries — which **breaks
> native Windows `pnpm`/builds** until you re-run `pnpm install` on the host, and is slow over
> NTFS. Without the `--config.confirmModulesPurge=false` flag it would instead hard-abort
> (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). **Do not bind-mount your primary checkout.** For
> the bind-mount path, open a **separate, fresh `git clone`** of the branch (no `node_modules`) —
> or just use path A. The named-volume path has none of this (fresh clone, isolated store).

When it opens, the integrated terminal is **inside** the container.

### Confirm you are in-container BEFORE trusting isolation (FR-012)

Running the assistant on the host silently defeats the whole point. Verify at a glance:

```bash
echo "$MCM_DEVCONTAINER"   # -> 1   (set only inside the container)
whoami                     # -> coder (non-root)
claude --version           # Claude Code CLI present
```

If `$MCM_DEVCONTAINER` is empty, you are on the **host** — stop and reopen in the container.

### Run Claude Code in-container

Claude Code is installed onto `PATH` by `postCreateCommand` and the `anthropic.claude-code`
extension is present. Run `claude` from the in-container terminal. Its blast radius is the
container.

### Secrets (FR-010) — injected at runtime, never committed

No secret is baked into the image or the committed config. Inject per-session via environment:

- A **gitignored** `.devcontainer/devcontainer.env` (covered by the repo-wide `*.env` ignore) read
  via the runner, or `remoteEnv` / the runner's secret mechanism.
- `FORGE_REGISTRY_HOST` — set this to allowlist the project's forge registry in the firewall (the
  host literal is kept out of git per the topology-scrub rule; `init-firewall.sh` reads it from
  env and skips cleanly when unset).
- The host user profile is **never** mounted in.

### Dev server over the network (SC-007)

Ports `8081` (Metro / Expo Web / dev BFF), `8082` (containerized dev BFF), and `8099` (Keycloak
OAuth) are forwarded (`forwardPorts`). A browser or a **physical device on the LAN** reaches a dev
server running inside the container via the forwarded address. When LAN routing is inconvenient,
the **Expo tunnel** is the documented fallback (slower; acceptable for occasional use). The legacy
Expo `19000/19001/19006` ports are unused by this Expo SDK 56 project — do not forward them.

### Teardown

```bash
# finish work, git push  ← the volume is the source of truth
devcontainer down --workspace-folder .     # stop (retains volumes)
# Full teardown (discards unpushed work): also `docker volume rm mcm-source mcm-commandhistory`
```

## In-container Docker & compose stacks (US2)

`docker build` / `docker run` and the project's compose stacks run on the **in-container DinD
engine**, separate from the host engine (nested containers never appear in the host's `docker ps`).
Bring up a stack the normal way, e.g. `pnpm nx up-auth infrastructure-as-code`.

**The first pull is slow (cold registries) and REQUIRES the firewall allowlist.** If a `docker
pull` hangs or is refused, **check the firewall allowlist BEFORE suspecting Docker**:

- The image registries must be allowlisted: Docker Hub (`registry-1.docker.io`, `auth.docker.io`,
  `index.docker.io`) **and its blob CDN hosts** (`production.cloudflare.docker.com`,
  **`production.cloudfront.docker.com`**), `ghcr.io` (+ `pkg-containers.githubusercontent.com`),
  and — for forge images — `FORGE_REGISTRY_HOST`. These are in `init-firewall.sh`.
  > **Load-bearing gotcha (validated 2026-07-11):** Docker Hub serves image *auth* from
  > `registry-1.docker.io` but the actual *blob layers* from `production.cloudfront.docker.com`.
  > Omitting that blob host makes `docker pull` fail **after** auth succeeds, with a misleading
  > `i/o timeout` on a `cloudfront` URL — check the allowlist, not Docker.
- **CDN IP rotation:** these CDN hosts round-robin across many IPs. The firewall allowlists by
  **domain** (re-resolved each apply) and is **re-runnable** — if a pull that worked earlier starts
  failing after an idle gap, re-apply to refresh the ipset (the script resets its own policy so a
  re-run never blocks its setup traffic):
  ```bash
  sudo /bin/bash .devcontainer/init-firewall.sh
  ```
  If pulls *still* fail intermittently on stale IPs, opt into the broader fallback — allowlist the
  whole AWS-CloudFront + Cloudflare CIDR ranges (a deliberate, wider egress opening):
  ```bash
  sudo FIREWALL_ALLOW_CDN_RANGES=1 /bin/bash .devcontainer/init-firewall.sh
  ```
  It is **off by default** to keep the default-deny meaningful.
- **Nested-container egress is a documented residual.** The firewall controls the dev container's
  own egress *and* dockerd's image pulls (both traverse the `OUTPUT` chain), but it deliberately
  leaves the `FORWARD` chain to dockerd so nested-container networking is not broken. A malicious
  *nested* container's egress is not independently firewalled in the pilot — accepted, documented,
  not hidden. If stricter nested control is later required, scope a second firewall pass to the
  docker bridge or allowlist registry CIDRs on `FORWARD` (fallback recorded here per T015a).

## Verification harness

Behavior-named scripts under [`.devcontainer/verify/`](../../.devcontainer/verify/), run via
`devcontainer exec` (headless) or from the in-container terminal. Each asserts one success
criterion and **fails if the environment is genuinely broken** (no self-healing):

| Script | Asserts | Run |
|---|---|---|
| `verify-host-isolation.sh` | SC-001 host FS/creds/SSH unreachable; marker present | in-container |
| `verify-engine-isolation.sh` | SC-002 nested engine works, no host socket; **complete host side** with `--host-check` | in-container **+** host |
| `verify-reproducible-recreate.sh` | SC-005 delete + recreate, zero manual steps | host |
| `verify-portable-runner.sh` | SC-006 same config runs under `@devcontainers/cli` | host |

```bash
# Headless, from a host bash on a populated workspace volume:
devcontainer exec --workspace-folder . bash .devcontainer/verify/verify-host-isolation.sh
KEEP_PROBE=1 devcontainer exec --workspace-folder . bash .devcontainer/verify/verify-engine-isolation.sh
bash .devcontainer/verify/verify-engine-isolation.sh --host-check   # the host half of SC-002
```

`verify-engine-isolation.sh` is intentionally two-sided: a container cannot observe the host engine
(that IS the isolation), so the definitive "host engine omits it" check runs on the host.

## Toolchain scope

Pilot image = **Node 24 + pnpm (corepack) + watchman + DinD** on `node:24-bookworm`. Note: the
prod BFF deploys on **node:20**, but the repo's pinned `pnpm@10.33` loads `node:sqlite` at startup
(Node ≥ 22/24 only) — on Node 20, `pnpm install` crashes with `ERR_UNKNOWN_BUILTIN_MODULE`. So the
dev container tracks the **dev toolchain's Node (24, same as the host)**; BFF runtime parity is a
SHOULD validated in CI, not here. **Rust stable + Python 3.13 + `uv`** are a deferred **increment 2** (added via
devcontainer features only if they stay within the < 5 min cold-build budget, SC-004). Compose
stacks build their own Rust/Python images *inside* nested Docker builds, so the pilot image does
not need those toolchains for `pnpm nx build` / integration tests.

## Startup budget (SC-004)

Warm start of an existing container: **< 15 s**. Cold build from scratch: **< 5 min** on the
workstation. Measure with `time devcontainer build --workspace-folder .` (cold) and a warm
`devcontainer up`.

**Observed during implementation (2026-07-11, this workstation):** image build with the Debian
base layer-cached ≈ **30 s**; a full `devcontainer up` including the docker-in-docker feature
install + firewall apply completed **well under the 5-min budget**. The authoritative from-scratch
cold measurement (empty Docker cache) and the warm-start number are confirmed during the pilot.
