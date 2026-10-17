---
type: Runbook
title: Developer environment setup (host toolchain)
description: How to provision a host development machine for MovieCollectionManager — the toolchain versions the repository pins (Node floor, pnpm via Corepack, Rust, Python/uv, Android SDK) and the companion tools (RTK output compressor, OpenWiki) — as an alternative to the devcontainer.
resource: docs/runbooks/dev-environment-setup.md
tags: [setup, toolchain, host, runbook]
verified:
  - by: openwiki/0.7.1
    at: 2026-10-17T03:12:52.160Z
sources:
  - id: openwiki-source-7e1c4d46c53be9bf32311e06
    resource: repo://.devcontainer/toolchain.Dockerfile
  - id: openwiki-source-8cb0da307c90adb4287997a5
    resource: repo://docs/runbooks/dev-environment-setup.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-cc2828785988d51226a4241e
    resource: repo://renovate.json
  - id: openwiki-source-ef3e1dc36da7e40bc6a337f5
    resource: repo://scripts/__tests__/wiki-maintain.guard.test.mjs
  - id: openwiki-source-238cf8b88f30f267614313be
    resource: repo://scripts/check-toolchain-consistency.mjs
  - id: openwiki-source-c8029c93bdccd81963968b22
    resource: repo://tools/openwiki-generator/package.json
  - id: openwiki-source-012d67e0a1df20ece216c0d0
    resource: repo://tools/openwiki-generator/pnpm-workspace.yaml
generated: { by: "openwiki/0.7.1", at: "2026-10-17T03:12:52.160Z" }
---

# Developer environment setup (host toolchain)

Covers provisioning a **host** machine with the toolchain MovieCollectionManager's AI-assisted
workflow expects: Node.js (LTS, floor `>=22.13` set by root `package.json` `engines.node`), pnpm
(via Corepack — the exact version pinned by root `package.json` `packageManager`, currently
`pnpm@12.13.0`), Nx (workspace, via `pnpm nx`), Rust (stable), Python 3.13 + `uv`, Docker Desktop
24+, OpenJDK 17, and the Android SDK (Platform 36 as the `compileSdk` the pinned React Native's
Gradle version catalog sets, with Build Tools and an Emulator API 34 system image) for mobile
builds. Everything here is pre-provisioned in the
[containerized dev environment](./devcontainer.md) already — the toolchain image bakes Node from
a `node:24-bookworm` base, resolves pnpm from `packageManager` via Corepack, and installs Android
SDK platform/emulator packages for its `ANDROID_API=34` build arg — this runbook exists
for the case where the containerized path isn't used, or before bringing up
[local dev infrastructure](./local-dev.md).

The `engines.node` floor is the repo's single Node requirement, and it is **enforced**, not
documented: `scripts/check-toolchain-consistency.mjs` reads every `node-version:` in the workflows
and every `FROM node:<v>` in the pinned Dockerfiles and fails the build for any pin below it. The
floor was set from pnpm 11's own `engines` (`>=22.13`); pnpm 12 declares only `>=18`, and the floor
was deliberately **not** lowered — raise it whenever `packageManager` moves to a manager with a
higher floor, or the gate keeps passing pins that manager refuses to run on.

> **Don't hardcode exact patch versions here.** Node and pnpm patch pins drift independently across
> contexts in this repo (CI workflows pin Node `24.19.0` while `frontend/mcm-app/Dockerfile` pins
> `24.21.0`) and are enforced for internal agreement by
> `scripts/check-toolchain-consistency.mjs`, not by this page. Point at the source of truth
> (`engines.node`, `packageManager`, `.devcontainer/toolchain.Dockerfile`) rather than repeating a
> number that will go stale.

## Gotchas

- **Install the pnpm version Corepack resolves from `packageManager`; never `corepack prepare
  pnpm@latest`.** The field is declared exactly once, in the **root** manifest — a workspace
  manifest that declares its own `packageManager` silently wins for anything run inside that
  directory and is maintained by Renovate on its own track, so the consistency gate fails a
  non-root declaration *including one whose value agrees*. Inside the repo, `corepack enable` plus
  `pnpm --version` must print the `packageManager` version.
- **Pin OpenWiki to the exact version the devcontainer toolchain image installs.** A version skew
  between the host and container workspaces can produce structurally different wiki bundles for the
  same repository state — check `.devcontainer/toolchain.Dockerfile` for the pinned version before
  installing globally (currently `openwiki@0.7.1`, with `mermaid` and `jsdom` beside it).
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
  floor that OpenWiki also requires — above this repo's own `>=22.13` floor).

## How the generator's version is held in step

The dev container bakes a global `openwiki` + `mermaid` + `jsdom` into its toolchain image; a CI
runner has no such copy, so the wiki-maintain job installs the same three from the **committed
lockfile** in `tools/openwiki-generator/` (`pnpm --dir tools/openwiki-generator install
--frozen-lockfile`, exact pins only, with a three-day `minimumReleaseAge` cooldown so a lockfile
regeneration cannot drag in a package published minutes ago). The two halves must name the same
version and the same peer set: `scripts/__tests__/wiki-maintain.guard.test.mjs` reads the
container's real install command line and fails if they diverge, which is why Renovate moves both in
one grouped PR. A host install that ignores the container's pin therefore diverges from both the
container and CI.

Full pinned-version table, per-tool install commands, and the Claude Code plugin list:
`docs/runbooks/dev-environment-setup.md`.
