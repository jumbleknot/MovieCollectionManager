# Phase 1 Data Model: environment artifacts

**Feature**: 060-devcontainer-docker-sandbox | **Date**: 2026-08-15

This feature has no application data model. Its "entities" are **environment artifacts** — the things that are created, configured, asserted about and destroyed. They are modelled here because their fields, relationships and lifecycle states are what the verify harness asserts against, and because two of them (the workspace path, the destination list) have invariants that fail *silently* if unstated.

---

## Entity: Sandbox

The hardware-isolated microVM. The new blast radius.

| Field | Value / constraint | Source of truth |
| --- | --- | --- |
| `name` | `mcm` | `sbx create --name` |
| `cpus` | ≥ 8 | set explicitly at creation (D-12) — never left to default |
| `memory` | ≥ 16 GB | set explicitly at creation |
| `disk envelope` | **unknown — must be established (G7)** | measured in P1 |
| `engine` | one private Docker engine, the only engine the assistant ever touches | `docker info` inside the VM |
| `kernel` | its own — not the WSL2 kernel | `uname -a` inside the VM |
| `/dev/kvm` | **absent** (gate R2, resolved negative) | Phase 0 probe |
| `policy` | exactly one attached Network policy (below) | `sbx policy` |
| `cli version` | v0.38.0, pinned once green | `sbx version` |

**Lifecycle**: `absent → created → running ⇄ stopped → removed`

- Packages, images, config and shell history **persist** across `stop`/`start`.
- `sbx rm` is total: the VM, its engine, every sibling container, every named volume, and the workspace clone all go. **Unpushed work is lost** — this is the teardown semantic that replaces "the container is disposable, the volume is not".
- `sbx template save` snapshots a proven sandbox for fast recreate (FR-029).

**Invariant**: exactly one sandbox is the engineering environment at a time. A second sandbox with the same workspace path is a footgun, not a feature.

---

## Entity: Network policy

The deny-by-default egress allowlist attached to a sandbox.

| Field | Value / constraint |
| --- | --- |
| `profile` | Locked Down for agent use (Balanced only during bring-up) |
| `allowed destinations` | generated from the canonical list — never hand-edited |
| `enforcement point` | **host-side proxy, outside the VM** |
| `scope` | the **whole VM**, including every sibling container |
| `audit` | `sbx policy log` — the primary triage surface |
| `host localhost` | blocked by the proxy |

**Invariants**:

1. Enforcement is not modifiable from inside the VM. If it is, the isolation claim is void.
2. The policy governs sibling containers. This is the property that closes the 037 residual; it is asserted (G5), not assumed.
3. The policy's allowlist and the in-VM firewall's allowlist derive from **one** file. Divergence is the R8 failure mode.

**Relationships**: `Sandbox 1 —— 1 Network policy`; `Network policy —— derived-from —— Canonical destination list`.

---

## Entity: Canonical destination list

`.devcontainer/egress-allowlist.json` — the single in-repo source of permitted destinations.

| Field | Type | Notes |
| --- | --- | --- |
| `domain` | string | e.g. `api.anthropic.com` |
| `group` | enum | `agent` \| `source` \| `registry` \| `packages` \| `app` |
| `reason` | string | why the entry exists — preserved from the current inline comments, which are dense and load-bearing |
| `cdn_rotating` | boolean | true for Docker Hub blobs, quay/Akamai, crates, PyPI — the ipset-staleness class |

**Runtime-injected, never stored**: the forge host, supplied from `FORGE_REGISTRY_HOST`. Writing it into this file would breach the topology-scrub gate.

**Emitted forms** (both by `scripts/gen-egress-policy.mjs`, neither hand-maintained):

- sandbox policy command set → host-side enforcement
- domain array → consumed by `init-firewall.sh`

**Validation rules**:

- No entry may be a bare IP (CDN-backed hosts rotate; the list resolves by domain and is re-runnable).
- No entry may contain a forge, tailnet or otherwise topology-sensitive hostname.
- Every entry carries a non-empty `reason`. An unexplained allowlist entry is an unreviewable one.

---

## Entity: Dev container

The unprivileged workspace container. **No longer a container host.**

| Field | Before (037/038) | After |
| --- | --- | --- |
| engine feature | `docker-in-docker:2` | `docker-outside-of-docker:1` |
| `Privileged` | `true` (forced) | **`false`** |
| `capAdd` | `NET_ADMIN`, `NET_RAW` | retained only while the in-VM firewall lives (D-05) |
| daemon inside | `dockerd` running | **none** |
| network mode | own netns | `--network=host` (the **VM's** netns) |
| `remoteUser` | `coder` | `coder` (unchanged) |
| `DOCKER_CONFIG` | `/home/coder/.docker-dind` | **removed** (D-10) |
| marker | `MCM_DEVCONTAINER=1` | unchanged |
| workspace mount | bind of the opened folder | bind of `/workspaces/mcm`, path-identical |

**Lifecycle**: `absent → built → running ⇄ stopped → removed`. New foot-gun: the assistant holds the engine socket, so `docker rm -f` on its **own** container ends the session. Recovery is `devcontainer up` from the VM, or template recreate. Documented, not prevented — it is inside the accepted blast radius.

---

## Entity: Sibling containers

Application stacks (auth, mcm, audit, observability), `dev-ollama`, Playwright runners, throwaway probes.

**Relationship change** — the structural heart of this feature:

```text
BEFORE: dev container ──contains──> nested engine ──contains──> stacks
AFTER:  sandbox engine ──contains──> { dev container, stacks, dev-ollama, probes }   (all peers)
```

| Property | Consequence |
| --- | --- |
| visible in `docker ps` from the dev container | yes — for the first time, the *whole* population, not a split-brain view |
| egress governed | **yes** — by the sandbox policy (was: unfiltered) |
| reachable from the dev-container shell | via VM loopback, using the unchanged documented ports |
| `host.docker.internal` | resolves to the VM gateway; `dev-ollama` reachable as today **[verify in P5]** |
| bind-mount path resolution | against the **VM** filesystem — see Workspace |

---

## Entity: Workspace

| Field | Value |
| --- | --- |
| location | VM filesystem, `/workspaces/mcm` |
| in-container path | `/workspaces/mcm` — **must be identical** |
| origin | `git clone` from the forge, inside the sandbox |
| host exposure | none; `E:\` is never mounted |
| backup | `git push` only |

**Invariant (asserted, because it fails silently)**: `pwd -P` inside the dev container equals the VM path, **and** that path exists on the VM as seen by a sibling. A mismatch does not error — the sibling mounts an empty or wrong directory and the run continues, producing a confidently wrong result. This is why `verify-workspace-path.sh` exists rather than a convention note.

**Not usable here**: a named-volume workspace. A volume is not a VM path a sibling can bind-mount (D-03).

---

## Entity: Persistent caches

Unchanged in name and purpose; now volumes on the sandbox engine.

| Volume | Contents | Note |
| --- | --- | --- |
| `mcm-commandhistory` | shell history | |
| `mcm-cargo-registry` | crate registry | never `.rustup`/`.cargo/bin` — those are baked and must track the image |
| `mcm-cargo-git` | git crate sources | |
| `mcm-uv-cache` | Python/uv cache | |
| `mcm-pnpm-store` | pnpm store | |
| `mcm-claude` | plugins, skills, service logins, **and the RTK binary** | constitution-mandated tooling lives here — assert it (Constitution Check) |

**Invariant**: caches survive dev-container recreate. They do **not** survive `sbx rm` — a distinction the current environment does not have, and one the runbook must state plainly.

---

## Entity: Verification check

| Field | Value |
| --- | --- |
| `name` | behavior-descriptive (`verify-engine-seam.sh`), never requirement-ID-named |
| `mode` | in-container \| VM-side \| host-side |
| `exit code` | 0 pass, 1 fail — no third state |
| `governing requirement` | header comment only (sanctioned provenance comment) |

Full contract in [contracts/verify-harness.md](contracts/verify-harness.md).

**Invariant**: a check must be able to fail. `verify-engine-seam.sh` must be RED on today's DinD container and GREEN on the new one; a check that passes in both environments is asserting nothing.
