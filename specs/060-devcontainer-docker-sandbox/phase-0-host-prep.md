# Phase 0 — Host prep record (imported)

**Feature**: 060-devcontainer-docker-sandbox | **Imported**: 2026-08-15 | **Source**: `E:\Programming\VSCode\p0-docker-sandbox-host-setup.md`

Phase 0 was carried out on the Windows 11 workstation **before** this specification existed, and its
record lived outside version control. This file brings it into the repository so the migration record
is self-contained and auditable (spec.md § Assumptions — "that evidence lives outside the repository
today").

**This is a record of what was observed, not a procedure to follow.** Where a row below was
re-verified during implementation on 2026-08-15, it says so and gives the command output. Where it
rests on the original Phase 0 run, it says that too. The distinction matters: a checklist that
records intent reads exactly like one that records evidence.

Nothing in this file contains a forge hostname, a tailnet address, or a credential value.

---

## Scope of Phase 0

Get `sbx` installed, authenticated, policy-defaulted and proven healthy on the host. No sandbox is
retained at the end — a throwaway smoke-test sandbox was created and removed. Docker Desktop, WSL2
and the existing 037/038 dev container were untouched throughout.

Phase 0 satisfies **User Story 1** (FR-001 … FR-006) in full.

---

## What was done

### 1. Windows Hypervisor Platform *(admin)*

Docker Sandboxes runs microVMs on the **Windows Hypervisor Platform** feature — distinct from
`VirtualMachinePlatform`, which is what WSL2 uses. Having the latter does not imply the former.

```powershell
Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform | Select FeatureName, State
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
Restart-Computer
```

The reboot is **not optional**. Running the first `sbx create` after enabling the feature without
rebooting is a documented cause of hangs and hypervisor errors.

### 2. Install the `sbx` CLI

```powershell
winget install -e --id Docker.sbx --source winget --accept-package-agreements --accept-source-agreements
```

Installs to `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`. See **Gotcha 1** below — this directory is
not necessarily on PATH.

### 3. Authenticate

```powershell
sbx login
```

Browser OAuth against the Docker account. Free tier is sufficient; only org-governance features are
paid.

### 4. Default network policy

`sbx create` fails until a default policy exists, and the first run otherwise prompts interactively:

```powershell
sbx policy set-default balanced
```

**Balanced** for bring-up only. User Story 2 tightens this to **Locked Down + explicit allowlist**
before any assistant work (FR-008). `allow-all` / Open was deliberately never used — it would defeat
the purpose of the exercise, and Balanced is sufficient to smoke-test.

### 5. Preflight

```powershell
sbx diagnose
```

### 6. Smoke test — create, inspect, destroy a throwaway sandbox

```powershell
mkdir $env:TEMP\sbx-smoke; cd $env:TEMP\sbx-smoke
sbx create --name p0-smoke claude .
sbx exec -it p0-smoke bash
```

Inside the sandbox:

```bash
uname -a                 # its own Linux kernel — not the WSL2 kernel
docker info              # the PRIVATE engine responds
docker run --rm hello-world
ls /dev/kvm 2>/dev/null && echo "kvm present" || echo "no kvm"   # gate R2 data
```

Cross-checked from the host side, which is the only non-fabricable half of the isolation claim:

```powershell
docker ps        # Docker Desktop's engine — must NOT show hello-world or anything sandbox-related
sbx ls           # the sbx view — p0-smoke listed
```

Torn down with `sbx rm p0-smoke`.

---

## P0 exit checklist — observed results

| # | Check | Observed result | Evidence / when |
|---|---|---|---|
| 1 | Hypervisor Platform enabled, host rebooted since | ✅ **Enabled and active** | Phase 0: feature enabled, host rebooted. Confirmed *functionally* on 2026-08-15 — a microVM was booted and ran a container, which is not possible with the feature disabled. Not re-checked via `Get-WindowsOptionalFeature` during implementation because that cmdlet requires elevation (see **Gotcha 3**). Host last boot 2026-08-15 10:42:37. |
| 2 | `sbx` on PATH, version recorded | ⚠️ **Installed; version recorded; NOT on PATH in a fresh shell** | `sbx version` → `v0.38.0 c022b14634c4bea846ca12870d1d5e97d5868b54`. Re-verified 2026-08-15 via the full path — see **Gotcha 1**. |
| 3 | Authenticated | ✅ **Completed in Phase 0** | `sbx login` OAuth flow completed. Not independently re-verified on 2026-08-15: every command that would prove it was blocked by **Gotcha 2**. |
| 4 | Default policy = `balanced` | ✅ **Set in Phase 0** | `sbx policy set-default balanced`. Re-verification on 2026-08-15 blocked by **Gotcha 2**; to be re-confirmed at T020 when the Locked Down profile is applied. |
| 5 | Preflight clean | ✅ **All green in Phase 0** | `sbx diagnose` reported healthy (hypervisor available, daemon startable, network OK). |
| 6 | MicroVM + private engine proven | ✅ **Proven, both sides** | `hello-world` ran inside the sandbox on its private engine; the host's `docker ps` never listed it. This is FR-005 satisfied. |
| 7 | Docker Desktop / WSL2 / dev container still healthy | ✅ **Unaffected** | The existing 037 dev container was opened normally after Phase 0 and behaved as before. |
| 8 | `/dev/kvm` presence recorded | ✅ **Recorded — ABSENT** | `ls /dev/kvm` inside the sandbox → not present. **Gate R2 resolved NEGATIVE.** Consequences in the next section. |

---

## Resolved gate data (T002)

Recorded 2026-08-15. These are the inputs later tasks read rather than re-derive.

### `sbx` CLI version — for the R5 pin

| Field | Value |
| --- | --- |
| Version | **v0.38.0** |
| Commit | `c022b14634c4bea846ca12870d1d5e97d5868b54` |
| Observed | 2026-08-15, via `& "$env:LOCALAPPDATA\DockerSandboxes\bin\sbx.exe" version` |

This is **newer than the v0.37-era research** the source proposal was written against (research.md
D-13). Every version-sensitive claim about `policy`, `ports`, `secret`, kits and SSH `acceptEnv` is
therefore **provisional** and must be verified against the installed CLI rather than inherited from
the proposal text. T040 pins this version once the environment is green.

### `/dev/kvm` — gate R2, resolved **NEGATIVE**

| Field | Value |
| --- | --- |
| Result | **ABSENT** inside the microVM |
| Observed | Phase 0, `ls /dev/kvm` in the `p0-smoke` sandbox |
| Consequence | No nested virtualization → **the local Android emulator does not survive this migration** |

This is a **documented scoped exception (FR-028 / SC-010), not a problem to be solved.**
Software-rendered emulation is explicitly ruled out — it is unusable in practice. Mobile E2E runs in
CI (already the recommended route for agent flows) or on the retained Docker Desktop environment on
demand. The Android SDK **stays** in `toolchain.Dockerfile` (research.md D-09): dropping it would
fork the toolchain description for one unavailable capability and break
`verify-toolchain-present.sh`'s parity assertions. Only the emulator capability is lost, not the
toolchain.

T050 makes `scripts/devcontainer-android.sh` refuse *legibly* on this basis, so a future session does
not spend an hour rediscovering it.

### Host CPU and RAM totals — **required by T018**

Observed 2026-08-15 via `Win32_ComputerSystem` / `Win32_Processor`:

| Field | Value |
| --- | --- |
| CPU | 12th Gen Intel(R) Core(TM) i7-12700K |
| Physical cores | **12** (8 P-cores + 4 E-cores) |
| Logical processors | **20** |
| Total RAM | **31.8 GB** (32 GB nominal) |
| OS | Windows 11 Home 10.0.26200 |
| Free disk — `C:` | 264.7 GB |
| Free disk — `E:` | 1252.4 GB |

**Why T018 needs these, and the trap they defuse.** The sandbox default is *N-1 CPUs and ~50% of host
RAM* (capped at 32 GB). On this workstation that default is:

| Resource | Sandbox default | Proposal floor | `max(default, floor)` |
| --- | --- | --- | --- |
| CPUs | **19** if N = logical (20), **11** if N = physical (12) | 8 | **the default — 19 or 11, either way > 8** |
| RAM | **~15.9 GB** (~50% of 31.8) | 16 GB | **16 GB — the floor, marginally** |

So passing `--cpus 8` unconditionally would **cut the sandbox from 19 (or 11) CPUs down to 8** —
under-provisioning it *relative to doing nothing at all*, and plausibly causing the very G6
performance miss that explicit sizing exists to prevent. Metro is the known OOM-prone component in
this workspace and would be the first to suffer.

RAM is the opposite case and is genuinely marginal: the 16 GB floor sits just above the ~15.9 GB
default, so passing it is correct but buys almost nothing.

**T018 must therefore compute `max(default, floor)` per resource from the table above, confirm the
actual default `sbx` applies on this host rather than trusting the N-1/50% rule, and record both the
default and the chosen value** — so that a later G6 investigation can tell which was in play.

---

## Workstation gotchas

Both were observed on this workstation, and both present as *"the tool is broken"* rather than as
what they are. That is precisely why they get named entries here and in the delta runbook (FR-030)
instead of living in a session's memory. A third was discovered during implementation and is
recorded with them.

### Gotcha 1 — `sbx` is not on PATH in a freshly opened shell

winget does not reliably refresh PATH for already-open shells, and on this workstation a bare `sbx`
does not resolve in a new one either.

```powershell
# per-shell fix
$env:Path += ";$env:LOCALAPPDATA\DockerSandboxes\bin"

# or invoke directly
& "$env:LOCALAPPDATA\DockerSandboxes\bin\sbx.exe" version
```

Documentation must not assume the bare command name resolves.

### Gotcha 2 — the daemon can be running yet unresponsive

```text
ERROR: ensure daemon: sandboxd (PID 27268) remained running but did not respond within 10s
```

Every `sbx` subcommand fails this way, so the CLI appears broken. It is not — a background daemon
process is wedged and must be stopped, after which the next `sbx` command restarts it cleanly.

**Observed 2026-08-15 during implementation: PID 27268, wedged, blocking all `sbx` work.**

**The recovery command in the original Phase 0 record and in `quickstart.md` does not work on
v0.38.0.** Two corrections, both of which cost time to find:

1. **The process is named `sbx`, not `sandboxd`.** The error message says `sandboxd`, but there is no
   process by that name:

   ```powershell
   Get-Process sandboxd     # returns NOTHING — the documented recovery silently no-ops
   Get-CimInstance Win32_Process -Filter "Name = 'sbx.exe'"   # PID 27268
   ```

   `Get-Process -Name sandboxd | Stop-Process -Force` therefore **exits 0 having done nothing** —
   the worst possible shape, because a clean exit reads as a successful recovery and the next `sbx`
   command fails identically.

2. **The wedged daemon runs elevated, so the recovery needs an elevated shell.** It runs under the
   *same user account*, which makes this non-obvious:

   ```text
   Owner          : WATSON-WORKSTAT\Steve      # same user…
   ExecutablePath : (blank)                    # …but not readable → higher integrity level
   Stop-Process   : Access is denied
   taskkill /F    : Access is denied
   ```

**Corrected recovery — run from an ELEVATED PowerShell:**

```powershell
Get-Process -Name sbx -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -eq 0 } |
  Stop-Process -Force
# then re-run any sbx command; it restarts the daemon
```

Verify it actually died before concluding the recovery worked — the failure mode above is a silent
no-op, so an unverified "I ran the fix" proves nothing:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'sbx.exe'"    # expect no rows
```

### Gotcha 3 — `ssh <name>.sbx` SILENTLY CONNECTS TO THE WINDOWS HOST when `sh` is missing

**This is the most dangerous entry on this page.** `sbx setup ssh` installs an SSH `ProxyCommand`
that is executed through `sh`. If `sh` is not on PATH — the default state on this workstation, and
something `sbx setup ssh` itself warns about in passing — the ProxyCommand cannot run and **OpenSSH
falls through to the local machine instead of failing**:

```text
$ ssh mcm.sbx "echo USER=$(whoami) HOST=$(hostname)"
Connecting to sandbox "mcm"…
USER=watson-workstatsteve HOST=Watson-Workstation-Win11     ← THE WINDOWS HOST, not the microVM
```

It prints *"Connecting to sandbox"*, returns a working shell, and exits 0. Every naive check passes.

**Observed 2026-08-15.** Had this gone unnoticed, the G1 forge-reachability gate would have been
evaluated by running `git clone` **on the Windows host** — which succeeds — and the feature would
have recorded "the forge is reachable from the sandbox" on the strength of a command that never
entered the sandbox.

**Never accept a bare exit code from `ssh *.sbx`. Assert the identity:**

```bash
ssh mcm.sbx 'echo "$(whoami)@$(hostname) $(uname -r)"'
# REQUIRED: agent@mcm <linux-kernel>      (this VM reports kernel 7.0.12)
# WRONG:    <you>@<your-windows-box>      → the ProxyCommand did not run
```

Fix — put Git's `sh` on PATH before any `sbx` SSH use:

```powershell
$env:Path += ";C:\Program Files\Git\bin"
```

This is why T019's Done-when is written as *"returns a shell as `agent@mcm`"* rather than *"returns
a shell"*. The weaker form is satisfied by the failure.

### Gotcha 4 — `git credential fill` returns NOTHING if fed CRLF

Extracting the forge credential to provision it into the sandbox fails silently from PowerShell,
because git's credential protocol requires **LF-terminated** `key=value` lines and PowerShell's
pipeline emits CRLF. The symptom is an empty result and exit 128 — indistinguishable from *"no
credential is stored"*, which sends you looking in the wrong place. The credential was in Windows
Credential Manager the whole time (`cmdkey /list` confirms three matching entries).

Working form — write the request with explicit LF and redirect it in:

```powershell
$req = "protocol=http`nhost=<forge>:3000`nusername=<user>`n`n".Replace("`r`n","`n")
[System.IO.File]::WriteAllText($tmp, $req, (New-Object System.Text.UTF8Encoding($false)))
cmd /c "`"C:\Program Files\Git\bin\git.exe`" credential fill < `"$tmp`""
```

Note also the **UTF-8 BOM** trap in the same family: a PowerShell here-string piped to `bash -s`
arrives with a BOM that corrupts the *first line only*. During G1 this silently blanked a variable
assignment, so a probe ran against an empty hostname and reported total unreachability. Base64-encode
scripts before sending them over SSH.

### Gotcha 5 — several host-side checks in this migration require elevation

Not an `sbx` fault, but the same class of surprise. `Get-WindowsOptionalFeature -Online` (exit
checklist row 1) and the Gotcha 2 recovery both fail with *"The requested operation requires
elevation"* or *"Access is denied"* from an ordinary shell. Any automated or assistant-driven run of
this migration must either be given an elevated shell or record these rows as **not re-verified**
rather than reporting them green.

---

## Rollback (returning the host to its pre-Phase-0 state)

```powershell
sbx ls          # then `sbx rm <name>` for any leftovers
winget uninstall Docker.sbx
Disable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform   # optional; needs a reboot
```

Nothing else on the workstation was modified by Phase 0.
