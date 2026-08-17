# Quickstart: validating the sandbox-hosted dev container

**Feature**: 060-devcontainer-docker-sandbox | **Date**: 2026-08-15

The runnable validation path, phase by phase. Each phase ends with the assertion that lets you move on, and names its rollback. Nothing here modifies the existing Docker Desktop environment until P6.

**Two things to know before the first command** (both observed on this workstation):

- `sbx` may not be on PATH in a fresh shell. It lives at `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`.
- `sandboxd` can be running yet unresponsive (`ensure daemon: sandboxd (PID …) remained running but did not respond within 10s`). Stop the process; the next command restarts it.

```powershell
# PATH fix for the current shell
$env:Path += ";$env:LOCALAPPDATA\DockerSandboxes\bin"
sbx version    # expect v0.38.0

# unresponsive-daemon recovery
Get-Process sandboxd -ErrorAction SilentlyContinue | Stop-Process -Force
```

---

## P0 — Host prep ✅ COMPLETE

Recorded in the Phase 0 host-setup document. Re-verify only if the workstation has been rebuilt.

```powershell
sbx version            # v0.38.0
sbx policy ls          # a default policy exists
sbx diagnose           # all green
```

**Established**: hypervisor enabled, authenticated, microVM + private engine smoke-proven, host `docker ps` never saw sandbox containers, **`/dev/kvm` absent**.

---

## P1 — Sandbox bring-up

```powershell
sbx create --name mcm --cpus 8 --memory 16
sbx setup ssh
ssh mcm.sbx
```

Inside the sandbox:

```bash
uname -a                  # its own kernel
docker info               # the private engine answers
df -h /                   # G7 — record the disk envelope NOW, not at ENOSPC
nproc && free -g          # confirm the sizing actually applied
```

**Pass when**: SSH lands as `agent@mcm`, `docker info` answers, and the disk envelope is written down.

**Rollback**: `sbx rm mcm`.

---

## P2 — Egress policy and the forge gate (G1 — the one that can stop the feature)

Apply the generated allowlist:

```powershell
node scripts/gen-egress-policy.mjs --format sbx-policy --forge-host $env:FORGE_REGISTRY_HOST
# pipe the emitted directives into sbx policy for sandbox 'mcm'
sbx policy ls
```

Then, **inside the sandbox**, prove the gate:

```bash
git clone https://<forge>/…/MovieCollectionManager.git /workspaces/mcm   # source
docker pull "$MCM_DEVCONTAINER_IMAGE"                                     # image, on the sandbox engine
curl -sSf https://api.anthropic.com/ -o /dev/null && echo allowlisted-ok
curl -sS  https://example.com/ && echo "LEAK" || echo blocked-as-expected
```

Back on Windows:

```powershell
sbx policy log        # example.com must appear as refused
```

**Pass when**: clone **and** image pull both succeed, an allowlisted fetch succeeds, `example.com` is refused, and the refusal is in the audit log.

**If the forge is unreachable** — this is G1, and it is the only gate that ends the migration:

1. Try system-proxy routing (`DOCKER_SANDBOXES_PROXY=system`).
2. Try a Tailscale subnet-router / hostname exposure.
3. If neither works: **stop**. Record the finding, retain the existing environment, and close the feature at User Story 2. That is a legitimate outcome, not a failure to try hard enough.

Then install the runner:

```bash
node --version            # ≥18
npm i -g @devcontainers/cli
```

**Rollback**: `sbx policy` reset to the bring-up profile; `sbx rm mcm`.

---

## P3 — Dev container up (G2, G3)

```bash
cd /workspaces/mcm
devcontainer up --workspace-folder /workspaces/mcm \
                --config .devcontainer/sandbox/devcontainer.json
```

Then run the harness. **Run the RED checks first** — a check that has never been seen failing is not yet a check:

```bash
# RED (expected to FAIL on the OLD Docker Desktop container):
bash .devcontainer/verify/verify-engine-seam.sh

# GREEN (in the new dev container):
bash .devcontainer/verify/verify-engine-seam.sh
bash .devcontainer/verify/verify-workspace-path.sh
bash .devcontainer/verify/verify-host-isolation.sh
bash .devcontainer/verify/verify-toolchain-present.sh
bash .devcontainer/verify/verify-caches-persist.sh
bash .devcontainer/verify/verify-personal-layer.sh      # incl. RTK present
bash .devcontainer/verify/verify-firewall-allowlist.sh
bash .devcontainer/verify/verify-committed-clean.sh
```

From the sandbox shell (VM-side):

```bash
bash .devcontainer/verify/verify-engine-seam.sh --vm-check   # Privileged: false
pgrep -c dockerd                                             # inside the container: 0
```

From Windows (host-side — the non-fabricable proof):

```powershell
docker ps -a      # must show NOTHING from the sandbox
bash .devcontainer/verify/verify-engine-seam.sh --host-check
```

**Pass when**: every check green, `"Privileged": false`, zero daemons in-container, and the Windows engine sees nothing.

**Rollback**: `docker rm -f` the dev container inside the VM and re-run `devcontainer up`; the Docker Desktop config is untouched.

---

## P4 — Editor chain (G4)

1. VS Code → **Remote-SSH** → `mcm.sbx`.
2. In that window → **Dev Containers** → attach to / reopen in the dev container.
3. In the in-container terminal:

```bash
echo $MCM_DEVCONTAINER    # 1
whoami                    # coder
claude --version
rtk gain                  # RTK active — constitution requirement
```

Then exercise the fallback **once**, so it is documented rather than theoretical:

```powershell
sbx ports mcm --publish 2222:2222
ssh -p 2222 coder@localhost
```

**Pass when**: a dev-container terminal runs the assistant, by either route, and the fallback has actually been used.

**Rollback**: remove the managed `Host *.sbx` block from `~/.ssh/config` and drop any published SSH port (`sbx ports mcm --remove 2222`). Nothing in the repository changed in this phase, and the Docker Desktop editor path is untouched.

---

## P5 — Workload proof (G5, G6)

**Capture the baseline on the OLD environment first** — without it the 1.5× budget is unfalsifiable.

In the new dev container:

```bash
node scripts/gen-dev-secrets.mjs && node scripts/gen-dev-env.mjs
pnpm nx up-auth
pnpm nx docker-build mcm-app
pnpm nx up-mcm
docker ps                 # siblings, including the dev container itself

# integration tier — the three URL exports, unchanged
pnpm nx test <project>    # per the runbook's validated sequence

# web E2E — Playwright in its official image, identical-path mount
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v /workspaces/mcm:/workspaces/mcm -w /workspaces/mcm …

# one agent E2E spec, on Anthropic
```

Then the two proofs this phase exists for:

```bash
# G5 — sibling egress governed (the closed 037 residual)
docker run --rm curlimages/curl -sS https://example.com/ && echo "LEAK" || echo blocked
```

```powershell
sbx policy log     # the SIBLING's refusal must appear here
```

```bash
# dev-ollama as a sibling; gateway reachability
bash scripts/devcontainer-ollama.sh
```

**Pass when**: all suites pass, wall-clock ≤1.5× baseline, and a sibling's non-allowlisted request is refused **and audited**.

**Expected to refuse cleanly**: `bash scripts/devcontainer-android.sh` — `/dev/kvm` is absent. It must say so legibly and not fail obscurely.

**Rollback**: tear the stacks down inside the VM (`pnpm nx down-mcm`, `down-auth`) or discard the whole VM with `sbx rm mcm`. No repository file is modified by this phase except `baseline-measurements.md`, and the Docker Desktop environment still runs the same suites.

---

## P6 — Adopt

```powershell
sbx template save mcm
```

Then:

1. Write `docs/runbooks/devcontainer-sandbox.md` — lifecycle, two-layer triage order (`sbx policy log` **first**), port publishing, teardown semantics, disk pruning, the `docker rm -f` self-destruct foot-gun, and the two workstation gotchas above.
2. Rewrite the posture section of `docs/runbooks/devcontainer.md`; archive the DinD sections.
3. Update `CLAUDE.md`, the OpenWiki source documents, and `README.md`.
4. Prove recreate-from-nothing ≤15 min warm.
5. After **two consecutive incident-free weeks** (see spec.md FR-032 for what counts as an incident): collapse to one `devcontainer.json`, delete `verify-engine-isolation.sh`, and stop offering the Docker Desktop path for assistant sessions.

**Retained deliberately**: Docker Desktop for non-assistant local use and as the mobile-emulator fallback.

**Rollback**: this is the only phase whose steps are not trivially reversible, because step 5 deletes the fallback configuration. Two consequences follow, and they are the reason step 5 is time-gated rather than effort-gated:

- **Before step 5**, rollback is `git revert` of the documentation commits — the environment itself is unaffected, because `.devcontainer/devcontainer.json` is still intact and still builds on Docker Desktop.
- **After step 5**, rollback is `git revert` of the collapse commit, which restores both the nested-engine configuration and `verify-engine-isolation.sh` from history. Verify the restored config actually builds before relying on it; a config that has not been exercised for a fortnight is a claim, not a fallback.

---

## Success criteria mapping

| Criterion | Proven at |
| --- | --- |
| SC-001 no nested engine, unprivileged | P3 |
| SC-002 harness green incl. host-side | P3 |
| SC-003 editor → assistant | P4 |
| SC-004 full stack set, invisible to host | P5 |
| SC-005 egress incl. **sibling** refusal + audit | P2 (shell) + P5 (sibling) |
| SC-006 suites pass ≤1.5× | P5 |
| SC-007 recreate ≤15 min | P6 |
| SC-008 documentation current | P6 |
| SC-009 no literal in git | P3 (`verify-committed-clean.sh`) + existing gates |
| SC-010 emulator exception recorded | P5 + P6 |
