---
type: Runbook
title: Developer environment setup (host toolchain)
description: How to provision a host development machine for MovieCollectionManager — the pinned toolchain versions (Node, pnpm, Rust, Python/uv, Android SDK) and the required companion tools (RTK output compressor, OpenWiki) — as an alternative to the devcontainer.
resource: docs/runbooks/dev-environment-setup.md
tags: [setup, toolchain, host, runbook]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-27T16:58:28.669Z
sources:
  - id: openwiki-source-7e1c4d46c53be9bf32311e06
    resource: repo://.devcontainer/toolchain.Dockerfile
  - id: openwiki-source-8cb0da307c90adb4287997a5
    resource: repo://docs/runbooks/dev-environment-setup.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-238cf8b88f30f267614313be
    resource: repo://scripts/check-toolchain-consistency.mjs
generated: { by: "openwiki/0.5.2", at: "2026-09-27T16:58:28.669Z" }
---

# Developer environment setup (host toolchain)

Covers provisioning a **host** machine with the toolchain MovieCollectionManager's AI-assisted
workflow expects: Node.js (LTS, floor `>=22.13` set by root `package.json` `engines.node`), pnpm
(via Corepack — the exact version pinned by root `package.json` `packageManager`, currently
`pnpm@11.25.0`), Nx (workspace, via `pnpm nx`), Rust (stable), Python 3.13 + `uv`, Docker Desktop
24+, OpenJDK 17, and the Android SDK (Platform 36 as the `compileSdk` the pinned React Native's
Gradle version catalog sets, with Build Tools and an Emulator API 34 system image) for mobile
builds. Everything here is pre-provisioned in the
[containerized dev environment](./devcontainer.md) already — the toolchain image bakes Node from
a `node:24-bookworm` base, resolves pnpm from `packageManager` via Corepack, and installs Android
SDK platform/emulator packages for its `ANDROID_API=34` build arg — this runbook exists
for the case where the containerized path isn't used, or before bringing up
[local dev infrastructure](./local-dev.md).

> **Don't hardcode exact patch versions here.** Node and pnpm patch pins drift independently across
> contexts in this repo (for example CI workflows currently pin Node `24.19.0` while the BFF/prod
> Docker images pin `24.14.1`) and are enforced for internal agreement by
> `scripts/check-toolchain-consistency.mjs`, not by this page. Point at the source of truth
> (`engines.node`, `packageManager`, `.devcontainer/toolchain.Dockerfile`) rather than repeating a
> number that will go stale.

## Gotchas

- **Pin OpenWiki to the exact version the devcontainer toolchain image installs.** A version skew
  between the host and container workspaces can produce structurally different wiki bundles for the
  same repository state — check `.devcontainer/toolchain.Dockerfile` for the pinned version before
  installing globally.
- **Never invoke the bare `openwiki` CLI on this repo — always go through the Nx target.** The bare
  CLI omits the telemetry opt-out and the raised Node heap size, and reliably OOMs; see
  [OpenWiki bundle generation and maintenance](../process/wiki-maintenance.md) and
  [Nx as the task runner](../invariants/nx-task-runner.md).
- **Never run `openwiki --init` on this repo.** `--update` creates the bundle when none exists,
  which avoids triggering the interactive onboarding wizard and the out-of-repo `.openwiki/.env`
  file it would otherwise write.
- **Windows requires the "Desktop development with C++" Visual Studio Build Tools workload** before
  `cargo build` succeeds — native crates link against it, and skipping it produces a build failure
  disconnected from the missing-toolchain root cause.
- **RTK (Rust Token Killer) is mandatory for AI-assisted sessions**, not optional tooling — it
  compresses terminal output before it reaches the assistant's context (~89% token savings measured);
  skipping it materially degrades agent session quality on this repo's verbose toolchains.
- **Regenerate any wiki bundle before committing it** by running the wiki-update Nx target and
  gating with `pnpm nx okf-lint infrastructure-as-code` — an ungated regeneration can drift from the
  conformance rules silently.
- **Install `mermaid` and `jsdom` as peer dependencies alongside `openwiki` — omitting them silently
  degrades diagram fences to plain text.** From OpenWiki 0.5.x, `mermaid` and `jsdom` are optional
  peer dependencies; without them the generator falls back to a weaker built-in fence check and
  rewrites any Mermaid diagram it cannot verify into a plain `text` fence. The run still exits 0 and
  every gate still passes — the only symptom is a diagram quietly downgraded to preformatted text,
  with no error, no warning, and no diff context to flag it. Install all three packages together at
  the same version the devcontainer toolchain image pins (see
  `docs/runbooks/dev-environment-setup.md` §6a for the exact invocation and the Node ≥ 22.22
  floor that OpenWiki 0.5.x also requires).

Full pinned-version table, per-tool install commands, and the Claude Code plugin list:
`docs/runbooks/dev-environment-setup.md`.
