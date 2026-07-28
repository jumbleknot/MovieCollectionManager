---
type: Runbook
title: Containerized dev environment (devcontainer)
description: The disposable Linux dev container the AI coding assistant runs inside — its honestly-stated two-tier isolation model (strong host-filesystem isolation, moderate privileged-DinD engine isolation), the default-deny egress firewall, and the VS Code / Windows-host quirks that block a first boot.
resource: docs/runbooks/devcontainer.md
tags: [devcontainer, docker, security, isolation, runbook]
timestamp: 2026-07-28T02:22:54.286Z
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
- **A host env var forwarded via `${localEnv}` (e.g. the Anthropic/TMDB API keys) is read from the VS
  Code process's own environment at launch time.** Setting it after VS Code is already running does
  nothing — VS Code must be relaunched with the value already present, then the container recreated.
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

Full prerequisite checklist, the Windows-host boot sequence, and the complete security-posture
narrative: `docs/runbooks/devcontainer.md`.
