# Contract: Committed Dev-Container Config + Verification Commands

**Feature**: 037-containerized-dev-env | **Date**: 2026-07-11

Two contracts this feature exposes: (A) the **committed configuration surface** any conformant runner consumes, and (B) the **verification-command contract** mapping each success criterion to a runnable check with a defined pass condition. Field-level rules are in [data-model.md](../data-model.md).

---

## A. Configuration Contract (what runners consume)

The `.devcontainer/` directory MUST be conformant to the [dev container spec](https://containers.dev) such that it resolves under **both** runners with zero edits:

- **Interactive**: VS Code "Dev Containers: Reopen in Container" (or "Clone Repository in Named Container Volume").
- **Headless**: `devcontainer up --workspace-folder <clone>` (`@devcontainers/cli`).

**Contract guarantees** (verified by section B):

| # | Guarantee | Runner-observable signal |
|---|---|---|
| C1 | Opens with an in-container integrated terminal; `claude` on `PATH` | `devcontainer exec … which claude` → path; `claude --version` → version |
| C2 | Runs as non-root, no host reach | `id -u` ≠ host user; host-only marker path absent |
| C3 | In-container Docker engine works and is host-independent | `docker run` inside succeeds; host `docker ps` omits it |
| C4 | Dev-server ports forwarded (this project's real ports) | host reaches `localhost:8081` (Metro/web/dev-BFF) when a dev server runs inside; `:8082`/`:8099` when the containerized BFF / Keycloak run in-container. Legacy `19000/19001/19006` are unused |
| C5 | Source on Linux named volume | workspace path is inside the container FS, not `/mnt/*`/NTFS |
| C6 | Default-deny egress with allowlist | disallowed host unreachable; allowlisted registry reachable |
| C7 | Reproducible | `delete` then `up` yields an equivalent environment, no prompts |
| C8 | Portable | identical `devcontainer.json` runs under the CLI runner unmodified |

---

## B. Verification-Command Contract (SC → check → pass condition)

Each row is realized by a script in `.devcontainer/verify/` (or a quickstart step) and is authored **RED-first** (fails before `.devcontainer/` exists), then GREEN.

| SC | Check (conceptual) | Pass condition |
|---|---|---|
| **SC-001** | From inside: attempt to read a known host-only file (e.g., a sentinel in the Windows user profile) and enumerate host credential/SSH stores | Read fails (path absent); no host `~/.ssh`, no host credential store present; in-container marker `MCM_DEVCONTAINER=1` present |
| **SC-002** | Inside: `docker build` a trivial image + `docker run` it; then on the **host** list containers | In-container build+run exit 0; host `docker ps -a` does **not** list the in-container container/image |
| **SC-003** | Run the bundler inside; edit a component; observe reload | Reload latency not perceptibly slower than native (qualitative, recorded in quickstart) |
| **SC-004** | Time a cold `devcontainer build` and a warm `up` | cold < 5 min; warm < 15 s |
| **SC-005** | `devcontainer delete` then `devcontainer up` from the committed def | Environment recreated with **0** manual steps; verify-host-isolation + verify-engine-isolation still pass |
| **SC-006** | `devcontainer up` (CLI runner) on a fresh clone of the committed def | Builds and runs unmodified; C1–C3 hold under the CLI runner |
| **SC-007** | Start a dev server inside; connect from a browser and a physical device over LAN (tunnel fallback) | App loads via the forwarded address on both |
| **SC-008** | Grep the published posture + updated PRD for privilege claims | **0** statements claiming "no privileged / unprivileged environment"; the moderate-engine-isolation caveat is present |
| **SC-009** | Run a full working session (backend/web/bundler + a compose-based integration test) entirely in-container | No host-side fallback needed (native mobile excepted) |

**Non-fabrication rule** (constitution): a verification script MUST fail if the environment is genuinely broken. No script may "fix up" the environment to force a pass; SC-002's isolation proof in particular must observe the *real* host engine, not a stub.
