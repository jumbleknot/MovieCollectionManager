# Runbook: Developer Environment Setup

> How to set up a **host** development machine for MovieCollectionManager and the day-to-day
> code workflows that aren't infrastructure operations. For the fully containerized alternative
> (everything below pre-provisioned in a disposable Linux container) see
> [devcontainer.md](devcontainer.md); to bring up the local stacks once the toolchain is
> installed, see [local-dev.md](local-dev.md).

The AI-assisted workflow relies on a standard toolchain. In the dev container it is all
pre-provisioned; on the host, install it once with the steps below.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 24.14.1 (LTS) | Frontend + BFF runtime |
| pnpm | via Corepack (`pnpm@10.33.0`) | JavaScript/TypeScript package manager |
| Nx | workspace (via `pnpm nx`) | Task runner (JS/TS + Rust + Python) |
| Rust | stable toolchain | mc-service |
| Python | 3.13 + `uv` | Agent layer, Specify CLI |
| Docker Desktop | 24+ | Infrastructure / test stacks |
| Open JDK | 17 | Android builds (mobile only) |
| Android Studio | SDK Platform 35 + Build Tools + Emulator | Android builds/emulator (mobile only) |
| Keycloak | (containerized) | IAM — runs via the `auth` stack |

## Installation

### 1. Git + GitHub CLI

```bash
winget install --id GitHub.cli --source winget
gh auth login
```

Install [git](https://git-scm.com/downloads).

### 2. VS Code + AI assistant

1. Install [Visual Studio Code](https://code.visualstudio.com/download).
2. Install the [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension (preferred), and/or [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat).

### 3. Python toolchain (uv + Specify CLI)

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) (Python package manager).
2. Install the Specify CLI (GitHub Spec Kit) in a new terminal:

   ```bash
   uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
   ```

   [Spec Kit install details](https://github.com/github/spec-kit/blob/main/README.md#1-install-specify-cli).

### 4. Docker Desktop

Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/) and make sure it is running.

### 5. Rust

1. Install [Rust](https://www.rust-lang.org/tools/install) (`rustup`).
2. **Windows only** — install the C++ build toolchain that native crates link against:
   1. Download [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
   2. Run the installer and select the **"Desktop development with C++"** workload.
   3. Complete the install (~5–8 GB), then restart your terminal.
3. Set the stable toolchain, add the language server, and install the cargo utilities used across the workflow (supply-chain + code-quality helpers):

   ```bash
   rustup default stable
   rustup component add rust-analyzer
   cargo install cargo-audit cargo-deny cargo-outdated cargo-machete cargo-semver-checks cargo-geiger cargo-expand cargo-bloat cargo-mutants
   ```

   (`cargo-tarpaulin` is a dev dependency of `backend/mc-service` for coverage — no global install needed.)
4. Install the Rust Claude Code plugins from a Claude Code session:

   ```text
   /plugin install rust-analyzer-lsp@claude-plugins-official
   /plugin marketplace add actionbook/rust-skills
   /plugin install rust-skills@rust-skills
   /reload-plugins
   ```

5. Install the [rust-analyzer](https://code.visualstudio.com/docs/languages/rust) VS Code extension.

### 6. RTK (Rust Token Killer)

A transparent CLI proxy that intercepts, filters, and compresses terminal command output before
it reaches the assistant's context (~89% token savings — **mandatory** for AI-assisted sessions):

```bash
cargo install --git https://github.com/rtk-ai/rtk
rtk init -g
```

Verify with `rtk gain` (> 80% compression expected after the first test run).

### 7. React Native / Expo (mobile toolchain)

Follow the [React Native environment setup](https://reactnative.dev/docs/set-up-your-environment). This project uses:

- Node.js **24.14.1**
- Open **JDK 17**
- Android Studio with **Android SDK Platform 35**, SDK Build Tools, and Android Emulator

Then:

1. **pnpm via Corepack** (bundled with Node):

   ```bash
   corepack enable
   corepack prepare pnpm@latest --activate
   pnpm --version          # confirms install
   pnpm setup              # sets the global bin directory
   ```

2. **EAS (Expo Application Services):**

   ```bash
   pnpm add -g eas-cli
   ```

   [Create an Expo account and log in](https://docs.expo.dev/get-started/set-up-your-environment/?mode=development-build#create-an-expo-account-and-login).

3. **React Native / Expo Claude Code plugins:**

   ```text
   /plugin marketplace add callstackincubator/agent-skills
   /plugin install react-native-best-practices@callstack-agent-skills
   /plugin install upgrading-react-native@callstack-agent-skills
   /plugin install expo/skills
   /reload-plugins
   ```

### 8. Other Claude Code plugins

Frontend Design, Superpowers, Context7, Code Review, Security Guidance, `pyright-lsp`,
`ai` (Pydantic AI, claude-plugins-official), `langsmith-tracing` (langchain-ai),
`langchain-community` (Codeblockz).

### 9. Clone + Nx

```bash
git clone https://github.com/jumbleknot/MovieCollectionManager.git
cd MovieCollectionManager
pnpm install                                  # installs Nx + all workspace deps
pnpm dlx skills add nrwl/nx-ai-agents-config  # configure Nx for AI assistants
```

The Nx plugins (`@nx/expo`, `@monodon/rust`, `@nx/playwright`, `@nxlv/python`) are already
declared in the workspace `package.json`, so `pnpm install` provisions them — no per-plugin
`nx add` needed. Install the [Nx Console](https://marketplace.visualstudio.com/items?itemName=nrwl.angular-console) VS Code extension for target discovery.

### 10. Docker networks, volumes, and Keycloak

Create the shared external networks and named volumes the stacks expect, then generate
per-machine secrets — the authoritative, full list lives in
[local-dev.md](local-dev.md#local-dev-infrastructure):

```bash
docker network create backend-network
docker network create keycloak-network
docker network create movie-assistant-mcp-network
# + the named volumes and `node scripts/gen-dev-secrets.mjs` — see local-dev.md
```

Bring up Keycloak with `pnpm nx up-auth infrastructure-as-code`; the dev realm (with clients,
roles, and test users) is **auto-imported** on first start — there is no separate realm-seed
script to run. Compose details: [keycloak/README.md](../../infrastructure-as-code/docker/keycloak/README.md).

Then start the app: `cd frontend/mcm-app && pnpm start` (press `w` for web, `a` for Android).
Full bring-up ordering, profiles, and env-var tables: [local-dev.md](local-dev.md).

## Working in the codebase

### Adding a new mc-service endpoint

mc-service is strict 4-layer Clean Architecture (Domain → Application → Adapters → API); outer
layers import inner, never the reverse. Full layer reference:
[MCM-Architecture.md](../MCM-Architecture.md). To add an endpoint, touch the layers inside-out:

1. **Domain** (`src/domain/`) — add entity fields or a validation `Specification<T>`.
2. **Application** (`src/application/`) — add the `Command`/`Query` struct + handler in
   `commands/` or `queries/`; add the method to the repository port in `ports/`.
3. **Adapters** (`src/adapters/mongodb/`) — implement the new port method (BSON ↔ domain).
4. **API** (`src/api/`) — add the Axum handler, register the route in `router.rs`, and wire the
   handler into `AppState` in `state.rs`.

Unit tests live **inline** in the same source file (`#[cfg(test)] mod tests { ... }`);
integration tests live in `backend/mc-service/tests/integration/`.

### Coverage gates

| Project | Tool | Threshold | Command |
|---------|------|-----------|---------|
| mcm-app | Jest | 70% lines | `pnpm nx test mcm-app --coverage` |
| mc-service | cargo-tarpaulin | 70% lines (unit + integration) | `cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov` |
| mcm-app | ESLint | zero errors | `pnpm nx lint mcm-app` |
| mc-service | clippy | zero warnings | `pnpm nx lint mc-service` |

> **mc-service unit-test coverage alone is ~29%** — by design. Clean Architecture pushes the
> MongoDB adapter and Axum API layers behind integration tests, so the **full** suite (unit +
> integration with MongoDB up) is what clears the 70% threshold. Don't read the unit-only number
> as a regression.

## See also

- [local-dev.md](local-dev.md) — bring up the four Compose stacks, profiles, env-var tables
- [devcontainer.md](devcontainer.md) — the containerized alternative to this whole setup
- [e2e-testing.md](e2e-testing.md) / [android-emulator.md](android-emulator.md) — test harnesses
- [MCM-Architecture.md](../MCM-Architecture.md) — full architecture + C4 diagrams
