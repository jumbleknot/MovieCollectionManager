# HANDOFF: 037-containerized-dev-env

**State**: SDD spec chain complete (spec → plan → research/data-model/contracts/quickstart → tasks), `/speckit-analyze` run, findings F1/F2/F4 remediated. **No implementation done yet.** Branch `037-containerized-dev-env`.

**Next command**: `/speckit-implement` (or execute `tasks.md` from T001). Read in order: [spec.md](spec.md) → [plan.md](plan.md) → [research.md](research.md) (decisions D1–D6) → [tasks.md](tasks.md). [contracts/devcontainer-contract.md](contracts/devcontainer-contract.md) has the SC→check→pass table; [quickstart.md](quickstart.md) is the validation guide.

## What this feature is (one line)

Give Claude Code a disposable Linux **dev container** (plain VS Code Dev Containers + the devcontainer spec, **not** DevPod) to run inside, so the agent's blast radius is the container, not the Windows host. Config-as-code committed to the repo. No app code, auth, or CI/CD touched.

## Decisions already locked (do NOT relitigate)

- **Runner = plain VS Code Dev Containers**; `@devcontainers/cli` is the headless/portability runner (SC-006). DevPod rejected as foundation (maintenance risk — issue #1915). The portable asset is `.devcontainer/`, not any tool. (research D1)
- **Source on a Docker named volume**, never an NTFS bind mount (research D2). Established at **Foundational** (T005/T006) so every phase runs on it.
- **In-container Docker = `docker-in-docker` feature**, which forces `privileged`. Accepted. Host socket mount is **rejected** (defeats isolation). (research D3)
- **Honest security posture** (FR-011/SC-008): strong host-FS/credential isolation, **moderate** engine isolation. Never claim "no privileged / unprivileged". The source PRD MUST be rewritten to match (FR-013 / T026).
- **Build on Anthropic's reference Claude Code devcontainer**: default-deny **egress firewall** (`init-firewall.sh`) + non-root `coder` user + persistent history. (research D4)
- **Pilot toolchain = Node 20 + pnpm + DinD only**; Rust/Python deferred to a build-time-measured increment 2 (research D5).

## Gotchas the implementer will hit

- **Enhanced Container Isolation (ECI) is incompatible with the DinD feature** — keep ECI **off** (research D3, features#1319).
- **Firewall ↔ DinD is the riskiest integration** — default-DROP egress must allowlist the registries DinD pulls from (Docker Hub/`ghcr.io`/forge registry) by **domain with re-resolution**, not a one-shot IP (CDN IPs rotate). This is task **T015a**; don't skip it.
- **Keep the forge registry host literal out of git** (topology-scrub gate) — source it from env in `init-firewall.sh` (T014).
- **Ports are `8081` (Metro/web/dev-BFF), `8082` (dev-container BFF), `8099` (Keycloak OAuth)** — verified against the codebase. The PRD's `19000/19001/19006` are dead legacy; do not use them (F1 fix).
- **Verify scripts are authored RED-first** (constitution TDD gate) and must fail if the environment is genuinely broken — no self-healing.

## Validation reality

Most acceptance (build the container, DinD, firewall, run Metro, device-over-LAN) is **hands-on host work on the Windows workstation** — it cannot be fully exercised headless by an agent. The verify scripts + quickstart are the checklist; expect the human to drive the pilot (Phase 1 of the PRD rollout). MVP to validate first: T001–T011 (isolated agent + egress control).

## Constitution note

One approved deviation: the container runs `privileged` (DinD requirement), documented in plan.md Complexity Tracking + FR-011, explicitly chosen by the human. Not a violation.
