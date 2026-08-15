# Tasks: Dev container on Docker Sandbox — retiring Docker-in-Docker

**Feature**: 060-devcontainer-docker-sandbox | **Branch**: `060-devcontainer-docker-sandbox` | **Date**: 2026-08-15

**Input**: [spec.md](spec.md) · [plan.md](plan.md) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) · [quickstart.md](quickstart.md)

Task format follows the repo's [feature-test-tasks-template](../../docs/templates/feature-test-tasks-template.md): every test task carries a **Verify RED** with expected failure output, every paired implementation task a **Verify GREEN**. Documentation/config tasks carry a **Done when** instead.

**Platform Parity Table: omitted, justified.** This feature has no frontend surface — it is a developer-environment migration with no web or mobile user flow. The template's "adapting to project type" guidance omits the table for non-multi-client features. The E2E regression requirement is *not* omitted: it appears as T041–T043 and in the Completion Checklist.

---

## Phase 1: Setup

- [ ] T001 Import the Phase 0 host-prep record from `E:\Programming\VSCode\p0-docker-sandbox-host-setup.md` into `specs/060-devcontainer-docker-sandbox/phase-0-host-prep.md`
- [ ] T002 [P] Record the resolved gate data in `specs/060-devcontainer-docker-sandbox/phase-0-host-prep.md`: `sbx` v0.38.0 (`c022b14634c4bea846ca12870d1d5e97d5868b54`), `/dev/kvm` **absent** (R2 negative), and the two workstation gotchas (PATH, unresponsive `sandboxd`)
- [ ] T003 Capture the Docker Desktop performance baseline into `specs/060-devcontainer-docker-sandbox/baseline-measurements.md` — time the runbook's bring-up + integration + web E2E sequence on the **current** environment

### T001 — Import the Phase 0 host-prep record into the repository

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**Spec reference**: spec.md#user-story-1 (Assumptions — "that evidence lives outside the repository today")

The Phase 0 work is complete but its record sits outside version control on the `E:` drive. Copy it into the feature directory so the migration record is self-contained and auditable, marking each exit-checklist row with its observed result rather than its intended one.

**Done when**: `specs/060-devcontainer-docker-sandbox/phase-0-host-prep.md` exists, all eight exit-checklist rows carry an observed result, and no forge hostname or tailnet address is present in it.

### T003 — Capture the Docker Desktop performance baseline

**Type**: Config change / measurement | **Time**: 1–2 hrs (mostly wall-clock) | **Risk**: Low

**Spec reference**: SC-006, research.md#D-12

Run the runbook's validated sequence on the **existing** Docker Desktop dev container and record wall-clock per stage. Without this the ≤1.5× budget has no denominator and G6 is unfalsifiable.

Do this **before** attention shifts to the sandbox. Docker Desktop is retained, so it remains technically possible later — but a baseline taken after weeks of sandbox work invites unnoticed drift in the comparison.

**Done when**: `baseline-measurements.md` records per-stage wall-clock for `up-auth`, `docker-build mcm-app`, `up-mcm`, the integration tier, and the web E2E suite, each with the date and the environment it was measured on.

---

## Phase 2: Foundational (blocking — must complete before User Story 2)

- [ ] T004 Create `.devcontainer/egress-allowlist.json` with all 30 destinations migrated from `.devcontainer/init-firewall.sh`, reasons preserved
- [ ] T005 Write the generator contract test in `.devcontainer/verify/verify-egress-allowlist-contract.sh`
- [ ] T006 Create `scripts/gen-egress-policy.mjs` with `--format sbx-policy`, `--format ipset-domains`, and `--check`
- [ ] T007 Replace the inline `DOMAINS=(...)` array in `.devcontainer/init-firewall.sh` with a read of `gen-egress-policy.mjs --format ipset-domains`
- [ ] T008 [P] Correct the honest-limits paragraph in `.devcontainer/init-firewall.sh` — the nested-container residual is now covered by sandbox policy, and under `--network=host` the script filters the VM's OUTPUT chain including dockerd's pulls

### T004 — Migrate the destination list to a canonical file

**Type**: New file | **Time**: 1 hr | **Risk**: Medium

**Spec reference**: FR-007, contracts/egress-allowlist.md

Move every domain from the script's inline array into `.devcontainer/egress-allowlist.json` with `domain`, `group`, `reason`, `cdnRotating` per the contract. **The reasons are load-bearing** — the current comments record why each CDN host rotates IPs, why quay needs four Akamai hosts, and why TMDB was allowlisted for the test runner rather than the app. Carry them across as prose, do not summarise them away.

Two rules with teeth: the forge host is **not** in this file (runtime-injected from `FORGE_REGISTRY_HOST`), and the OpenWiki analytics host is **not** added — telemetry stays disabled by configuration, never by allowlisting.

Update the TMDB reason: under sandbox policy the "test runner only, app traffic is FORWARD-chain" distinction no longer holds, because policy governs siblings too.

**Done when**: the file validates against T006's `--check`, contains 30 destinations, contains no forge/tailnet literal, and every `reason` is non-empty.

### T005 — Write the generator contract test

**Type**: Test | **Time**: 45 min | **Risk**: None

**Spec reference**: FR-007, FR-011

**Scenarios covered**:

- US2-AC1: the allowlist derives from the project's canonical destination list
- FR-011: no topology-sensitive literal enters git

**File**: `.devcontainer/verify/verify-egress-allowlist-contract.sh`

Assert that `gen-egress-policy.mjs` satisfies its contract: both formats emit one line per destination in stable order; `--forge-host` appends the forge entry to both; omitting it omits the entry **cleanly** with exit 0; `--check` rejects a bare IP, an empty `reason`, and an unknown `group`.

**Verify RED** (run before T006 exists):

```bash
bash .devcontainer/verify/verify-egress-allowlist-contract.sh
```

**Expected RED**: script exits 1 — `✗ scripts/gen-egress-policy.mjs not found` (all 8 assertions fail; the generator does not exist yet).

> 0 failures here means the test is asserting nothing and must be fixed before T006.

### T006 — Implement the egress policy generator

**Type**: Implementation | **Time**: 2 hrs | **Risk**: Low

**Spec reference**: FR-007, contracts/egress-allowlist.md

**Prerequisite**: T005 complete and verified RED.

Create `scripts/gen-egress-policy.mjs` per the generator contract. Never writes files (both forms are piped by their consumer, so no generated artifact can fall stale in git). `--forge-host` optional; absent → omit cleanly, exit 0, mirroring the current script's unset-skips-cleanly behaviour.

**Verify GREEN**:

```bash
bash .devcontainer/verify/verify-egress-allowlist-contract.sh
```

**Expected GREEN**: `0 failures — 8 assertions passed`.

**Also run**:

```bash
node scripts/gen-egress-policy.mjs --check
```

**Expected**: exit 0.

### T007 — Point `init-firewall.sh` at the canonical list

**Type**: Implementation | **Time**: 45 min | **Risk**: Medium

**Spec reference**: FR-007

**Prerequisite**: T006 green.

Replace the inline array with a read of `gen-egress-policy.mjs --format ipset-domains`, passing `FORGE_REGISTRY_HOST` through. **Change nothing else.** The reset ordering, the "flush only our own chains, never `-X`" rule that stops dockerd's user chains being deleted, the RFC1918 bridge allows, and the re-runnable ipset refresh all stay exactly as they are — each was earned by a specific failure.

**Verify GREEN** (in the current Docker Desktop dev container, before any sandbox work):

```bash
sudo env FORGE_REGISTRY_HOST=$FORGE_REGISTRY_HOST /bin/bash .devcontainer/init-firewall.sh
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected GREEN**: firewall applies without error and `verify-firewall-allowlist.sh` passes — proving the extraction is behaviour-neutral **on the existing environment** before it is relied on in the new one.

---

## Phase 3: User Story 1 — Workstation is sandbox-capable (P1) ✅ COMPLETE

**Goal**: the workstation can run hardware-isolated microVMs with a private container engine, proven on a throwaway sandbox.

**Independent test**: create a throwaway sandbox, run a container in it, confirm the workstation's engine never sees it, destroy it.

**Status**: carried out ahead of this specification. Tasks recorded for the migration record and marked complete; evidence in `phase-0-host-prep.md` (T001).

- [X] T009 [US1] Enable the Windows Hypervisor Platform feature and reboot the workstation
- [X] T010 [US1] Install the `sbx` CLI via winget and record its version — **v0.38.0**
- [X] T011 [US1] Authenticate `sbx` against the Docker account
- [X] T012 [US1] Set the default network policy to a deny-by-default profile (`balanced`, tightened in US2)
- [X] T013 [US1] Run `sbx diagnose` and clear every flagged item
- [X] T014 [US1] Create a throwaway sandbox, run a container inside it, and confirm the Windows engine's `docker ps` never lists it
- [X] T015 [US1] Probe `/dev/kvm` inside the sandbox and record the result — **absent** (gate R2 resolved negative)
- [X] T016 [US1] Destroy the throwaway sandbox and confirm the existing dev container still opens normally

**Checkpoint**: US1 complete — the workstation hosts microVMs, and the emulator question is answered before any effort was spent on it.

---

## Phase 4: User Story 2 — Governed, audited egress with the forge reachable (P1)

**Goal**: the sandbox reaches exactly what the work needs, enforcement is untamperable from inside, refusals are audited, and the private forge is reachable for source and images.

**Independent test**: from a sandbox shell, fetch each allowlisted destination, clone/fetch/push from the forge, pull the toolchain image, then hit a non-allowlisted destination and confirm refusal plus audit entry.

**⚠ This phase contains G1 — the only gate that can end the feature.**

- [ ] T017 [US2] Create the `mcm` sandbox with explicit sizing (`--cpus 8 --memory 16`) and record the disk envelope (G7) in `specs/060-devcontainer-docker-sandbox/baseline-measurements.md`
- [ ] T018 [US2] Configure SSH access (`sbx setup ssh`) and prove `ssh mcm.sbx` lands in the VM
- [ ] T019 [US2] Apply the generated Locked Down allowlist to the `mcm` sandbox from `gen-egress-policy.mjs --format sbx-policy`
- [ ] T020 [US2] Write the sandbox egress probe suite in `.devcontainer/verify/verify-sandbox-egress.sh`
- [ ] T021 [US2] **G1 GATE** — prove forge reachability from inside the sandbox: `git clone`, `git fetch`, `git push`, and `docker pull` of the digest-pinned toolchain image
- [ ] T022 [US2] Install Node ≥18 and `@devcontainers/cli` inside the sandbox
- [ ] T023 [US2] Provision credentials by the D-07 preference order and confirm nothing relies on env vars riding the SSH session

### T020 — Write the sandbox egress probe suite

**Type**: Test | **Time**: 1 hr | **Risk**: Low

**Spec reference**: spec.md#user-story-2

**Scenarios covered**:

- US2-AC1: every allowlisted destination is reachable
- US2-AC2: a non-allowlisted destination is refused **and** appears in the audit log
- US2-AC5: enforcement cannot be altered from inside the sandbox
- US2-AC6: the workstation's loopback services are unreachable

**File**: `.devcontainer/verify/verify-sandbox-egress.sh`

Probe each destination group from the sandbox shell; probe `example.com` and require refusal; attempt to alter the policy from inside and require that it remains in effect; probe a workstation loopback service and require unreachability. Assert the audit entry exists for the refusal — a silent block and an audited block are different postures, and only the second is what FR-008 requires.

**Verify RED** (run before T019 applies the policy):

```bash
ssh mcm.sbx 'bash /workspaces/mcm/.devcontainer/verify/verify-sandbox-egress.sh'
```

**Expected RED**: exits 1 — `✗ example.com reachable — policy not enforcing` and `✗ no audit entry for refused destination` (bring-up profile is permissive; deny-by-default is not yet applied).

### T021 — G1 gate: prove forge reachability through the sandbox proxy

**Type**: Implementation / gate | **Time**: 1–3 hrs | **Risk**: **High**

**Spec reference**: FR-009, US2-AC3, US2-AC4, US2-AC7, research.md#G1

**Prerequisite**: T019, T020.

The forge is on a Tailscale overlay; sandbox egress is redirected through a host-side proxy documented as not necessarily following VPN split-tunnel routing. Prove all four operations from inside the sandbox: clone, fetch, push, and `docker pull` of `MCM_DEVCONTAINER_IMAGE` onto the **sandbox's** engine.

**If unreachable**, in order: (1) `DOCKER_SANDBOXES_PROXY=system` routing; (2) a Tailscale subnet-router or hostname exposure. If neither works, **stop the feature here** — record the finding in `research.md`, close US2 with scenario 7 satisfied, and retain the current environment. That is a legitimate result, not a failure to try hard enough.

**Verify GREEN**:

```bash
ssh mcm.sbx 'cd /workspaces/mcm && git fetch --dry-run && git push --dry-run && docker pull "$MCM_DEVCONTAINER_IMAGE"'
```

**Expected GREEN**: all three succeed; `docker images` on the sandbox engine lists the pulled digest.

**Also run**:

```bash
ssh mcm.sbx 'bash /workspaces/mcm/.devcontainer/verify/verify-sandbox-egress.sh'
```

**Expected**: 0 failures — allowlist reachable, `example.com` refused and audited, host loopback unreachable.

**Checkpoint**: US2 complete — the migration is viable. Nothing beyond this point is worth attempting until G1 is green.

---

## Phase 5: User Story 3 — Unprivileged dev container on the sandbox's own engine (P1)

**Goal**: the dev container runs unprivileged with no engine inside it, drives the sandbox's engine, and keeps the existing toolchain, caches and workflows.

**Independent test**: bring the dev container up from a clean clone; assert no daemon inside, unprivileged from the VM, invisible from Windows, toolchain and caches unchanged.

**Contains G2 (engine seam) and G3 (workspace path).**

- [ ] T024 [US3] Write `.devcontainer/verify/verify-engine-seam.sh` (in-container, `--vm-check`, `--host-check` modes) per contracts/verify-harness.md
- [ ] T025 [US3] Write `.devcontainer/verify/verify-workspace-path.sh` with the sibling-probe assertion
- [ ] T026 [US3] Create `.devcontainer/sandbox/devcontainer.json` — `docker-outside-of-docker:1`, `"runArgs": ["--network=host"]`, no `privileged`, no `DOCKER_CONFIG`
- [ ] T027 [US3] Clone the repository on the VM at `/workspaces/mcm` and bring the dev container up with `devcontainer up --workspace-folder /workspaces/mcm --config .devcontainer/sandbox/devcontainer.json`
- [ ] T028 [US3] **G2 GATE** — run `verify-engine-seam.sh` in all three modes and confirm green
- [ ] T029 [US3] **G3 GATE** — run `verify-workspace-path.sh` and confirm the sibling probe sees the repository
- [ ] T030 [P] [US3] Update `.devcontainer/verify/verify-host-isolation.sh` to be sandbox-aware — no Windows path visible at all
- [ ] T031 [P] [US3] Update `.devcontainer/verify/verify-personal-layer.sh` to assert the RTK binary is present on the `mcm-claude` volume
- [ ] T032 [P] [US3] Update `.devcontainer/verify/verify-firewall-allowlist.sh` to read `egress-allowlist.json` instead of re-listing domains inline
- [ ] T033 [US3] Remove the Compose v5 parity pin from `.devcontainer/toolchain.Dockerfile` (it existed only to out-rank the DinD feature's apt plugin)
- [ ] T034 [US3] Run the full harness in the new dev container and confirm every check green

### T024 — Write the engine-seam check

**Type**: New file (test) | **Time**: 2 hrs | **Risk**: Medium

**Spec reference**: spec.md#user-story-3, contracts/verify-harness.md

**Scenarios covered**:

- US3-AC1: no container-engine daemon runs inside the dev container
- US3-AC2: the dev container is not privileged
- US3-AC3: container operations execute on the sandbox's engine
- US3-AC4: the Windows engine sees neither the dev container nor anything it creates

**File**: `.devcontainer/verify/verify-engine-seam.sh`

Implement the seven assertions in the harness contract across three modes. This **replaces** `verify-engine-isolation.sh`, whose pass condition (no docker socket mounted) is now false by design — the new architecture mounts one on purpose, and the reachable engine is the microVM's, not the host's. Per the repository rule, the guard is updated at the cause: the replacement must assert the new premise with at least equal force, not simply drop the old assertion.

Keep and widen the `--host-check` mode. It is the only **non-fabricable** proof, because it reads the real Windows engine.

**Verify RED** (run in the **current DinD** dev container — the check must fail there):

```bash
bash .devcontainer/verify/verify-engine-seam.sh
```

**Expected RED**: exits 1 — `✗ dockerd is running inside the container`, `✗ no docker socket present`, and (via `--vm-check`) `✗ Privileged: true`. Three assertions failing.

> If this passes on the DinD container, the check is asserting nothing. A check that is green in both environments distinguishes nothing.

### T026 — Create the sandbox dev-container variant

**Type**: Config change | **Time**: 1 hr | **Risk**: Medium

**Spec reference**: FR-013, FR-014, FR-015, FR-016, FR-019, research.md#D-01, #D-02, #D-10

**Prerequisite**: T024, T025 complete and verified RED.

Copy `.devcontainer/devcontainer.json` to `.devcontainer/sandbox/devcontainer.json` and apply the delta:

| Change | Detail |
| --- | --- |
| Feature | `docker-in-docker:2` → `docker-outside-of-docker:1`; replace the FR-004/FR-011 privileged-rationale comment with a note that the engine is the sandbox's |
| Network | add `"runArgs": ["--network=host"]` — "host" is the **sandbox VM** |
| `DOCKER_CONFIG` | **remove** — the credsStore workaround's cause is gone (headless CLI builds the container) |
| `capAdd` | keep `NET_ADMIN`/`NET_RAW` while `init-firewall.sh` lives (D-05); note the retirement path |
| Volumes, `remoteUser`, `containerEnv`, lifecycle hooks | unchanged |
| `workspaceMount`/`workspaceFolder` | still **omitted** — `--workspace-folder` supplies the matching default |

`.devcontainer/devcontainer.json` is **not modified** by this task. It must keep working on Docker Desktop until adoption (FR-019).

**Done when**: `devcontainer up --config .devcontainer/sandbox/devcontainer.json` builds and starts on the sandbox engine, and the Docker Desktop path still opens unchanged.

### T028 — G2 gate: the engine seam

**Type**: Implementation / gate | **Time**: 1 hr | **Risk**: High

**Spec reference**: SC-001, SC-002

**Prerequisite**: T024 verified RED, T026, T027.

**Verify GREEN** (in the new dev container):

```bash
bash .devcontainer/verify/verify-engine-seam.sh
```

**Expected GREEN**: `0 failures — 5 in-container assertions passed`, engine ID recorded.

**Also run** (VM-side, then host-side):

```bash
ssh mcm.sbx 'bash /workspaces/mcm/.devcontainer/verify/verify-engine-seam.sh --vm-check'
```

**Expected**: `✓ Privileged: false`.

```powershell
docker ps -a    # Windows engine — must list nothing from the sandbox
bash .devcontainer/verify/verify-engine-seam.sh --host-check
```

**Expected**: `PASS host-side` — no probe, no stack container, no dev container.

Any failure here is a design defect, not a tuning problem. Do not proceed to US4.

### T029 — G3 gate: workspace path identity

**Type**: Implementation / gate | **Time**: 30 min | **Risk**: High

**Spec reference**: FR-017, US3-AC6, research.md#D-03

**Prerequisite**: T025 verified RED, T027.

**Verify GREEN**:

```bash
bash .devcontainer/verify/verify-workspace-path.sh
```

**Expected GREEN**: `0 failures` — `pwd -P` is `/workspaces/mcm`, the sibling probe lists the repository, and `pnpm-workspace.yaml` is visible through it.

This gate exists because a path mismatch **does not error**. The sibling mounts an empty directory, the run proceeds, and the result is confidently wrong. Fix before any workload runs.

**Checkpoint**: US3 complete — `privileged` and the nested engine are gone, and it is proven from all three vantage points.

---

## Phase 6: User Story 4 — Reaching the assistant from the workstation's editor (P2)

**Goal**: open VS Code on Windows, land in a dev-container terminal, run the coding assistant.

**Independent test**: connect through and confirm the in-container markers and assistant version; then exercise the fallback once.

- [ ] T035 [US4] **G4 GATE** — connect VS Code Remote-SSH to `mcm.sbx`, then attach via the Dev Containers extension, and confirm `MCM_DEVCONTAINER=1`, `whoami` → `coder`, `claude --version`, and that the configured extensions load
- [ ] T036 [US4] Confirm `rtk gain` reports active compression in the in-container shell (constitution requirement — a silently RTK-less environment looks healthy while violating it)
- [ ] T037 [US4] Exercise the sshd-in-container fallback once (`sbx ports mcm --publish 2222:2222`) and record it as used, not theoretical
- [ ] T038 [US4] Pin the `sbx` version and add a release-notes review step to the update ritual (R5)

### T035 — G4 gate: the two-hop editor chain

**Type**: Config change / gate | **Time**: 1 hr | **Risk**: Medium

**Spec reference**: FR-022, US4-AC1, US4-AC2, research.md#D-08

Both hops are standard in isolation; their composition is not documented by Docker. If it fails, the fallback (T037) becomes the documented default and the feature continues — this gate cannot stop the migration, but its outcome decides which route the runbook presents first.

**Done when**: a dev-container terminal from the host editor reports `1`, `coder`, and a working `claude --version`, by whichever route succeeded — and the runbook records which one is primary.

---

## Phase 7: User Story 5 — Full workload parity, with sibling egress governed (P2)

**Goal**: the real workload runs at acceptable speed, and the previously unfiltered sibling egress is proved closed.

**Independent test**: run the runbook's validated sequence against sibling stacks, timed against the baseline; issue a disallowed request from inside a sibling container.

**Contains G5 (sibling egress — the security payoff) and G6 (performance).**

- [ ] T039 [US5] Bring up the stacks as siblings: `gen-dev-secrets` → `gen-dev-env` → `up-auth` → `docker-build mcm-app` → `up-mcm`
- [ ] T040 [US5] Run the integration tier with the three documented URL exports unchanged
- [ ] T041 [US5] Run the web E2E suite via the Playwright official-image recipe with the identical-path mount
- [ ] T042 [US5] Run one agent E2E spec against Anthropic
- [ ] T043 [US5] Bring up `dev-ollama` as a sibling and confirm gateway reachability via `host.docker.internal` → VM gateway
- [ ] T044 [US5] Write the sibling-egress probe in `.devcontainer/verify/verify-firewall-allowlist.sh` — a refused request originating **inside a sibling container**
- [ ] T045 [US5] **G5 GATE** — prove the sibling refusal is blocked **and** audited in `sbx policy log`
- [ ] T046 [US5] **G6 GATE** — record migrated wall-clock in `baseline-measurements.md` and compare against T003; escalate with measurements if > 1.5×
- [ ] T047 [US5] Determine whether proxy header injection reaches sibling containers (R7) and record the resulting credential posture in `research.md`
- [ ] T048 [US5] Update `scripts/devcontainer-android.sh` to refuse explicitly and legibly when `/dev/kvm` is absent, naming the alternative routes

### T044 — Write the sibling-egress probe

**Type**: Test | **Time**: 45 min | **Risk**: Low

**Spec reference**: spec.md#user-story-5, FR-025, contracts/egress-allowlist.md

**Scenarios covered**:

- US5-AC5: a sibling container's non-allowlisted request is refused, and an audit entry is produced

**File**: `.devcontainer/verify/verify-firewall-allowlist.sh`

Add a fourth probe row: run a throwaway sibling (`docker run --rm curlimages/curl`) and request a non-allowlisted destination. It must be refused. This must be a **real probe from a real sibling** — inferring it from the policy's stated scope proves nothing, and the whole security claim of this feature rests on this one assertion.

**Verify RED** (run in the **current DinD** dev container, where the residual is open by design):

```bash
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected RED**: exits 1 — `✗ sibling container reached example.com — nested-container egress unfiltered`. This is the documented 037 residual failing on purpose, which is exactly what makes the GREEN meaningful.

### T045 — G5 gate: the closed residual

**Type**: Implementation / gate | **Time**: 45 min | **Risk**: High

**Spec reference**: FR-025, SC-005

**Prerequisite**: T044 verified RED.

**Verify GREEN** (in the sandbox dev container):

```bash
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected GREEN**: `0 failures` — including `✓ sibling container refused example.com`.

**Also run**:

```powershell
sbx policy log | Select-String example.com
```

**Expected**: the sibling's refusal appears in the audit log. Blocked-but-unaudited does not satisfy FR-008; if the block is silent, the posture claim is weaker than stated and must be recorded that way.

**Checkpoint**: US5 complete — the environment works, and the headline security improvement is proven rather than asserted.

---

## Phase 8: User Story 6 — Reproducible recreate, documented, old path retired (P3)

**Goal**: anyone can recreate the environment from nothing, diagnose it, and find one current description of it.

**Independent test**: from a workstation with the tooling but no sandbox, follow the documentation to a working dev container within 15 minutes, with no undocumented step.

- [ ] T049 [US6] Snapshot the proven environment (`sbx template save mcm`) and record the recreate procedure
- [ ] T050 [US6] Write `docs/runbooks/devcontainer-sandbox.md` — lifecycle, two-layer triage order, port publishing, teardown semantics, disk pruning, foot-guns, and the two workstation gotchas
- [ ] T051 [US6] Rewrite the posture section of `docs/runbooks/devcontainer.md` and archive the DinD sections (lock deadlock, credsStore, Compose parity)
- [ ] T052 [P] [US6] Update `CLAUDE.md` — the environment gate entry and knowledge index
- [ ] T053 [P] [US6] Update `README.md` with the new environment description
- [ ] T054 [P] [US6] Update the OpenWiki **source** documents so the generator regenerates the bundle correctly (never hand-edit generated pages)
- [ ] T055 [US6] Prove recreate-from-nothing ≤ 15 min warm and record the measurement
- [ ] T056 [US6] After two consecutive incident-free weeks: collapse to a single `devcontainer.json`, delete `.devcontainer/verify/verify-engine-isolation.sh`, and stop offering the Docker Desktop path for assistant sessions

### T050 — Write the delta runbook

**Type**: Documentation | **Time**: 3 hrs | **Risk**: None

**Spec reference**: FR-030, SC-008

Must contain, at minimum:

- **Triage order** for a blocked request: `sbx policy log` **first**, then the in-VM ipset staleness reflex. Without a stated order, two allowlists cost more time than they save (R8).
- **Lifecycle**: create / stop / start / template / rm, and what each preserves. `sbx rm` is total — the VM, the engine, every sibling, every named volume, and the workspace clone. **Unpushed work is lost.**
- **Ports**: `sbx ports` publishing, and the LAN-device answer from T057 — either a `netsh portproxy` remedy or an explicit "unsupported" (R9).
- **Foot-guns**: `docker rm -f` on the dev container's own container ends the session (R11); recovery is `devcontainer up` from the VM or a template recreate.
- **Disk**: the envelope measured in T017 and a pruning practice (G7).
- **The two workstation gotchas**: `sbx` not on PATH in a fresh shell; `sandboxd` running-but-unresponsive. Both present as "the tool is broken" — which is why they need named entries rather than tribal memory.

**Done when**: the runbook contains all six sections and a developer who has never used `sbx` can follow it from install to working dev container.

### T051 — Rewrite the current runbook's posture section

**Type**: Documentation | **Time**: 1 hr | **Risk**: None

**Spec reference**: FR-021, FR-031, SC-008

The FR-011 posture statement — host-FS isolation STRONG, engine isolation MODERATE — is the honest self-assessment that justified the current design. It must be **restated, not deleted**: engine isolation from the host is now STRONG (hypervisor boundary), while isolation *within* the VM is deliberately weak and accepted because the VM is the disposable blast radius.

Archive rather than delete the DinD sections. They document real failures (the `meta.db` flock deadlock, the credsStore exit 255, the Compose parity pin) that remain true for anyone on the retained Docker Desktop path.

**Done when**: no passage describes the nested engine as the current environment, the new ledger is stated in FR-011's own honest style, and the retained-path sections are clearly marked as such.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T057 Determine whether `sbx ports` can bind non-loopback for a physical LAN device; implement the `netsh portproxy` remedy or declare the workflow unsupported (R9)
- [ ] T058 [P] Confirm `.gitignore` covers the sandbox-local env file and any kit carrying topology literals — root `.gitignore` only, no new nested file
- [ ] T059 [P] Run `verify-committed-clean.sh` and the existing secret/topology gates; confirm no forge hostname, tailnet address or credential entered git
- [ ] T060 Run `node scripts/check-openwiki-governance.mjs` and confirm the documentation changes pass the governance gate
- [ ] T061 Update `specs/060-devcontainer-docker-sandbox/research.md` with every gate's actual outcome, replacing the decision rules with what happened

---

## Dependencies

```text
Phase 1 (Setup) ──────────────────────────────────────┐
                                                       │
Phase 2 (Foundational: canonical allowlist)  ──────────┤
   T004 → T005 → T006 → T007 → T008                    │
                                                       ▼
Phase 3 (US1) ✅ complete — no blocking edges     Phase 4 (US2)
                                                   T017 → T018 → T019 → T020 → T021 (G1)
                                                                                  │
                                          ┌───────────────────────────────────────┘
                                          ▼
                                     Phase 5 (US3)
                                     T024,T025 (RED) → T026 → T027 → T028 (G2), T029 (G3)
                                                                    │
                                          ┌─────────────────────────┴────────────┐
                                          ▼                                      ▼
                                    Phase 6 (US4)                          Phase 7 (US5)
                                    T035 (G4) → T037                       T039…T045 (G5), T046 (G6)
                                          └──────────────┬───────────────────────┘
                                                         ▼
                                                   Phase 8 (US6)
                                                   T049 → T050,T051 → T055 → T056
                                                         │
                                                         ▼
                                                   Phase 9 (Polish)
```

**Hard ordering rules**

- **T003 before cutover.** The baseline is the denominator of SC-006.
- **T021 (G1) gates everything downstream.** If the forge is unreachable, the feature ends at US2 — do not start Phase 5.
- **T024/T025 must be RED before T026.** Writing the config first makes the checks trivially green and the TDD gate meaningless.
- **T044 must be RED on the current DinD container.** That RED *is* the documented 037 residual; without seeing it fail there, the GREEN proves nothing.
- **T056 is time-gated**, not effort-gated — two consecutive incident-free weeks of daily use.

## Parallel execution opportunities

| Phase | Parallel set | Why safe |
| --- | --- | --- |
| 1 | T002 ∥ T003 | different files; T003 is wall-clock-bound and can run while T002 is written |
| 5 | T030 ∥ T031 ∥ T032 | three different verify scripts, no shared state |
| 8 | T052 ∥ T053 ∥ T054 | `CLAUDE.md`, `README.md`, OpenWiki sources — distinct files |
| 9 | T058 ∥ T059 | independent gates |

Everything else is sequential: this is a migration, and each phase's gate is the precondition for the next phase being worth attempting.

## Implementation strategy

**MVP = US2.** Not US3. The smallest increment that delivers real value is *the answer to whether this migration is possible at all* — G1 either clears the way or ends the feature, and it costs a fraction of the full migration to find out. Every subsequent phase is wasted effort if G1 fails.

**Then US3** — the migration proper, and the point at which `privileged` and the nested engine are actually gone.

**Then US4 + US5 in parallel** where the workstation allows; they touch different surfaces.

**US6 last, and partly time-gated.** Documentation is written as the phases complete, but the collapse to a single configuration waits out the two-week observation window. Retiring the fallback before it has been proven unnecessary is how a migration turns a good outcome into an outage.

---

## Completion Checklist

Before marking `060-devcontainer-docker-sandbox` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: No nested engine — zero daemons in-container, `"Privileged": false`, both asserted automatically
- [ ] **SC-002**: Verification suite passes in full, including the host-side proof that the Windows engine sees nothing
- [ ] **SC-003**: A developer reaches an in-dev-container terminal running the assistant from the host editor
- [ ] **SC-004**: The assistant creates, interrogates and destroys the full stack set; 100% invisible to the workstation
- [ ] **SC-005**: Allowlisted reachable; non-allowlisted refused with audit entry **including from a sibling container**; host loopback unreachable
- [ ] **SC-006**: Integration + web E2E + one agent E2E pass at ≤1.5× the measured baseline, unmodified service map
- [ ] **SC-007**: Recreate-from-nothing ≤15 min warm, zero undocumented manual steps
- [ ] **SC-008**: Runbooks, `CLAUDE.md`, OpenWiki and `README.md` all describe the new environment; no passage presents the nested engine as current
- [ ] **SC-009**: No credential, forge hostname or tailnet address in git; existing gates pass unchanged
- [ ] **SC-010**: Emulator loss recorded as a scoped exception with named alternatives; no other workflow regressed
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `bash .devcontainer/verify/*.sh` — full harness green in the new environment (a **skipped** check counts as a failure)
- [ ] `node scripts/check-openwiki-governance.mjs` — governance gate passes
- [ ] `pnpm nx e2e mcm-app` — full-stack web E2E regression green in the new environment
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)
