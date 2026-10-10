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
| destroy | `sbx rm mcm --force` (v0.45.0+ prompts, and a non-interactive prompt answers *No*) |
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
*sandbox* (`sbx rm` + template, [§7b](devcontainer-sandbox-lifecycle.md)/[§8b](devcontainer-sandbox-lifecycle.md)) destroys the microVM, the workspace and every volume.
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
re-pin did not take. Nothing survives this that would not survive a plain restart, so [§8b](devcontainer-sandbox-lifecycle.md)'s
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
| VM shell, <= v0.43.0 | HTTP **403** with `Blocked by network policy` |
| VM shell, v0.47.0 | HTTP **403** with `Approval required for <host>:<port>.` / `Review and respond with:  sbx policy approval ls` |

🔴 **v0.47.0 changed the VM-shell refusal body — and the change read as a breach.** The first
harness run after the upgrade reported `example.com is REACHABLE — deny-by-default is NOT
enforcing`. It was not reachable: the proxy still answered 403, but with the new body, and the
check's marker no longer matched, so it took the 403 for the origin's. Both verify scripts now
accept both bodies (2026-10-08).

The new body also means **a refusal now queues a pending approval** (`sbx policy approval ls`
lists every refused host, with `no matching allow rule (default deny)` and `allow`/`dismiss`
options). Nothing is let through until a person answers one, so default-deny holds — but
`sbx policy approval respond … allow` is now a second way to widen egress that bypasses
`egress-allowlist.json`. **Never use it**: add the destination to the canonical file and apply the
generated rule (§4), or the next recreate silently loses it. Use `dismiss` to clear the queue.

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
sbx policy ls mcm                                  # the rule should now be listed (POSITIONAL)
```

`mcm` is this environment's sandbox — the same name every command in section 2 uses. It is only a
variable in the recreate-from-template flow below, where you are naming a NEW sandbox.

Confirm from inside the container rather than inferring from the diff — a request, never `nc -z`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/
```

### Which tier each host unblocks

An absent destination does not merely fail a command — it retires a **merge-gating tier** to
CI-only by accident, and the retirement is silent because the tier still *appears* to run (a skip
reads as a pass, and a fail-closed scanner reports `NOT RUN`). These are the entries whose absence
has actually done that:

| Host | Tier it unblocks | Symptom when absent |
| --- | --- | --- |
| `semgrep.dev` | `guardrails / sast` — Semgrep code SAST | `sast-scan.mjs` exit ≥ 2, "registry unreachable" (item #222) |
| **`api.osv.dev`** | `guardrails / sast` — **pip-audit**, the Python SCA half | `pip-audit: NOT RUN — httpx ConnectError ... Failed to resolve 'api.osv.dev'` (item #394) |
| **`registry.ollama.ai`** + its R2 blob host (**both**, see the next table) | `nx test:golden movie-assistant`, the agent half of `E2E_TIER=gate`, and `nx up-agents-prod` | `ollama pull` → `lookup registry.ollama.ai ... no such host`; `ollama list` stays empty and the model precheck aborts (item #394) |
| `api.themoviedb.org` | `nx test:integration web-api-mcp` — the certification lookup | live TMDB assertions unreachable from the dev-container shell (feature 059) |

⚠️ **A degraded environment and a real defect are indistinguishable.** With no model present,
an agent tier fails for a reason that looks exactly like a code fault. Feature 068 misdiagnosed two
of its three real defects as "environmental" on precisely this ambiguity — and the three defects
(`httpx2`'s separate exception hierarchy, a bare `streamable_http_app()` re-enabling DNS-rebinding
protection, and a `McServiceToolError` that mcp 2.x refused to relay) were all caught only by CI,
because no locally-runnable tier existed to catch them. That is the cost this table exists to
prevent, and the reason a missing host is triaged as a **blocked gate**, not an inconvenience.

### The trap that has now bitten six times: front door ≠ blob host

A service's API host and its download/CDN host are different names, and allowlisting the first
yields a fetch that authenticates and then dies:

| Service | Front door | Blob/CDN host |
| --- | --- | --- |
| Docker Hub | `registry-1.docker.io` | `production.cloudfront.docker.com` |
| GHCR | `ghcr.io` | `pkg-containers.githubusercontent.com` |
| Quay | `quay.io` | `cdn0N.quay.io` |
| MCR | `mcr.microsoft.com` | `*.data.mcr.microsoft.com` |
| GitHub releases | `github.com` | **`release-assets.githubusercontent.com`** |
| Ollama models | `registry.ollama.ai` | **`dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com`** |

GitHub releases also shows a second failure mode: `objects.githubusercontent.com` was **correct when
written** and silently stopped covering release downloads when GitHub migrated — a previously-valid
entry can go stale without anything changing on our side.

The Ollama row shows a third wrinkle, and the reason it is pinned rather than wildcarded: the blob
host is a **Cloudflare R2 bucket whose subdomain is the vendor's account id**, constant across pulls
while the path and the SigV4 query are per-request. `*.r2.cloudflarestorage.com` would have worked
and would have opened every R2 bucket of every account to this VM. A layer failure after a clean
manifest therefore means a **changed account id**, not a stale ipset — read the new name out of the
error and add it.

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

### 🔴 A `-v` mount SOURCE is resolved by the daemon, on the VM — not in this container

The seam above is about output. This one is about paths, and it bites the moment you run a container
of your own from in here (a probe, a scanner, Playwright). The `docker` CLI does not open the source
path; it sends the mount spec to the engine, which resolves it against **its own** filesystem. The
dev container's paths are not the daemon's paths.

**Only the workspace tree is shared.** `/workspaces/mcm` is genuinely the same directory on both
sides — verified by writing a canary in here and reading it back from inside a container. The VM has
its **own** `/tmp` and `/home/coder`, so a path under either is a different directory that merely
looks right.

**And a missing source is not an error — the daemon CREATES it, as an empty directory.** That single
fact is why both symptoms below point away from the cause. Measured 2026-09-07 (item #249):

| what you mount | what the container actually gets | how it fails |
| --- | --- | --- |
| a session scratch dir under `/tmp/…` | an **empty directory** the daemon just created | `MODULE_NOT_FOUND … requireStack: [ 'internal/preload' ]` — reads as a broken script |
| `-v /var/run/docker-host.sock:/var/run/docker.sock` | an **empty directory** where a socket belongs | `FATAL … unable to find the specified image "<tag>" … docker error: … Cannot connect to the Docker daemon` — reads as an image that was never built |
| `-v /var/run/docker.sock:/var/run/docker.sock` | the real socket | works |

The socket line is the counter-intuitive one: this container's own `DOCKER_HOST` is
`docker-host.sock` (above), so that is the name you reach for — but as a mount **source** it is
resolved VM-side, where the engine's socket is plain `/var/run/docker.sock`. Mount the wrong one and
`ls -la /var/run` on the VM afterwards shows a freshly created `docker-host.sock` **directory**
sitting next to the real `srw-rw---- docker.sock`; those stubs persist and make the next attempt fail
the same way.

**Probe before you debug the payload** — one command tells you which of the two you are looking at:

```bash
docker run --rm -v "$SRC":/x:ro alpine:3 stat -c '%F %n' /x   # "directory" for a dir you expected;
                                                              # "socket" for a socket. Empty dir => not shared.
docker run --rm -v "$SRC":/x:ro alpine:3 ls -la /x            # empty => the daemon invented this path
```

**So stage anything a container must read under `/workspaces`**, not in a session scratch directory —
and remember it lands in the build context of any `docker build .` from the repo root, so delete it
when you are done (or add it to `.git/info/exclude` while it lives).

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
of fault as [the prod/CI published-port collision](../../openwiki/invariants/published-port-reservation.md),
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

> This is the **image-change** variant, which is why steps 0-3 exist. For the far more common
> `devcontainer.json`-only change, use §2's *Recreating the DEV CONTAINER* — same step 4, no re-pin.
> Step 3's `set -a` is required either way.

> 🔴 **The digest does NOT come from the run summary — that route is dead on this forge.** This
> block said "from the build's run summary" until 2026-08-31, and item #268 is the measurement that
> it cannot work: there is no log endpoint, no summary endpoint, and `/actions/runs/{id}/jobs` is
> `404`. The workflow really does write the pinned ref to `$GITHUB_STEP_SUMMARY`, and nothing on
> this build can read it back. Ask the **registry** instead — that is authoritative anyway, because
> it is what `docker pull` resolves.

```bash
# 0. RESOLVE the digest from the registry. Run this from INSIDE the dev container (it is what has
#    MCM_FORGE_TOKEN) and do it FIRST — step 4 destroys that container, so resolving afterwards
#    means resolving from a shell that cannot. `$SHA` is the full 40-hex commit the run built.
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
curl -sS -o /dev/null -w '%header{docker-content-digest}\n' \
  -u "$OWNER:$MCM_FORGE_TOKEN" -H "Accept: $ACCEPT" \
  "$FORGE/v2/$OWNER/mcm-devcontainer/manifests/$SHA"
```

> ⚠️ **Do NOT take the digest from the packages API** (`/api/v1/packages/$OWNER?type=container&…`).
> Its newest row for a build is the **provenance attestation** — the `unknown/unknown` entry in the
> OCI index — not the image, and pinning it fails at pull time. Measured 2026-08-31 on the
> `6a27312c` build: the packages list led with `sha256:78de8866…` (attestation) while the tag
> actually resolved to `sha256:7a0192db…` (the index). The `manifests/<tag>` request above returns
> the index under **every** `Accept` header, which is why it is the one to trust.
>
> ✅ **Verify the image carries the change before pulling 13 GB**, by walking index → amd64 manifest
> → config blob and reading the build history — the same technique
> [ci-diagnostics](ci-diagnostics.md) uses to prove what is in a published image:
>
> ```bash
> jq -r '.history[].created_by' cfg.json | grep -aoE 'default-toolchain [^ ]+|cargo-audit@[0-9.]+'
> ```

```bash
NEW=<the 64-hex digest resolved above>                        # NOT the tag — pin by digest

# 1a. Build the ref FROM THE PIN YOU ALREADY HAVE. Do not assemble it from $FORGE_REGISTRY_HOST:
#     that variable lives in ~/.mcm-sandbox-env, which nothing has sourced yet at this point in the
#     sequence, so a fresh VM shell has it EMPTY and `docker pull` fails with the misleading
#     `invalid reference format` (measured 2026-08-31). Deriving it cannot get the host or the
#     namespace wrong.
OLD=$(grep -m1 '^MCM_DEVCONTAINER_IMAGE=' ~/.mcm-sandbox-env | cut -d= -f2- | tr -d "\"'")
case "$OLD" in
  *@sha256:*) REF="${OLD%@*}@sha256:$NEW"; echo "new ref: $REF" ;;
  *) echo "STOP — the current pin is not digest-pinned ($OLD); do not guess the ref" ;;
esac

# 1b. pull, and CONFIRM the image carries the change BEFORE it becomes your environment.
#     Check the tools THIS refresh was for, not a fixed list — `pwsh --version` proves only that
#     you pulled some image.
docker pull "$REF"
docker run --rm --entrypoint bash "$REF" -lc 'id -u coder; rustc --version; uv --version'

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

### 🔴 `containerEnv` BAKES a value into the image — never put a credential there

`containerEnv` is not merely "environment for the container". The devcontainer CLI compiles every
entry into an **`ENV` instruction in the generated `Dockerfile-with-features`**, so anything listed
there becomes part of the image. Measured 2026-09-19, on the derived dev-container image while the
four credentials were still listed:

```bash
docker image inspect <derived-image> --format '{{range .Config.Env}}{{println .}}{{end}}'
#   MCM_ANTHROPIC_API_KEY=sk-ant-…   TMDB_API_KEY=…   MCM_FORGE_TOKEN=…   MCM_FORGE_ISSUE_TOKEN=…
docker image history --no-trunc <derived-image> | grep -c 'sk-ant-'    # → 3 layers
```

That is a **permanent** leak: it survives every container recreate, and `docker image inspect` or
`docker history` hands the values to anyone who can read the image. It also made `devcontainer up`
echo all four in clear text on the `docker run` line at every rebuild — which is how it was found.

> ✅ **The pushed base image was verified clean** — zero credentials in `Config.Env`, zero history
> layers. The leak was confined to the locally built derived image, never published to the forge.

**`remoteEnv` is not the fix here.** This sandbox is routinely entered by `ssh mcm.sbx` +
`docker exec`, and `remoteEnv` does not reach those — it would silently strip the credentials from
the path used most. The four are therefore passed by **`docker run --env-file`** (`runArgs`), with
the file written by an `initializeCommand` that runs on the VM *before* create, because `--env-file`
fails outright on a missing file. Measured:

| | `containerEnv` | `--env-file` |
| --- | --- | --- |
| `docker exec` inherits it | ✅ | ✅ |
| Baked into the image | 🔴 **yes** | ✅ no |
| Printed on the `docker run` line | 🔴 **yes** | ✅ path only |
| Visible in `docker inspect <container>` | yes | yes — **inherent** |

The last row does not go away: if `docker exec` must see a variable, the container's own config has
to carry it. What changes is that the exposure dies with the container instead of living in an image.

⚠️ **`docker --env-file` is not a shell and does no quote processing.** Given `Q1='quoted'` the
container sees `Q1=['quoted']`, apostrophes included (measured). `~/.mcm-sandbox-env` uses the
shell's quoted form, so it must never be handed to docker directly — credentials would arrive
wrapped in stray quotes and fail authentication in a way that reads as a bad key rather than a
quoting bug. `.devcontainer/gen-container-secrets-env.sh` sources it as a shell and re-emits the
bare form.

> ⚠️ **A newline guard written as `*"$(printf '\n')"*` matches EVERYTHING.** Command substitution
> strips trailing newlines, so it evaluates to the empty string and the pattern degrades to `*""*`.
> Measured here: it rejected all four valid credentials and produced an empty env file. Use bash's
> `*$'\n'*`.

🔴 **`devcontainer up` does NOT recreate the container when only `runArgs` / `containerEnv` change.**
Measured 2026-09-19: after moving the credentials to `--env-file`, a plain `devcontainer up`
reattached to the existing container in ~13 log lines — straight to `postStartCommand`, no build, no
`docker run` — and the environment kept running the **old image with the credentials still baked
in**. It reports success, so the fix appears applied when nothing changed. Verify against the
container, never against the command's exit code:

```bash
sbx exec mcm sh -c 'C=$(docker ps --filter label=devcontainer.config_file --format "{{.Names}}" | head -1)
  docker inspect "$C" --format "{{.Created}} {{.Image}}"'      # is it actually new?
```

Force it when the config changed:

```bash
devcontainer up --remove-existing-container --workspace-folder /workspaces/mcm \
                --config /workspaces/mcm/.devcontainer/sandbox/devcontainer.json
```

⚠️ **An image built while the credentials were still in `containerEnv` keeps them forever.** Moving
to `--env-file` fixes new builds; it does not sanitise old ones. Remove any such image
(`docker image rm <id>`) — and treat the credentials it carried as exposed.

---


## Lifecycle sections — see [devcontainer-sandbox-lifecycle.md](devcontainer-sandbox-lifecycle.md)

Recreating, resizing and upgrading the sandbox live in
[devcontainer-sandbox-lifecycle.md](devcontainer-sandbox-lifecycle.md), under their original section
numbers: **§7b** templates and recreate-from-nothing, **§7e** a full disk wearing other symptoms,
**§7f** "docker daemon failed to start", **§8** disk (three volumes, all resizable), **§8b** what a
cold recreate needs that the template does not carry, **§10** the verification harness, and **§10b**
the `sbx` version and the upgrade ritual. They were split out of this file on 2026-10-10 so each
source stays small enough for the wiki generator (item #682); the numbers are unchanged, so a `§8b`
reference elsewhere still means the same section.

## 11. Foot-guns, collected

- **`sbx start`** does not exist; it prints help. Use `sbx run --name`.
- **`sbx run` without `--name`** can create a second sandbox.
- **Prompts default to *No* non-interactively.** `sbx secret rm` needs `-f`; `rtk init -g` answers
  "no" and prints a manual step nobody reads (which is why `ensure-rtk-hook.sh` exists).
- **`pnpm` is not in the VM** — only in the dev container. VM-level scripts must
  `docker exec … bash -lc`, or fail with `rc=127`.
- **`docker exec` output vanishes for commands over ~0.5 s** unless `DOCKER_HOST` bypasses socat (§5).
- **A `docker -v` source resolves on the VM, and a missing one is CREATED as an empty directory** —
  only `/workspaces` is shared, and the engine socket to mount is `/var/run/docker.sock`, not
  `docker-host.sock` (§5).
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
