# Tasks: A test run cannot take the dev sandbox's service stacks down

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

**Tests**: Mandatory (TDD), per `docs/templates/feature-test-tasks-template.md`.

## Path Conventions

- Jest configs: `frontend/mcm-app/package.json` (`jest` key), `packages/design-system/jest.config.js`
- Dev container: `.devcontainer/sandbox/devcontainer.json`
- Guard: `scripts/__tests__/dev-memory-bounds.guard.test.mjs`

### Where each check runs

The guard is plain `node --test` and runs anywhere, including the Windows host. The worker count and
the memory limit are properties of the sandbox, so they are measured there: the worker count in a
**worktree** of this branch inside the dev container (never `/workspaces/mcm`, which other sessions
share), the limit from the VM shell.

**Put node's flags before the path.** `node --test <file> --test-name-pattern x` runs everything:
arguments after the path become the script's own `argv`.

---

## Phase 1: User Story 3 — the guard (P2, written first because it is the RED for US1 and US2)

### T001 — Guard test

**Type**: Test | **Spec reference**: US3-AC1..3, FR-004, SC-004

**File(s)**: `scripts/__tests__/dev-memory-bounds.guard.test.mjs`

Discover Jest configs from `git ls-files` (plan §3), read them without executing them, and assert
FR-001 and FR-002 per file and FR-003 over the dev-container config. Also assert that discovery
found the three known configs.

**Verify RED**: `node --test scripts/__tests__/dev-memory-bounds.guard.test.mjs` on the unchanged
configs.
**Expected RED**: failures naming `frontend/mcm-app/package.json` and
`packages/design-system/jest.config.js` (no `maxWorkers`), and the missing `--memory` run argument.
The integration config passes (`maxWorkers: 1`).

---

## Phase 2: User Story 1 — cap the workers (P1)

### T002 — Jest caps

**Type**: Config | **Spec reference**: US1, FR-001, FR-002, FR-005

**File(s)**: `frontend/mcm-app/package.json`, `packages/design-system/jest.config.js`

Add `maxWorkers: 4` and `workerIdleMemoryLimit: '1.5GB'` to both (plan §1), with the rationale in
the design-system comment.

**Verify GREEN**: the T001 command; the two Jest assertions pass, the dev-container one still fails.

### T003 — Measure in the dev container

**Type**: Verification | **Spec reference**: US1-AC1, US1-AC4, SC-001

In a worktree of this branch (with its own `CI=true pnpm install --frozen-lockfile`; a symlinked
`node_modules` does not satisfy nx): run `pnpm nx test mcm-app --skip-nx-cache` with no override,
sampling the `jest-worker` process count every second. Then run once with `-- --maxWorkers=2` and
confirm 2.

**Expected**: ≤ 4 workers; 1730 passed / 0 failed / 0 skipped in 162 suites; 2 workers with the
override. Record the duration and the peak `free -m`.

---

## Phase 3: User Story 2 — contain the effect (P1)

### T004 — Dev container memory limit

**Type**: Config | **Spec reference**: US2, FR-003

**File(s)**: `.devcontainer/sandbox/devcontainer.json`

Add `"--memory=10g", "--memory-swap=10g"` to `runArgs`, with the budget from plan §2 in the comment.

**Verify GREEN**: the T001 command passes in full.

### T005 — Prove the containment

**Type**: Verification | **Spec reference**: US2-AC1, US2-AC2, SC-002, SC-003

From the VM shell, with the auth and mcm stacks up (one-time networks and volumes first —
[local-dev.md](../../docs/runbooks/local-dev.md)):

1. Recreate the dev container from this branch's config, then
   `docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}'` → `10737418240` twice.
2. Record each stack container's `StartedAt` and health.
3. In the dev container, allocate past the limit (a `node` process holding growing buffers).
4. **Expected**: the allocator exits 137 with an OOM kill in the dev container's cgroup
   (`memory.events` `oom_kill` incremented); every stack container's `StartedAt` and health are
   unchanged.

---

## Phase 4: Documentation

### T006 — Runbook

**Type**: Docs | **Spec reference**: FR-006

**File(s)**: `docs/runbooks/devcontainer-sandbox-lifecycle.md`

Add §7g (plan §4), and point the section index in `devcontainer-sandbox.md` at it.

### T007 — Closeout

Record the T003 and T005 measurements in the PR, and tick these tasks.

---

## Results (2026-11-03)

All tasks done: **T001 ✅ T002 ✅ T003 ✅ T004 ✅ T005 ✅ T006 ✅ T007 ✅**

| Task | Measured |
| --- | --- |
| T001 RED | guard on unchanged configs: **5 failures** — mcm-app and design-system (cap + idle limit each), the dev-container limit; the integration config and discovery passed |
| T002 / T004 GREEN | guard **7/7**; full `scripts/__tests__` in the dev container: 1949 passed, 0 failed, 1 skipped (`proxied grep …`, an existing RTK test: `rtk not runnable here`) |
| T003, no override | `pnpm nx test mcm-app --skip-nx-cache`: **peak 4 workers**, 1730 passed / 162 suites, 34 s, with auth + mcm stacks up; VM used 4.7 → 8.7 GB |
| T003, override | `-- --maxWorkers=2`: peak 2 workers, 1730 passed |
| T003, design-system | peak 4 workers, 131 passed |
| T005, limit | throwaway dev container built from this branch's config (`--skip-post-create`): `Memory=10737418240 MemorySwap=10737418240` |
| T005, containment | allocator inside it: exit **137**, `constraint=CONSTRAINT_MEMCG` (2026-11-01 was `global_oom`), cgroup `oom_kill` 0 → 1; every stack container's `StartedAt`, `RestartCount` (0) and health unchanged; the dev container itself kept running |

The throwaway container was used because a live session occupied the real one, and a recreate
would have ended it. The real dev container received the same limit with
`docker update --memory 10g --memory-swap 10g` (no restart); it takes it from config on its next
recreate.
