---
type: Convention
title: Package-manager enforcement (pnpm only)
description: Why npm and yarn are hard-blocked rather than merely discouraged — the root package.json preinstall script that runs only-allow pnpm, and how it fails a fresh clone before anything is written.
tags: [pnpm, package-manager, tooling, monorepo]
timestamp: 2026-07-30T12:53:48+00:00
---

# Package-manager enforcement (pnpm only)

pnpm is the only sanctioned package manager for the JavaScript/TypeScript workspace (cargo for Rust);
npm and yarn are prohibited outright, not just discouraged in docs. The root `package.json`'s
`preinstall` script enforces this mechanically:

```json
"preinstall": "npx --yes only-allow pnpm"
```

## Gotchas

- **pnpm only - npm and yarn are hard-blocked by the root package.json preinstall running
  only-allow pnpm (feature 006), so npm install aborts on a fresh clone before writing anything.**
  `npm install` / `yarn install` abort with a clear "Use pnpm install" message before any package is
  written; `pnpm install` passes. In a tree that already has pnpm's symlinked `node_modules`, npm
  instead crashes even earlier in its own arborist — also blocked, just less cleanly.
- **The guard is a `preinstall` hook, not a documentation convention** — it fires under whatever
  package manager the developer actually invoked, so it reliably catches npm/yarn regardless of what
  CLAUDE.md says. See `specs/006-clean-flakiness/research.md` for why the alternative
  (`engines`/`engine-strict` alone) was rejected as fragile and bypassable.
- **Always use `pnpm install`.** There is no supported recovery path through npm or yarn — the
  workspace's symlinked `node_modules` layout and `pnpm-workspace.yaml` project list assume pnpm.
- **The pnpm VERSION is declared exactly once, in the ROOT `package.json`'s `packageManager` — a
  workspace package must never declare its own.** corepack and pnpm resolve that field from the
  *nearest* `package.json` above the working directory, so a second copy silently wins for anything
  run inside that package, and Renovate's built-in npm manager extracts it from every manifest and
  maintains each copy as a separate dependency on its own track. Measured 2026-08-29 (item #286):
  `frontend/mcm-app/package.json` held a copy written as `pnpm@10.33.0` by the npm→pnpm migration
  alongside the root's; later bumps moved the root only, Renovate carried the app copy to `10.34.5`,
  and the root reached `11.22.0` — a whole major apart, with the Dependency Dashboard proposing a
  `pnpm to v11` update against the shadow pin. `check-toolchain-consistency.mjs` now fails any
  non-root manifest declaring the field, **including one whose value agrees**: the rule is "declared
  once", not "declared consistently", because an agreeing copy is one bot PR away from drifting.

See [Nx as the universal task runner](/openwiki/invariants/nx-task-runner.md) for how installed
dependencies are then invoked — every build/test/lint/deploy command goes through Nx, not through
package-manager scripts directly.
