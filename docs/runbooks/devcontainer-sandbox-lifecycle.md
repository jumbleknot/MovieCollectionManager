# Runbook — the dev container on a Docker Sandbox microVM: lifecycle

Recreating, resizing, verifying and upgrading the sandbox. The day-to-day operating manual — the
credential rule (§0), getting in, layering, egress, the engine seam, networking, ports, running git,
credential injection and the collected foot-guns — is [devcontainer-sandbox.md](devcontainer-sandbox.md).
Section numbers are the same in both files, so `§8b` means the same thing wherever it is cited. Split
out of `devcontainer-sandbox.md` on 2026-10-10 (item #682).

> **The credential rule applies here too**: never set `ANTHROPIC_API_KEY` in this environment — see
> [devcontainer-sandbox.md §0](devcontainer-sandbox.md).

---

## 7b. Templates and recreate-from-nothing

```powershell
sbx template save mcm mcm-proven:060                       # ~17 min, ~16.8 GB
sbx run -t docker.io/library/mcm-proven:060 --name <new> -d shell C:\path\to\a\scratch\dir
```

### 🔴 ALWAYS pass the workspace explicitly

**`sbx run` mounts the CURRENT DIRECTORY as the sandbox workspace unless told otherwise**, and it
does so **read-write over virtiofs**. Creating a sandbox while sitting in the repo therefore mounts
the repo into the VM and **destroys the host-filesystem isolation this whole environment exists
for**. Measured 2026-08-16 — a file written inside the recreated sandbox appeared immediately in the
Windows working copy:

```text
mcm            ...  C:\Users\Steve\sbx-workspaces\mcm-vm     ← correct: a dedicated scratch dir
mcm-recreate   ...  E:\...\MovieCollectionManager            ← the repo, writable from the VM
```

The `mcm` sandbox is correctly configured: its only virtiofs mounts are `/etc/resolv.conf`,
`/etc/hosts` and a dedicated workspace directory. Keep it that way.

> Note the layering: the **dev container** is separately isolated from the VM's mounts, which is what
> `verify-host-isolation.sh` asserts at the container level. A Windows mount in the VM is still a
> real exposure — anything run in the VM shell (not the container) can reach it.

### 🔴 A template does NOT carry the egress policy either — apply it before anything pulls

**Policy rules are scoped per sandbox** (`--sandbox mcm`). A sandbox created from the template gets
the **default** profile, not this environment's deny-all + allowlist, so the forge is not reachable
and the very first `docker pull` is refused. Measured 2026-08-16: `devcontainer up` on a fresh
sandbox failed four retries in **~1 second each** — which is the tell. A network fault times out; a
**policy refusal is instant**. Treating that speed as a clue is faster than reading the error.

The recreate sequence is therefore **instantiate → apply policy → provision**, never
instantiate → provision:

```powershell
sbx run -t docker.io/library/mcm-proven:060 --name <new> -d shell C:\path\to\scratch\dir

# apply from the GENERATOR, one rule per emitted line — never hand-written, never copied
node scripts/gen-egress-policy.mjs --format sbx-policy --forge-host $env:FORGE_REGISTRY_HOST
#   -> for each "allow network <domain>":  sbx policy allow network <domain> --sandbox <new>

devcontainer up --workspace-folder /workspaces/mcm --config /workspaces/mcm/.devcontainer/sandbox/devcontainer.json
```

### ⚠️ A template does NOT contain the Docker images

`sbx template save` snapshots the VM root filesystem, **not** the Docker data disk. Measured: a
sandbox recreated from `mcm-proven:060` came up in **4 seconds** with **zero images**.

So recreate is **fast but COLD**. The 4-second instantiation is followed by a full cold rebuild and
re-pull of every image — which is where the real time goes, and it is *not* the 293 s warm
`docker-build` figure. Budget accordingly, and treat "recreate ≤ 15 min" as covering instantiation
plus provisioning, not instantiation alone.

⚠️ `sbx template save` **stops the sandbox** and holds a lock that blocks other `sbx` commands for
its full duration (~17 min here). Do not run it when you need the environment, and do not conclude
it failed because `sbx template ls` shows nothing — check whether the sandbox went to `stopped`.

---

## 7e. 🔴 A full disk does not announce itself — it wears other symptoms

The 49 GB Docker disk filled three times on 2026-08-17, and **not once did the error mention disk**:

| What it printed | What it looked like | What it was |
| --- | --- | --- |
| feature install `exit code: 100` | an apt or feature-config fault | disk full |
| `At least one invalid signature was encountered` / `is not signed` | GPG or MITM-proxy corruption of `deb.debian.org` | disk full — apt wrote a truncated `InRelease`, so verification failed |
| build died in `exporting layers` | needed a bit more room | disk full, on a 13 GB copy-up |

**`df` is the authority; `docker system df` is not.** Docker reported gigabytes `RECLAIMABLE` while
`df` said 0 bytes free, because it counts shared layers optimistically. Three separate prunes freed
"space" that never appeared. What finally freed 13 GB was deleting the **derived** `vsc-mcm:latest`
image *after* its parent toolchain image was gone — until then its layers were shared and deleting
either freed almost nothing.

**Order that actually works when the disk is full:**

```bash
df -h /var/lib/docker                # believe THIS, not docker system df
docker builder prune -af             # -f alone drops only UNUSED cache; -af got 17.8 GB, then 7.5 GB
docker image rm <old-toolchain-digest>   # parent first…
docker image rm vsc-mcm-<hash>:latest    # …then the derived image, which now owns its layers
```

⚠️ **Build cache can mask a broken environment.** Those `apt` failures had been present for a while;
builds "succeeded" by reusing a cached feature-install layer that never ran apt. Pruning the cache
did not cause the failure — it *revealed* it. A green build that reused cache proved less than it
appeared to, which is the same lesson as a skipped test reading as a pass.

> **Two dev-container images will not fit.** The toolchain image is ~14 GB and the derived container
> another ~13.5 GB. Pulling a new toolchain image while the old one and its derived image are still
> present exceeds the disk on its own. Remove the previous pair as part of re-pinning.

---

## 7f. 🔴 "docker daemon failed to start" is usually sbx giving up, not dockerd failing

```text
ERROR: failed to start sandbox: start runtime: request failed: 500 Internal Server Error:
docker daemon failed to start inside the sandbox
```

**Measured 2026-09-19, on both v0.39.0 and v0.43.0: dockerd had not failed.** In all five recorded
occurrences it reached, in its own log, *after* sbx had already declared the failure:

```text
level=info msg="Daemon has completed initialization"
level=info msg="API listen on /var/run/docker.sock"
```

On the 14:51 occurrence sbx reported the failure **1.7 seconds after** dockerd began serving the
socket. The message names the wrong component, and it is the single most misleading string this
environment produces — it reads as a corrupt VM or a full disk and is neither.

### The mechanism — a readiness deadline, then the idle-stop finishes the job

1. dockerd restores every container it finds, and this VM holds **20 with `restart: unless-stopped`**
   (keycloak, the six langfuse services, unleash ×2, otel-lgtm, opa, bff ×3, mc-service ×2, ollama).
   Restoring them took **54–101 s** across five measured starts.
2. sbx's dockerd-readiness budget is shorter — **every one of those five overran it, so the budget is
   under ~54 s.** It is hardcoded; there is no flag and no `DOCKER_SANDBOXES_*` variable for it
   (checked against the strings in `sbx.exe` for both versions).
3. sbx aborts and the **CLI process exits**, which the daemon logs as `session disconnected,
   deferring auto-stop`.
4. The ~30 s idle-stop then expires — `auto-stop grace period expired, stopping runtime` — and kills
   a VM whose dockerd had been healthy for the whole grace period.

So the sandbox is destroyed roughly 30 s *after* it finished coming up correctly.

### Prove it before believing the message

Read dockerd's own log out of the daemon log rather than trusting the CLI's summary:

```bash
python - <<'PY'
import json
p=r"C:\Users\Steve\AppData\Local\DockerSandboxes\sandboxes\state\sandboxd\daemon.log"
for line in open(p,encoding='utf-8',errors='replace'):
    if '"level":"ERROR"' in line and 'dockerd failed to start' in line:
        b=json.loads(line)['msg']
        print('completed_init=', 'Daemon has completed initialization' in b,
              'api_listen=',     'API listen on /var/run/docker.sock' in b)
PY
```

`completed_init=True` means dockerd is fine and the deadline is the fault.

### Getting in anyway — the 30 s grace window

The window between the CLI's error and the idle-stop is a live, healthy sandbox. A command issued
into it attaches instantly and, being a session, **defers the auto-stop for as long as it runs**:

```bash
sbx run --name mcm          # ~60-100 s, then "fails". Ignore the error.
sbx exec mcm sh -c 'docker ps'   # issue within ~30 s — attaches to the running VM
```

> ⚠️ **`sbx run` that succeeds does not return.** It attaches the interactive `shell` agent and
> blocks forever with no TTY, so `sbx run … | tail` never prints. That is a held session, not a
> hang — and it is the cheapest way to pin the sandbox up while you work through `sbx exec`.
>
> ⚠️ **Git Bash mangles a `/workspaces/...` argument** passed to `sbx.exe`: it becomes
> `C:/Program Files/Git/workspaces/...` and the command exits **127**. Wrap it —
> `sbx exec mcm sh -c 'bash /workspaces/mcm/...'` — or set `MSYS_NO_PATHCONV=1`.

### The durable fix — the launcher stopped believing the exit code

**There is no knob.** The budget is a compiled-in constant: no `--flag`, no `DOCKER_SANDBOXES_*` or
`SBX_*` variable, no settings file (there are none on disk at all), no `sbx daemon start` option, and
no dockerd-timeout key in the binary — checked on **v0.39.0 and v0.43.0**. Patching `sbx.exe` is not
a fix either: it breaks the Docker Inc Authenticode signature on the component that enforces this
environment's isolation and egress, and every MSI upgrade reverts it.

So the fix belongs on our side. `scripts/open-sandbox.ps1` used to `throw` the instant `sbx run`
returned non-zero — three lines above a readiness probe that would have disproved it. It now treats
the **exit code as a claim and SSH answering as evidence**, and waits up to **120 s** (deadline-based,
because each probe costs `ConnectTimeout` plus the sleep, so a loop count is not a number of
seconds). Failure detection is not weakened: a genuinely broken sandbox never answers, and the throw
then carries the original exit code and output.

Measured 2026-09-19 with all 20 containers restoring:

```text
sbx run reported exit 1 - checking SSH before believing it (see runbook 7f)
sandbox is up and answering SSH (61s)
EXITCODE=0
```

**This is what makes the environment robust, not the container count** — the launcher no longer cares
how long dockerd takes, so the stacks can stay up.

### Optional — trimming restore time

Fewer restored containers still means a faster start (~24 s with 11, ~123 s with 20). `unless-stopped`
keeps a manually stopped container down across daemon restarts, so this is effective and reversible:

```bash
sbx exec mcm sh -c 'docker stop langfuse-web langfuse-worker langfuse-clickhouse \
  langfuse-minio langfuse-postgres langfuse-redis unleash-service unleash-postgres otel-lgtm'
```

Bring them back with the documented `nx up-*` targets. This is now a **speed** choice, not a
correctness one. **v0.43.0 did not raise the deadline** — it is not fixed by upgrading.

> ⚠️ **A bare `sbx run` / `sbx exec` still shows the false failure.** Only the launcher is immune.
> When starting by hand, use the §7f grace window, or just run `scripts/open-sandbox.ps1`.

---

## 8. Disk — three volumes, all of them resizable

> **Corrected 2026-08-27 (item #246).** This section used to state that the VM's Docker disk was
> **"49 GB and cannot be enlarged (v0.38.0 exposes no `--disk` flag)"**. The premise was right — there
> is no *flag* — but the conclusion was wrong, and it is why pruning was treated as the only lever
> through five image rebuilds. The sizes are set by **environment variables**, read at sandbox
> **creation** time, and all three exist in v0.38.0.

A sandbox has **three** independently sized volumes. Confirm which one is binding before turning a
knob — raising the wrong one changes nothing:

| Device | Default | Mounted at | Holds | Knob |
| --- | ---: | --- | --- | --- |
| `vdd` | 50 GiB | `/var/lib/docker` | every Docker image/layer **and the dev container's own writable layer** — this is the `/` the dev container reports | `DOCKER_SANDBOXES_DOCKER_SIZE` |
| `vdb` | 20 GiB | `/` (VM root) | `/workspaces/<name>` — the working tree | `DOCKER_SANDBOXES_ROOT_SIZE` |
| — | 50 GiB | cloned workspace | only in `--clone` mode; unused here | `DOCKER_SANDBOXES_CLONED_WORKSPACE_SIZE` |

**`/var/lib/docker` is not visible from inside the dev container** (`No such file or directory`), and
`df /` there reports `vdd` because the container's overlay upper dir lives on it. That is what made
the topology hard to read from the inside. Establish it from the **VM shell** instead:

```bash
sbx exec <name> sh -c 'lsblk | grep ^vd; df -h /var/lib/docker /'
```

### Changing a size — creation-time only, so it means recreate

```powershell
[Environment]::SetEnvironmentVariable('DOCKER_SANDBOXES_DOCKER_SIZE','150GB','User')
[Environment]::SetEnvironmentVariable('DOCKER_SANDBOXES_ROOT_SIZE','40GB','User')
# then a NEW shell, so sbx and the daemon inherit them
```

Current values: **Docker 150 GB, root 40 GB** (Docker raised from 100 GB on 2026-10-08, when it
stood at 91 % — 85 GB used, 8.5 GB free — with the root volume at 38 %).

⚠️ **A User-scope variable reaches neither the current shell nor a daemon that is already
running.** Which of the CLI and the daemon reads it has not been isolated; the 2026-10-08 resize
sidestepped the question by giving both the value before creating — then verified from the host
(below), which is the check that matters:

```powershell
$env:DOCKER_SANDBOXES_DOCKER_SIZE = '150GB'; $env:DOCKER_SANDBOXES_ROOT_SIZE = '40GB'
sbx daemon stop; sbx ls        # sbx ls restarts the daemon, from THIS environment
```

The full recreate, in order: back up (§8b), `sbx rm mcm --force`, then
`sbx create --name mcm -m 16g --skills=off shell C:\Users\<you>\sbx-workspaces\mcm-vm`, then apply
the egress policy (§7b) **before** anything pulls, then the three §8b steps, a fresh clone into
`/workspaces/mcm`, the restored `.env` files, a `sbx stop`, and `devcontainer up`.

⚠️ **A CLI `devcontainer up` installs no personal layer**, and `sbx rm` took the `~/.claude` volume
that held it — so the harness's `personal-layer` check FAILS with `RTK not found`. VS Code applies
`dotfiles.repository` on its own; the CLI needs it passed (`--dotfiles-repository <url>`).

The RTK **hook** is a separate trap. `postCreateCommand` runs `ensure-rtk-hook.sh` **before** the
dotfiles pass, when RTK does not exist yet, so it wires nothing; and a dotfiles `install.sh` that
calls plain `rtk init -g` wires nothing either — it prompts, a non-interactive run answers *No*,
and it exits 0. Measured 2026-10-08: the dotfiles log said `RTK active` with no hook in
`settings.json`. A dotfiles script must use `rtk init -g --auto-patch` and check the hook landed;
if yours does not, run `bash .devcontainer/ensure-rtk-hook.sh` in the container afterwards.
Expect to log in to Claude Code and `gh` again.

Set them at **User scope, not `$env:`**. A later `sbx` upgrade makes this load-bearing: **v0.42.0
drops the default Docker volume from 50 GB to 10 GB**, so any future recreate that forgets the
variable silently gets a far smaller disk than the one before it.

Verify from the **host**, never with `df` inside — on <= v0.39.0 a recreate that reuses a deleted
sandbox's name can inherit its old volumes, and `df` will report the old size as if the resize took:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\DockerSandboxes\sandboxes\state\sandboxd" -Recurse -Filter *.img |
  ForEach-Object { "{0,8:N1} GB  {1}" -f ($_.Length/1GB), $_.Name }
# expect: mcm-docker.img = the DOCKER_SIZE, rwlayer.img = the ROOT_SIZE
```

The spec records what was actually stamped — read it with a **case-sensitive** JSON parser
(PowerShell's `ConvertFrom-Json` rejects the file: it carries both `HTTP_PROXY` and `http_proxy`):

```bash
# in state/sandboxd/runtimes/mcm.json
node -e "const s=JSON.parse(require('fs').readFileSync('mcm.json','utf8')).Spec; console.log(s.DinDVolumeSize, s.RootFilesystemSize)"
```

### Sparse is real, but only until written

A fresh 100 GB volume occupies **438 MB** on the host. But blocks are **never released back**: the
previous 50 GiB volume had reached 100 % once and was still holding **53.6 GB of real bytes** at
deletion. Treat a declared size as a future host cost, not a free option. Check with
`compact /q <path to mcm-docker.img>` — it prints allocated vs declared.

### Relocating the data root off `C:`

There is **no supported setting** ([docker/sbx-releases#228](https://github.com/docker/sbx-releases/issues/228),
open since 2026-06-11; the maintainer's `msiexec INSTALLFOLDER=` suggestion moves only the install).
A junction on the **`sandboxes` subfolder** works — junctioning the *parent* `DockerSandboxes` folder
is what broke for the issue reporter, because it also holds `bin\sbx.exe`:

```powershell
sbx rm <name> --force        # do this FIRST: the tree drops to ~8 GB, so the move is cheap
sbx daemon stop
robocopy "$env:LOCALAPPDATA\DockerSandboxes\sandboxes" "E:\DockerSandboxes\sandboxes" /E /MOVE
cmd /c mklink /J "$env:LOCALAPPDATA\DockerSandboxes\sandboxes" "E:\DockerSandboxes\sandboxes"
```

🔴 **The move breaks SSH until you fix the ACLs — and that breaks `open-sandbox.ps1`.** Files under
`%LOCALAPPDATA%` are owner-only; the same files on another volume inherit that volume's ACL, which
grants `Authenticated Users`. Windows OpenSSH refuses a config it considers world-readable, so
`ssh <name>.sbx` — and therefore the one-step VS Code launcher, which uses the Windows ssh client —
fails with:

```text
Bad permissions. Try removing permissions for user: NT AUTHORITY\Authenticated Users (S-1-5-11)
Bad owner or permissions on …/sandboxes/config/ssh/config
```

Restrict the directory and let the files inherit from it. Do **not** pass `(OI)(CI)` with `/T` — those
flags are meaningless on a *file*, so `/inheritance:r` strips the inherited ACEs and the grant adds
nothing, leaving a file with **no ACEs at all** that not even its owner can read (measured):

```powershell
$ssh = "E:\DockerSandboxes\sandboxes\config\ssh"
icacls $ssh /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
icacls "$ssh\*" /reset        # files inherit from the directory
& C:\Windows\System32\OpenSSH\ssh.exe -o BatchMode=yes <name>.sbx "echo SSH_OK"
```

⚠️ **`ssh <name>.sbx` does not work from Git Bash, and the error blames DNS.** `sbx setup ssh` writes
an `Include` with a **Windows-style absolute path**, which MSYS OpenSSH does not recognise as
absolute — it resolves it *relative to `~/.ssh/`*, matches nothing, and silently continues to DNS:

```text
debug1: /c/Users/<you>/.ssh/config line 2: include ~/.ssh/C:/Users/<you>/AppData/…/config matched no files
ssh: Could not resolve hostname <name>.sbx: Name or service not known
```

"Could not resolve hostname" reads as a network or sandbox fault; it is a config path that never
loaded. Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`) handles the same file correctly, and
that is the client VS Code uses — so the launcher is unaffected. From Git Bash use `sbx exec <name>`
or the Windows client by full path. Confirm which client is at fault with `ssh -v … 2>&1 | grep -i
include` before touching the sandbox.


⚠️ **Re-verify the junction after every `sbx` upgrade** — an MSI could recreate the folder. It
survived the v0.38.0 → v0.39.0 upgrade (measured 2026-08-27), which is evidence, not a guarantee:

```powershell
Get-Item "$env:LOCALAPPDATA\DockerSandboxes\sandboxes" -Force | Select-Object LinkType, Target
```

⚠️ **`sbx rm` on <= v0.39.0 does not reclaim everything** — it left **7.7 GB** of containerd template
cache behind. That content is reusable, so it is not waste, but do not read the leftover as a failed
delete. v0.42.0 fixes both this and the name-reuse inheritance above.

### Reclaiming space without a resize

```bash
docker builder prune -f     # reclaimed 3.665 GB; never touches images
docker image prune -f       # DANGLING ONLY
```

⚠️ **Never `docker image prune -a`.** It evicts the 3.5 GB Playwright image (and any other image not
currently attached to a container), which the web-E2E recipe needs and which must then be re-pulled.

### Measured, 2026-08-27 — the resize plus item #244 together

| | before | after |
| --- | --- | --- |
| Docker volume | 50 GiB, 6.3 GB free (87 %) | **100 GB, 58 GB free after a full build** |
| VM root / `/workspaces` | 20 GiB | **40 GB** |
| `mcm-bff` image | 5.85 GB | **1.73 GB** |
| `pnpm nx docker-build mcm-app` in the dev container | failed twice at `exporting layers`, 4.2 GB then 6.9 GB free | **succeeds, 9 m 22 s, export 26.6 s** |

**Item #249 took the same image to 335 MB** (measured 2026-09-07). What #244 shipped was the
*runtime* tree; almost none of it is reachable AT runtime. `pnpm deploy --prod` materialized 1628
packages (916 MB) because they are dependencies of `mcm-app` — but they are dependencies of the WEB
BUNDLE, already compiled into `dist/`. A traced run (a `--require` preload recording every module
resolution and `fs` read while the full web E2E suite plus a sweep of every route drove the
container) touched **76** of them. `scripts/prune-bff-runtime-modules.mjs` now keeps only the
closure of `express`, `@expo/server` and `openai` — **81 packages, 22.9 MB** — and the build fails
if the exported bundle grows a lazy `require("…")` the script does not account for.

| | after #244 | after #249 |
| --- | --- | --- |
| `mcm-bff` image | 1.73 GB | **335 MB** |
| `/app/runtime/node_modules` | 916 MB, 1628 packages | **22.9 MB, 81 packages** |
| Trivy `--severity CRITICAL --ignore-unfixed` | exit 0 | exit 0 |

---

## 8b. 🔴 A cold recreate needs three things the template does not carry

Beyond the egress policy (§7b), a sandbox created from scratch is missing setup that nothing in the
provisioning path supplies. All three were hit on 2026-08-27; each stops the recreate dead.

**1. The `devcontainer` CLI is not installed.** §7b's recreate sequence calls `devcontainer up`, and
the binary does not exist in a fresh sandbox:

```bash
sudo npm install -g @devcontainers/cli
```

**2. `/etc/docker/daemon.json` has no `insecure-registries`.** The forge registry is plain **HTTP on
:3000**, so every pull fails with `http: server gave HTTP response to HTTPS client`. This was already
identified as owed by [specs/060 research](../../specs/060-devcontainer-docker-sandbox/research.md)
(T053) and never landed:

```bash
printf '{\n  "insecure-registries": ["%s:3000"]\n}\n' "$FORGE_REGISTRY_HOST" | sudo tee /etc/docker/daemon.json
```

**3. `/etc/init.d/docker restart` does not work here** — it exits on
`ulimit: error setting limit (Invalid argument)`, leaves the new config unapplied, and `docker info`
keeps answering, so it reads as success. There is no systemd (PID 1 is `tini`). Restart the
**sandbox** instead, which brings `dockerd` up with the new config:

```bash
sbx stop <name>            # the next `sbx exec` restarts it
```

> ⚠️ **An instant failure is not always a policy refusal.** §7b says a ~1 s failure means the egress
> policy refused the connection, since "a network fault times out; a policy refusal is instant". True,
> but incomplete: the HTTPS/HTTP mismatch above fails in **0.034 s** and has nothing to do with
> policy. Instant means *rejected before leaving the host*, which has at least two causes — read the
> error text before acting on the timing.

### What a recreate destroys, and what to save first

`/workspaces/<name>` is **a plain directory on `vdb`, not a mount** — the host workspace directory is
empty, so `sbx rm` destroys the working tree. Pushed commits are safe; these are not, and
`~/.mcm-sandbox-env` is the one that hurts, because it carries `MCM_DEVCONTAINER_IMAGE` (the pin
§7b's rebuild needs) alongside `FORGE_REGISTRY_HOST` and four credentials:

```bash
ssh <name>.sbx 'cd ~ && tar czf /tmp/home.tgz .git-credentials .gitconfig .gitignore_global .bashrc .bash_profile .env.e2e.local .mcm-sandbox-env* .mcm-reboot-manifest.txt'
ssh <name>.sbx 'cd /workspaces/<name> && git status --porcelain --ignored=matching -uall | grep "^!!" | cut -c4- | grep -E "[.]env" | tar czf /tmp/env.tgz -T -'
```

🔴 **Validate the archive, do not trust the exit code.** `tar -T -` fed an empty list writes a valid
**45-byte archive with zero entries**, and `sbx cp` copies it with no error — a backup that exists,
is named correctly, and contains nothing. This happened on 2026-08-27 when a `sed` in the pipeline
failed under PowerShell quoting (`cut -c4-` above avoids it). Always:

```bash
tar tzf <archive> | wc -l          # compare against the file count you expected
```

---

## 10. Verification harness

```bash
bash .devcontainer/verify/run-harness.sh
```

Twelve scripts across three vantage points (in-container, VM-side, host-side). The host-side checks
cannot be faked from inside — a claim asserted only from within the thing being claimed about is not
proof — and the harness refuses to report them as passed without `MCM_HOST_CHECK`.

> 🔴 **Running the harness DESTROYS and rebuilds the dev container.** The last check,
> `verify-reproducible-recreate.sh`, removes the container *and its derived image* by design. That is
> the check working as intended — but it means the harness is never a read-only operation, and a
> `reproducible-recreate` FAIL means **the dev container is gone right now**, not that some
> hypothetical future recreate would fail. Check `docker ps` for it before diagnosing anything else;
> the service stacks survive, so the sandbox still looks healthy.
>
> **Measured 2026-09-19 — the rebuild used to fail, twice, for the same reason.** The sandbox
> config's BASE_IMAGE is `${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}`, and that variable
> lives in `~/.mcm-sandbox-env`, which is deliberately **not** auto-sourced (D-07). `run-harness.sh`
> runs this script from a non-login shell, so it was unset, the arg fell back to the bare tag, and
> `devcontainer up` turned it into a pull of a non-existent reference:
>
> ```text
> No manifest found for docker.io/library/mcm-devcontainer
> Error: Command failed: docker pull mcm-devcontainer
> ```
>
> The damage was the **order** — the teardown had already run, so the failure left no dev container
> at all and every later check reported `No such container`, which reads as an isolation fault.
> **Fixed:** the script now sources the pin, and asserts the base image is present-or-pullable
> **before** it destroys anything, failing with the dev container still standing if it is not.
>
> On an older checkout, recover by rebuilding with the pin sourced, exactly as §8b specifies:
>
> ```bash
> sbx exec mcm sh -c 'set -a; . ~/.mcm-sandbox-env; set +a
>   devcontainer up --workspace-folder /workspaces/mcm \
>                   --config /workspaces/mcm/.devcontainer/sandbox/devcontainer.json'
> ```

The harness has a second instrument problem, at the opposite end — a check that fails safe above, and
one that passes unsafe here:

> ⚠️ **`verify-engine-seam.sh --host-check` PASSES VACUOUSLY when Docker Desktop is stopped.** Its
> assertions are all of the form *"the Windows engine does not list X"*, and it does not distinguish
> **"the engine answered and X was absent"** from **"the engine could not be reached at all"**. With
> Docker Desktop shut down every `docker` call fails, so all four assertions pass and it prints
> `PASS host-side — the Windows engine sees nothing from the microVM` (measured 2026-09-19, exit 0).
>
> That is the non-fabricable proof the harness refuses to fake, so a vacuous pass is worth more
> caution than a failure. Confirm the engine was actually reachable before believing it:
>
> ```bash
> docker version --format 'server={{.Server.Version}}'   # must print a version, not a connect error
> ```
>
> Nothing is *disproven* by the vacuous run — with no Windows engine running, nothing can leak to
> one. But it cannot catch a regression that only appears while Docker Desktop is up, so re-run it
> with Docker Desktop started before treating SC-002 as re-verified.

---

## 10b. The `sbx` version, and the ritual before upgrading it (R5)

**Pinned at: `v0.47.0` (`0411f50ee4700fe7bd37e6e7e3aced563e850ca9`), upgraded from v0.43.0 on
2026-10-08** (`winget upgrade Docker.sbx`, after `sbx daemon stop`). Most of this page was
originally measured against v0.38.0; where a behaviour was re-checked on a later version it says
so.

**v0.44–v0.47, the release-note items that touch this environment** (there is no v0.44.0; v0.45.0
follows v0.43.0):

- **Removal commands prompt (v0.45.0)**, and declining returns non-zero — `sbx rm` needs `--force`
  in any script or agent shell.
- **Egress is stricter (v0.45.0–v0.47.0)**: DNS resolution is refused when no rule permits it, PTR
  lookups only for already-authorized IPs, policy evaluation failures fail **closed**, and raw TCP to
  a denied hostname is no longer let through by an allow rule for its resolved IP. All narrow; none
  widens egress.
- **`secret set --command` helpers run from a fresh temp dir (v0.46.0)** — unused here (`sbx secret
  ls` is empty), noted in case that changes.
- Still **no `--disk` flag** on `sbx create` (checked on v0.47.0); sizes remain §8's variables.

Upgrade itself, 2026-10-08: the `E:` junction, both size variables, both `.img` volumes and the
sandbox all survived. The sandbox was then **recreated** for the §8 resize, so the policy-UUID
continuity checked on v0.43.0 was not re-tested. Created with `--skills=off` — the previous
sandbox predated v0.43.0's `readonly` default and never had the host skills store mounted. The
recreated sandbox carries **only** the 51 generator rules; the kit-provisioned `openrouter.ai` rule
the old sandbox had was not re-provisioned by the `shell` kit.

**Verification for v0.47.0 + the 150 GB recreate, 2026-10-08:**

| Check | Result |
| --- | --- |
| `run-harness.sh`, first run | **9/12** — three FAILs, none a regression: `sandbox-egress` (the refusal-body change, [§3](devcontainer-sandbox.md) — an instrument fault), `personal-layer` (no dotfiles on a CLI `devcontainer up`, §8), `firewall-allowlist` (the known first-run case below; passed on a re-run) |
| `run-harness.sh`, after the marker fix + dotfiles + `ensure-rtk-hook.sh` | **12/12 PASS**, `reproducible-recreate` included |
| G5 sibling-egress refusal | **PASS** — sibling blackholed; default-deny intact |
| `verify-sandbox-egress.sh --audit-check` | **PASS** — refusal in the audit log, all 50 canonical destinations live |
| `verify-engine-seam.sh --host-check` | **PASS** against a **running** engine (`server=29.7.2`), probe kept, `MCM_SANDBOX_CONTAINER` set |
| Volumes, from the host | `mcm-docker.img` **150.0 GB**, `rwlayer.img` **40.0 GB**; `/var/lib/docker` 147 G in the VM |

> Previous pin: `v0.43.0` (`79805a6e3c6667520dc2da4f6bdeddae9b700969`), upgraded from v0.39.0 on
> 2026-09-19 — the notes and table below record that upgrade. Record the version whenever you report a problem —
several behaviours here are version-specific and undocumented.

Re-checked on v0.43.0 and **unchanged**: `sbx start` still does not exist; there is still no
`--disk` flag (sizes remain creation-time environment variables, §8); the local idle-stop still has
no knob (`--on-timeout` exists but is cloud-only and tied to `--ttl`); and the dockerd-readiness
deadline that makes a healthy sandbox unstartable is **not** raised, and still has no knob of any
kind — the launcher works around it instead (§7f).

**Changed in v0.43.0:** `sbx create`/`sbx run` now take `--skills=off|readonly|readwrite` and
default to **`readonly`**, so the host skills store is mounted into new sandboxes unless you opt
out. `sbx policy ls` takes the sandbox **positionally** (`sbx policy ls mcm`); `--sandbox` is
rejected there, though it is still correct for `sbx policy allow network --sandbox mcm` ([§4](devcontainer-sandbox.md)).

> ⚠️ **The upgrade itself was clean, and preserved more than expected.** The `E:` junction survived,
> `DOCKER_SANDBOXES_DOCKER_SIZE`/`ROOT_SIZE` and both `.img` volumes were untouched, and the sandbox
> survived v0.43.0's UUID migration with its local egress policy intact — **same policy UUID, all 50
> network allow rules**. Only the *kit* policy's UUID changed, which is expected.

**Verification actually performed for this upgrade (step 3/4 above), 2026-09-19:**

| Check | Result |
| --- | --- |
| The 12 harness invocations except `reproducible-recreate` | **all PASS** |
| `verify-sandbox-egress.sh --audit-check` (host-side, the G5 audit half) | **PASS** — refusal present in the governance audit log, **all 49 canonical destinations live in the policy** |
| G5 sibling-egress refusal (in `verify-firewall-allowlist.sh`) | **PASS** — sibling container blackholed; default-deny intact |
| `verify-reproducible-recreate.sh` | **PASS**, after fixing the script. It failed first for a **pre-existing** reason, not the upgrade — the base image is absent from the pre-upgrade inventory too and the script never sourced the pin. It now sources it and refuses before destroying (see §10) |
| `verify-engine-seam.sh --host-check` | **PASS**, re-run against a **running** Windows engine (`server=29.7.2`) with a live probe. The first run was vacuous — Docker Desktop was stopped |

The host-side proof is only worth reading when it was run properly, which means: Docker Desktop
**up**, the in-container half run first with `KEEP_PROBE=1` so a probe actually exists on the other
side of the boundary, and `MCM_SANDBOX_CONTAINER` set so the real dev container's absence is asserted
too. Do **not** set `MCM_EXPECT_NO_STACKS=1` on this workstation: the retained Docker Desktop path
legitimately leaves exited MCM stack containers on the Windows engine, and the script's own comment
allows for exactly that.

```bash
# 1. in the sandbox — leave a probe behind
sbx exec mcm sh -c 'DC=$(docker ps --filter label=devcontainer.config_file --format "{{.Names}}" | head -1)
  docker exec -u coder -w /workspaces/mcm -e KEEP_PROBE=1 "$DC" bash .devcontainer/verify/verify-engine-seam.sh'
# 2. on Windows, with Docker Desktop running
MCM_SANDBOX_CONTAINER=<dev-container-name> \
  bash .devcontainer/verify/verify-engine-seam.sh --host-check mcm-engine-seam-probe
```

⚠️ `verify-firewall-allowlist.sh` failed on the first harness run and passed after a full
`devcontainer up`. The dev container returns after a VM restart via `restart: always`, which does
**not** re-run `postStart` — so `init-firewall.sh` never reapplies the in-container rules. A sandbox
that has only ever been restarted, never `devcontainer up`-ed, can therefore be running without
them.

`sbx` is a fast-moving, pre-1.0 tool that this environment depends on for **isolation and egress
enforcement**, so an upgrade is a security-relevant change, not a routine one. Before upgrading:

1. **Read the release notes for the intervening versions**, specifically for changes to: network
   policy semantics, `--network=host` behaviour, port publishing, the idle-stop timeout, secret
   injection, and template semantics. Each is load-bearing here.
2. **Capture the before-state**: `bash .devcontainer/verify/verify-reboot-survival.sh --capture`.
3. **Upgrade**, then re-run the harness: `bash .devcontainer/verify/run-harness.sh`, plus the
   host-side `verify-sandbox-egress.sh --audit-check`.
4. **Re-run G5 explicitly.** The sibling-egress refusal is the security claim this whole environment
   rests on, and it is enforced by the tool being upgraded. A green harness that skipped it proves
   nothing about the property that matters most.
5. Note the new version here.

> Behaviours observed on v0.38.0 that a future version may change silently — check each after an
> upgrade rather than assuming: no `--disk` flag to enlarge the 49 G Docker disk; the ~30 s
> idle-stop is hardcoded with no knob; `sbx start` does not exist; `sbx run` defaults the workspace
> to the current directory; templates exclude the Docker image store.

---
