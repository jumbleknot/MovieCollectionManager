# Implementation Plan: Dev container on Docker Sandbox — retiring Docker-in-Docker

**Branch**: `060-devcontainer-docker-sandbox` | **Date**: 2026-08-15 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/060-devcontainer-docker-sandbox/spec.md`

## Summary

Rehost the AI-assisted engineering environment inside a Docker Sandbox microVM and have the dev container drive the sandbox's **own** Docker engine as an unprivileged client over its socket. The `docker-in-docker` dev-container feature is replaced by `docker-outside-of-docker`, `privileged` is deleted, and application stacks become **siblings** of the dev container on one engine rather than nested children inside it.

Three implementation levers carry the whole migration, and everything else follows from them:

1. **Feature swap + `--network=host`.** With the dev container in the sandbox VM's network namespace, sibling stacks publish on the VM's loopback and the entire documented local service map (`localhost:8082 / 8099 / 3001 / 27017 / 6379`), the integration-tier URL exports, and the Playwright container recipe keep working **verbatim**. This is what makes a topology change cost almost no in-repo churn.
2. **Identical workspace path** at `/workspaces/mcm` on both the VM and inside the dev container. With one engine, every sibling `-v` path resolves against the **VM** filesystem, so path equality is a correctness requirement, not a convention — and it is asserted, not assumed.
3. **One canonical egress destination list** in-repo, emitting both the host-side sandbox policy and the in-VM iptables allowlist. Today that list is inlined in `init-firewall.sh`; extracting it is what keeps the two enforcement layers from forking into two truths.

The security payoff is concrete and measurable: `init-firewall.sh` documents, in its own header, that it "does **NOT** independently firewall the egress of *nested running containers*" — the FORWARD chain is deliberately left to dockerd. Sandbox policy is enforced host-side, outside the VM, and governs **all** VM egress including every sibling container. That closes a residual the current environment has carried, openly, since feature 037.

## Technical Context

**Language/Version**: Bash (verify harness, firewall, lifecycle hooks); Node.js 24 + ESM (`scripts/*.mjs` generators); JSONC (`devcontainer.json`); YAML (sandbox kit). No application-code change in any language.

**Primary Dependencies**: Docker Sandbox CLI (`sbx`) **v0.38.0**, pinned once green; `ghcr.io/devcontainers/features/docker-outside-of-docker:1` (replacing `docker-in-docker:2`); `@devcontainers/cli` inside the sandbox; the existing digest-pinned `MCM_DEVCONTAINER_IMAGE` toolchain image; VS Code Remote-SSH + Dev Containers extensions.

**Storage**: Docker named volumes on the sandbox engine — `mcm-commandhistory`, `mcm-cargo-registry`, `mcm-cargo-git`, `mcm-uv-cache`, `mcm-pnpm-store`, `mcm-claude` — carried across unchanged. Workspace is a plain directory on the VM filesystem (`/workspaces/mcm`), **not** a named volume (see D-03).

**Testing**: The `.devcontainer/verify/` harness is the test suite for this feature — RED-first, exit-code asserted. It goes from **nine scripts to twelve**: `verify-engine-isolation.sh` is replaced by `verify-engine-seam.sh` (D-06), and three are added — `verify-workspace-path.sh`, `verify-egress-allowlist-contract.sh`, `verify-sandbox-egress.sh`. Workload proof reuses the existing integration tier, Playwright web E2E, and one agent E2E spec unchanged.

**Target Platform**: Windows 11 host → Docker Sandbox microVM (own Linux kernel) → sandbox Docker engine → unprivileged dev container (Debian, user `coder`) + sibling stacks.

**Project Type**: Developer-environment / infrastructure migration. No `backend/`, `frontend/`, `agents/`, or `mcp-servers/` source is modified.

**Performance Goals**: Migrated workload wall-clock ≤ **1.5×** the Docker Desktop baseline (SC-006). Warm recreate-from-nothing ≤ **15 min** (SC-007). Baseline must be captured on the current environment *before* cutover (T-block P5) or the ratio is unfalsifiable.

**Constraints**: No `privileged`. No engine daemon inside the dev container. No host filesystem, credential or loopback reachable from the VM. No forge hostname, tailnet address or secret literal in git. The existing Docker Desktop path must keep working until adoption. Disk envelope of the microVM is undocumented and must be established before it is discovered by an ENOSPC mid-session.

**Scale/Scope**: One workstation, one developer, one sandbox. **~10 committed files changed and ~8 added**, of which: 1 verify script replaced, 3 verify scripts added, 3 verify scripts modified, 2 new non-verify files (`egress-allowlist.json`, `gen-egress-policy.mjs`), 1 new dev-container variant, 1 new runbook, and 4 documentation surfaces updated. Six migration phases, six of which have runtime gates. (The earlier "~4 changed / ~2 added" estimate was wrong by 3–4× and is corrected here — it was made before the verify-harness delta and the allowlist extraction were enumerated in `tasks.md`.)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — result at the end of this section.*

| Principle | Applies how | Status |
| --- | --- | --- |
| **AI Assistant Constraints — Technology Agnosticism** | `spec.md` states outcomes only; every product name, flag, path and command lives here in `plan.md`. | ✅ PASS |
| **AI Assistant Constraints — Behavior-Descriptive Identifiers** | New artifacts are named for behavior (`verify-engine-seam.sh`, `egress-allowlist.json`, `gen-egress-policy.mjs`), never `verify-fr013.sh`. Requirement IDs go in header comments as provenance — the one sanctioned WHAT-comment. | ✅ PASS |
| **AI Assistant Constraints — Documentation** | FR-030/FR-031 make the runbook, CLAUDE.md, OpenWiki and README part of the work, not a follow-up. | ✅ PASS |
| **Security — Deny By Default** | Egress is deny-by-default at both layers; the sandbox layer is enforced outside the agent's reach and audited. | ✅ PASS |
| **Security — Principle of Least Privilege** | This feature *removes* privilege: `privileged` deleted, and `NET_ADMIN`/`NET_RAW` retained only while `init-firewall.sh` remains (D-05), with a stated retirement path. | ✅ PASS — improves |
| **Security — Secrets Management** | No secret in source or config. Preference order host-keychain → kit → gitignored env (D-07). Topology-scrub unchanged: forge host stays a `${localEnv}`/sandbox-local value. | ✅ PASS |
| **Test-Driven Development (NON-NEGOTIABLE)** | The verify harness is the test suite. Every task pair is Verify RED → implement → Verify GREEN, per `docs/templates/feature-test-tasks-template.md`. RED is genuinely reachable here: the engine-seam check fails on the current DinD container because a socket is absent, and the current engine-isolation check fails on the new one because a socket is present. | ✅ PASS |
| **Test Type Integrity** | Nothing is mocked. Every assertion reads the real engine, the real policy log, the real host. `--host-check` mode deliberately reads the actual Windows engine. | ✅ PASS |
| **Common Stack — Nx as universal task runner** | ⚠️ The verify harness is invoked as bash, not through Nx — an existing condition inherited from 037/038, not introduced here. See Complexity Tracking. | ⚠️ PASS with recorded deviation |
| **Common Stack — RTK token compression** | RTK is constitution-mandated for AI sessions and is installed by the out-of-repo dotfiles into `~/.claude/tools` on the `mcm-claude` volume. That volume moves unchanged, so RTK survives — but `verify-personal-layer.sh` must confirm it, because a silently RTK-less environment violates the constitution while looking healthy. | ✅ PASS — explicit assertion required |
| **Git Management — single root `.gitignore`** | The sandbox-local env file and any kit carrying topology literals must be covered by the root `.gitignore`, not a new nested one. | ✅ PASS |
| **Governance — amendments** | No constitutional principle is changed. `docs/runbooks/devcontainer.md`'s posture section is amended, which is documentation, not constitution. | ✅ PASS |

**Post-Phase-1 re-check**: no new violation introduced by the design. The two-layer egress model and the temporary dual configuration are the only added complexity, both recorded and both with a stated end state in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/060-devcontainer-docker-sandbox/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — 14 decisions, with the open runtime gates
├── data-model.md        # Phase 1 — environment artifacts, fields, lifecycle states
├── quickstart.md        # Phase 1 — runnable validation guide, phase by phase
├── contracts/
│   ├── egress-allowlist.md   # Canonical destination list + both emitted forms
│   └── verify-harness.md     # Each check's invocation, mode, and exit-code contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (complete)
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
.devcontainer/
├── devcontainer.json                  # MODIFIED at adoption; sandbox variant added first
├── sandbox/
│   └── devcontainer.json              # ADDED — the docker-outside-of-docker variant (pilot)
├── Dockerfile                         # unchanged (thin FROM ${BASE_IMAGE})
├── toolchain.Dockerfile               # MODIFIED — retire the DinD-parity Compose pin
├── init-firewall.sh                   # MODIFIED — consume the extracted allowlist; scope note
├── egress-allowlist.json              # ADDED — the single canonical destination list
└── verify/
    ├── verify-engine-seam.sh                # ADDED — replaces verify-engine-isolation.sh
    ├── verify-engine-isolation.sh           # DELETED at adoption (premise inverted, see D-06)
    ├── verify-workspace-path.sh             # ADDED — identical-path assertion (R10)
    ├── verify-egress-allowlist-contract.sh  # ADDED — generator contract (D-04)
    ├── verify-sandbox-egress.sh             # ADDED — VM-level egress probes (US2)
    ├── verify-host-isolation.sh             # MODIFIED — sandbox-aware
    ├── verify-firewall-allowlist.sh         # MODIFIED — canonical list + sibling probe
    ├── verify-personal-layer.sh             # MODIFIED — assert RTK present
    ├── verify-portable-runner.sh            # MODIFIED — config parameter (D-15/G4)
    └── …                                    # caches-persist, toolchain-present,
                                             #   reproducible-recreate, committed-clean: unchanged

scripts/
├── gen-egress-policy.mjs              # ADDED — emits sbx policy commands + ipset domain list
├── devcontainer-android.sh            # MODIFIED — explicit, documented no-KVM refusal
├── devcontainer-ollama.sh             # unchanged (sibling now, same published port)
└── build-devcontainer-image.mjs       # unchanged

docs/runbooks/
├── devcontainer-sandbox.md            # ADDED — the delta runbook (lifecycle, triage, ports…)
└── devcontainer.md                    # MODIFIED — posture rewritten; DinD sections archived

openwiki/                              # regenerated, not hand-edited (see CLAUDE.md)
CLAUDE.md                              # MODIFIED — gate/index entry for the new environment
README.md                              # MODIFIED — environment description
```

**Structure Decision**: No application source tree is touched. The feature lives in `.devcontainer/` (configuration + verification), `scripts/` (the allowlist generator), and the documentation surfaces named by FR-031. The sandbox variant is a **sibling config directory** (`.devcontainer/sandbox/`) rather than a branch of the main file, so `devcontainer up --config` selects it while the Docker Desktop path stays byte-identical until adoption (FR-019).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| ----------- | ------------ | ------------------------------------- |
| **Two egress enforcement layers** (host-side sandbox policy + in-VM `init-firewall.sh`) rather than one | The sandbox policy is new and unproven here; `init-firewall.sh`'s allowlist semantics are battle-tested in this repo across three features. Running both during migration gives the smallest behavioural delta and a fallback if policy granularity disappoints. | Sandbox-policy-only is the *intended* end state and is explicitly listed in spec Out of Scope as a later decision — but adopting it in the same change that moves the engine would conflate two failure modes. The cost is R8 (misdiagnosis), paid down by one canonical list (D-04) and a stated triage order. |
| **Two dev-container configurations** during the migration (`.devcontainer/devcontainer.json` + `.devcontainer/sandbox/devcontainer.json`) | FR-019 requires the current environment to keep working on Docker Desktop until adoption; a single mutated file would break the working environment on the first commit. | Mutating in place would leave no rollback and no A/B for the performance comparison. FR-032 collapses them after two incident-free weeks, so the duplication is time-boxed, not permanent. |
| **Bash verify harness not invoked through Nx** | Pre-existing condition from features 037/038, unchanged by this feature. These checks run *outside* and *around* the container (host-side mode reads the Windows engine), which is not a workspace-project target shape. | Wrapping the harness in Nx targets is a defensible cleanup but is scope creep here, and would add churn to a dozen scripts during a migration whose whole risk profile depends on minimal in-repo delta. Recorded so it is a decision, not an oversight. |

## Phase gates (execution order and stop conditions)

Each gate resolves a spec risk. A gate that fails has a defined consequence, not a retry loop.

| Gate | Phase | Resolves | Stop condition |
| --- | --- | --- | --- |
| **G1 Forge reachability** | P2 | R1 / FR-009 | If the forge is unreachable and neither system-proxy routing nor a subnet-router exposure fixes it → **stop the feature**, record the finding, retain the current environment. This is the only gate that can end the migration. |
| **G2 Engine seam** | P3 | FR-013/014/015/020 | Any daemon inside the container, any `Privileged: true`, or any sandbox container visible to the Windows engine → design defect, not a tuning problem. |
| **G3 Workspace path** | P3 | R10 / FR-017 | Path mismatch → sibling mounts silently mount the wrong content; must be fixed before any workload runs. |
| **G4 Editor chain** | P4 | R6 / FR-022 | Primary chain failing is acceptable; the sshd fallback must then be the documented default. |
| **G5 Sibling egress** | P5 | R8 / FR-025 | A refused request from inside a sibling container must produce an audit entry. Failure means the headline security claim is unproven — do not adopt. |
| **G6 Performance** | P5 | R3 / FR-026 | > 1.5× baseline → escalate with measurements; sizing is the first remedy, abandonment the last. |

## Open runtime unknowns

These are unresolvable by research and resolve only by execution. Each has a decision rule so neither outcome blocks planning — detail in [research.md](research.md).

- **Forge reachability through the sandbox egress proxy** (G1) — the one that can end the feature.
- **Whether proxy header injection reaches sibling containers** (FR-027) — either outcome acceptable; only the recorded posture differs.
- **Whether the Dev Containers extension layers over the sandbox Remote-SSH session** (G4) — and specifically whether it can *build* (Reopen in Container) or only *connect* (Attach to Running Container). The sshd fallback keeps a terminal reachable either way, but the build answer decides whether the sandbox retains a second runner or becomes dependent on `@devcontainers/cli` alone (D-15).
- **The microVM disk envelope** — establish in P1, before it is discovered by failure.
- **Whether `sbx ports` can bind non-loopback** for a physical LAN device — remedy or declare unsupported.
- **v0.38.0 behavioural deltas** from the v0.37-era research the proposal was written against — verify, do not inherit.

## Notes carried from the workstation

Two things observed on this host during Phase 0 verification, both destined for the delta runbook (FR-030) because both present as "the tool is broken":

- `sbx.exe` is installed at `%LOCALAPPDATA%\DockerSandboxes\bin\` but is **not on PATH** in a freshly opened shell.
- `sandboxd` can be **running yet unresponsive** to its own CLI (`ensure daemon: sandboxd (PID …) remained running but did not respond within 10s`). Recovery is to stop the process and let the next command restart it.
