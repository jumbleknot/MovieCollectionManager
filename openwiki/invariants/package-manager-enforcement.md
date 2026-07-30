---
type: Convention
title: Package-manager enforcement (pnpm only)
description: Why npm and yarn are hard-blocked rather than merely discouraged — the root package.json preinstall script that runs only-allow pnpm, and how it fails a fresh clone before anything is written.
resource: CLAUDE.md
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

See [Nx as the universal task runner](/openwiki/invariants/nx-task-runner.md) for how installed
dependencies are then invoked — every build/test/lint/deploy command goes through Nx, not through
package-manager scripts directly.
