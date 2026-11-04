# Feature Specification: A test run cannot take the dev sandbox's service stacks down

**Feature Branch**: `chore/sbx-v0.51-shell-kit` (batched into PR #929)

**Created**: 2026-11-03

**Status**: Draft

**Input**: The 2026-11-01 sandbox failure — "investigate why the docker sandbox dev container is
failing … it may be space again". It was not space.

## Measured Baseline *(evidence for every claim in this spec)*

### The failure was memory, and a unit-test run caused it

Measured on the `mcm` sandbox (sbx v0.47.0, 16 GiB VM, 20 vCPUs, **no swap**) on 2026-11-01:

| Observation | Value |
| --- | --- |
| Disk, `/var/lib/docker` | 81 %, 28 GB free — **not** the cause |
| VM memory | 14 of 15 GiB used, 565 MiB free |
| Dev container (`docker stats`) | **12.29 GiB** of 15.7 GiB |
| Load average | 65 / 167 / 156 |
| Largest consumer | `pnpm nx test mcm-app`, from another session's worktree: **~19 `jest-worker` processes, 6.9 GB RSS together** |
| Kernel | `Out of memory: Killed process 9130 (java)` — Keycloak's JVM, `global_oom` |
| Consequence | `keycloak-service` in a restart loop (exit 137); both Mongo containers `unhealthy` |
| Host | 31.8 GB RAM, 1.8 GB free; sbx logging `host memory pressure: signalled guest drop-caches` |

The run finished on its own; memory fell to 3.9 GiB used and Keycloak recovered. Nothing was killed
by hand.

### Why the run was that large

Neither Jest unit config sets `maxWorkers`, so Jest uses its default of **(cores − 1)**: 19 on this
20-vCPU VM. Jest caps that at the number of test files, and mcm-app has 160.

| Config | `maxWorkers` | Test files |
| --- | --- | --- |
| `frontend/mcm-app/package.json` → `jest` | unset → 19 | 160 |
| `packages/design-system/jest.config.js` | unset → 13 (capped by file count) | 14 |
| `frontend/mcm-app/jest.integration.config.js` | `1` (serialized on purpose) | — |

nx runs up to **3 tasks in parallel** by default (`nx.json` sets no `parallel`), and CI's
`nx affected --target=lint,test,…` selects both unit suites, so the two fan-outs can stack.

### What one worker costs

Measured 2026-11-03 in the recreated dev container, with no stacks running:
`pnpm nx test mcm-app -- --maxWorkers=4` passed **1730 tests in 162 suites in 24 s**. Used memory
rose from **1.8 GB to at least 5.3 GB** (the last 3-second sample was still climbing): about
**0.9 GB per worker** at peak. The 2026-11-01 snapshot's ~450 MB per process was taken at one
moment, mid-run, and understates the peak.

### Why the kernel picked Keycloak

Every process in the VM shares one memory pool. No container has a memory limit, so a global OOM
picks the largest single process **anywhere in the VM** — and one JVM is larger than any one Jest
worker. The fan-out caused the pressure; a bystander paid for it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Running the unit tests leaves room for everything else (Priority: P1)

As a developer or agent in the dev container, when I run `pnpm nx test mcm-app` (or
design-system's, or both through `nx affected`) I want it to use a bounded number of workers, so
that the service stacks and the other sessions on this VM keep running.

**Independent Test**: run `pnpm nx test mcm-app` with no CLI override and count `jest-worker`
processes during the run.

**Acceptance Scenarios**:

1. **Given** the dev container, **When** `pnpm nx test mcm-app` runs with no `--maxWorkers`,
   **Then** at most **4** Jest workers exist at any moment, and the pass/fail/skip counts equal the
   uncapped run's (1730 / 0 / 0 across 162 suites).
2. **Given** the same, **When** `pnpm nx test design-system` runs, **Then** at most 4 workers exist.
3. **Given** a worker whose heap has grown past the idle limit after a test file, **Then** Jest
   replaces it before the next file (`workerIdleMemoryLimit`).
4. **Given** a developer who needs a different count for one run, **When** they pass
   `-- --maxWorkers=N`, **Then** N is used (the CLI still overrides config).

### User Story 2 — A runaway inside the dev container stays inside it (Priority: P1)

As the operator of this sandbox, I want the dev container to have a memory limit, so that anything
that does exhaust memory — several sessions testing at once, a leak, a build — is killed **inside
the dev container**, never Keycloak, Mongo or the BFF beside it.

**Independent Test**: inside the dev container, allocate past the limit; observe that the
allocating process is killed and that every sibling stack container keeps running.

**Acceptance Scenarios**:

1. **Given** a dev container created from `.devcontainer/sandbox/devcontainer.json`, **When**
   inspected, **Then** `HostConfig.Memory` is **10 GiB** and `HostConfig.MemorySwap` equals it.
2. **Given** the auth and mcm stacks running, **When** a process in the dev container allocates
   beyond the limit, **Then** that process is OOM-killed (exit 137) and `keycloak-service`,
   `mc-service-store-mongo` and `mcm-bff-*` keep their uptime and health.

### User Story 3 — The caps cannot be dropped silently (Priority: P2)

As a maintainer, I want a guard test that fails when a Jest config loses its cap — including a
**new** Jest project added later — or when the dev container loses its memory limit, so the bounds
outlive the memory of this incident.

**Acceptance Scenarios**:

1. **Given** any git-tracked Jest config (a `jest*.config.*` file, or a `package.json` with a `jest`
   key) whose `maxWorkers` is unset or above 4, **Then** the guard fails naming that file.
2. **Given** a Jest config allowing more than one worker without `workerIdleMemoryLimit`, **Then**
   the guard fails.
3. **Given** the sandbox `devcontainer.json` without a `--memory` run argument, or with
   `--memory-swap` different from it, **Then** the guard fails.

### Edge Cases

- **Several sessions testing at once.** Two capped runs are 8 workers (~7 GB). With editors and
  agents that can exceed 10 GiB; then the OOM kill lands on a Jest worker *inside* the dev
  container, which is the intended failure (US2). The cap reduces the frequency; the limit decides
  who pays.
- **Ollama.** `dev-ollama` is a sibling, outside the limit. A loaded 7B model takes several GB from
  the ~5.7 GiB left to the VM. Bounding Ollama is out of scope; the limit still protects the stacks
  from the dev container.
- **CI.** The runner has 16 cores; Jest there used 15 workers per suite and will now use 4. Unit
  tests ran in ~24 s with 4 workers in the dev container, so the cost is seconds, not minutes.
- **The limit applies at container creation.** An existing dev container keeps no limit until it is
  recreated (`devcontainer up --remove-existing-container`, or the harness's
  `reproducible-recreate`). `docker update --memory` applies it to a running one.

## Requirements *(mandatory)*

- **FR-001**: Every git-tracked Jest configuration MUST set `maxWorkers` to an integer between 1
  and 4.
- **FR-002**: A Jest configuration allowing more than one worker MUST set `workerIdleMemoryLimit`.
- **FR-003**: `.devcontainer/sandbox/devcontainer.json` MUST pass `--memory` and an equal
  `--memory-swap` in `runArgs`, at **10g**.
- **FR-004**: A guard test under `scripts/__tests__/` MUST enforce FR-001..FR-003, discovering Jest
  configs from `git ls-files` rather than from a fixed list.
- **FR-005**: The CLI override (`--maxWorkers=N`) MUST keep working.
- **FR-006**: The sandbox runbook MUST record the memory budget and how to apply the limit to a
  running container.

## Success Criteria *(mandatory)*

- **SC-001**: `pnpm nx test mcm-app` in the dev container, no override: ≤ 4 workers observed,
  counts 1730 / 0 / 0 in 162 suites.
- **SC-002**: The dev container reports `HostConfig.Memory` = 10737418240.
- **SC-003**: An allocation past the limit inside the dev container is OOM-killed there, while every
  stack container keeps its uptime.
- **SC-004**: The guard test fails on today's `main` (RED) and passes with this change (GREEN).

## Out of Scope

- A memory limit on Ollama or on the service stacks.
- The Docker Desktop config (`.devcontainer/devcontainer.json`), kept only for the Android emulator.
- Raising the VM's 16 GiB: the host had 1.8 GB free during the incident.
- The `python` command missing from the toolchain image (`python3` is present).
