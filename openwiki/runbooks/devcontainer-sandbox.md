---
type: Runbook
title: Dev container on Docker Sandbox microVM (primary environment)
description: The primary AI-assisted development environment since feature 060 — a dev container running inside a Docker Sandbox microVM. Covers lifecycle, egress policy, the socat engine seam, networking quirks, restart/reboot survival, disk limits, the template-recreate trap that destroys host-filesystem isolation, and the re-pin procedure with the two ways it silently rebuilds the old image.
resource: docs/runbooks/devcontainer-sandbox.md
tags: [devcontainer, sandbox, docker, security, isolation, runbook]
timestamp: 2026-08-22T00:00:00+00:00
---

# Dev container on Docker Sandbox microVM (primary environment)

Since feature 060, the primary AI-assisted development environment is a **dev container running inside a Docker Sandbox microVM**, not Docker Desktop and not Docker-in-Docker. It measured **0.43×** the wall-clock of the [Docker Desktop / DinD path](devcontainer.md) across five stages (`docker-build` alone went 1024 s → 293 s).

The [Docker Desktop path](devcontainer.md) is retained for one reason only: the **Android emulator**, which needs `/dev/kvm` that the microVM cannot provide (feature 060, gate R2, resolved negative). Everything else — web E2E, integration, the agent stack, day-to-day assistant work — runs here.

## Credential rule — read first

AI-assisted coding runs on the **Claude Max subscription**. `MCM_ANTHROPIC_API_KEY` exists only for the movie assistant (E2E) and OpenWiki. **Never set `ANTHROPIC_API_KEY` in any environment.** Claude Code silently prefers it over a subscription login, with no warning and nothing in the UI showing which is in use. **Measured 2026-08-16: ~$15 of unintended spend in one day** on a workstation where the subscription was present the whole time.

The key is mapped to `ANTHROPIC_API_KEY` **only at the point of use**: agent gateway (`agent-stack.mjs`), OpenWiki maintenance (`wiki-maintain.mjs`), and the containerized E2E recipe. Each is a separate process running no interactive assistant. CI injects `ANTHROPIC_API_KEY` from repository secrets into jobs that also run no assistant.

> The VM itself has `ANTHROPIC_API_KEY=proxy-managed` — that 13-character value is Docker Sandbox's own marker (§ Credential injection), not a leftover.

## Gotchas

- **`sbx start` DOES NOT EXIST.** The invocation silently prints the root help and appears to do nothing. To start a stopped sandbox: **`sbx run --name mcm -d`**. `sbx stop --help` states this; `sbx start` does not.

- **`--name` is load-bearing on `sbx run`.** Without it, `sbx run mcm` tries to run an agent called `mcm`; omitting `--name` can create a second sandbox instead of restarting the existing one.

- **The VM idle-stops ~30 seconds after the last session disconnects — this is normal, not a fault.** Coming back to a "missing" environment usually means it idle-stopped; start it and nothing is lost. Long unattended jobs die unless a session is held open (`ssh mcm.sbx 'sleep 5400'` in another window; launch work with `setsid nohup … &`). The dev container carries `--restart=always` and returns by itself; the agent stack does not — see Restart and reboot below.

- **`sandboxd` does not auto-start at boot.** After a workstation reboot, `sbx run --name mcm -d` starts it on demand. Reaching for `ssh mcm.sbx` first can surface a daemon error that reads like a broken environment rather than a cold host — start with `sbx run`.

- **`init-firewall.sh` is NOT run here.** On the Docker Desktop path the dev container programs its own `ipset`/`iptables` default-deny. On the sandbox path, egress is governed by the **host-side policy** — not the in-VM firewall. Triage order when something is blocked: **host policy first**, in-VM second. That is the opposite of the Docker Desktop path.

- **`nc -z <ip> 443` reports OPEN against a blocked destination.** The sandbox proxy accepts the TCP connection and refuses at TLS. A connect-only probe will say egress is wide open when it is not. Always probe with a real request.

- **Refusals look different from each vantage point:**

  | From | Blocked destination looks like |
  |---|---|
  | dev container | no route — `curl` writes `000` |
  | sibling container | `rc=6` — NXDOMAIN (DNS-layer refusal) |
  | raw IP from a sibling | `rc=35` — TLS terminated mid-handshake |
  | VM shell | HTTP **403** with `Blocked by network policy` |

- **The socat relay truncates output — exit 0 with no stdout (D-19).** The dev container reaches the VM engine through `docker-outside-of-docker`, fronted by a socat relay (`/var/run/docker.sock`). socat's half-close timeout defaults to 0.5 s; `docker exec` half-closes stdin immediately, so socat tears the relay down mid-response. Fast commands work, so the seam looks healthy under quick probes; only real work fails. Fix already applied in `.devcontainer/sandbox/devcontainer.json`: `"DOCKER_HOST": "unix:///var/run/docker-host.sock"`. If you invoke Docker from a context that does not inherit `containerEnv`, pass it explicitly: `docker exec -e DOCKER_HOST=unix:///var/run/docker-host.sock …`.

- **`host.docker.internal` is unreachable from the dev container** — Docker's implicit entry resolves to `fe80::1` (link-local IPv6). Under `--network=host`, a sibling's published port *is* localhost. Use `localhost` instead. The gateway and MCP containers still need `--add-host host.docker.internal:host-gateway` (`172.18.0.1`); that flag is load-bearing — keep it.

- **The agent stack does NOT come back after restart.** `movie-assistant-gateway` and the 3 MCP servers are started with `restart=no` deliberately — a restart policy would resurrect the gateway from its pre-rebuild image (the "silently runs old code" trap). Restart explicitly: `MODEL_PROVIDER=anthropic pnpm nx up-agents-prod infrastructure-as-code`. Verify with `verify-reboot-survival.sh --verify`, not by eye.

- **Docker disk is 49 GB and cannot be enlarged (v0.38.0).** It reached 94% (3.1 GB free) during feature 060. Reclaim space with `docker builder prune -f` (safe, never touches images). **Never `docker image prune -a`** — it evicts the 3.5 GB Playwright image which must then be re-pulled.

- **Template recreate destroys host-filesystem isolation unless the workspace is specified explicitly (critical, measured 2026-08-16).** `sbx run` mounts the **current directory** as the sandbox workspace read-write over virtiofs unless told otherwise. Creating a sandbox while sitting in the repo mounts the repo into the VM — a file written inside immediately appeared in the Windows working copy. Always pass a dedicated scratch directory: `sbx run -t … --name <new> -d shell C:\path\to\scratch\dir`.

- **A template does NOT carry the egress policy.** A sandbox created from a template gets the default (allow-all) profile. Apply the policy before anything pulls: run `node scripts/gen-egress-policy.mjs --format sbx-policy` and apply each emitted rule with `sbx policy allow network <domain> --sandbox <new>`. A policy refusal is **instant** (< 1 s); a network fault times out. Speed is the diagnostic clue.

- **A template does NOT contain Docker images.** `sbx template save` snapshots the VM root filesystem, not the Docker data disk. A sandbox recreated from a template comes up in seconds with zero images — the real time is the cold rebuild and re-pull that follows.

- **`sbx template save` stops the sandbox and holds a lock for its full duration (~17 min).** Other `sbx` commands block while the save runs. Do not run it when you need the environment, and do not conclude it failed because `sbx template ls` shows nothing — check whether the sandbox went to `stopped`.

- **`anthropicKey()` in `agent-stack.mjs` honours `ANTHROPIC_API_KEY` first.** In this VM that variable holds `proxy-managed` (the sandbox's marker), so a naive run injects a non-credential and fails with a 401 that reads as a bad key rather than a precedence problem. Use `env -u ANTHROPIC_API_KEY` so `.env.local` wins.

- **Front door ≠ blob/CDN host — allowlisting the API host is not enough.** A service's API host and its download host are different names; allowlisting the first yields a fetch that authenticates and then dies. Allowlist both. Confirmed traps:

  | Service | Front door | Blob/CDN host |
  |---|---|---|
  | Docker Hub | `registry-1.docker.io` | `production.cloudfront.docker.com` |
  | GHCR | `ghcr.io` | `pkg-containers.githubusercontent.com` |
  | Quay | `quay.io` | `cdn0N.quay.io` |
  | MCR | `mcr.microsoft.com` | `*.data.mcr.microsoft.com` |
  | GitHub releases | `github.com` | `release-assets.githubusercontent.com` |

  `objects.githubusercontent.com` was correct when written and silently stopped covering GitHub release downloads when GitHub migrated — a previously-valid entry can go stale without anything changing on our side. **When a fetch fails with a DNS error, follow the redirect chain before adding the host named in the error:** `curl -sSL -o /dev/null -w '%{url_effective}\n' <url>`

- **Port publishing to LAN devices works natively — no `netsh portproxy` shim needed.** `sbx ports mcm --publish 0.0.0.0:8081:8081` binds the port on the Windows host non-loopback. Omitting the `HOST_IP` prefix (`--publish 8081:8081`) restricts to loopback only. Windows Firewall is still the remaining variable — all three profiles are enabled by default, so an inbound allow rule is required for LAN reach; `pnpm start --tunnel` (Expo tunnel) needs no inbound rule. **`sbx ports` lists nothing when the sandbox is stopped** — that is not the same as "ports were removed". Check `sbx ls` first.

- **`sbx` is pinned at v0.38.0 — an upgrade is a security-relevant change, not a routine one.** It is load-bearing for isolation and egress enforcement. Before upgrading: read release notes for changes to network policy semantics, `--network=host` behaviour, port publishing, idle-stop timeout, secret injection, and template semantics; capture before-state with `verify-reboot-survival.sh --capture`; re-run the full harness; re-run G5 explicitly (sibling-egress refusal is the core security claim). Record the new version in the source runbook.

- **`pnpm` is not in the VM shell — only inside the dev container.** VM-level scripts that call `pnpm` directly fail with `rc=127`. Use `docker exec … bash -lc` to run them inside the container.

- **`sbx secret rm` and interactive `sbx` prompts default to *No* non-interactively.** Pass `-f` to skip the confirmation. `rtk init -g` also answers "no" silently and prints a manual step — that is why `ensure-rtk-hook.sh` exists.

- **Run git inside the dev container, not the VM shell — uid mismatch was the cause, and is now fixed.** Prior to 2026-08-17 the VM user (`agent`) was uid 1000 and the container user (`coder`) was uid 1001; anything git wrote from the VM landed owned by uid 1000, which the container saw as `node` (not `coder`), making object writes fail silently on 111 of 256 `.git/objects` subdirs. **FIXED (2026-08-17):** `toolchain.Dockerfile` now creates `coder` at 1000:1000, moving the base image's `node` to 1100. Both sides are now 1000:1000 and git works from either. To automate from outside the container, prefer `docker exec -u coder …` — this remains the safe, portable form. `fix-workspace-ownership.sh` still runs at create/start to repair any already-poisoned tree.

  **Applying it is a re-pin, not a local build.** Pushing a `toolchain.Dockerfile` change *is* the trigger — the `devcontainer-image` workflow builds and publishes automatically, so check for a `build-publish` run before building anything by hand.

  **The procedure, in full — and it runs in the VM shell, not the container.** A container cannot rebuild itself; `devcontainer up` must run from `ssh mcm.sbx`, and it destroys the container you may be working in. Everything below is one VM-shell session, because step 3's `set -a` only holds there.

  ```bash
  NEW=<the 64-hex digest from the build's run summary>          # NOT the tag — pin by digest
  REG="$FORGE_REGISTRY_HOST:3000"

  # 1. pull, and CONFIRM the image carries the change BEFORE it becomes your environment
  docker pull $REG/<ns>/mcm-devcontainer@sha256:$NEW
  docker run --rm --entrypoint bash $REG/<ns>/mcm-devcontainer@sha256:$NEW -lc 'id -u coder; pwsh --version'

  # 2. edit the pin. MCM_DEVCONTAINER_IMAGE lives in ~/.mcm-sandbox-env (NOT ~/.bashrc). The file is
  #    KEY='value' — quoted, and with NO `export` keyword. Substitute only the digest.
  cp ~/.mcm-sandbox-env ~/.mcm-sandbox-env.bak
  sed -i "/^MCM_DEVCONTAINER_IMAGE=/s|@sha256:[0-9a-f]\{64\}|@sha256:$NEW|" ~/.mcm-sandbox-env
  grep MCM_DEVCONTAINER_IMAGE ~/.mcm-sandbox-env

  # 3. source it, and GATE on the result rather than eyeballing it
  set -a; . ~/.mcm-sandbox-env; set +a
  case "$MCM_DEVCONTAINER_IMAGE" in
    *"$NEW") echo "PIN OK — safe to rebuild" ;;
    *)       echo "PIN NOT APPLIED — stop; devcontainer up would build the OLD image" ;;
  esac

  # 4. only on PIN OK. (For the UID fix specifically, chown the tree to 1000 first.)
  devcontainer up --workspace-folder /workspaces/mcm \
    --config .devcontainer/sandbox/devcontainer.json --remove-existing-container
  ```

  🔴 **Two ways this silently re-creates the OLD container, both measured 2026-08-22.**

  **`set -a` is load-bearing.** `~/.mcm-sandbox-env` has no `export` keyword, and `.devcontainer/sandbox/devcontainer.json` reads the pin as `${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}` from **the shell running `devcontainer up`**. Source it without `set -a` and the variable is set but not exported, so `localEnv` misses it and the build **falls back to the literal default `mcm-devcontainer`** — a stale local image, with no error.

  **An all-`CACHED` build is the tell.** A re-pin that did not take produces a build where every layer reports `CACHED` and a container that starts perfectly, having changed nothing. Read the one line that settles it — `devcontainer up` echoes it:

  ```text
  docker buildx build … --build-arg BASE_IMAGE=<registry>/<ns>/mcm-devcontainer@sha256:<digest>
  ```

  If that digest is the old one, stop; nothing after it matters. A genuine re-pin is **not** all-CACHED, because the layers above the new base must rebuild.

  ⚠️ **`devcontainer up` prints its full `docker run` invocation, including every `-e` secret in clear text** — `MCM_ANTHROPIC_API_KEY`, `TMDB_API_KEY`, `MCM_FORGE_TOKEN`, `MCM_FORGE_ISSUE_TOKEN`. Treat that output as credential material: do not paste it into an issue, a chat, or a transcript, and rotate all four if you already have.

- **A full disk does not announce itself — it wears other symptoms.** The 49 GB Docker disk has filled three times, and not once did the error name disk: `exit code: 100` on a feature install (looks like an apt fault), `is not signed` / `At least one invalid signature was encountered` (looks like GPG or MITM-proxy corruption of `deb.debian.org`), and a build dying in `exporting layers` (looks like an export problem). `docker system df` is unreliable — it reported gigabytes "reclaimable" while `df -h /var/lib/docker` said 0 bytes free, because it counts shared layers optimistically. Believe `df`. Prune order that works: `docker builder prune -af` first (`-f` alone drops only unused cache; `-af` reclaimed 17.8 GB), then remove the old toolchain image, then the derived image (which now owns its layers). **Two dev-container images will not fit simultaneously** — the toolchain image is ~14 GB and the derived container another ~13.5 GB; remove the previous pair before pulling a new toolchain image. Warning: build cache can mask a broken environment — apt failures may be hidden by a cached feature-install layer that never ran apt, so pruning the cache reveals failures rather than causing them.

## One-step launch

```powershell
pwsh scripts/open-sandbox.ps1
```

Checks whether the sandbox is running, starts it if not, waits for SSH, and opens VS Code directly inside the dev container. The URI it generates is computed dynamically — a pasted URI silently opens the wrong target if the workspace path or config file moves. Once opened, the entry appears in **File → Open Recent** (`Ctrl+R`), but only while the sandbox is running; against a stopped VM the Recent entry fails in a way that reads as a broken environment.

Full lifecycle, egress allowlist management, the engine seam, restart/reboot survival, disk management, credential injection, and the verification harness: `docs/runbooks/devcontainer-sandbox.md`.
