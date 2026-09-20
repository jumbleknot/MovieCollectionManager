---
type: Runbook
title: Developer environment setup (host toolchain)
description: How to provision a host development machine for MovieCollectionManager — the pinned toolchain versions (Node, pnpm, Rust, Python/uv, Android SDK) and the required companion tools (RTK output compressor, OpenWiki) — as an alternative to the devcontainer.
resource: docs/runbooks/dev-environment-setup.md
tags: [setup, toolchain, host, runbook]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-20T11:41:17.059Z
sources:
  - id: openwiki-source-8cb0da307c90adb4287997a5
    resource: repo://docs/runbooks/dev-environment-setup.md
generated: { by: "openwiki/0.5.2", at: "2026-09-20T11:41:17.059Z" }
---

# Developer environment setup (host toolchain)

Covers provisioning a **host** machine with the toolchain MovieCollectionManager's AI-assisted
workflow expects: Node.js, pnpm (via Corepack), Nx, Rust (stable), Python 3.13 + `uv`, Docker
Desktop, and the Android SDK/emulator for mobile builds. Everything here is pre-provisioned in the
[containerized dev environment](./devcontainer.md) already — this runbook exists
for the case where the containerized path isn't used, or before bringing up
[local dev infrastructure](./local-dev.md).

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
