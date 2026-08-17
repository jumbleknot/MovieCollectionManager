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
pwsh scripts/open-sandbox.ps1
```

It checks whether the sandbox is running, starts it if not, waits for SSH, and opens VS Code
**directly inside the dev container**.

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
| dev container | no route — `curl` writes `000` |
| sibling container | `rc=6` — NXDOMAIN (DNS-layer refusal) |
| raw IP from a sibling | `rc=35` — TLS terminated mid-handshake |
| VM shell | HTTP **403** with `Blocked by network policy` |

⚠️ **`nc -z <ip> 443` reports OPEN against a blocked destination.** The proxy accepts the TCP
connection and refuses at TLS. A connect-only probe will tell you egress is wide open when it is
not. Always probe with a real request.

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

devcontainer up --workspace-folder /workspaces/mcm --config .devcontainer/sandbox/devcontainer.json
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

---

## 8. Disk — this is an operational constraint, not a formality

The VM's Docker disk is **49 GB and cannot be enlarged** (v0.38.0 exposes no `--disk` flag). It
reached **94 % (3.1 GB free)** during this feature, which is enough to fail an image pull.

```bash
docker builder prune -f     # reclaimed 3.665 GB; never touches images
docker image prune -f       # DANGLING ONLY
```

⚠️ **Never `docker image prune -a`.** It evicts the 3.5 GB Playwright image (and any other image not
currently attached to a container), which the web-E2E recipe needs and which must then be re-pulled.

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
