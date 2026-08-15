# Proposal: Move AI-assisted engineering to a Dev Container hosted on Docker Sandbox — retiring DinD

> **Status:** Proposal (pre-spec, SDD input), revision 2. Intended home: `docs/proposals/`.
> **Revision note:** r1 proposed carrying the existing Docker-in-Docker (DinD) layer into the sandbox unchanged. That missed the point of the migration. **This revision eliminates DinD entirely:** the Docker Sandbox's own private engine becomes *the* engine, and the dev container consumes it as a plain, unprivileged client over the engine's socket ("docker-outside-of-docker"). DinD, and the `privileged` flag it forced, do not survive this proposal.
> **Supersedes nothing yet** — the current Docker Desktop + privileged-DinD dev container (features 037/038) remains the working environment until this proposal graduates through spec → plan → tasks.
> **Sources:** Docker Sandboxes (`sbx`) facts are from Docker's official docs and hands-on third-party writeups as of 2026-08; `sbx` is young and moving fast (SSH v0.37, 2026-07-24; kit spec v2 in v0.38, 2026-08-06). Load-bearing unproven claims are tagged **[verify in pilot]**.

---

## 1. Problem statement

The current containerized dev environment (features 037/038) gives the AI coding assistant a disposable Linux container on Docker Desktop (WSL2 backend). Because the assistant must create/destroy containers (compose stacks, throwaway test containers), the container runs the `docker-in-docker` feature — which forces **`privileged`** and caps the posture at (per `docs/runbooks/devcontainer.md`, FR-011):

- **Host-filesystem / credential isolation: STRONG.**
- **Container-engine isolation: MODERATE** — a privileged-container escape can reach the shared Docker Desktop WSL2 VM and therefore the host engine. ECI cannot help (incompatible with DinD).

DinD is also the source of a standing operational tax: the stale-container `meta.db` flock deadlock after rebuilds, the nested `host.docker.internal` reroute (which forced Ollama inside the container), the Compose-version parity pin, the credsStore/`DOCKER_CONFIG` workaround, and the documented **unfirewalled nested-container egress residual** (the FORWARD chain is deliberately left to dockerd).

**Goal:** rehost the dev container on **Docker Sandbox** — a hardware-isolated microVM with its **own private Docker engine** — and have the dev container (and the AI assistant in it) drive *that* engine directly over its socket. No nested engine, no `privileged`, no DinD. The blast radius for everything the assistant does — file writes, package installs, and every container it creates — is the disposable microVM, never the host.

## 2. What Docker Sandbox is (research summary)

Docker Sandboxes (`sbx` CLI, `winget install Docker.sbx`; Docker Desktop **not** required) run each sandbox as a **lightweight microVM with its own dedicated Linux kernel, filesystem, network stack, and its own private Docker daemon**. Properties relevant here:

| Property | Detail |
|---|---|
| Isolation | Hypervisor-level (microVM), not namespaces. On Windows 11 it uses the **Hypervisor Platform** feature (already enabled where WSL2 is in use); coexists with Docker Desktop/WSL2. Reboot required after first enabling Hypervisor Platform. |
| Private Docker engine | Each sandbox ships a full Docker engine — `docker build` / `run` / `compose` work natively; containers **never appear in the host's `docker ps`**. This engine is precisely what replaces DinD. |
| Workspace | Direct mode (host tree mounted read-write), **clone mode** (`--clone`: isolated git clone inside the sandbox; host source read-only at `/run/sandbox/source`), or host-worktree mode. Fixed at creation. A sandbox can also be created with no meaningful host mount and populated by `git clone` inside — the strongest posture. |
| Network governance | Per-sandbox default-deny allowlist policies (Open / Balanced / Locked Down) via `sbx policy` (`allow network <host>`, CIDR rules, `sbx policy log` audit). Enforced **host-side by a proxy, outside the VM** — untamperable from inside, and it governs **all** VM egress, including every container the engine runs. The proxy also blocks access to the host's localhost. |
| Secrets | `sbx secret` keeps credentials in the host keychain; the egress proxy **injects auth headers in flight**, so keys like `ANTHROPIC_API_KEY` need never exist inside the VM. Since v0.37.1, SSH sessions do **not** forward credential env vars unless explicitly configured (`ssh.acceptEnv`). |
| SSH / editors | `sbx setup ssh` writes a managed `Host *.sbx` block; `ssh <name>.sbx` lands as `agent@<name>`. Official VS Code integration: **Remote-SSH → `<name>.sbx`**; first connect installs VS Code Server in the sandbox. (Experimental as of v0.37.) |
| Ports | `sbx run -p HOST:SANDBOX` or `sbx ports <name> --publish …`; services must bind `0.0.0.0`; mappings appear as `127.0.0.1:8080->3000/tcp`. |
| Resources | `--cpus` / `--memory`; defaults N-1 host CPUs, ~50% host RAM (capped 32 GB). |
| Persistence / reuse | Packages, images, config, history persist across stop/start. `sbx template save` snapshots a sandbox (`sbx run -t TAG …`); **kits** (YAML, spec v2) declaratively describe setup, permissions, credentials. |
| Platforms | Windows 11 x86_64, macOS Apple silicon, Ubuntu 24.04+ (Linux builds intermittent; no ARM64 Linux). Free for commercial use; org governance is paid. |

**Known rough edges:** measurable runtime overhead in the worst case; SSH experimental with a moving command surface; host SSH-agent signing doesn't reach inside; first sandbox creation downloads a template image.

## 3. Proposed architecture — one engine, no DinD

### 3.1 Topology

```
BEFORE (037/038)                            AFTER (this proposal)
Windows 11 host                             Windows 11 host
└─ Docker Desktop (WSL2 VM, shared)         ├─ Docker Desktop (unchanged, for non-agent use)
   └─ dev container  ⚠ privileged           └─ Docker Sandbox microVM   ← isolation boundary
      ├─ Claude Code                            ├─ sbx network policy (host-side, default-deny,
      ├─ init-firewall.sh                       │    governs the WHOLE VM incl. all containers)
      └─ DinD engine (nested)                   └─ sandbox's private Docker engine (THE engine)
         └─ app stacks (auth/mcm/…)                 ├─ dev container — UNPRIVILEGED
                                                    │    ├─ Claude Code
                                                    │    ├─ docker CLI → engine socket (no daemon inside)
                                                    │    └─ shares the sandbox network namespace
                                                    ├─ app stacks (auth/mcm/…)   ← siblings
                                                    └─ dev-ollama, throwaway test containers ← siblings
```

Three structural changes, and everything else follows from them:

1. **The nested engine is deleted.** The dev container swaps the `docker-in-docker` feature for **`docker-outside-of-docker`** (docker CLI + compose in the container, engine socket mounted). Every `docker …` / `docker compose …` / `pnpm nx up-*` the assistant runs executes on the **sandbox's** engine. App stacks, dev-ollama, and ad-hoc containers become **siblings** of the dev container rather than children inside it.
2. **`privileged` is gone.** Nothing in the dev container needs it anymore — the engine runs outside the container, managed by the sandbox. The container keeps `remoteUser: coder` and (if the in-container firewall is retained, §3.5) `NET_ADMIN`/`NET_RAW`; otherwise even those can go.
3. **The dev container joins the sandbox's network namespace** (`--network=host`, where "host" = the sandbox VM, *not* Windows). This single choice is what lets the existing workflows carry over unchanged: sibling stacks publish on the VM's loopback, so `localhost:8082 / 8099 / 3001 / 27017 / 6379` work from the dev-container shell **exactly as they do today** (today the dev container is the DinD host; after the move the sandbox VM is the Docker host and the dev container sits in its netns). The E2E recipes (`E2E_BFF_TARGET=dev-container` → `http://localhost:8082`), the integration-tier URL exports, and the Playwright `--network host` container recipe keep working verbatim.

**Isolation ledger, stated honestly (FR-011 style).** Host-filesystem/credential isolation: STRONG (hypervisor boundary; nothing of `E:\`, the user profile, or host credentials mounted; host localhost blocked by the sbx proxy). Engine isolation from the *host*: STRONG (the engine the agent controls lives inside the microVM; the Windows host engine is unreachable). Isolation *within* the VM: deliberately weak and accepted — the agent holds the sandbox engine's socket, so it fully controls sibling containers, their volumes, and (via the engine) the VM's container-visible filesystem. That is the design: the VM is the disposable blast radius, and `sbx rm` erases all of it. This is a strictly better ledger than today's, where the weak seam (privileged DinD) faced the *host*.

### 3.2 Why this shape and not the alternatives

- **DinD-inside-the-sandbox (r1 of this proposal):** works, changes nothing in-repo, but preserves the entire DinD tax (flock deadlocks, `privileged`, nested `host.docker.internal`, Compose parity pin, double image caches) one level down — and misses the stated intent. Rejected.
- **Sandbox as the dev environment (no dev container at all):** provision the toolchain via template/kit, run Claude Code directly in the VM. Simplest topology, but it abandons the committed, digest-pinned `.devcontainer/` asset (portable under VS Code ext + `@devcontainers/cli`, FR-008), the named-volume cache scheme, the lifecycle hooks, and the verify harness — i.e., it violates "the Dev Container retains existing setup and tools," and it forks environment truth into a kit that will drift from `toolchain.Dockerfile`. Kept visible as a possible *future* simplification (§7), not this migration.
- **Chosen: dev container as an unprivileged client of the sandbox engine.** The `.devcontainer/` asset, toolchain image, caches, personal dotfiles layer, and runbook knowledge survive; the engine layer the assistant drives becomes the sandbox's; DinD and `privileged` are deleted.

### 3.3 The committed-config delta (small, and it is a *simplification*)

This migration does require touching `.devcontainer/devcontainer.json` — unlike r1 — but every edit removes complexity rather than adding it:

| Change | Detail |
|---|---|
| Feature swap | `ghcr.io/devcontainers/features/docker-in-docker:2` → **`ghcr.io/devcontainers/features/docker-outside-of-docker:1`** (installs docker CLI + compose plugin, mounts `/var/run/docker.sock` from the sandbox). The comment block explaining why DinD forces `privileged` (FR-004/FR-011) is replaced by a note that the engine is the sandbox's. |
| Network mode | Add `"runArgs": ["--network=host"]` — see §3.1(3). `forwardPorts` stays for the VS Code-attached case; host-side exposure is `sbx ports` (§3.6). |
| Workspace path | The repo is cloned **on the sandbox VM filesystem at `/workspaces/mcm`** and the dev container bind-mounts it at the identical path. Identical-path mounting is the standard docker-outside-of-docker requirement: sibling containers bind-mount workspace paths (the Playwright recipe mounts `/workspaces/mcm`), and with one engine those `-v` paths resolve against the **VM** filesystem — so container path and VM path must match. The 037 rule "omit `workspaceMount`/`workspaceFolder`" still holds; `devcontainer up --workspace-folder /workspaces/mcm` from the VM produces the matching default mount. |
| DinD-only plumbing retired | The Compose v5 parity pin (exists to out-rank the DinD feature's apt plugin), the `DOCKER_CONFIG=/home/coder/.docker-dind` credsStore workaround, and the entire DinD-lock runbook section become dead — removed or archived. The sandbox engine's Compose version is what it is; parity is now with *one* engine, not three. |
| Volumes | The named cache volumes (`mcm-commandhistory`, `mcm-cargo-registry`, `mcm-cargo-git`, `mcm-uv-cache`, `mcm-pnpm-store`, `mcm-claude`) move unchanged — they are just volumes on the sandbox engine now. |
| `${localEnv}` passthroughs | Mechanism unchanged; the "local" env is now the sandbox session where `devcontainer up` runs (§3.5). The VS Code-extension quirks (`${localEnv:VAR:default}` non-application, Wayland socket, credsStore injection, "fully quit VS Code after `setx`") all disappear from the container-build path — the headless CLI builds it. |

Because the current `devcontainer.json` must keep working on Docker Desktop until cutover, the spec should deliver this as a **variant config** (e.g. `.devcontainer/sandbox/devcontainer.json`, selectable via `devcontainer up --config`) during the pilot, collapsing to a single config at adoption.

### 3.4 Requirement-by-requirement mapping

| Requirement | How it is met |
|---|---|
| **VS Code on the host can SSH into the dev container and run Claude Code** | Two-hop, both standard: (1) `sbx setup ssh` once → VS Code **Remote-SSH** to `mcm.sbx` (official integration). (2) In that remote window, the **Dev Containers** extension attaches to / reopens in the dev container on the sandbox's engine — the standard "Dev Containers over Remote-SSH" flow against a remote Docker host. Claude Code runs in the in-container terminal as today. **[verify in pilot: Dev Containers ext on top of the sbx Remote-SSH session]** Fallback: `sshd` in the dev container + `sbx ports mcm --publish 2222:2222` → Remote-SSH directly into the dev container, one hop. |
| **Claude Code can create/destroy other containers and interrogate them** | Directly, on the sandbox's engine, via the mounted socket: `docker run/rm/ps/logs/exec/inspect`, `docker compose`, `pnpm nx up-*` all work from the dev-container shell — and now `docker ps` shows the *actual* full container population of the environment (stacks + dev container itself), which is more interrogable than today's split-brain (host engine invisible, nested engine partial). Everything it creates/destroys lives and dies inside the microVM. |
| **Internet/forge/TMDB access, but no host access** | **Primary enforcement moves to sbx network policy**: host-side, agent-untamperable, default-deny with an explicit allowlist (mirroring `init-firewall.sh`'s domain list: Anthropic, GitHub, npm, Docker Hub+CDNs, ghcr, quay+CDNs, crates, PyPI, Expo, TMDB, `<forge-host>`), plus `sbx policy log` audit. Crucially this governs **all** VM egress — including sibling app-stack containers — which **closes the documented 037 residual** (nested-container egress was deliberately unfirewalled under DinD). Host access: hypervisor boundary + the proxy's host-localhost block; no host filesystem/credentials mounted. In-container `init-firewall.sh` is retained or retired per §3.5. Tailnet forge reachability through the proxy is a **hard pilot gate** (§6 R1). |
| **Dev container retains existing setup and tools** | Same base image chain (`MCM_DEVCONTAINER_IMAGE` → thin `FROM ${BASE_IMAGE}` → `toolchain.Dockerfile`: Node 24, Rust, uv/Python 3.13, gh, Android SDK, OpenWiki), same `remoteUser: coder`, same named-volume caches and personal dotfiles layer, same lifecycle hooks minus DinD-specific plumbing, same verify-harness intent (assertions updated to the new engine seam, §5 P3). The only capability delta is where the engine lives — which is the point. |

### 3.5 Egress enforcement: two layers become "sbx primary, iptables optional"

Today `init-firewall.sh` is the *only* egress control, and it explicitly cannot cover nested containers (FORWARD left to dockerd). After the move:

- **sbx policy is the primary control** — default-deny for the entire VM including every sibling container, enforced outside the agent's reach, with an audit trail. Locked Down profile + the explicit domain allowlist generated from the same source list the script uses today (keep one canonical list in-repo; emit both formats).
- **`init-firewall.sh` becomes optional defense-in-depth.** Under `--network=host` it programs the *VM's* OUTPUT chain (needs `NET_ADMIN`/`NET_RAW` on the dev container), which now also covers dockerd's image pulls and — unlike today — sibling-container egress traverses the VM's FORWARD chain where a second pass *could* be scoped later. The pilot should run **with** it first (smallest behavioral delta, and its allowlist semantics are battle-tested in this repo), and a follow-up decision (§7) can retire it once sbx `policy log` has earned trust. If retired, the capAdd entries go too and the dev container becomes fully capability-default.
- Triage order changes and must be documented in the delta runbook: a blocked fetch is now checked against **`sbx policy log` first** (it has the audit trail), then the in-VM ipset staleness reflex. The "CDN blob timeout → re-apply the firewall" gotcha gains a second, more likely suspect.

**Secrets.** Provisioning order of preference: (1) **`sbx secret` + proxy header injection** where applicable — with one engine, *all* traffic (dev-container shell, agent gateway, any sibling) egresses through the same VM path, so injection plausibly covers the nested agent-gateway's Anthropic calls too **[verify in pilot — R7]**; the key then never exists inside the VM, an isolation improvement over today. (2) A **kit** declaring setup + credentials. (3) A gitignored env file sourced in the sandbox shell before `devcontainer up` (today's posture, one boundary further in). The v0.37.1 SSH `acceptEnv` default means nothing may rely on env vars riding the SSH session. Topology-scrub is unchanged: forge host literals live only in sandbox-local config/kit, never in git.

### 3.6 Ports, devices, workspace source-of-truth

- **Ports:** stacks publish on the VM (`0.0.0.0`/loopback as today, reachable from the dev-container shell via localhost); expose to the Windows host with `sbx ports mcm --publish 8081:8081` (+8082, 8099 as needed) — or rely on VS Code Remote-SSH port forwarding for browser-on-host use. For a **physical phone on the LAN** (SC-007): `sbx ports` binds loopback per current docs, so LAN access needs a host-side `netsh interface portproxy` or the documented Expo-tunnel fallback. **[verify in pilot: non-loopback binding]** |
- **Workspace:** clone on the VM at `/workspaces/mcm` (from the forge, inside the sandbox). `E:\` is never mounted — stronger than today's bind-mount path and equivalent in spirit to the named-volume daily driver. **`git push` remains the durable backup; `sbx rm` discards unpushed work** — same discipline, new wording. Direct-mode mounting of a host checkout stays available for occasional use but is not the default (and never the primary `E:\…\MovieCollectionManager` checkout — the node_modules caveat applies).
- **dev-ollama:** comes up as a sibling on the same engine; publishes `11434` on the VM; with the gateway's existing `host.docker.internal: host-gateway` extra_hosts mapping it resolves to the VM gateway and reaches dev-ollama as today. The `postStartCommand` chain (firewall → ollama → android prepare) survives with the firewall step per §3.5. **[verify in pilot: host-gateway resolution on the sandbox engine]**

## 4. What gets better, what stays, what gets riskier

**Better** — `privileged` deleted; DinD flock-deadlock class, credsStore workaround, and Compose-parity pin deleted; engine-isolation seam faces a disposable VM, not the host; **nested/sibling-container egress is governed for the first time** (closes the 037 documented residual); host-side tamper-proof network policy with an audit log; possibility of keys never materializing inside the VM; one engine and one image cache instead of two (disk and pull-time win); `docker ps` shows the whole truth; `sbx rm` is a genuinely total teardown; ECI incompatibility moot; VS Code host-side build quirks moot.

**Same** — the toolchain image and cache volumes; the in-container workflow (Claude Code, Nx targets, compose bring-up, integration/E2E recipes and their env exports, localhost service map); default-deny egress semantics; git-push-as-backup discipline; the verify-harness *intent*.

**Riskier / open** — §6. Headline: tailnet forge reachability through the sbx proxy (R1), `/dev/kvm` in the microVM for the Android emulator (R2), performance of VM + sibling stacks (R3, one nesting level *less* than r1), identical-path workspace assumption in sibling bind-mount recipes (R10, new), sbx SSH experimental status (R5).

## 5. Migration plan (increment 1)

Every phase has a rollback; the Docker Desktop environment keeps working until P6.

- **P0 — Host prep.** `winget install Docker.sbx`; confirm Hypervisor Platform (reboot if newly enabled); `sbx login`; default policy Balanced for bring-up (tighten to Locked Down + allowlist before agent use); `sbx diagnose`.
- **P1 — Sandbox bring-up.** `sbx create --name mcm --cpus <N> --memory <G>` (≥8 CPU / ≥16 GB; establish the disk envelope — R4). `sbx setup ssh`; prove `ssh mcm.sbx` and VS Code Remote-SSH. Confirm the private engine: `docker info` inside the VM.
- **P2 — Egress + forge gate.** Apply the allowlist via `sbx policy allow network …` (generated from the canonical domain list); prove `git clone` from the forge and `docker pull <forge>/…/mcm-devcontainer@sha256:<digest>` **on the sandbox engine**. **Gate R1 resolves here.** Install Node ≥18 + `@devcontainers/cli`; wire secrets/env (§3.5).
- **P3 — Dev container up, sandbox variant.** Clone to `/workspaces/mcm` on the VM; `devcontainer up --workspace-folder /workspaces/mcm --config .devcontainer/sandbox/devcontainer.json` (the docker-outside-of-docker variant, §3.3). Port the verify harness: host-isolation (unchanged in spirit), **engine seam** (replaces engine-isolation: asserts no daemon inside the container, socket present, and — host side — the Windows engine never sees the dev container or any stack container), toolchain-present, caches-persist, firewall-allowlist (per §3.5 decision), committed-clean. Probe `/dev/kvm` (R2 resolves).
- **P4 — Editor chain.** Remote-SSH window → Dev Containers ext → attach/reopen; confirm `echo $MCM_DEVCONTAINER` → 1, `whoami` → coder, `claude --version`, extensions load. Exercise the sshd-in-container fallback once so it is documented, not theoretical. (R6 resolves.)
- **P5 — Workload proof.** The runbook's validated sequence, now against sibling stacks: `gen-dev-secrets` → `up-auth` → `docker-build mcm-app` → `up-mcm` → integration tier with the three URL exports → Playwright-in-official-image web E2E (identical-path mount — R10 resolves) → one agent E2E spec on Anthropic with the key only in `sbx secret` (R7 resolves) → dev-ollama sibling + gateway reachability (host-gateway probe). Measure wall-clock vs. the Docker Desktop baseline (budget ≤1.5×, else R3 escalates).
- **P6 — Adopt.** `sbx template save` for fast recreate (+ kit for team reproducibility); write the delta runbook (`devcontainer-sandbox.md`): two-layer egress triage, `sbx` lifecycle, port publishing, teardown semantics; update the 037 runbook posture section (engine seam now faces the VM; DinD sections archived); collapse to a single `devcontainer.json` (the docker-outside-of-docker one) and retire the Docker Desktop path for *agent* sessions after two green weeks. Docker Desktop remains for non-agent local use and as the mobile-emulator fallback if R2 failed.

Rollback at any phase: `sbx stop`/`sbx rm mcm`; nothing on the Docker Desktop path was touched (the sandbox config is additive until P6).

## 6. Risks and open questions (pilot gates)

| # | Risk / question | Impact | Mitigation / decision rule |
|---|---|---|---|
| R1 | **Tailnet forge reachability.** Sandbox egress runs through sbx's host-side proxy; documented behavior warns it "does not necessarily follow the same path as … VPN split-tunnel rules." A Tailscale-only forge may be invisible. | Blocks image pull, git push/pull, CI diagnostics — hard blocker. | Test in P2. If unreachable: `DOCKER_SANDBOXES_PROXY=system` routing (v0.37+), a Tailscale subnet-router/hostname exposure, or declare sbx not-yet-viable and stop at P2. |
| R2 | **`/dev/kvm` inside the microVM** (Android emulator). Nested virtualization in an sbx VM on Windows Hypervisor Platform is undocumented and likely absent. | Loses local mobile E2E. | Probe in P3. If absent: mobile E2E in CI (already the recommended path for agent flows) or on the retained Docker Desktop environment on demand; document as a scoped exception. No software-rendered emulation. |
| R3 | **Performance: microVM + sibling stacks.** Third-party reports call sandbox overhead significant in the worst case; memory defaults to 50% of host. Note this design has **one less nesting level** than both today (Desktop VM → container → DinD) and r1. | Slow E2E, OOM-prone Metro. | Size explicitly in P1; measure in P5 against ≤1.5×. |
| R4 | **Disk capacity in the sandbox** (toolchain image + stack images + dev-ollama models + caches; single engine halves today's duplication but the envelope is undocumented). | Mid-session ENOSPC. | Establish in P1; prune policy in the delta runbook; escalate if hard-capped too low. |
| R5 | **`sbx ssh` is experimental** (v0.37; surface has moved; VS Code reconnect quirks documented; managed SSH-config blocks can corrupt). | Editor-access instability. | Pin the sbx version once green; keep the sshd fallback wired; release-notes review joins the update ritual. |
| R6 | **Dev Containers extension over the sbx Remote-SSH session** not explicitly documented by Docker. | Two-hop editor chain might need the fallback permanently. | P4 proves it; the fallback is fully functional. |
| R7 | **Proxy header-injection scope** for traffic from sibling containers (agent gateway → Anthropic). | Decides whether keys can be fully host-resident. | Test in P5 with the key only in `sbx secret`. Either outcome acceptable; only the posture note differs. |
| R8 | **Two-layer egress misdiagnosis** (sbx policy + optional in-VM iptables): failures present as the union of two allowlists. | Lost triage time. | One canonical domain list emits both configs; triage order (policy log first) in the delta runbook; §7 decision point to retire the iptables layer. |
| R9 | **LAN device access** (physical phone → Metro/BFF) through loopback-only `sbx ports`. | Mobile-on-device workflows. | Host `netsh` portproxy or the documented Expo tunnel; confirm need in P5. |
| R10 | **Identical-path bind-mount assumption** (new, replaces DinD-era path semantics): sibling `-v` paths resolve against the VM filesystem, so workspace path in-container must equal the VM path (`/workspaces/mcm`), and any recipe that mounts `$PWD` must run from a path that exists on the VM. Named-volume workspaces (today's clone-in-volume) are **not** directly usable by sibling mounts. | Playwright/tooling recipes break subtly. | The §3.3 path convention; a verify-script assertion (`[ "$(pwd -P)" = /workspaces/mcm ]` and the path exists on the VM per `docker run --rm -v /workspaces/mcm:/probe alpine ls /probe`); audit the two `$PWD`-mount recipes in the runbook during P5. |
| R11 | **Socket = full engine control** (the agent can stop/rm any sibling, including infrastructure it depends on, or its own container). | Self-inflicted session breakage (not a host risk). | Accepted within the VM blast radius — same class as today's DinD control. Document the one new foot-gun: `docker rm -f` on the dev container itself kills the session; recovery is `devcontainer up` from the VM (or `sbx` template recreate). |

## 7. Explicit non-goals now / candidates later

- **Sandbox-as-dev-environment** (no dev container; kit/template provisions the toolchain directly in the VM) — revisit once kits (spec v2) mature, if the dev-container layer proves redundant in practice.
- **Retiring `init-firewall.sh`** in favor of sbx policy alone — a §3.5/P6 follow-up decision after R7/R8 experience, not part of this migration.
- **A second egress pass scoped to sibling containers** (FORWARD-chain rules in the VM) — only if sbx policy granularity proves insufficient (it is currently per-sandbox, not per-container).
- **Homelab Linux host migration** (Sysbox-class rootless engines) — unchanged long-term alternative; this proposal is the Windows-workstation answer.

## 8. Success criteria (for the eventual spec)

1. **No DinD anywhere:** no Docker daemon runs inside the dev container (`pgrep dockerd` empty in-container); the dev container runs unprivileged (`docker inspect` on the sandbox engine shows `"Privileged": false`); all container operations execute on the sandbox's engine.
2. Ported verify harness green, including the new engine-seam assertions and: the **Windows host engine never sees** the dev container or any stack container.
3. VS Code on the host reaches an in-dev-container terminal via SSH and runs Claude Code (primary chain or documented fallback).
4. The agent can create, interrogate (`ps/logs/exec/inspect`), and destroy the full stack set from the dev-container shell; nothing it does is visible to or reachable from the host engine.
5. Egress: allowlisted domains reachable; a non-allowlisted probe (`example.com`) blocked **at the sbx layer** with an audit-log entry — including when issued **from a sibling container** (the closed residual, proven); host localhost unreachable from inside.
6. Integration + web E2E + one agent E2E spec pass with wall-clock ≤1.5× the Docker Desktop baseline, using the unmodified localhost service map.
7. Recreate-from-nothing (template/kit + `devcontainer up`) ≤ 15 min warm, zero manual steps beyond documented env provisioning.
8. Runbooks, CLAUDE.md, OpenWiki, and README.md all updated with new instructions/processes/gotchas/key learnings so any human or AI coding assistant can pick up and use efficiently.
9. No secret literal, forge hostname, or tailnet address enters git (existing gates pass unchanged).

---

### Appendix A — Current-state facts this proposal relies on

- `devcontainer.json`: DinD feature (moby → `privileged`), `remoteUser: coder`, NET_ADMIN/NET_RAW, named volumes (`mcm-commandhistory`, `mcm-cargo-registry`, `mcm-cargo-git`, `mcm-uv-cache`, `mcm-pnpm-store`, `mcm-claude`), six `${localEnv}` pass-throughs, forwardPorts 8081/8082/8099, `postStartCommand` = firewall → ollama → android prepare.
- Two-Dockerfile seam: thin `FROM ${BASE_IMAGE}` ← `MCM_DEVCONTAINER_IMAGE`; heavy `toolchain.Dockerfile` (Node 24, Rust, uv/Python 3.13, gh, Android SDK+emulator, OpenWiki, Compose v5 pin — the pin exists only for DinD parity and retires with it).
- `init-firewall.sh`: default-deny OUTPUT, domain-resolved ipset allowlist (Anthropic, GitHub, npm, Docker Hub+CDNs, ghcr, quay+Akamai, crates, PyPI, Expo, TMDB, `FORGE_REGISTRY_HOST`), FORWARD left to dockerd (**the residual this proposal closes**), loopback + RFC1918 bridge allows, re-runnable.
- Verify harness: host-isolation, engine-isolation (two-sided), reproducible-recreate, portable-runner, toolchain-present, caches-persist, firewall-allowlist, personal-layer, committed-clean.
- Runbook-validated workflows that must survive: compose stacks bring-up, integration tier (three URL exports), Playwright-in-official-image E2E (`--network host`, `--user $(id -u)`, `$PWD` mount — R10), agent E2E on Anthropic, dev-ollama, Android emulator via KVM (R2).

### Appendix B — Key external references

- Docker Sandboxes overview / get started / usage / workflows / VS Code integration / release notes — docs.docker.com/ai/sandboxes/ (+ /integrations/vscode/, /release-notes/)
- `sbx` CLI reference (run, create, exec, cp, ports, policy, secret, template, setup ssh) — docs.docker.com/reference/cli/sbx/
- Hands-on: A. Lock, “Running AI agents safely in a microVM using docker sandbox” (andrewlock.net); A. Raina, “SSH straight into your agent sandboxes” and “10 things you must know about Docker Sandboxes” (ajeetraina.com); SDNTechForum, “Docker Sandboxes (sbx) on Windows 11” (medium.com).
- Dev Containers: `docker-outside-of-docker` feature (github.com/devcontainers/features), `@devcontainers/cli` (containers.dev).
