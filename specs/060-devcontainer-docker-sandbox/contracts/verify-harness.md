# Contract: environment verification harness

**Feature**: 060-devcontainer-docker-sandbox | **Governing**: FR-020, FR-013, FR-014, FR-017 | **Risk closed**: R10

The harness is this feature's test suite. Every check is a shell script under `.devcontainer/verify/`, returns `0` (pass) or `1` (fail) with no third state, and prints one `✓`/`✗` line per assertion. Provenance (`Governing: FR-###`) lives in the header comment — the one sanctioned WHAT-comment under the Behavior-Descriptive Identifiers principle.

## Invocation modes

| Mode | Where it runs | Why it must exist |
| --- | --- | --- |
| **in-container** | dev-container shell | asserts what the container can see about itself |
| **VM-side** | sandbox shell (`sbx exec`) | asserts what the sandbox engine reports about the container — `Privileged`, mounts |
| **host-side** | Windows PowerShell | the only **non-fabricable** proof: it reads the real Windows engine |

A claim asserted only from inside the thing being claimed about is not proof. The host-side mode is what makes the isolation claim falsifiable.

## Harness after migration

This table is the **definition of "the full harness"** referenced by the aggregate run and the Completion Checklist. A script absent from this table is a script that can be skipped without anyone noticing, so every script the feature creates or touches appears here.

| Script | Status | Mode(s) | Asserts |
| --- | --- | --- | --- |
| `verify-engine-seam.sh` | **ADDED** — replaces `verify-engine-isolation.sh` | in-container + VM-side + host-side | the new engine boundary (below) |
| `verify-workspace-path.sh` | **ADDED** | in-container + VM-side | path identity (below) |
| `verify-egress-allowlist-contract.sh` | **ADDED** | any (pure generator check) | `gen-egress-policy.mjs` satisfies [egress-allowlist.md](egress-allowlist.md): both formats emit one stable-ordered line per destination; `--forge-host` appends to both; omitting it omits cleanly with exit 0; `--check` rejects a bare IP, an empty `reason`, an unknown `group` |
| `verify-sandbox-egress.sh` | **ADDED** | VM-side (sandbox shell) | allowlisted destinations reachable; a non-allowlisted destination refused **and audited**; policy unalterable from inside; workstation loopback unreachable |
| `verify-engine-isolation.sh` | **DELETED at adoption** | — | its premise inverts (see below) |
| `verify-host-isolation.sh` | MODIFIED | in-container | `MCM_DEVCONTAINER=1`, non-root `coder`, no host filesystem/credential mount — now also: no Windows path visible at all |
| `verify-firewall-allowlist.sh` | MODIFIED | in-container + sibling | reads the canonical list; adds the sibling-egress probe |
| `verify-personal-layer.sh` | MODIFIED | in-container | personal layer intact — **and RTK present** (constitution-mandated) |
| `verify-portable-runner.sh` | MODIFIED — **scoped**, see below | in-container | config resolves under the runner(s) that actually build it |
| `verify-toolchain-present.sh` | unchanged | in-container | Node 24, Rust, uv/Python 3.13, gh, Android SDK, OpenWiki |
| `verify-caches-persist.sh` | unchanged | in-container | the six named volumes survive recreate |
| `verify-reproducible-recreate.sh` | unchanged | VM-side | recreate from nothing |
| `verify-committed-clean.sh` | unchanged | in-container | no secret/topology literal committed |

**Twelve scripts after migration** (nine today, minus one replaced, plus three added). The aggregate run enumerates exactly these — see "Aggregate run" below.

### `verify-portable-runner.sh` is scoped, not carried unchanged

Feature 037's FR-008 requires the dev-container asset to resolve unmodified under **both** the VS Code Dev Containers extension and `@devcontainers/cli`. That dual-runner claim does not survive the move intact, and pretending it does would leave a check asserting something the design deliberately changed:

- `.devcontainer/devcontainer.json` (Docker Desktop, retained until adoption) — **both runners**, unchanged claim.
- `.devcontainer/sandbox/devcontainer.json` — **`@devcontainers/cli` only**. The container is built headlessly inside the VM; the extension *attaches* to the result rather than building it. This is the mechanism that deletes the whole class of VS Code build-path quirks (`${localEnv:VAR:default}` non-application, the Wayland socket, credsStore injection, "fully quit VS Code after `setx`") — see [research.md](../research.md) D-08 and D-15.

The script therefore takes the config under test as a parameter and asserts the runner set appropriate to it. Asserting extension-buildability of the sandbox variant would be asserting a property the design intentionally dropped.

## Why `verify-engine-isolation.sh` is replaced rather than edited

Its pass condition is now false by design. It asserts:

```bash
# The host Docker socket must NOT be mounted in (that anti-pattern hands the container the host
# engine and defeats isolation — research D3).
if grep -Eq '/(var/run|run)/docker\.sock' /proc/mounts; then
  err "host docker.sock is bind-mounted into the container — isolation defeated (rejected pattern)"
```

The new architecture mounts a socket **on purpose**. The old script's premise — *the engine you can reach is the host engine* — no longer holds: the reachable engine is the microVM's, and the Windows engine is behind a hypervisor boundary the container cannot cross.

Per the repository rule that a guard broken by a deliberate change is **updated at the cause, never deleted**, the replacement asserts the new premise with at least equal force. Dropping the assertion without replacing it would be the failure mode that rule exists to prevent.

## `verify-engine-seam.sh` contract

```text
Usage:
  bash .devcontainer/verify/verify-engine-seam.sh                  # in-container (default)
  bash .devcontainer/verify/verify-engine-seam.sh --vm-check       # from the sandbox shell
  bash .devcontainer/verify/verify-engine-seam.sh --host-check [probe]   # from Windows
Env:
  KEEP_PROBE=1   leave the probe container running so the host side can observe its ABSENCE
```

| # | Assertion | Mode | Governing |
| --- | --- | --- | --- |
| 1 | `MCM_DEVCONTAINER=1` — refuse to run outside the container (non-fabrication) | in-container | FR-013 |
| 2 | No `dockerd` **and** no `containerd` process inside the container | in-container | FR-013 |
| 3 | A docker socket is present **and** `docker info` answers | in-container | FR-015 |
| 4 | The engine ID reported in-container equals the sandbox engine's ID | in-container + VM-side | FR-015 |
| 5 | Build + run a probe; the engine lists it | in-container | FR-015 |
| 6 | `docker inspect` of the dev container reports `"Privileged": false` | VM-side | **FR-014 — the headline claim** |
| 7 | The Windows engine lists neither the probe, nor any stack container, nor the dev container | host-side | FR-015, SC-002 |

**RED/GREEN behaviour** — both directions are genuine, which is what makes this a TDD test rather than a rubber stamp:

| Environment | `verify-engine-seam.sh` | `verify-engine-isolation.sh` |
| --- | --- | --- |
| current DinD dev container | **FAIL** — `dockerd` running, no socket, `Privileged: true` | PASS |
| new sandbox dev container | **PASS** | **FAIL** — socket present |

A `Verify RED` command that reports 0 failures means the check is trivially passing and must be corrected before implementation — the standard applies here exactly as it does to application tests.

## `verify-workspace-path.sh` contract

```text
Usage:
  bash .devcontainer/verify/verify-workspace-path.sh
Env:
  MCM_WORKSPACE_PATH   default /workspaces/mcm
```

| # | Assertion | Why |
| --- | --- | --- |
| 1 | `pwd -P` of the workspace equals `$MCM_WORKSPACE_PATH` | symlinked or differently-mounted paths break sibling `-v` resolution |
| 2 | A sibling probe sees the same content: `docker run --rm -v $MCM_WORKSPACE_PATH:/probe alpine ls /probe` returns the repository's own top-level entries | proves the path exists **on the VM**, not just in the container |
| 3 | The probe's listing includes a known repository marker (e.g. `pnpm-workspace.yaml`) | an empty or wrong directory mounts **successfully** — presence alone proves nothing |

Assertion 3 is the point of the script. A path mismatch does not raise an error: the sibling mounts an empty directory, the run proceeds, and the result is confidently wrong. That is precisely the class of instrument failure this repository has been burned by, so it is asserted rather than assumed.

## Aggregate run

The full harness is run at P3 (environment proof) and again at P6 (adoption). Every script must be green before FR-032's two-week observation clock starts. A skipped check counts as a **failure**, not a pass — the repository's standing rule that a skip reads as a pass unless something forces it to fail.

"Full harness" means exactly these twelve, and the run must **enumerate them by name and count**, not glob the directory — a glob silently shrinks when a file is renamed or lost, and reports success while checking less:

```text
in-container : engine-seam, workspace-path, host-isolation, firewall-allowlist,
               personal-layer, portable-runner, toolchain-present, caches-persist,
               committed-clean, egress-allowlist-contract
VM-side      : engine-seam --vm-check, sandbox-egress, reproducible-recreate
host-side    : engine-seam --host-check
```

The run fails if fewer than twelve scripts report a result.
