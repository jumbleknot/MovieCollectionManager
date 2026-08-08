---
type: Convention
title: Nx as the universal task runner
description: Why nearly every build/test/lint/deploy command across the polyglot monorepo goes through Nx rather than the underlying tool directly, the executors that bridge Nx to cargo, pytest, and Docker Compose, and the one measured exception — interactive tools whose arguments vary per invocation.
tags: [nx, monorepo, tooling, build]
timestamp: 2026-07-26T20:11:56+00:00
---

# Nx as the universal task runner

`pnpm nx <target> <project>` is the single invocation surface for every language and every project in
the monorepo — frontend (Jest/Playwright/ESBuild via `@nx/expo` and `@nx/playwright`), Rust
(`@monodon/rust`, which shells out to `cargo` internally — pass cargo args through with `--`), and
Python (`@nxlv/python`, which shells out to `uv`). `pnpm` and `cargo` are the only sanctioned package
managers; npm/yarn are hard-blocked at `pnpm install` time.

Nx also drives most of the repository's own operational tooling — the compose stack lifecycle
(`up-auth`/`up-mcm`/`up-audit`/`up-observability`), security scans (`dast`, `sast`, `infra-scan`),
and the OpenWiki knowledge bundle itself (`wiki-update`, `okf-lint`) are Nx targets defined in
`infrastructure-as-code/project.json`, not standalone scripts a developer would discover by reading
`package.json`. **Most, not all**: a small, named class of interactive tools is invoked directly, for a
measured reason — see the first gotcha below.

## Gotchas

- **An Nx target costs ~60 s in this workspace no matter how fast the underlying command is — so
  interactive tools are invoked directly, and the dividing line is what invokes a command, not where it
  lives.** Measured 2026-08-08: `pnpm nx check-naming infrastructure-as-code` took **61 s warm** against
  **0.09 s** for `node scripts/check-resource-naming.mjs` — the same script, ~700×. Reproduced on a
  second target (`okf-lint`: 61 s vs 0.3 s), and `pnpm nx show projects` alone takes **31 s**, so the
  bulk is project-graph computation, not the task. That overhead is invisible on a gate that runs once
  per push and disqualifying for a command an agent runs several times inside one turn. Hence:
  fixed-argument gate, build, test and lifecycle operations get targets (`check-naming`, `dast`, `sast`,
  `okf-lint`, `preflight`, `up-*`); tools whose arguments vary per invocation are run as
  `node scripts/…` — today `ci-status.mjs`, `gen-dev-secrets.mjs` and `gen-dev-env.mjs`, and feature
  049's backlog tool is specified the same way for the same reason. Nothing escapes the gate by taking
  that route: their unit tests still run inside Nx, because `pnpm nx preflight infrastructure-as-code`
  runs `scripts/__tests__`. When in doubt, ask who types the command — CI and policy get targets,
  humans and agents typing varying flags do not.
- **Even a single test run goes through Nx first**, using `--` argument passthrough
  (`pnpm nx test mcm-app -- --testNamePattern "..."`). The Maestro mobile-E2E wrapper script is a
  separate exception from the interactive-tool class above — it exists only because the `e2e:mobile`
  target has no single-flow passthrough, not because of invocation latency.
- **Type-checking has its own Nx target** (`pnpm nx typecheck mcm-app`) separate from `lint` — CI's
  `affected` job runs it, and a developer who only runs `lint` locally can still push a
  type-checking regression.
- **`test:integration` is explicitly uncached** in `nx.json`'s `targetDefaults` — it depends on live
  external state (a running database, a running Keycloak) that Nx's content-hash caching cannot see,
  so caching it would silently produce stale-pass results.
- **`deploy` targets depend on `build`** — `nx.json`'s `targetDefaults` wires `deploy: { dependsOn:
  ["build"] }`, so a deploy always rebuilds first; there is no path to deploying a stale artifact
  through the Nx target itself.
- **The bare `openwiki` CLI OOMs on this repo — always invoke it through `pnpm nx wiki-update
  infrastructure-as-code`.** The Nx target sets the telemetry opt-out env var and raises the Node
  heap size; the bare CLI does neither, and the OOM is a direct consequence, not an intermittent
  flake. See [Wiki maintenance](/openwiki/process/wiki-maintenance.md).
- **`nx affected`/`nx run-many` are the sanctioned way to scope or batch work** — reach for the
  `nx-workspace` skill for querying projects/targets/dependencies and `nx-generate` for scaffolding,
  rather than hand-rolling either.

Full per-project target tables and commands: `CLAUDE.md`'s Commands section and each project's
`project.json`.
