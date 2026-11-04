# Implementation Plan: A test run cannot take the dev sandbox's service stacks down

**Spec**: [spec.md](./spec.md) | **Branch**: `chore/sbx-v0.51-shell-kit` (PR #929)

## Summary

Two independent layers. **Bound the cause:** cap every Jest configuration at 4 workers and recycle
workers that grow past 1.5 GB. **Contain the effect:** give the sandbox dev container a 10 GiB memory
limit, so the kernel's choice of victim is made inside it rather than across the whole VM. A guard
test keeps both from regressing, and finds new Jest projects by itself.

## Technical Context

- Jest 29.7 (`jest-worker` 29.7.0): `maxWorkers` accepts an integer or a percentage;
  `workerIdleMemoryLimit` accepts a size string and is checked after each test file. A CLI
  `--maxWorkers` overrides the config value.
- Docker 29 on the sandbox VM: `--memory` sets the cgroup limit; `--memory-swap` equal to it means
  no swap (the VM has none anyway, so this states intent rather than changing behaviour).
- The dev container is created by `devcontainer up` from `.devcontainer/sandbox/devcontainer.json`;
  `runArgs` are passed to `docker run` verbatim.
- Guard tests run under `node --test` (`scripts/__tests__/*.guard.test.mjs`) in the guardrail gate
  and in `pnpm nx preflight infrastructure-as-code`.

## Design

### 1. Jest caps

| File | Change |
| --- | --- |
| `frontend/mcm-app/package.json` → `jest` | `"maxWorkers": 4`, `"workerIdleMemoryLimit": "1.5GB"` |
| `packages/design-system/jest.config.js` | `maxWorkers: 4`, `workerIdleMemoryLimit: '1.5GB'` |
| `frontend/mcm-app/jest.integration.config.js` | unchanged (`maxWorkers: 1`) |

**Why an integer, not a percentage.** The constraint is memory, and memory per worker does not
scale with core count. `25%` would be 5 workers here and 4 on CI, and would grow on a larger
machine with the same RAM. 4 workers ran the full mcm-app suite in 24 s (spec baseline).

**Why 1.5 GB for the idle limit.** Workers peak around 0.9 GB. A limit below that would recycle
healthy workers after nearly every file; 1.5 GB recycles only a worker that kept growing, which is
the leak case it exists for.

`package.json` cannot carry a comment, so the rationale lives in the design-system config's comment
and in the guard test's header, which links this spec.

### 2. Dev container memory limit

`.devcontainer/sandbox/devcontainer.json` → `runArgs` gains `"--memory=10g", "--memory-swap=10g"`,
with a comment carrying the budget:

| VM, 15.7 GiB | GiB |
| --- | ---: |
| dev container limit | 10 |
| dockerd | ~1 |
| auth + mcm stacks (Keycloak JVM ~1.3, Mongo ×2, BFF, Redis, Postgres, …) | ~2 |
| headroom (Ollama, observability stack when up) | ~2.7 |

The Docker Desktop config is not touched (out of scope; it is retained only for the emulator).

### 3. Guard — `scripts/__tests__/dev-memory-bounds.guard.test.mjs`

- Discover Jest configs with `git ls-files`: files named `jest.config.*` / `jest.*.config.*`, and
  `package.json` files carrying a `jest` key. Excluded: anything under `node_modules`.
- Read values **without executing** the config: JSON for `package.json`; a regex over the source
  (`maxWorkers:\s*(\d+)`, `workerIdleMemoryLimit:`) for JS configs. Executing a config would run
  its side effects (env loading, preflights) inside a guard test.
- Assert FR-001/FR-002 per file, naming the file on failure; assert that discovery found at least
  the three known configs, so an empty discovery cannot pass vacuously.
- Assert FR-003 over `devcontainer.json`'s text: one `--memory=<N>g` and one `--memory-swap=<N>g`,
  equal, N = 10.

### 4. Runbook

`docs/runbooks/devcontainer-sandbox-lifecycle.md` §7e gets a sibling, **§7g — memory**: the
2026-11-01 signature (OOM kill of a bystander, not of the cause), the budget, `docker update` for a
running container, and the guard's name.

## Tests

| Spec | Test | Where |
| --- | --- | --- |
| US3, SC-004 | the guard, RED on `main`, GREEN after | `node --test scripts/__tests__/dev-memory-bounds.guard.test.mjs` |
| US1, SC-001 | worker count + counts, no override | dev container, worktree of this branch |
| US2, SC-002/003 | `docker inspect` + an over-limit allocation with stacks up | sandbox VM |

## Risks

- **A slower CI unit leg.** Bounded: 24 s locally at 4 workers; CI previously used up to 15.
- **The limit kills something wanted.** By design it kills inside the dev container. A session
  losing a process is recoverable; Keycloak losing its realm cache mid-E2E is what this prevents.
- **The guard's regex misses an exotic config shape** (a computed `maxWorkers`). It then fails, which
  is the safe direction: the author states the cap literally.
