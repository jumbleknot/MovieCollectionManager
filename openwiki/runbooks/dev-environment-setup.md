---
type: Runbook
title: Developer environment setup (host toolchain)
description: How to provision a host development machine for MovieCollectionManager — the pinned toolchain versions (Node, pnpm, Rust, Python/uv, Android SDK) and the required companion tools (RTK output compressor, OpenWiki) — as an alternative to the devcontainer.
resource: docs/runbooks/dev-environment-setup.md
tags: [setup, toolchain, host, runbook]
timestamp: 2026-07-28T01:56:50+00:00
---

# Developer environment setup (host toolchain)

Covers provisioning a **host** machine with the toolchain MovieCollectionManager's AI-assisted
workflow expects: Node.js, pnpm (via Corepack), Nx, Rust (stable), Python 3.13 + `uv`, Docker
Desktop, and the Android SDK/emulator for mobile builds. Everything here is pre-provisioned in the
[containerized dev environment](/openwiki/runbooks/devcontainer.md) already — this runbook exists
for the case where the containerized path isn't used, or before bringing up
[local dev infrastructure](/openwiki/runbooks/local-dev.md).

## Gotchas

- **Pin OpenWiki to the exact version the devcontainer toolchain image installs.** A version skew
  between the host and container workspaces can produce structurally different wiki bundles for the
  same repository state — check `.devcontainer/toolchain.Dockerfile` for the pinned version before
  installing globally.
- **Never invoke the bare `openwiki` CLI on this repo — always go through the Nx target.** The bare
  CLI omits the telemetry opt-out and the raised Node heap size, and reliably OOMs; see
  [OpenWiki bundle generation and maintenance](/openwiki/process/wiki-maintenance.md) and
  [Nx as the task runner](/openwiki/invariants/nx-task-runner.md).
- **Never run `openwiki --init` on this repo.** `--update` creates the bundle when none exists,
  which avoids triggering the interactive onboarding wizard and the out-of-repo `.openwiki/.env`
  file it would otherwise write.
- **Windows requires the "Desktop development with C++" Visual Studio Build Tools workload** before
  `cargo build` succeeds — native crates link against it, and skipping it produces a build failure
  disconnected from the missing-toolchain root cause.
- **RTK (Rust Token Killer) is mandatory for AI-assisted sessions**, not optional tooling — it
  compresses terminal output before it reaches the assistant's context (~89% token savings measured);
  skipping it materially degrades agent session quality on this repo's verbose toolchains.
- **Check for staleness before regenerating** — `pnpm nx okf-lint infrastructure-as-code --
  --check-coverage` is a free, no-model-call check; only run the wiki-update Nx target if it reports
  drifted concepts or uncited documents, then gate the result with `pnpm nx okf-lint
  infrastructure-as-code`. See
  [OpenWiki bundle generation and maintenance](/openwiki/process/wiki-maintenance.md).

Full pinned-version table, per-tool install commands, and the Claude Code plugin list:
`docs/runbooks/dev-environment-setup.md`.
