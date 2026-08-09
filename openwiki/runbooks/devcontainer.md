---
type: Runbook
title: Containerized dev environment (devcontainer)
description: The disposable Linux dev container the AI coding assistant runs inside — its honestly-stated two-tier isolation model (strong host-filesystem isolation, moderate privileged-DinD engine isolation), the default-deny egress firewall, and the VS Code / Windows-host quirks that block a first boot.
resource: docs/runbooks/devcontainer.md
tags: [devcontainer, docker, security, isolation, runbook]
timestamp: 2026-08-09T00:00:00+00:00
---

# Containerized dev environment (devcontainer)

The committed [`.devcontainer/`](../../.devcontainer/) directory gives the AI coding assistant a
throwaway Linux container to run inside, so a compromised dependency or errant agent command has a
blast radius bounded by the container rather than the host's files, credentials, or SSH keys. The
toolchain image (`.devcontainer/toolchain.Dockerfile`) bakes in Node, Rust, Python/uv, the Android
SDK + an x86_64 system image, and OpenWiki, so nothing needs a per-open download once the egress
firewall is up. `init-firewall.sh` enforces default-deny outbound with a narrow allowlist (Anthropic
API, GitHub, npm, the container-image registries DinD pulls from).

## Gotchas

- **The isolation is two different strengths — don't conflate them.** Host-filesystem/credential/SSH
  isolation is strong (no host profile, SSH keys, credential store, or Docker socket is mounted).
  Container-engine isolation is only moderate: in-container Docker-in-Docker requires `privileged`,
  and a privileged-container escape can reach the shared host engine. This is accepted deliberately,
  not an oversight.
- **Docker Desktop Enhanced Container Isolation (ECI) must stay OFF.** ECI is incompatible with the
  `docker-in-docker` feature and fails with a `mount: /sys/kernel/security: permission denied` error.
- **Two VS Code client-side conveniences break a privileged DinD container and only surface in VS
  Code, not the headless CLI.** The Wayland-socket mount must be disabled via a user setting
  (`dev.containers.mountWaylandSocket: false`); the Docker credential-helper injection is already
  fixed in committed config — don't remove that fix.
- **A host env var forwarded via `${localEnv}` (`ANTHROPIC_API_KEY`, `TMDB_API_KEY`, `MCM_FORGE_TOKEN`,
  `MCM_FORGE_ISSUE_TOKEN`) is read from the VS Code process's own environment at launch time.** Setting
  it after VS Code is already running does nothing — VS Code must be relaunched with the value already
  present, then the container recreated. For `MCM_FORGE_ISSUE_TOKEN`: `setx` alone is not enough; fully
  quit VS Code (`taskkill /F /IM Code.exe`) and relaunch from a shell where the value is already visible,
  then rebuild. With it unset, backlog reads still work via `MCM_FORGE_TOKEN`; writes are refused naming
  the missing variable. See [The agent-driven backlog](/openwiki/runbooks/backlog.md) for credential and
  reach details.
- **`crates.io` is not allowlisted — `cargo` commands need `--offline` here.** The same
  default-deny firewall that blocks npm CDN drift also blocks the Cargo registry. All commands
  that compile or test mc-service need `--offline --manifest-path backend/mc-service/Cargo.toml`.
  **A failing `--offline` resolve is not an obstacle to work around — it is a lock-discipline
  check:** it means the change is pulling a package absent from `Cargo.lock`, which CI will
  also reject. Do not reach for `--online`; inspect what is being added. See
  [cargo fmt formats the WHOLE crate](/openwiki/gotchas/rust-formatting-scope.md) for the
  companion formatting trap in this crate.
- **Local Ollama runs inside the dev container itself, not on the Windows host** — nested
  Docker-in-Docker breaks `host.docker.internal` reachability to the host, so the fix was moving
  Ollama into the container rather than routing around the network gap. See
  [Model-provider scoping](/openwiki/invariants/model-provider-scoping.md) for how this interacts
  with the gateway's provider selection.
- **A Docker CDN blob timeout on `docker compose up` is usually firewall/CDN-IP drift, not a real
  outage** — re-running `init-firewall.sh` to re-resolve the allowlisted CDN IPs and retrying is the
  documented fix, not disabling the firewall.
- **The Android emulator now runs natively in the dev container** (baked-in SDK + system image, host
  `/dev/kvm` passthrough) — see [Android emulator & APK builds](/openwiki/runbooks/android-emulator.md)
  for the boot ritual and the mobile-agent-flow caveat that still applies inside the container.
- **"Docker won't start after a rebuild" is almost always a stale container holding the DinD lock, not
  corruption.** DinD's data-root lives on a persistent named volume keyed by workspace hash, so a
  rebuilt container reuses the same volume. If a *previous* dev-container instance is still running,
  its `containerd` holds an `flock` on `meta.db` and the new daemon blocks forever with a boltdb
  timeout. `pgrep containerd` finding nothing while the lock is held is the tell — the holder is in
  another container. **Diagnose first** (python3 flock probe to distinguish "locked" from "corrupt"),
  then fix on the host: `docker ps`, `docker rm -f` every container that is NOT this one, then
  `sudo nohup /usr/local/share/docker-init.sh`. **Do NOT delete `meta.db` and do NOT
  `docker volume rm`/`docker system prune --volumes`** — `meta.db` deletion destroys every image in
  the DinD engine, and `/workspaces` itself is a named volume so a prune takes your working tree with
  it. Full diagnosis commands: `docs/runbooks/devcontainer.md`.

Full prerequisite checklist, the Windows-host boot sequence, and the complete security-posture
narrative: `docs/runbooks/devcontainer.md`.
