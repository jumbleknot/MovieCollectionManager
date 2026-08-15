# Phase 0 Research: Dev container on Docker Sandbox

**Feature**: 060-devcontainer-docker-sandbox | **Date**: 2026-08-15

Source material: `docs/proposals/proposal-devcontainer-on-docker-sandbox.md` (r2), the Phase 0 host-prep record, and direct inspection of `.devcontainer/` on this branch. Decisions marked **[gate]** cannot be settled by research — they resolve at a named execution phase, and each carries a decision rule so both outcomes are actionable.

---

## D-01 — Engine topology: dev container as an unprivileged client of the sandbox engine

**Decision**: Swap `ghcr.io/devcontainers/features/docker-in-docker:2` for `ghcr.io/devcontainers/features/docker-outside-of-docker:1`. The dev container gets the docker CLI + compose plugin and the sandbox engine's socket; it runs no daemon. Application stacks, `dev-ollama` and throwaway test containers become **siblings**.

**Rationale**: The sandbox already ships a full private engine. Running a second engine inside a container inside that VM preserves every DinD cost — the `privileged` flag, the stale-lock deadlock, the rerouted `host.docker.internal`, the Compose parity pin, the credsStore workaround, double image caches — while adding a nesting level. Deleting the nested engine is the entire point of the migration; relocating it is not.

**Alternatives considered**:

- *DinD inside the sandbox* (proposal r1): zero in-repo delta, but keeps the full DinD tax one level down and leaves `privileged` in place. Rejected as missing the intent.
- *No dev container at all* — provision the toolchain directly in the VM via a kit: simplest topology, but abandons the committed, digest-pinned `.devcontainer/` asset, the named-volume cache scheme, the lifecycle hooks and the verify harness, and forks environment truth into a kit that will drift from `toolchain.Dockerfile`. Kept as a possible future simplification; recorded in spec Out of Scope.

**Consequence**: `privileged` is deleted. `capAdd: ["NET_ADMIN","NET_RAW"]` survives only as long as `init-firewall.sh` does (D-05).

---

## D-02 — Network mode: the dev container joins the sandbox VM's network namespace

**Decision**: `"runArgs": ["--network=host"]` in the sandbox variant, where "host" means the **sandbox VM**, not Windows.

**Rationale**: This is the single choice that makes the migration cheap. Today the dev container *is* the Docker host, so sibling ports appear on its loopback. After the move the VM is the Docker host — sharing its netns reproduces exactly the same view. Everything downstream keeps working verbatim: `E2E_BFF_TARGET=dev-container` → `http://localhost:8082`, the integration tier's three URL exports, `localhost:8099` for Keycloak, `localhost:3001` for mc-service, the Mongo/Redis ports, and the Playwright `--network host` recipe. Without it, every one of those documented addresses would need rewriting and the runbook's validated sequences would all become suspect.

**Consequence**: `init-firewall.sh` under this mode programs the **VM's** OUTPUT chain, which now also covers dockerd's own image pulls — a scope increase, noted in D-05. `forwardPorts` is retained for the VS Code-attached case; host-side exposure is `sbx ports` (D-11).

---

## D-03 — Workspace on the VM filesystem at an identical path

**Decision**: Clone the repository **on the VM** at `/workspaces/mcm` and bring the dev container up with `devcontainer up --workspace-folder /workspaces/mcm`, producing a default bind mount at the identical in-container path. `E:\` is never mounted.

**Rationale**: With one engine, a sibling's `-v /workspaces/mcm:/x` resolves against the **VM** filesystem, not the dev container's. The repo has at least two recipes that mount the working tree (the Playwright-in-official-image E2E recipe, and `$PWD`-mounting tooling), so container path and VM path **must** be equal or those mounts silently bind the wrong content — the worst failure mode available here, because it looks like it worked.

The 037 rule "omit `workspaceMount`/`workspaceFolder`" still holds and is what makes this work: hardcoding either breaks the clone-in-volume path and the differing-basename case. `devcontainer up --workspace-folder` supplies the correct default mount without hardcoding anything.

**Alternatives considered**:

- *Named-volume workspace* (today's daily driver, via "Clone Repository in Named Container Volume"): **not usable**, because a named volume is not a VM path a sibling can bind-mount. This is a real capability loss versus today's fastest path, accepted because the VM filesystem is already Linux-native (the reason the named volume was fast on Windows in the first place).
- *Direct-mode host mount of `E:\…\MovieCollectionManager`*: available for occasional use, never the default — it re-introduces the host-filesystem seam the migration removes, and the `node_modules` caveat applies.

**Consequence**: a new `verify-workspace-path.sh` asserts `pwd -P` equals `/workspaces/mcm` **and** that the path exists on the VM, proven by a sibling probe (`docker run --rm -v /workspaces/mcm:/probe alpine ls /probe`). Convention alone is not enough for something that fails silently.

---

## D-04 — One canonical egress destination list, two emitted forms

**Decision**: Extract the destination list currently inlined in `.devcontainer/init-firewall.sh` into `.devcontainer/egress-allowlist.json`, and add `scripts/gen-egress-policy.mjs` to emit (a) the `sbx policy allow network …` command set and (b) the domain array `init-firewall.sh` consumes. Neither consumer keeps its own copy.

**Rationale**: Two enforcement layers with two hand-maintained lists is the R8 misdiagnosis risk in its purest form — a blocked fetch becomes the union of two allowlists and diagnosis becomes guesswork. The current list is not trivial: it carries `api.anthropic.com`, GitHub's five hosts, npm, Docker Hub + its CloudFront/Cloudflare blob CDNs, ghcr, quay + four Akamai CDN hosts, crates.io's three hosts, PyPI + `files.pythonhosted.org` + `astral.sh`, Expo's two, `api.themoviedb.org`, and the runtime-injected forge host. Each entry has a recorded reason. Duplicating that by hand guarantees drift.

**Constraint**: the forge host stays **out of the file** — it is injected at runtime from `FORGE_REGISTRY_HOST`, exactly as today, because it is topology-sensitive and gated out of git. The generator must therefore accept it as a parameter, never bake it.

**Consequence**: `verify-firewall-allowlist.sh` reads the canonical file rather than re-listing domains, so it cannot pass against a stale expectation.

---

## D-05 — Two egress layers: sandbox policy primary, in-VM firewall as defense-in-depth

**Decision**: Sandbox policy (Locked Down + generated allowlist) is the primary control. `init-firewall.sh` is **retained** for this migration. Triage order is documented as: `sbx policy log` **first**, then the in-VM ipset staleness reflex.

**Rationale**: Sandbox policy is enforced host-side, outside the VM, untamperable from inside, audited, and — decisively — governs **all** VM egress including every sibling container. `init-firewall.sh`'s own header states it does *not* firewall nested containers because the FORWARD chain is deliberately left to dockerd. That documented residual is what the sandbox layer closes.

Retaining the iptables layer during the migration is the smallest behavioural delta, and its allowlist semantics are battle-tested here across three features. Retiring it is a separate, later decision, already recorded in spec Out of Scope.

**Scope change to be aware of**: under `--network=host` (D-02) the script programs the VM's OUTPUT chain, so it now also filters dockerd's image pulls. The registry entries in the list — previously needed because the *nested* dockerd shared the container's netns — remain necessary for exactly the same structural reason, one level out.

**Consequence**: the "CDN blob timeout → re-apply the firewall" gotcha gains a second and more likely suspect. The delta runbook must state the order, or the two layers cost more time than they save.

---

## D-06 — The engine-isolation check is replaced, not edited, because its premise inverts

**Decision**: Add `verify-engine-seam.sh`; delete `verify-engine-isolation.sh` at adoption.

**Rationale**: This is not a rename. The current script asserts, as a **pass** condition:

> the host Docker socket must NOT be mounted in (that anti-pattern hands the container the host engine and defeats isolation)
> — `grep -Eq '/(var/run|run)/docker\.sock' /proc/mounts` → **fail** if found

The new architecture mounts a docker socket into the dev container **on purpose**. Under the old script that is a hard failure, and under the new architecture the old script's premise — "the engine you can reach is the *host* engine" — is simply false: the reachable engine is the microVM's, and the host engine is behind a hypervisor boundary the container cannot cross.

This is the CLAUDE.md rule in action — *a guard that fails because you changed what it protects gets updated at the cause, never deleted*. So the replacement must assert the **new** premise with equal force, not merely drop the old assertion:

| Assertion | Side | Replaces |
| --- | --- | --- |
| No `dockerd`/`containerd` process runs inside the dev container (`pgrep` empty) | in-container | the "nested engine works" assertions |
| A docker socket **is** present and answers `docker info` | in-container | the inverted socket check |
| The engine's reported ID is the **sandbox's**, recorded for cross-check | in-container | nested daemon ID capture |
| `docker inspect` of the dev container shows `"Privileged": false` | VM-side | *new* — this is the headline claim |
| The Windows engine lists neither the probe, nor any stack container, nor the dev container itself | host-side | `--host-check` mode, widened |

The host-side mode is kept and widened: it is the only non-fabricable proof, because it reads the real Windows engine.

**RED-first is genuine here**, which matters for the TDD gate: `verify-engine-seam.sh` fails on today's DinD container (no socket mounted, `dockerd` running, `Privileged: true`), and `verify-engine-isolation.sh` fails on the new one (socket present). Neither is trivially green.

---

## D-07 — Secrets: most host-resident mechanism that works

**Decision**: Preference order — (1) `sbx secret` with proxy header injection, so the value never exists inside the VM; (2) a kit declaring setup + credentials; (3) a gitignored env file sourced in the sandbox shell before `devcontainer up` (today's posture, one boundary further in).

**Rationale**: Today six values ride `${localEnv}` from the Windows host into the container: `MCM_DEVCONTAINER_IMAGE`, `FORGE_REGISTRY_HOST`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY`, `MCM_FORGE_TOKEN`, `MCM_FORGE_ISSUE_TOKEN`. The mechanism is unchanged — "local" simply becomes the sandbox session where `devcontainer up` runs. Option (1) is strictly better where it applies, because it removes the value from the blast radius entirely.

**Hard constraint from v0.37.1 onward**: SSH sessions do **not** forward credential environment variables unless `ssh.acceptEnv` is configured. Nothing may rely on env vars riding the SSH session — a silent-empty failure mode this repo has already been bitten by (the "fully quit VS Code after `setx`" gotcha is the same shape).

**[gate — P5]** Whether injection reaches **sibling** containers (the agent gateway's Anthropic calls) is unproven. Decision rule: either outcome is acceptable; only the recorded posture differs. If injection covers siblings, `ANTHROPIC_API_KEY` need never enter the VM and that is a stated isolation improvement; if not, it is provisioned as today and the posture note says so.

---

## D-08 — Editor chain: two standard hops, with a wired fallback

**Decision**: Primary — `sbx setup ssh` once, then VS Code **Remote-SSH → `mcm.sbx`**, then the **Dev Containers** extension attaches to / reopens in the dev container on the sandbox's engine. Fallback — `sshd` in the dev container plus `sbx ports mcm --publish 2222:2222`, giving one-hop Remote-SSH directly into the dev container.

**Rationale**: Both hops are standard in isolation (official sandbox VS Code integration; the ordinary "Dev Containers over Remote-SSH against a remote Docker host" flow). Their **composition** is not documented by Docker.

**Note on what this move deletes**: the VS Code-extension build quirks disappear from the container-build path entirely, because the headless `@devcontainers/cli` builds it inside the VM — no `${localEnv:VAR:default}` non-application, no Wayland socket, no credsStore injection, no "fully quit VS Code after `setx`".

**[gate — P4]** Decision rule: if the composition fails, the fallback becomes the documented default. It is fully functional, so this gate cannot stop the feature — but it must be *exercised* either way (FR-023), so it is documented rather than theoretical.

---

## D-09 — Android: capability lost, toolchain retained

**Decision**: Keep the Android SDK in `toolchain.Dockerfile`. Make `scripts/devcontainer-android.sh` refuse **explicitly and legibly** when `/dev/kvm` is absent. Record the emulator as a scoped exception with named alternatives: mobile E2E in CI (already the recommended path for agent flows) or on the retained Docker Desktop environment on demand.

**Rationale**: Phase 0 resolved gate R2 **negative** — `/dev/kvm` is absent in the microVM. But dropping the SDK would fork `toolchain.Dockerfile` for one unavailable capability, break `verify-toolchain-present.sh`'s parity assertions, and complicate the fallback environment that still needs it. The existing script already no-ops without KVM; the change is to make the refusal *say why*, so a future session does not spend an hour rediscovering that nested virtualization is unavailable.

**Alternative rejected**: software-rendered emulation — explicitly ruled out in the proposal, and unusable in practice.

---

## D-10 — Retire the DinD-only plumbing rather than carry it

**Decision**: Delete, in the sandbox variant and then at adoption:

| Artifact | Why it existed | Why it goes |
| --- | --- | --- |
| Compose v5 parity pin in `toolchain.Dockerfile` | out-rank the DinD feature's apt-installed compose plugin | there is one engine now; parity is with itself |
| `DOCKER_CONFIG=/home/coder/.docker-dind` | VS Code writes a host-side `credsStore` helper into `~/.docker/config.json` that the nested docker cannot execute | the headless CLI builds the container; the quirk's source is gone |
| The DinD-lock runbook section | stale-container `meta.db` flock deadlock after rebuilds | no nested engine, no nested lock |
| `privileged` (implied by the feature) and its FR-004/FR-011 comment block | forced by `docker-in-docker` | replaced by a note that the engine is the sandbox's |

**Rationale**: Carrying dead workarounds forward is how a migration keeps its predecessor's tax. Each of these exists *only* because of the nested engine, and each is individually traceable to it in the current comments — which makes the deletion safe and auditable rather than speculative.

---

## D-11 — Ports and LAN devices

**Decision**: Sibling stacks publish inside the VM as today, reachable from the dev-container shell via localhost (D-02). Expose to Windows with `sbx ports mcm --publish 8081:8081` (+8082, +8099) or via Remote-SSH port forwarding for browser-on-host use.

**[gate — P5]** A **physical phone on the LAN** (SC-007 of feature 037's numbering; FR/edge case here) needs non-loopback binding, and current docs say `sbx ports` binds loopback. Decision rule: verify whether non-loopback binding is possible; if not, the remedy is a host-side `netsh interface portproxy` rule or the documented Expo tunnel — and if neither is acceptable, the workflow is declared unsupported in the new environment rather than left ambiguous.

---

## D-12 — Performance: capture the baseline before cutover, or the budget is meaningless

**Decision**: Time the runbook's validated sequence **on the current Docker Desktop environment first**, then repeat it in the sandbox. Budget ≤1.5× (SC-006). Size the sandbox explicitly at creation: ≥8 CPU, ≥16 GB.

**Rationale**: A ratio needs a numerator and a denominator. Defaults are N-1 host CPUs and ~50% host RAM (capped 32 GB), which may be adequate — but "adequate" must be measured, especially for Metro, which is the known OOM-prone component in this workspace. Note this design has **one less nesting level** than today (Desktop VM → container → DinD), so the naive expectation is not automatically slower.

**Decision rule**: > 1.5× → escalate with the measurements. Re-sizing is the first remedy; abandonment is the last, and only with numbers behind it.

---

## D-13 — v0.38.0 is newer than the proposal's research; verify rather than inherit

**Decision**: Treat every version-sensitive claim in the proposal as **provisional** and confirm against the installed v0.38.0.

**Rationale**: The proposal was researched against v0.37 (SSH landed 2026-07-24) and notes kit spec v2 arriving in v0.38.0 (2026-08-06). The installed CLI is **v0.38.0** (`c022b14634c4bea846ca12870d1d5e97d5868b54`). The moving surfaces that matter here are the `policy` subcommands, `ports` binding behavior, `secret` injection scope, `template`/kit syntax, and SSH `acceptEnv` defaults — i.e. nearly every mechanism this plan depends on. The proposal itself flags the CLI as "young and moving fast".

**Consequence**: pin the version once the environment is green (R5), and add a release-notes review to the update ritual. The pin is not bureaucracy — an experimental CLI that silently changes a flag is exactly the class of instrument failure CLAUDE.md warns about.

---

## D-14 — Workstation operational facts, captured now

**Decision**: Both belong in the delta runbook (FR-030), not in a session's memory.

- **`sbx` is not on PATH in a fresh shell.** It installs to `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`; winget does not always refresh PATH for open shells. Documentation must not assume the bare command resolves — observed on this workstation.
- **`sandboxd` can be running yet unresponsive**: `ensure daemon: sandboxd (PID …) remained running but did not respond within 10s`. Observed on this workstation. Recovery is to stop the process and let the next command restart it. It presents as the CLI being broken, which is precisely why it needs a named entry.

**Rationale**: Both are instrument failures, not environment failures. This repository has repeatedly paid for confusing the two.

---

## D-15 — The two runners swap roles; whether the anti-lock-in property survives is a **G4 outcome**, not a design decision

**[gate — P4]** This entry deliberately does **not** decide. It states what changes, what is unknown, and what each outcome obliges.

**What FR-008 actually bought.** Feature 037's `verify-portable-runner.sh` header states its purpose plainly: the extension is the daily driver, `@devcontainers/cli` is the **independent second runner**, "so the setup is not hostage to any single tool." The script's assertions are all CLI-side — `read-configuration`, `devcontainer up`, then the isolation proofs through `devcontainer exec`. **It never exercises the VS Code extension.** The extension half of the property is verified by being used every day, not by this script.

**What the migration changes.** The roles swap:

| | Runner that builds daily | Runner that proves non-lock-in |
| --- | --- | --- |
| 037 / Docker Desktop | VS Code Dev Containers extension | `@devcontainers/cli` (this script) |
| 060 / sandbox | **`@devcontainers/cli`** (headless, inside the VM) | **the extension — unasserted** |

So the property does not shrink; it **points the other way**, and nothing currently asserts the new direction. The script keeps working and becomes *more* load-bearing, because it now tests the primary build path rather than the alternate one.

**The open question (G4).** D-08's editor chain says the Dev Containers extension "attaches to / **reopens in**" the container. Those are different operations:

- *Attach to Running Container* — the CLI built it; the extension only connects. Always available.
- *Reopen in Container* — **the extension builds**, from inside the Remote-SSH session, against the sandbox engine. Unknown whether this works.

**Decision rule at G4:**

- **If Reopen in Container works** → the dual-runner property survives intact in its new direction. Delete this entry; `verify-portable-runner.sh` needs no scoping, only the config-path parameter so it can check both configs.
- **If it does not work** → record it as a known constraint, and accept a real consequence: **the sandbox environment is then hostage to `@devcontainers/cli`**, inside a VM whose Node was provisioned by hand (T023). Today a broken CLI is survivable — you open the folder in VS Code and keep working. Under this outcome there is no such fallback, so the delta runbook owes an explicit recovery path (most likely `sbx template save` restore, or CLI reinstall from the allowlisted npm registry).

**What survives regardless.** The two VS Code-client tweaks — `dev.containers.mountWaylandSocket: false` and the `credsStore` → `DOCKER_CONFIG` workaround — do genuinely disappear. Both exist only because the extension issues `docker run` **host-side on Windows**; in the Remote-SSH session the extension runs on Linux, with no WSLg socket and no Windows credential helper. That part of D-08 holds independently of the G4 outcome.

**Why this is deferred rather than decided.** An earlier revision of this entry decided the negative case in advance — narrowing the sandbox variant to CLI-only on the strength of a prediction about how the extension behaves. That traded away an anti-lock-in property the repository deliberately paid for, on no evidence, in a document that then read as settled. Narrowing a guard is legitimate (see D-06), but only once the cause is known. Here the cause is exactly what G4 measures, so the narrowing waits for it.

---

## Open gates, consolidated

| Gate | Phase | Question | If it fails |
| --- | --- | --- | --- |
| **G1** | P2 | Is the tailnet forge reachable through the sandbox egress proxy for git **and** image pull? | Try `DOCKER_SANDBOXES_PROXY=system` routing, then a Tailscale subnet-router/hostname exposure. If neither works: **stop the feature**, record the finding, retain the current environment. |
| **G2** | P3 | No daemon in-container, unprivileged, invisible to the Windows engine? | Design defect — do not tune around it. |
| **G3** | P3 | Does the workspace path match on both sides, proven by a sibling probe? | Fix before any workload runs; sibling mounts fail silently. |
| **G4** | P4 | Does the Dev Containers extension layer over the sandbox Remote-SSH session — **attach only, or also Reopen in Container** (D-15)? | Attach works but Reopen does not: record the constraint; the sandbox is then hostage to `@devcontainers/cli`, so the runbook owes an explicit CLI-recovery path. Neither works: the sshd fallback becomes primary. Feature continues in every case. |
| **G5** | P5 | Is a sibling container's non-allowlisted request refused **and** audited? | The headline security claim is unproven — do not adopt. |
| **G6** | P5 | Wall-clock ≤ 1.5× baseline? | Escalate with measurements; re-size first. |
| **G7** | P1 | What is the microVM's disk envelope? | Establish before ENOSPC finds it; document a prune practice. |
