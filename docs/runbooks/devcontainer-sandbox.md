# Runbook — the dev container on a Docker Sandbox microVM

The AI-assisted development environment runs as a **dev container inside a Docker Sandbox microVM**,
not on Docker Desktop and not in Docker-in-Docker. This page is the operating manual for that
environment: how to get into it, how it is layered, what breaks, and how to tell a real fault from
an instrument lying to you.

The Docker Desktop path still exists and is documented in [devcontainer.md](devcontainer.md). It is
retained for one reason only — the **Android emulator**, which needs `/dev/kvm` that the microVM
cannot provide (feature 060, gate R2, resolved negative).

---

## 0. The credential rule — read this before anything else

> **AI-assisted coding runs on the Claude MAX SUBSCRIPTION. The Anthropic API key exists only for
> the movie assistant (E2E) and OpenWiki.** This holds identically on the Windows host, in the
> Docker Desktop dev container, and in this sandbox.

The key is carried as **`MCM_ANTHROPIC_API_KEY`** and mapped to `ANTHROPIC_API_KEY` **only at the
point of use** — the agent gateway (`agent-stack.mjs`), OpenWiki maintenance (`wiki-maintain.mjs`),
and the containerized web/agent E2E recipe. Each is a separate process running no assistant.

**Never set `ANTHROPIC_API_KEY` in any of the three environments.** Claude Code silently prefers it
over an existing subscription login, with no warning and nothing in the UI showing which is in use,
so a session bills pay-per-token while a valid subscription sits idle. **Measured 2026-08-16: ~$15
of unintended spend in one day**, on a workstation where `oauthAccount` was present throughout.

CI is unaffected: it injects `ANTHROPIC_API_KEY` into jobs that run no interactive assistant, and
every consumer honours that name first. Full mechanism and the host migration command:
[devcontainer.md](devcontainer.md).

> **The VM has its own `ANTHROPIC_API_KEY=proxy-managed`.** That 13-character value is *not* a key
> and not a leftover — it is Docker Sandbox's own marker. If a secret is stored (`sbx secret set`),
> a proxy substitutes the real credential in flight. See §9.

---

## 1. Getting in — one step, not four

The manual route is *open VS Code → Remote-SSH: Connect to Host → Open Folder → Dev Containers:
Attach to Running Container*. Don't do that. Use:

```powershell
.\scripts\open-sandbox.ps1
```

It checks whether the sandbox is running, starts it if not, waits for SSH, and opens VS Code
**directly inside the dev container**.

> Runs on **Windows PowerShell 5.1** — the default shell. `pwsh` (PowerShell 7) is **not** required
> and is not installed by default on Windows. If script execution is blocked by policy:
> `powershell -ExecutionPolicy Bypass -File .\scripts\open-sandbox.ps1`

For zero commands, make a shortcut with this target and pin it:

```text
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<repo>\scripts\open-sandbox.ps1"
```

### How it works, and why it is not a hardcoded string

VS Code can address a dev container that lives inside a remote SSH host with one compound URI:

```text
vscode-remote://dev-container+<hex>@ssh-remote+mcm.sbx/workspaces/mcm
```

`<hex>` is the hex-encoded UTF-8 of a small JSON descriptor naming the workspace path and the
`devcontainer.json` to use. The script **generates** it. A pasted URI silently opens the *wrong*
target the moment the workspace path or config file moves — and "wrong target" here is a window that
looks entirely correct while running somewhere else.

> Once opened this way the entry appears in **File → Open Recent** (`Ctrl+R`), which is faster
> still — **but only while the sandbox is running.** Against a stopped VM the Recent entry fails in
> a way that reads as a broken environment. That is what the script's start-check is for.

---

## 2. Lifecycle — and the two commands that surprise people

| Intent | Command |
| --- | --- |
| list sandboxes and their state | `sbx ls` |
| start an existing, stopped sandbox | **`sbx run --name mcm -d`** |
| stop without destroying | `sbx stop mcm` |
| destroy | `sbx rm mcm` |
| shell in | `ssh mcm.sbx` |

⚠️ **`sbx start` DOES NOT EXIST.** It is not an error — the invocation silently prints the root
help, so a procedure built on it appears to do nothing and reads as a broken sandbox. `sbx stop
--help` states the real path: *"Stopped sandboxes retain their state and can be restarted with
`sbx run`."*

⚠️ **`--name` is load-bearing.** `sbx run` *creates a sandbox if one does not exist*, and the first
positional argument is an **agent**, not a sandbox. `sbx run mcm` would try to run an agent called
`mcm`; without `--name` you can end up with a second sandbox rather than your existing one.

### After a workstation reboot

`sandboxd` **does not auto-start at boot**. `sbx run --name mcm -d` starts it on demand, so no manual
step is owed — but reaching for `ssh mcm.sbx` first can surface a daemon error that reads like a
broken environment rather than a cold host. Start with `sbx run`.

Everything else survives a real reboot, verified 2026-08-16: workspace clone, all images, all
volumes, all containers, shell history, and every container that was running **with a restart
policy** comes back on its own. See § 7 for the delta (the agent stack does not, by design) and use
`verify-reboot-survival.sh --verify` rather than judging by eye.

### The microVM stops when idle — this is the normal case, not a fault

The VM stops roughly **30 seconds after the last session disconnects**. It is hardcoded; there is no
configuration knob. Consequences you will actually meet:

- Coming back to a "missing" environment usually means it idle-stopped. Start it; nothing is lost.
- **Long unattended jobs die** unless a session is held. Hold one:
  `ssh mcm.sbx 'sleep 5400'` in another window, and launch the work with `setsid nohup … &`.
- The dev container carries `--restart=always` so it returns by itself; see §7 for what does not.

### Recreating the DEV CONTAINER — after a `devcontainer.json` change

**Two different things are called "recreate", and confusing them is expensive.** Recreating the
*sandbox* (`sbx rm` + template, §7b/§8b) destroys the microVM, the workspace and every volume.
Recreating the *dev container* keeps all of that and rebuilds only the container — it is what you
want after editing `devcontainer.json`, and it is the common case that was previously documented
only inside §7d's UID-fix narrative, where it reads as part of an image re-pin.

**It runs in the VM shell, and it destroys the container you are working in.** A container cannot
rebuild itself, so an assistant session inside it ends when this runs. `containerEnv`, `mounts` and
`onCreateCommand` changes take effect **only** at container creation — editing them changes nothing
until this is done.

```bash
ssh mcm.sbx                       # the VM shell, NOT the container

# 1. Gate first: the VM's copy of the repo must actually carry your change. A recreate that used
#    the old config is indistinguishable from one that worked, so check rather than assume.
grep -c <the-thing-you-added> /workspaces/mcm/.devcontainer/sandbox/devcontainer.json

# 2. `set -a` is LOAD-BEARING even when you are not re-pinning. ~/.mcm-sandbox-env has no `export`
#    keyword, and the config reads the pin as ${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}
#    from THIS shell. Source it without -a and the variable is set but not exported: `localEnv`
#    misses it and the build silently falls back to the stale local `mcm-devcontainer` image.
set -a; . ~/.mcm-sandbox-env; set +a
echo "$MCM_DEVCONTAINER_IMAGE"    # must print the pinned @sha256:<digest>, not a bare tag

# 3. recreate
devcontainer up --workspace-folder /workspaces/mcm \
  --config /workspaces/mcm/.devcontainer/sandbox/devcontainer.json --remove-existing-container
```

🔴 **`--config` resolves against your CWD, not against `--workspace-folder`.** The VM shell lands in
`/home/agent/workspace`, so the relative form every snippet in this runbook used until 2026-08-27
fails there — and it fails in a way that reads like the file is missing rather than like the path is
wrong:

```text
Error: Dev container config (/home/agent/workspace/.devcontainer/sandbox/devcontainer.json) not found.
```

The gate commands above are unaffected because they name absolute paths, so step 1 passes and step 3
is what breaks. Pass `--config` absolutely (as shown), or `cd /workspaces/mcm` first.

**Editing `.devcontainer/devcontainer.json` alone changes nothing on this path.**
`.devcontainer/sandbox/devcontainer.json` is a *duplicate*, not an extension (feature 060, until
FR-032 collapses them), with its own `containerEnv` and its own `onCreateCommand`. The sandbox is
the path in daily use, so a change made only to the Docker Desktop file is real, committed, and
inert — and the recreate that "didn't work" sends you looking at the wrong thing. Edit both.

⚠️ **`devcontainer up` echoes its full `docker run` invocation, including every `-e` secret in clear
text** — `MCM_ANTHROPIC_API_KEY`, `TMDB_API_KEY`, `MCM_FORGE_TOKEN`, `MCM_FORGE_ISSUE_TOKEN`. Treat
that output as credential material: never paste it into an issue, a chat, or a transcript.

**Hold the VM shell open for the whole build.** The idle-stop above fires ~30 s after the last
session disconnects, and a half-built container is one of the ways `Exited (255)` appears.

When the **image** is what changed (a `toolchain.Dockerfile` edit), this is not enough — you need the
full pull → verify → re-pin → rebuild sequence in §7d, including the all-`CACHED` tell that says the
re-pin did not take. Nothing survives this that would not survive a plain restart, so §8b's
"what a recreate destroys" does **not** apply here: volumes, `/workspaces/mcm` and
`~/.mcm-sandbox-env` all live in the VM, which this leaves untouched.

---

## 3. Layering — where each rule is actually enforced

```text
Windows host ── sbx daemon ── egress policy  ◄── THE enforcement layer
   └── microVM ("host" for --network=host)
        ├── dev container   (docker-outside-of-docker, shares the VM netns)
        └── sibling containers (compose stacks, agent stack, probes)
```

**Triage order when something is blocked: host policy first, in-VM second.** That is the opposite of
the Docker Desktop path, and it matters because the in-VM firewall **is not used here at all**.

### The sandbox path does not run `init-firewall.sh` (D-18)

On Docker Desktop the dev container programs its own `ipset`/`iptables` default-deny. Here it does
not, for two measured reasons:

1. `--network=host` means the dev container shares the VM's network namespace **identically**
   (`net:[4026532855]` on both sides). A default-DROP from inside it would be **VM-wide**, hitting
   the sandbox's own policy proxy and every sibling container.
2. It was never running anyway. `postStartCommand` is a *devcontainer-lifecycle* hook — it does not
   fire on a Docker-level restart, and the idle-stop cycle restores containers through Docker.

Egress was fully governed throughout regardless, by the host-side policy. `postStartCommand` now
runs **`assert-egress-governed.sh`**, which verifies rather than re-implements, and fails if a
blocked host is reachable **or** if an allowlisted one is not — a severed network must not read as a
security pass.

### Refusals look different from each vantage point

A check keyed to one refusal signature reports a hole when the mechanism merely changed:

| From | Blocked destination looks like |
| --- | --- |
| dev container | `rc=6` — NXDOMAIN (DNS-layer refusal); `curl` also writes `000` |
| sibling container | `rc=6` — NXDOMAIN (DNS-layer refusal) |
| raw IP from a sibling | `rc=35` — TLS terminated mid-handshake |
| VM shell | HTTP **403** with `Blocked by network policy` |

⚠️ **`nc -z <ip> 443` reports OPEN against a blocked destination.** The proxy accepts the TCP
connection and refuses at TLS. A connect-only probe will tell you egress is wide open when it is
not. Always probe with a real request.

⚠️ **`000` is not a signature — it is curl's placeholder for a request that was never made.** The
dev-container row above read "no route — `curl` writes `000`" until 2026-08-27 (item #253), which
says route layer and hands you the one field that cannot distinguish the layers. It cost a triage
pass: `curl -w '%{http_code}'` against a non-allowlisted host prints `000` and the resolver error
goes to *stderr*, so a probe that captures only stdout reports a route-level block for what is
actually NXDOMAIN. **Read the exit code, not the status code.** Measured from the dev container:

```bash
getent hosts registry.npmjs.org   # allowlisted -> resolves;      curl -> 200, rc=0
getent hosts example.com          # NOT allowlisted -> no answer;  curl -> 000, rc=6
```

Both vantage points refuse at DNS because both enforce the same per-FQDN allowlist. Node surfaces
that same refusal as `getaddrinfo ENOTFOUND <host>` — the signature `platform.claude.com` and
`mcp.expo.dev` were each first diagnosed from.

⚠️ **The allowlist resolves per FQDN, never per apex domain.** A sibling name on an already-allowed
domain is a separate entry and is refused without one — `api.expo.dev` answers 200 from the dev
container while `mcp.expo.dev` NXDOMAINs. This is the same front-door-vs-blob-host trap tabulated in
§4, and the lesson is that it is not specific to registries: it applies to every second hostname a
service uses, MCP endpoints included.

---

## 4. Egress allowlist

One canonical list, two emitted forms, never hand-edited:

```bash
node scripts/gen-egress-policy.mjs --check              # validate
node scripts/gen-egress-policy.mjs --format sbx-policy  # host-side rules
node scripts/gen-egress-policy.mjs --format ipset-domains
```

Source of truth: `.devcontainer/egress-allowlist.json`. Add a destination there and regenerate;
never add a rule by hand to one layer.

### 🔴 Adding a destination does NOT reach a RUNNING sandbox

The two layers pick a new entry up differently, and only one of them does so by itself. The in-VM
iptables half re-reads the canonical file every time `init-firewall.sh` runs (postStart). The
**host-side policy is scoped per sandbox** (`--sandbox <name>`) and holds whatever was applied when
that sandbox was created — a committed entry changes nothing for it. So the destination stays
blocked, with the commit sitting in git looking like the fix:

```powershell
sbx ls                                             # confirm the name and that it is running
sbx policy allow network <domain> --sandbox mcm    # operator, on the Windows host
sbx policy ls --sandbox mcm                        # the rule should now be listed
```

`mcm` is this environment's sandbox — the same name every command in section 2 uses. It is only a
variable in the recreate-from-template flow below, where you are naming a NEW sandbox.

Confirm from inside the container rather than inferring from the diff — a request, never `nc -z`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/
```

### The trap that has now bitten five times: front door ≠ blob host

A service's API host and its download/CDN host are different names, and allowlisting the first
yields a fetch that authenticates and then dies:

| Service | Front door | Blob/CDN host |
| --- | --- | --- |
| Docker Hub | `registry-1.docker.io` | `production.cloudfront.docker.com` |
| GHCR | `ghcr.io` | `pkg-containers.githubusercontent.com` |
| Quay | `quay.io` | `cdn0N.quay.io` |
| MCR | `mcr.microsoft.com` | `*.data.mcr.microsoft.com` |
| GitHub releases | `github.com` | **`release-assets.githubusercontent.com`** |

The last one also shows a second failure mode: `objects.githubusercontent.com` was **correct when
written** and silently stopped covering release downloads when GitHub migrated. A previously-valid
entry can go stale without anything changing on our side.

> **When a fetch fails with a DNS error, follow the REDIRECT CHAIN before adding the host named in
> the error.** The message names the host you asked for, not the host that was blocked:
> `curl -sSL -o /dev/null -w '%{url_effective}\n' <url>`

---

## 5. The engine seam — and the defect that returns exit 0 with no output (D-19)

The dev container reaches the VM's engine through `docker-outside-of-docker`, which bind-mounts the
socket as `/var/run/docker-host.sock` and fronts it with a socat relay on `/var/run/docker.sock`.

**That relay silently truncates output.** socat's half-close timeout defaults to **0.5 s**, and
`docker exec` half-closes stdin immediately, so socat tears the relay down mid-response:

```text
sleep 0s -> [LATE-0]      sleep 1s -> []  rc=0      sleep 3s -> []  rc=0
```

**Exit code 0 with empty stdout.** Fast commands work, so the seam looks healthy under any quick
probe; only real work fails. It cost an agent-stack bring-up (`production_nodes_enabled=` — empty,
not `false`, against a healthy gateway) and two test stages their entire logs.

**Fix, already applied** in `.devcontainer/sandbox/devcontainer.json`:

```jsonc
"DOCKER_HOST": "unix:///var/run/docker-host.sock"
```

If you invoke docker from a context that does not inherit `containerEnv` (a raw `docker exec` from
the VM into the dev container, a script run before the env is set), **pass it explicitly** or you
will collect artifacts with no logs:

```bash
docker exec -e DOCKER_HOST=unix:///var/run/docker-host.sock -u coder -w /workspaces/mcm <dc> bash -lc '…'
```

`verify-engine-seam.sh` assertion 3b guards this with a deliberately **slow** (2 s) trivial command.
A fast probe there would assert nothing.

---

## 6. Networking quirks you will hit

| Symptom | Cause | Use instead |
| --- | --- | --- |
| `host.docker.internal` unreachable from the dev container | Docker's implicit entry resolves to `fe80::1` (link-local IPv6) | **`localhost`** — under `--network=host` a sibling's published port *is* localhost |
| `host.docker.internal` works from the gateway/MCP containers | they are started with `--add-host host.docker.internal:host-gateway` → `172.18.0.1` | keep that flag; it is load-bearing |
| a sibling cannot be reached by container name | no shared user-defined network | publish the port, use `localhost` |

---

## 7. Restart and reboot — what survives

Proven across a full `sbx stop` → `sbx run --name mcm -d` cycle: workspace clone (same commit), all
images, all volumes, all containers, shell history, and the dev container running again.

| Comes back automatically | Does **not** |
| --- | --- |
| dev container (`restart=always`) | `movie-assistant-gateway` |
| the 9 compose containers (`unless-stopped`) | the 3 MCP servers |

The agent stack is started by `docker run` with **`restart=no`, deliberately**. A restart policy
would resurrect the gateway from its *pre-rebuild* image — the "silently runs old code" trap. Bring
it back explicitly:

```bash
MODEL_PROVIDER=anthropic pnpm nx up-agents-prod infrastructure-as-code
```

Verify a restart with the instrument, not by eye — a partially restored environment looks identical
to a healthy one until the next build takes seventeen minutes:

```bash
bash .devcontainer/verify/verify-reboot-survival.sh --capture   # BEFORE
bash .devcontainer/verify/verify-reboot-survival.sh --verify    # AFTER
```

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

## 7c. Port publishing — including to a physical LAN device (R9)

```powershell
sbx ports mcm                                       # list
sbx ports mcm --publish 8081:8081                   # loopback only (the DEFAULT)
sbx ports mcm --publish 0.0.0.0:8081:8081           # reachable from the LAN
sbx ports mcm --unpublish 0.0.0.0:8081:8081
```

**`sbx ports` binds non-loopback natively — no `netsh portproxy` shim is needed.** The spec is
`[[HOST_IP:]HOST_PORT:]SANDBOX_PORT[/PROTOCOL]`, and omitting `HOST_IP` is what restricts it to
loopback. Verified 2026-08-16: publishing `0.0.0.0:8081:8081` showed `0.0.0.0 8081` in `sbx ports`
and `0.0.0.0:8081` LISTENING in `Get-NetTCPConnection` on Windows.

To reach Metro from a phone: publish on `0.0.0.0`, then browse to `<windows-lan-ip>:8081`. **Windows
Firewall is the remaining variable** — all three profiles are enabled by default, so an inbound
allow rule for the port is required; if you would rather not add one, `pnpm start --tunnel` (the
Expo tunnel) needs no inbound rule at all.

> ⚠️ **`sbx ports` lists nothing when the sandbox is stopped.** That is not the same as "your ports
> were removed" — it is the idle-stop. Check `sbx ls` before concluding anything was lost. Published
> ports are restored on restart.

> 💡 **`ssh mcm.sbx` starts a stopped sandbox by itself.** You do not have to `sbx run` first; the
> connection triggers the start. `scripts/open-sandbox.ps1` still starts it explicitly because it
> then *waits* for readiness, which is what stops VS Code racing the boot.

### 🔴 The sandbox and the Windows host share ONE port space — and a VS Code forward holds it

Measured 2026-08-23. `sbx ports`, **VS Code's dev-container port forwarding**, and anything published
by Docker Desktop on Windows all bind the *same* `127.0.0.1` port space. There is no separation: a
port the sandbox has forwarded is a port the host cannot bind, and vice versa. This is the same class
of fault as [the prod/CI published-port collision](/openwiki/invariants/published-port-reservation.md),
one layer down.

**It cost most of a session, in two different disguises.**

*Disguise 1 — a bind that fails loudly.* Bringing up the host's `auth` stack while the dev container
was open:

```text
Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:8099 ->
127.0.0.1:0: listen tcp4 127.0.0.1:8099: bind: Only one usage of each socket address ...
```

That one is honest — you know immediately. **The damage is what you do next:** the natural reflex is
`docker compose up -d`, which does not merely start the container, it *reconciles* it and prints
`Container keycloak-service Recreated`. The original container is destroyed. Use `docker start <name>`,
or `up -d --no-recreate`, when the container already exists.

*Disguise 2 — the dangerous one, a forward with nothing behind it.* VS Code keeps the host port bound
for the lifetime of the window **even when the service inside the sandbox has stopped**. A client then
completes the TCP handshake and waits forever for a response that never comes. No refusal, no error,
no timeout — just a hang. An Android emulator sat on its splash screen indefinitely because the app's
dev-server connection was `ESTAB` to a VS Code forward serving nothing.

**Diagnose by asking who owns the port, not whether it answers:**

```powershell
Get-NetTCPConnection -LocalPort 8099 -State Listen |
  ForEach-Object { "{0} <- PID {1} ({2})" -f $_.LocalAddress, $_.OwningProcess,
                    (Get-Process -Id $_.OwningProcess).ProcessName }
```

| Owning process | What it is |
| --- | --- |
| `Code` | a **VS Code dev-container forward** — may be a dead tunnel; closing the window or "Stop Forwarding Port" releases it |
| `com.docker.backend` | a Docker Desktop published port (a host stack) |
| `ssh` | a manual `ssh -L` tunnel |

**A reachability check is not an ownership check.** `curl` succeeding proves *something* is listening;
it does not prove it is the something you meant. When two Keycloaks exist — one in the sandbox, one on
the host — `localhost:8099` answers either way, and credentials from the host's `auth.env` are rejected
by the sandbox's instance. That reads exactly like "my password broke" and is not. Confirm which
instance you are talking to before concluding anything about credentials.

---

## 7d. 🔴 Run git INSIDE the container, never from the VM shell

The VM user and the container user are **different UIDs**, and the same UID renders under a different
name on each side — which makes the symptom read like corruption rather than permissions:

| | UID | shows as |
| --- | ---: | --- |
| VM shell (does the clone; any `ssh <sandbox> 'git …'`) | **1000** | `agent` |
| dev container | **1001** | `coder` |
| a VM-created file, seen from inside the container | 1000 | **`node`** (the base image's user) |

Anything git writes from the VM is unwritable by the container user. It fails deep, on individual
object writes:

```text
111 of 256 .git/objects subdirs plus 27 worktree files are owned by node, not coder,
so any object write fails
```

**Two ways in, and the second keeps happening:** the documented recreate clones from the VM shell, so
a fresh environment is born with it; and any later `ssh <sandbox> 'git -C /workspaces/… fetch|pull'`
re-poisons it. That is an easy reflex when scripting the sandbox from the host, and it is how the
111 subdirs above were created.

**The rule: git runs in the container.** To automate from outside, go through
`docker exec -u coder …`, never the VM shell.

### ✅ FIXED (2026-08-17) — `coder` is uid 1000, matching the VM user

`toolchain.Dockerfile` creates `coder` at **1000:1000**, moving the base image's `node` to 1100
first. At that point in the build the image is nearly empty, so the renumber is free. Verified after
re-pinning:

```text
VM        : 1000:1000  (agent)
container : 1000:1000  (coder)
container git write: OK
VM        git write: OK          ← both sides, which no earlier attempt achieved
workspace paths not owned by me: 0
```

**Applying it is a re-pin, not a local build.** Pushing a `toolchain.Dockerfile` change *is* the
trigger — the `devcontainer-image` workflow builds and publishes automatically, so check for a
`build-publish` run before building anything by hand.

**The procedure, in full — and it runs in the VM shell, not the container.** A container cannot
rebuild itself; `devcontainer up` must run from `ssh mcm.sbx`, and it destroys the container you may
be working in. Everything below is one VM-shell session, because step 3's `set -a` only holds there.

> This is the **image-change** variant, which is why steps 1-3 exist. For the far more common
> `devcontainer.json`-only change, use §2's *Recreating the DEV CONTAINER* — same step 4, no re-pin.
> Step 3's `set -a` is required either way.

```bash
NEW=<the 64-hex digest from the build's run summary>          # NOT the tag — pin by digest
REG="$FORGE_REGISTRY_HOST:3000"

# 1. pull, and CONFIRM the image carries the change BEFORE it becomes your environment
docker pull $REG/<ns>/mcm-devcontainer@sha256:$NEW
docker run --rm --entrypoint bash $REG/<ns>/mcm-devcontainer@sha256:$NEW -lc 'id -u coder; pwsh --version'

# 2. edit the pin. MCM_DEVCONTAINER_IMAGE lives in ~/.mcm-sandbox-env (NOT ~/.bashrc). The file is
#    KEY='value' — quoted, and with NO `export` keyword. Substitute only the digest.
cp ~/.mcm-sandbox-env ~/.mcm-sandbox-env.bak
sed -i "/^MCM_DEVCONTAINER_IMAGE=/s|@sha256:[0-9a-f]\{64\}|@sha256:$NEW|" ~/.mcm-sandbox-env
grep MCM_DEVCONTAINER_IMAGE ~/.mcm-sandbox-env

# 3. source it, and GATE on the result rather than eyeballing it
set -a; . ~/.mcm-sandbox-env; set +a
case "$MCM_DEVCONTAINER_IMAGE" in
  *"$NEW") echo "PIN OK — safe to rebuild" ;;
  *)       echo "PIN NOT APPLIED — stop; devcontainer up would build the OLD image" ;;
esac

# 4. only on PIN OK. (For the UID fix specifically, chown the tree to 1000 first.)
devcontainer up --workspace-folder /workspaces/mcm \
  --config /workspaces/mcm/.devcontainer/sandbox/devcontainer.json --remove-existing-container
```

🔴 **Two ways this silently re-creates the OLD container, both measured 2026-08-22.**

**`set -a` is load-bearing.** `~/.mcm-sandbox-env` has no `export` keyword, and
`.devcontainer/sandbox/devcontainer.json` reads the pin as
`${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}` from **the shell running `devcontainer up`**.
Source it without `set -a` and the variable is set but not exported, so `localEnv` misses it and the
build **falls back to the literal default `mcm-devcontainer`** — a stale local image, with no error.

**An all-`CACHED` build is the tell.** A re-pin that did not take produces a build where every layer
reports `CACHED` and a container that starts perfectly, having changed nothing. Read the one line
that settles it — `devcontainer up` echoes it:

```text
docker buildx build … --build-arg BASE_IMAGE=<registry>/<ns>/mcm-devcontainer@sha256:<digest>
```

If that digest is the old one, stop; nothing after it matters. A genuine re-pin is **not**
all-CACHED, because the layers above the new base must rebuild.

⚠️ **`devcontainer up` prints its full `docker run` invocation, including every `-e` secret in clear
text** — `MCM_ANTHROPIC_API_KEY`, `TMDB_API_KEY`, `MCM_FORGE_TOKEN`, `MCM_FORGE_ISSUE_TOKEN`. Treat
that output as credential material: do not paste it into an issue, a chat, or a transcript, and
rotate all four if you already have.

Afterwards, confirm from **inside** the new container — the pin is not the proof, the tool is:

```bash
bash .devcontainer/verify/verify-toolchain-present.sh      # asserts the whole baked toolchain
```

⚠️ The historical account below is kept because the failure modes are instructive, and because the
same trap will reappear for anyone renumbering a user in a large image.

⚠️ **Do not shortcut this with a layer on top of the prebuilt image.** Tried 2026-08-17; it cannot
work. Changing a file's ownership **copies it up into the new overlay layer**, so a UID renumber
duplicates the entire ~13 GB image. The build died in `exporting layers` with `no space left on
device` on the Android system image, and filled the VM's disk to 100% doing it.

> **Recovery, worth knowing on its own:** `docker builder prune -f` freed almost nothing, because
> BuildKit only drops *unused* cache. **`docker builder prune -af`** reclaimed **17.8 GB**.

Two further approaches were tried and rejected — recorded so they are not retried:

| Approach | Result |
| --- | --- |
| `"updateRemoteUserUID": true` (the dev-container spec's own mechanism) | did not engage — set explicitly, container rebuilt, `coder` stayed 1001 |
| chown the tree to the container user | symmetric see-saw: `container git write: OK / VM git write: FAILED` |

**Until the image is rebuilt**, the supported posture is the rule above — and the VM shell's
inability to write the repo *enforces* it rather than merely encouraging it.

[`fix-workspace-ownership.sh`](../../.devcontainer/fix-workspace-ownership.sh) still runs at create
and at every start, repairing only mismatched paths (a healthy tree costs one `find`). It exists for
a tree already poisoned by earlier VM-side writes; understand it as moving the problem between the
two users, not solving it:

```bash
bash .devcontainer/fix-workspace-ownership.sh /workspaces/mcm
```

> A UID mismatch also trips git's *dubious ownership* guard, a different and equally confusing
> error. The script sets `safe.directory` as well.

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
[Environment]::SetEnvironmentVariable('DOCKER_SANDBOXES_DOCKER_SIZE','100GB','User')
[Environment]::SetEnvironmentVariable('DOCKER_SANDBOXES_ROOT_SIZE','40GB','User')
# then a NEW shell, so sbx and the daemon inherit them
```

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

## 9. Credential injection (`sbx secret`) — what it can and cannot reach

`sbx secret set anthropic --sandbox mcm` stores a credential **outside** the sandbox; a proxy
substitutes it in flight, so the key never exists inside. Measured reach:

| Vantage | Injection reaches it? |
| --- | --- |
| VM shell | ✅ yes |
| dev container | ⚠️ only with `https_proxy` + the proxy CA (it shares the VM netns) |
| bridge siblings (gateway, MCP) | ❌ **no** — they cannot route to the proxy's ULA address |

The gateway therefore keeps receiving the real key by injection from gitignored
`agents/movie-assistant/.env.local`. Moving the **dev container** onto proxy-managed credentials is
recorded as a follow-up (D-20) rather than applied: `https_proxy` routes *every* HTTPS client
through the proxy, including the forge, registry pulls, pnpm, cargo, uv and the Playwright fetch.

⚠️ `anthropicKey()` in `agent-stack.mjs` honours **`ANTHROPIC_API_KEY` first** so CI's injected
secret wins. In this VM that variable holds `proxy-managed`, so a naive run injects a non-credential
and fails with a 401 that reads as a bad key rather than a precedence problem. Use
`env -u ANTHROPIC_API_KEY` so `.env.local` wins.

---

## 10. Verification harness

```bash
bash .devcontainer/verify/run-harness.sh
```

Twelve scripts across three vantage points (in-container, VM-side, host-side). The host-side checks
cannot be faked from inside — a claim asserted only from within the thing being claimed about is not
proof — and the harness refuses to report them as passed without `MCM_HOST_CHECK`.

---

## 10b. The `sbx` version, and the ritual before upgrading it (R5)

**Pinned and proven at: `v0.38.0` (`c022b14634c4bea846ca12870d1d5e97d5868b54`).** Everything on this
page was measured against that build. Record the version whenever you report a problem — several
behaviours here are version-specific and undocumented.

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

## 11. Foot-guns, collected

- **`sbx start`** does not exist; it prints help. Use `sbx run --name`.
- **`sbx run` without `--name`** can create a second sandbox.
- **Prompts default to *No* non-interactively.** `sbx secret rm` needs `-f`; `rtk init -g` answers
  "no" and prints a manual step nobody reads (which is why `ensure-rtk-hook.sh` exists).
- **`pnpm` is not in the VM** — only in the dev container. VM-level scripts must
  `docker exec … bash -lc`, or fail with `rc=127`.
- **`docker exec` output vanishes for commands over ~0.5 s** unless `DOCKER_HOST` bypasses socat (§5).
- **`nc -z` reports OPEN against blocked destinations** (§3).
- **`sbx template save` holds a lock** and blocks other `sbx` commands, for many minutes on a
  large sandbox.
- **A tool's "no" is about the tool.** Before concluding something is impossible here, check the
  instrument — most wrong turns in this migration were instruments, not the environment.

---

## 12. Related

- [devcontainer.md](devcontainer.md) — the retained Docker Desktop path (and the emulator exception)
- [e2e-testing.md](e2e-testing.md) — the Playwright image recipe and tier flags
- [android-emulator.md](android-emulator.md) — why mobile E2E does not run here
- `specs/060-devcontainer-docker-sandbox/research.md` — decisions D-01…D-20 with the measurements
