---
type: Reference
title: MovieCollectionManager repository — structure and working conventions
description: The MCM monorepo itself — its directory layout, polyglot tech stack, the two dev-environment options (sandbox microVM and Docker Desktop), the mandatory pre-work gates (credential rule, SDD gate, PR-head rule), and the load-bearing gotchas that cost a session when missed.
resource: README.md
tags: [monorepo, devcontainer, docker-sandbox, nx, sdd, onboarding]
timestamp: 2026-08-18T00:00:00+00:00
---

# MovieCollectionManager repository — structure and working conventions

MCM is a multi-user, full-stack movie-collection app built as a polyglot pnpm/Nx monorepo: a
React Native/Expo universal client, a Rust/Axum domain service, a Python LangGraph agent gateway,
three scoped MCP servers, shared infrastructure-as-code, and a fully self-hosted Forgejo CI/CD
pipeline. It is also a working example of spec-driven, AI-assisted development — every feature
flows through a spec → plan → tasks artifact set before any implementation code is written.

For the full description, architecture diagram, feature list, and tech stack table, see the
[README](../../README.md). For individual deployable-unit pages, see the rest of the
[projects/](index.md) section.

---

## Directory layout

```text
├── frontend/mcm-app/          # Universal Expo app + BFF (src/app, src/bff-server)
├── backend/mc-service/        # Rust movie-collection service (Clean Architecture)
├── agents/movie-assistant/    # LangGraph supervisor + AG-UI gateway
├── mcp-servers/               # movie-mcp, web-api-mcp, spreadsheet-mcp
├── packages/design-system/    # Shared Tamagui component library and tokens
├── api-specs/                 # OpenAPI 3.0.3 contracts (API-first)
├── infrastructure-as-code/    # Docker Compose stacks, Keycloak, Vault, observability, Komodo
├── specs/                     # Spec Kit feature folders (spec/plan/tasks per feature)
├── docs/                      # Architecture, PRDs, runbooks, decisions (human-owned)
├── openwiki/                  # Generated OKF knowledge wiki (summaries + gotchas + links)
├── scripts/                   # CI gates and dev utilities
├── security/                  # SAST, DAST, and image-scan configuration
└── .forgejo/workflows/        # CI/CD pipelines
```

All tasks run through [Nx as the universal task runner](../invariants/nx-task-runner.md) — never
npm/yarn, and never the underlying tools directly (`pnpm nx test mcm-app`, `pnpm nx lint
mc-service`, `pnpm nx run-many --targets=test,lint`).

---

## Dev environment — two options

### Primary: Docker Sandbox microVM (feature 060)

The AI-assisted development environment runs as a **dev container inside a Docker Sandbox
microVM** (`sbx`), not on Docker Desktop and not in Docker-in-Docker. Siblings (compose stacks,
agent stack) build on the microVM's own engine and share its network namespace
(`docker-outside-of-docker`, `--network=host`). Egress is governed by a deny-by-default policy
enforced **outside the VM** — closing the gap an in-container firewall never could.

**Measured advantages over the Docker-in-Docker path:** 0.43× the wall-clock across five stages;
`docker-build` alone went from 1024 s to 293 s.

**One-step entry:**

```powershell
.\scripts\open-sandbox.ps1
```

Runs on **Windows PowerShell 5.1** — the default shell. `pwsh` (PowerShell 7) is **not** required
and is not installed by default on Windows. It checks whether the sandbox is running, starts it if
not, waits for SSH, and opens VS Code directly inside the dev container. See
**[docs/runbooks/devcontainer-sandbox.md](../../docs/runbooks/devcontainer-sandbox.md)** for the full
operating manual: lifecycle, egress triage, engine seam, disk limits, and the credential rule.

### Retained: Docker Desktop / Docker-in-Docker

The Docker Desktop path is kept for **one reason only**: the Android emulator, which needs
`/dev/kvm` that the microVM cannot provide (gate R2, resolved negative). Everything else —
web E2E, integration, the agent stack, day-to-day assistant work — belongs on the sandbox.
See [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md) and the wiki page
[Containerized dev environment (devcontainer)](../runbooks/devcontainer.md).

### Expo/Metro limitation

The dev container is a headless Linux environment. **The Android emulator and iOS Simulator
cannot run inside it.** Native mobile build, emulator, and device-debug work (including Maestro
mobile E2E) remain host-side activities. The container covers everything else: backend
development, compose-based test stacks, the web target, and Metro (watchman-backed, hot-reload).
The sole documented exception is the `devcontainer-android.sh` path for DinD; the script refuses
legibly and names both remaining routes rather than failing silently.

---

## Mandatory pre-work gates

These gates apply before any implementation or assistant session. They are in `CLAUDE.md` (the
index) in priority order because they have each cost a session or produced a hard-to-diagnose
failure.

### 1 — Credential rule: never set `ANTHROPIC_API_KEY`

AI-assisted coding runs on the **Claude MAX SUBSCRIPTION**. The Anthropic API key
(`MCM_ANTHROPIC_API_KEY`) exists only for the movie assistant (agent gateway) and OpenWiki. It is
mapped to `ANTHROPIC_API_KEY` **only at the point of use** in three separate processes
(`agent-stack.mjs`, `wiki-maintain.mjs`, containerized E2E).

**Setting `ANTHROPIC_API_KEY` in any environment — host, Docker Desktop container, or sandbox VM
— silently bills the session pay-per-token while the subscription sits idle, with no UI
indication.** This was measured at ~$15 of unintended spend in a single day on a workstation
where `oauthAccount` was present throughout (2026-08-16). If you have previously set it, remove
it and verify with `echo $env:ANTHROPIC_API_KEY` (host) / `echo $ANTHROPIC_API_KEY` (shell) =
empty, then restart VS Code.

The sandbox VM carries `ANTHROPIC_API_KEY=proxy-managed` as Docker Sandbox's own marker — this
is not a key and not a leftover. Do not confuse it with an injected secret.

### 2 — SDD is not optional

Before writing implementation code under `backend/`, `frontend/`, `agents/`, `mcp-servers/`, or
`infrastructure-as-code/`, a numbered `specs/NNN-*/` **spec → plan → tasks** set must already
exist. Proposals (`docs/proposals/**`) and knowledge/index edits are exempt. See
[Proposal → spec → plan → tasks → implementation lifecycle](../process/spec-driven-development.md).

### 3 — PR head must be a real branch, not an AGit push

A PR's head MUST be a real branch (`git push origin HEAD:<branch>`, then POST via the
`git credential fill` credential). An AGit push (`HEAD:refs/for/main`) yields a
`refs/pull/N/head` head that Forgejo runs **with NO Actions secrets** — every `${{ secrets.* }}`
is empty, and Nx reports `Misconfigured remote cache endpoint`. This cost two sessions a day on
#126. See [docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md).

---

## Gotchas

### `sbx start` does not exist — use `sbx run`

`sbx start` is not a command. It silently prints the root help, so a procedure built on it
appears to do nothing and reads as a broken sandbox. The correct command to restart a stopped
sandbox is:

```bash
sbx run --name mcm -d
```

`sbx stop --help` states this plainly: *"Stopped sandboxes retain their state and can be
restarted with `sbx run`."*

### `--name` is load-bearing on `sbx run`

`sbx run` **creates a new sandbox** if one does not exist, and the first positional argument
is an **agent**, not a sandbox name. Running `sbx run mcm` tries to run an agent called `mcm`.
Without `--name` you can end up with a second sandbox rather than your existing one.

### `sandboxd` does not auto-start at boot

After a workstation reboot, `sandboxd` must be started on demand — `sbx run --name mcm -d`
does this. Reaching for `ssh mcm.sbx` first surfaces a daemon error that reads like a broken
environment rather than a cold host. Everything else survives a real reboot (workspace clone,
images, volumes, containers with a restart policy). Verify with
`.devcontainer/verify/verify-reboot-survival.sh --verify` rather than judging by eye.

### A template carries neither Docker images NOR the egress policy

`sbx template save` snapshots the VM root filesystem, **not** the Docker data disk. A sandbox
recreated from `mcm-proven:060` comes up in ~4 seconds with zero images — followed by a full
cold rebuild. Budget accordingly: "recreate ≤ 15 min" covers instantiation plus provisioning.

Policy rules are scoped per sandbox. A sandbox created from the template gets the **default**
profile — the forge is unreachable and the first `docker pull` is refused (policy refusals are
instant, ~1 s; network faults time out — use that difference as a diagnostic clue). The recreate
sequence is: instantiate → apply egress policy (from `gen-egress-policy.mjs`) → provision.

### The workspace foot-gun: `sbx run` mounts the current directory read-write

`sbx run` mounts the **current directory** as the sandbox workspace over virtiofs, read-write,
unless an explicit path is given. Creating a sandbox while sitting in the repo therefore mounts
the repo into the VM and destroys the host-filesystem isolation this environment exists for.
Measured 2026-08-16: a file written inside a recreated sandbox appeared immediately in the
Windows working copy. Always pass an explicit scratch directory.

### The socat relay silently truncates `docker exec` output (D-19)

The `docker-outside-of-docker` feature fronts the VM's socket with a socat relay. socat's
half-close timeout defaults to 0.5 s; `docker exec` half-closes stdin immediately, so socat
tears the relay down mid-response. Fast commands return exit 0 with no output — the seam looks
healthy under any quick probe while real work fails. The fix (already applied in
`.devcontainer/sandbox/devcontainer.json`):

```bash
DOCKER_HOST=unix:///var/run/docker-host.sock
```

If you invoke Docker from a context that does not inherit `containerEnv` (a raw `docker exec`
from the VM into the dev container, a script run before the env is set), pass it explicitly.

### egress triage order is inverted vs the Docker Desktop path

On Docker Desktop the dev container programs its own in-container `ipset`/`iptables` default-deny.
In the sandbox that firewall is **not used** — the enforcement is at the host-side policy outside
the VM, and the in-VM firewall would be VM-wide under `--network=host`. When something is blocked:
**host policy first, in-VM second** — the opposite of the Docker Desktop path. `nc -z <ip> 443`
reports OPEN against a blocked destination because the proxy accepts the TCP connection and refuses
at TLS; always probe with a real request.

### Run git inside the container, not the VM shell — and the UID fix (§7d)

The VM user (`agent`, uid 1000) and the container user (`coder`) were different UIDs. Anything git
wrote from the VM shell was unwritable by the container user — the failure appeared deep in
`.git/objects` and read like corruption rather than permissions.

**Rule: git runs in the container.** For automation from outside, go through
`docker exec -u coder …`, never `ssh <sandbox> 'git …'`.

**✅ FIXED 2026-08-17:** `toolchain.Dockerfile` now creates `coder` at **1000:1000** (moving the
base image's `node` to 1100 first), so both sides share the same uid. The rule above still stands
for automation scripts — `ssh <sandbox> 'git …'` re-poisons the tree even after the fix. See
[docs/runbooks/devcontainer-sandbox.md §7d](../../docs/runbooks/devcontainer-sandbox.md) for the
re-pin procedure and the two rejected alternatives.

---

## Related concepts

- [CI/CD pipeline (Forgejo Actions)](ci-cd-pipeline.md) — the three workflows that gate every PR
- [Nx as the universal task runner](../invariants/nx-task-runner.md) — why all commands go through Nx
- [RTK (Rust Token Killer) token compression](../invariants/rtk-token-compression.md) — mandatory before any assistant session
- [Testing tiers and what gates a merge](../invariants/testing-tiers.md) — which tiers block a merge
- [Proposal → spec → plan → tasks → implementation lifecycle](../process/spec-driven-development.md) — SDD mechanics
- [Containerized dev environment (devcontainer)](../runbooks/devcontainer.md) — wiki summary of the devcontainer runbooks
