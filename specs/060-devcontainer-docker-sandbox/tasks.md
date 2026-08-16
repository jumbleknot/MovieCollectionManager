# Tasks: Dev container on Docker Sandbox — retiring Docker-in-Docker

**Feature**: 060-devcontainer-docker-sandbox | **Branch**: `060-devcontainer-docker-sandbox` | **Date**: 2026-08-15

**Input**: [spec.md](spec.md) · [plan.md](plan.md) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) · [quickstart.md](quickstart.md)

Task format follows the repo's [feature-test-tasks-template](../../docs/templates/feature-test-tasks-template.md): every task that **writes or modifies a test** carries a **Verify RED** with expected failure output and a paired task with **Verify GREEN**. Every other task carries a **Done when** — a concrete observable condition, stated on the task line itself for single-step tasks and in a detail block for the rest.

**Platform Parity Table: omitted, justified.** This feature has no frontend surface — it is a developer-environment migration with no web or mobile user flow. The template's "adapting to project type" guidance omits the table for non-multi-client features. The E2E regression requirement is *not* omitted: it appears as T043–T044 and in the Completion Checklist.

**Revision note (post-`/speckit-analyze`)**: renumbered from 61 to 65 tasks. Added T009 (revert procedure for the `init-firewall.sh` change), T034 (scope the portable-runner check per D-15), T051 (reboot survival), T058 (per-phase rollback record). Added TDD checkpoints to T026, T031, T032. Added a `Done when` to every remaining task.

---

## Phase 1: Setup

- [X] T001 Import the Phase 0 host-prep record from `E:\Programming\VSCode\p0-docker-sandbox-host-setup.md` into `specs/060-devcontainer-docker-sandbox/phase-0-host-prep.md`
- [X] T002 [P] Record the resolved gate data in `specs/060-devcontainer-docker-sandbox/phase-0-host-prep.md`: `sbx` v0.38.0 (`c022b14634c4bea846ca12870d1d5e97d5868b54`), `/dev/kvm` **absent** (R2 negative), the host's CPU/RAM totals (needed by T018), and the two workstation gotchas — **Done when**: all four are recorded with the date observed
- [X] T003 Capture the Docker Desktop performance baseline into `specs/060-devcontainer-docker-sandbox/baseline-measurements.md`

> **T003 outcome — 1320 s total (22.0 min), all five stages timed on the merged tree.**
> `up-auth` 43 s · `docker-build` **1024 s** · `up-mcm` 25 s · integration 32 s · web E2E 196 s.
> Measured **warm** (27 images cached) — the daily-work condition, and the one T048 must reproduce.
> Verified post-merge without pushing: the container's clone `879d2987` is an **ancestor** of branch
> HEAD, the `pnpm-lock.yaml` blob hash is **identical**, and the only non-spec differences are three
> doc/state files. Exact commands are recorded verbatim in
> [baseline-measurements.md](baseline-measurements.md) — a ratio computed against a different command
> or a different workload composition is not a ratio.
>
> **`docker-build` is 78% of the total and is I/O-bound, not CPU-bound** — ~12 min of it stalled in
> state `D` on one `chown -R` in the final layer, paying nested-overlayfs cost (DinD overlay2 →
> WSL2 ext4 → Windows). This is the number most likely to move at G6, since the sandbox removes a
> nesting level; if it does *not* improve, that is a signal to investigate rather than absorb.
>
> **Two findings that change later tasks:**
>
> 1. **T042 cannot trust jest's skip count.** The integration tier reports `120 passed / 120 total`,
>    exit 0, **zero skips** — while **≥9 tests** print `SKIP:` and return successfully (ollama ×4,
>    OpenSearch ×4, gateway ×1). T042's "0 skips" Done-when must assert on `grep -c 'SKIP:'`; the
>    obvious implementation would report success while nine tests did nothing.
> 2. **The web-E2E single failure is a composition gap, not a regression.** `assistant.spec.ts:78`
>    times out because the bring-up sequence (T041's, and this baseline's) omits `up-agents-prod`, so
>    no gateway answers the dock. Recorded rather than fixed, so T048 compares like with like. Do not
>    add the agent stack to one side only.

---

> **T002 outcome — host totals recorded, and they invert the sizing instinct.** i7-12700K, 12
> physical / **20 logical** cores, **31.8 GB** RAM. The sandbox default (N-1 CPUs, ~50% RAM) is
> therefore **~19 or 11 CPUs and ~15.9 GB** — so `--cpus 8` would *cut* the sandbox well below the
> default, and only the 16 GB memory floor actually binds. T018 must pass `max(default, floor)` per
> resource. Full working in [phase-0-host-prep.md](phase-0-host-prep.md).
>
> **A third workstation gotcha was found, and it invalidates the documented recovery.** The wedged
> daemon process is named **`sbx`, not `sandboxd`**, so `Get-Process sandboxd | Stop-Process` (as
> written in the original Phase 0 record and in [quickstart.md](quickstart.md)) **exits 0 having
> done nothing** — a silent no-op that reads as a successful recovery. It also runs **elevated**, so
> the kill needs an elevated shell even though it is owned by the same user. Both corrections are
> recorded in [phase-0-host-prep.md](phase-0-host-prep.md) § Gotcha 2 and are owed to T053.

### T001 — Import the Phase 0 host-prep record into the repository

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**Spec reference**: spec.md#user-story-1 (Assumptions — "that evidence lives outside the repository today")

The Phase 0 work is complete but its record sits outside version control on the `E:` drive. Copy it into the feature directory so the migration record is self-contained and auditable, marking each exit-checklist row with its observed result rather than its intended one.

**Done when**: `specs/060-devcontainer-docker-sandbox/phase-0-host-prep.md` exists, all eight exit-checklist rows carry an observed result, and no forge hostname or tailnet address is present in it.

### T003 — Capture the Docker Desktop performance baseline

**Type**: Config change / measurement | **Time**: 1–2 hrs (mostly wall-clock) | **Risk**: Low

**Spec reference**: SC-006, research.md#D-12

Run the runbook's validated sequence on the **existing** Docker Desktop dev container and record wall-clock per stage. Without this the ≤1.5× budget has no denominator and G6 is unfalsifiable.

Do this **before** attention shifts to the sandbox. Docker Desktop is retained, so it remains technically possible later — but a baseline taken after weeks of sandbox work invites unnoticed drift in the comparison.

**Done when**: `baseline-measurements.md` records per-stage wall-clock for `up-auth`, `docker-build mcm-app`, `up-mcm`, the integration tier, and the web E2E suite, each with the date and the environment it was measured on.

---

## Phase 2: Foundational (blocking — must complete before User Story 2)

- [X] T004 Create `.devcontainer/egress-allowlist.json` with all ~~30~~ **28** destinations migrated from `.devcontainer/init-firewall.sh`, reasons preserved
- [X] T005 Write the generator contract test in `.devcontainer/verify/verify-egress-allowlist-contract.sh`
- [X] T006 Create `scripts/gen-egress-policy.mjs` with `--format sbx-policy`, `--format ipset-domains`, and `--check`
- [X] T007 Replace the inline `DOMAINS=(...)` array in `.devcontainer/init-firewall.sh` with a read of `gen-egress-policy.mjs --format ipset-domains` — **Verify GREEN passed** in the current DinD dev container
- [X] T008 [P] Correct the honest-limits paragraph in `.devcontainer/init-firewall.sh` — the nested-container residual is now covered by sandbox policy, and under `--network=host` the script filters the VM's OUTPUT chain including dockerd's pulls — **Done when**: no sentence in the header claims nested-container egress is unfiltered, and the OUTPUT-chain scope change is stated
- [X] T009 Record the revert procedure for T007/T008 in `specs/060-devcontainer-docker-sandbox/rollback.md`

> **T004 addition — `mcr.microsoft.com` was added as a 29th destination (approved 2026-08-15).** It was
> **not** in the inline array, because it was *masked*: the Playwright image was already cached on the
> DinD engine, so no pull ever traversed the firewall. Two things break that mask under 060 — a fresh
> sandbox has an empty image cache, and the documented cold-pull escape (`iptables -P OUTPUT ACCEPT`)
> **cannot work** under a policy enforced host-side and untamperable from inside (FR-008). Without the
> entry there is no in-environment way to obtain the image, so T043/SC-006 could not pass. This was
> **measured, not predicted**: the T003 baseline failed exactly here once the pin moved 1.60.0 → 1.62.1
> (`dial tcp 150.171.70.10:443: i/o timeout`). Canonical list is now **29** destinations (+ the
> runtime-injected forge host = 30 enforced).
>
> **T004 correction — the destination count is 28, not 30.** Counted from the array actually present
> in `init-firewall.sh` (`awk '/^ALLOWED_DOMAINS=\(/,/^\)/' … | grep -c '"'` → **28**), and the
> group table in [contracts/egress-allowlist.md](contracts/egress-allowlist.md) independently lists
> the same 28 (agent 1 + source 5 + registry 12 + packages 9 + app 1). The "30" in this task line
> was wrong; 28 in-file destinations plus the runtime-injected forge host = 29 enforced entries. The
> contract file needed no change — only this task line did.
>
> **T007 Verify GREEN — evidence.** Run in the current DinD dev container from a genuinely clean
> iptables state (the container had restarted, which clears the ruleset and the ipset — confirming
> they are not persisted). Applied with the exact `postStartCommand` invocation
> (`sudo env FORGE_REGISTRY_HOST=… /bin/bash …/init-firewall.sh`): exit 0, *"read 29 destinations
> from the canonical allowlist"*, **179** ipset entries against the original script's **178** — a
> one-IP delta from DNS A-record variance, not a rule difference. `verify-firewall-allowlist.sh`
> then passed: 7/7 allowlisted sources reachable, `example.com` refused, default-deny intact.
>
> Two stronger checks were done before it ever touched iptables, because this script runs on every
> start: the generator's domain set was diffed against the committed inline array and is
> **set-identical** (28/28, empty diff), and the script now **fails closed** — missing generator,
> missing `node`, non-zero generator exit, or an empty resolved list all abort *before* the reset
> section, so an empty allowlist can never reach `iptables -P OUTPUT DROP`. That combination — empty
> list plus default-DROP — is a total egress blackout that presents as a network fault rather than a
> bug in this script, and `mapfile < <(node …)` would have hidden it (process substitution makes the
> generator's exit status invisible to `set -e`).
>
> **Cold-start half**: `docker start` does not run devcontainer lifecycle hooks, so a true
> VS Code/CLI cold start is still owed. The nearest faithful proof was run instead — the **entire
> `postStartCommand` chain verbatim** (`init-firewall.sh && devcontainer-ollama.sh &&
> devcontainer-android.sh`) from the cleared state, exit 0, with ollama and android both reporting
> ready. A firewall failure would have broken the `&&` chain and silently skipped both.
>
> **T008 interpretation.** The Done-when asks that no sentence claim nested-container egress is
> unfiltered. The rewritten header states the residual *per topology* rather than dropping it: under
> 060 the host-side sandbox policy governs all VM egress including siblings, while on the **retained
> Docker Desktop path** no outer layer exists. Stating that scoped truth is more useful than a blanket
> claim in either direction, and it is what makes the retained path's remaining risk legible.

### T004 — Migrate the destination list to a canonical file

**Type**: New file | **Time**: 1 hr | **Risk**: Medium

**Spec reference**: FR-007, contracts/egress-allowlist.md

Move every domain from the script's inline array into `.devcontainer/egress-allowlist.json` with `domain`, `group`, `reason`, `cdnRotating` per the contract. **The reasons are load-bearing** — the current comments record why each CDN host rotates IPs, why quay needs four Akamai hosts, and why TMDB was allowlisted for the test runner rather than the app. Carry them across as prose, do not summarise them away.

Two rules with teeth: the forge host is **not** in this file (runtime-injected from `FORGE_REGISTRY_HOST`), and the OpenWiki analytics host is **not** added — telemetry stays disabled by configuration, never by allowlisting.

Update the TMDB reason: under sandbox policy the "test runner only, app traffic is FORWARD-chain" distinction no longer holds, because policy governs siblings too.

**Done when**: the file validates against T006's `--check`, contains 30 destinations, contains no forge/tailnet literal, and every `reason` is non-empty.

### T005 — Write the generator contract test

**Type**: Test | **Time**: 45 min | **Risk**: None

**Spec reference**: FR-007, FR-011

**Scenarios covered**:

- US2-AC1: the allowlist derives from the project's canonical destination list
- FR-011: no topology-sensitive literal enters git

**File**: `.devcontainer/verify/verify-egress-allowlist-contract.sh`

Assert that `gen-egress-policy.mjs` satisfies its contract: both formats emit one line per destination in stable order; `--forge-host` appends the forge entry to both; omitting it omits the entry **cleanly** with exit 0; `--check` rejects a bare IP, an empty `reason`, and an unknown `group`.

**Verify RED** (run before T006 exists):

```bash
bash .devcontainer/verify/verify-egress-allowlist-contract.sh
```

**Expected RED**: script exits 1 — `✗ scripts/gen-egress-policy.mjs not found` (all 8 assertions fail; the generator does not exist yet).

> 0 failures here means the test is asserting nothing and must be fixed before T006.

### T006 — Implement the egress policy generator

**Type**: Implementation | **Time**: 2 hrs | **Risk**: Low

**Spec reference**: FR-007, contracts/egress-allowlist.md

**Prerequisite**: T005 complete and verified RED.

Create `scripts/gen-egress-policy.mjs` per the generator contract. Never writes files (both forms are piped by their consumer, so no generated artifact can fall stale in git). `--forge-host` optional; absent → omit cleanly, exit 0, mirroring the current script's unset-skips-cleanly behaviour.

**Verify GREEN**:

```bash
bash .devcontainer/verify/verify-egress-allowlist-contract.sh
```

**Expected GREEN**: `0 failures — 8 assertions passed`.

**Also run**:

```bash
node scripts/gen-egress-policy.mjs --check
```

**Expected**: exit 0.

### T007 — Point `init-firewall.sh` at the canonical list

**Type**: Implementation | **Time**: 45 min | **Risk**: Medium

**Spec reference**: FR-007

**Prerequisite**: T006 green.

Replace the inline array with a read of `gen-egress-policy.mjs --format ipset-domains`, passing `FORGE_REGISTRY_HOST` through. **Change nothing else.** The reset ordering, the "flush only our own chains, never `-X`" rule that stops dockerd's user chains being deleted, the RFC1918 bridge allows, and the re-runnable ipset refresh all stay exactly as they are — each was earned by a specific failure.

⚠️ This script runs on **every start of the environment you are working in today**. A failure here — a missing `node` on the root PATH under `sudo`, a generator crash — degrades the current dev container's egress on its next start, not some future one. T009 exists because of this.

**Verify GREEN** (in the current Docker Desktop dev container, before any sandbox work):

```bash
sudo env FORGE_REGISTRY_HOST=$FORGE_REGISTRY_HOST /bin/bash .devcontainer/init-firewall.sh
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected GREEN**: firewall applies without error and `verify-firewall-allowlist.sh` passes — proving the extraction is behaviour-neutral **on the existing environment** before it is relied on in the new one.

**Also run** (the script must survive a container restart, when it runs as root via the lifecycle hook):

```bash
# rebuild/restart the dev container, then:
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected**: passes on a cold start, not only when invoked by hand.

### T009 — Record the revert procedure for the firewall change

**Type**: Documentation | **Time**: 20 min | **Risk**: None

**Spec reference**: FR-033

**Prerequisite**: T007, T008.

T007/T008 are the only tasks in this feature that modify a file the **current working environment** executes on every start. Create `specs/060-devcontainer-docker-sandbox/rollback.md` and record, as its first entry, how to restore the inline `DOMAINS` array — the commit to revert, and the one-command emergency path (`sudo iptables -P OUTPUT ACCEPT`) that restores egress while the revert is prepared.

This file is extended by T058 with the per-phase rollbacks; it starts here because this is the first genuinely destructive change.

**Done when**: `rollback.md` exists, names the revert commit range for T007/T008, and states the emergency egress-restore command.

---

## Phase 3: User Story 1 — Workstation is sandbox-capable (P1) ✅ COMPLETE

**Goal**: the workstation can run hardware-isolated microVMs with a private container engine, proven on a throwaway sandbox.

**Independent test**: create a throwaway sandbox, run a container in it, confirm the workstation's engine never sees it, destroy it.

**Status**: carried out ahead of this specification. Tasks recorded for the migration record and marked complete; evidence in `phase-0-host-prep.md` (T001).

- [X] T010 [US1] Enable the Windows Hypervisor Platform feature and reboot the workstation
- [X] T011 [US1] Install the `sbx` CLI via winget and record its version — **v0.38.0**
- [X] T012 [US1] Authenticate `sbx` against the Docker account
- [X] T013 [US1] Set the default network policy to a deny-by-default profile (`balanced`, tightened in US2)
- [X] T014 [US1] Run `sbx diagnose` and clear every flagged item
- [X] T015 [US1] Create a throwaway sandbox, run a container inside it, and confirm the Windows engine's `docker ps` never lists it
- [X] T016 [US1] Probe `/dev/kvm` inside the sandbox and record the result — **absent** (gate R2 resolved negative)
- [X] T017 [US1] Destroy the throwaway sandbox and confirm the existing dev container still opens normally

**Checkpoint**: US1 complete — the workstation hosts microVMs, and the emulator question is answered before any effort was spent on it.

---

## Phase 4: User Story 2 — Governed, audited egress with the forge reachable (P1)

**Goal**: the sandbox reaches exactly what the work needs, enforcement is untamperable from inside, refusals are audited, and the private forge is reachable for source and images.

**Independent test**: from a sandbox shell, fetch each allowlisted destination, clone/fetch/push from the forge, pull the toolchain image, then hit a non-allowlisted destination and confirm refusal plus audit entry.

**⚠ This phase contains G1 — the only gate that can end the feature.**

- [X] T018 [US2] Create the `mcm` sandbox sized to **max(host default, floor)** and record the disk envelope (G7) in `specs/060-devcontainer-docker-sandbox/baseline-measurements.md`
- [X] T019 [US2] Configure SSH access (`sbx setup ssh`) and prove `ssh mcm.sbx` lands in the VM — **Done when**: `ssh mcm.sbx` returns a shell as `agent@mcm` without an interactive prompt, and `docker info` inside it reports the private engine
- [X] T020 [US2] Apply the generated Locked Down allowlist to the `mcm` sandbox from `gen-egress-policy.mjs --format sbx-policy` — **Done**: `policy init deny-all` + all 30 rules applied from the generator, none hand-added
- [X] T021 [US2] Write the sandbox egress probe suite in `.devcontainer/verify/verify-sandbox-egress.sh` — RED then GREEN, both halves
- [X] T022 [US2] **G1 GATE** — ✅ **GREEN** — clone, fetch, **real push**, and `docker pull` of the digest-pinned toolchain image all succeed from inside the sandbox
- [X] T023 [US2] Install Node ≥18 and `@devcontainers/cli` inside the sandbox — **node v22.22.1**, **devcontainer 0.88.0**
- [X] T024 [US2] Provision the six `${localEnv}` credentials into the sandbox by the D-07 **fallback** mechanism, enumerated explicitly

> ### T021 — RED confirmed in BOTH directions, and the first GREEN was a false negative
>
> **RED (specified form).** `example.com` is *already* refused under the `balanced` bring-up policy,
> so the task's stated RED was **not observable** as written. A genuine RED was produced by injecting
> a deliberate divergence — `sbx policy allow network --sandbox mcm example.com` — which flipped the
> assertion exactly as predicted: `✗ example.com is REACHABLE — deny-by-default is NOT enforcing`.
> The rule was then removed. A second, independent RED came for free: under `balanced`, `github.com`
> and `api.themoviedb.org` were unreachable (2 failures).
>
> **The first GREEN attempt reported `github.com` unreachable — and the probe was wrong, not the
> policy.** `curl -i` was downloading GitHub's entire homepage, which exceeds the timeout through the
> proxy. Verified by hand: `HTTP/2 200`, curl exit 0. Had this been "fixed" by adding entries to the
> allowlist, egress would have been silently widened to chase a bug in the test. The probe now reads
> `%{http_code}` instead of the body.
>
> **Final state — VM-side 0 failures, host-side audit 0 failures**: 5/5 groups reachable,
> `example.com` refused, `--noproxy` and a cleared proxy environment both still refused (so
> enforcement is at the network layer, not advisory), workstation loopback unreachable, the refusal
> present in `sbx policy log`, and all 29 canonical destinations present in the live policy.
>
> Three instrument lessons are baked into the script's header because each produced a confident wrong
> answer: a refusal here is an **HTTP 403 with a `Blocked by network policy` body, not a timeout**;
> a **TCP connect proves nothing** (`gateway.docker.internal:11434` and `:5432` both "connect" with
> nothing behind them, so every probe is application-level); and `sbx policy ls <sandbox>` returns a
> **summary naming no resources**, so grepping it reports every destination as absent — `--json` is
> required.
>
> ⚠️ Two PowerShell-specific traps also cost time and belong in T053: `Select-Object -First N`
> **terminates the upstream native command** (it aborted `sbx policy init` mid-run, leaving the
> policy uninitialised), and piping a script's output through `sed` makes `$?` **sed's** exit code,
> not the script's — which briefly showed a failing check as `EXIT=0`.
>
> ### T024 — provisioned at preference (3), but preference (1) is REAL and T049 should take it
>
> All six resolve when the file is sourced (`mode=600`, owner `agent`, at `~/.mcm-sandbox-env`,
> outside the repository so no `.gitignore` entry is needed). The file is **deliberately not
> auto-sourced from `.bashrc`**, which is what makes the D-07 hard-constraint check meaningful.
>
> **The no-SSH-forwarding check passed, with a nuance worth recording.** `MCM_FORGE_TOKEN` came back
> **empty** over a bare SSH command, as required. `ANTHROPIC_API_KEY` came back **non-empty — but the
> value is the sandbox's own `proxy-managed` sentinel**, not a forwarded secret. That is not a
> failure; it is direct evidence for **D-07 preference (1)**, which `sbx secret --help` confirms:
> *"the proxy uses stored secrets to authenticate API requests on behalf of the agent. The secret is
> never exposed directly."* The sandbox pre-wires `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`
> and others as `proxy-managed` placeholders.
>
> **My env file currently OVERRIDES that placeholder with the real key — a deliberate downgrade to
> preference (3)**, exactly as T024 specifies, so this phase does not depend on an unanswered
> question. T049 should reverse it. The open half remains whether injection reaches **sibling
> containers** (the agent gateway's calls), which only Phase 7 can answer.
>
> **T022 also required a credential finding**: the forge git credential was installed at
> `~/.git-credentials` (mode 600) and the registry needed `MCM_FORGE_TOKEN` separately — see the G1
> block above.

> ### 🚦 G1 IS GREEN — the migration is viable and the feature continues
>
> All four required operations proven from inside the microVM: `git clone`, `git fetch`, a **real
> `git push`** (probe branch created on the forge and deleted — not `--dry-run`), and `docker pull`
> of the digest-pinned toolchain image onto the **sandbox's own** engine (13.3 GB). `pwd -P` is
> `/workspaces/mcm`, so D-03's identical-path requirement already holds. **Neither documented remedy
> was needed** — no subnet router, and `DOCKER_SANDBOXES_PROXY=system` was set during diagnosis but
> was not the fix.
>
> **G1 first appeared to FAIL, twice, for purely instrumental reasons.** Recorded in full in
> [research.md](research.md#g1--resolved-green-2026-08-16), because either would have ended the
> feature on a false negative: (1) every early probe used **`https://…:443`** when the forge is
> **`http://…:3000`**, so the proxy's `502` was correct behaviour, not a routing failure — the control
> that broke it open was that the *Windows host* could not reach :443 either, while `tailscale status`
> showed the peer active; (2) a **UTF-8 BOM** on a PowerShell here-string blanked a variable, so a
> whole probe suite ran against an empty hostname and failed with perfect internal consistency.
>
> **T024 must provision BOTH forge tokens — they have opposite scopes.** git works with the
> `git credential fill` credential and the registry **401s** on it; `docker pull` works with
> `MCM_FORGE_TOKEN`. This is the inverse of the CLAUDE.md PR-creation gate. Neither covers both.
>
> **T018 sizing — the trap was real and is now measured.** `sbx` reported `cpu 20 / memory 16g` at
> creation, and `nproc` inside confirms **20**. v0.38.0's default is *all* host CPUs (not N-1), so
> the proposal's `--cpus 8` would have cut the sandbox by 60% versus doing nothing. Only the 16 GB
> memory floor binds.
>
> **G7 disk envelope — two disks, and tighter than it looks.** `/` is 20 G (19 G free);
> `/var/lib/docker` is a **separate 50 G disk**. The toolchain image alone takes **13.3 GB → 27%**,
> leaving 35 G for Playwright (3.4 GB), the built app image, Keycloak, two Postgres, two Mongo,
> Redis and `dev-ollama` + models. There is no `--disk` flag in v0.38.0, so the prune practice T053
> owes is a real requirement.
>
> **T020 is only partial, deliberately.** The forge rule is applied and proven, but the full
> `deny-all` + 29-destination application is **not** done, because T021's Verify RED must be observed
> *first* — the RED requires a permissive policy in which `example.com` is still reachable. Applying
> the allowlist now would make that RED unobservable. Note also that the task's "Locked Down profile"
> does not exist in v0.38.0: profiles are absent, and the equivalent is `sbx policy init deny-all`
> plus explicit allows.
>
> ⚠️ **`verify-sandbox-egress.sh` (T021) must not assert "blocked == timeout".** The sandbox proxy
> returns **HTTP 403** for a refused host, whereas the in-VM iptables layer produces a timeout. A
> probe written for one shape silently misreads the other — measured: `example.com` → `403`.

### T018 — Create the sandbox, sized against the host's actual defaults

**Type**: Config change | **Time**: 30 min | **Risk**: Medium

**Spec reference**: research.md#D-12, G7

**Prerequisite**: T002 (host CPU/RAM recorded).

⚠️ **Do not hardcode the floor.** The sandbox default is N-1 host CPUs and ~50% host RAM (capped 32 GB). On this workstation that default is plausibly *larger* than the 8 CPU / 16 GB floor the proposal names — so passing `--cpus 8 --memory 16` unconditionally would **under-provision relative to doing nothing at all**, and could itself cause the G6 performance miss the explicit sizing exists to prevent. Metro is the known OOM-prone component and is the first thing that would suffer.

Compute `max(default, floor)` from the totals recorded in T002 and pass that. Record both the default and the chosen value, so a later G6 investigation can tell which one was in play.

Then establish the disk envelope (G7) — `df -h /` inside the VM — before ENOSPC finds it mid-session.

**Done when**: the sandbox exists with sizing ≥ the host default; `baseline-measurements.md` records the host totals, the sandbox default, the chosen values, and the disk envelope.

### T021 — Write the sandbox egress probe suite

**Type**: Test | **Time**: 1 hr | **Risk**: Low

**Spec reference**: spec.md#user-story-2, contracts/verify-harness.md

**Scenarios covered**:

- US2-AC1: every allowlisted destination is reachable
- US2-AC2: a non-allowlisted destination is refused **and** appears in the audit log
- US2-AC5: enforcement cannot be altered from inside the sandbox
- US2-AC6: the workstation's loopback services are unreachable

**File**: `.devcontainer/verify/verify-sandbox-egress.sh`

Probe each destination group from the sandbox shell; probe `example.com` and require refusal; attempt to alter the policy from inside and require that it remains in effect; probe a workstation loopback service and require unreachability. Assert the audit entry exists for the refusal — a silent block and an audited block are different postures, and only the second is what FR-008 requires.

**Verify RED** (run before T020 applies the policy):

```bash
ssh mcm.sbx 'bash /workspaces/mcm/.devcontainer/verify/verify-sandbox-egress.sh'
```

**Expected RED**: exits 1 — `✗ example.com reachable — policy not enforcing` and `✗ no audit entry for refused destination` (bring-up profile is permissive; deny-by-default is not yet applied).

### T022 — G1 gate: prove forge reachability through the sandbox proxy

**Type**: Implementation / gate | **Time**: 1–3 hrs | **Risk**: **High**

**Spec reference**: FR-009, US2-AC3, US2-AC4, US2-AC7, research.md#G1

**Prerequisite**: T020, T021.

The forge is on a Tailscale overlay; sandbox egress is redirected through a host-side proxy documented as not necessarily following VPN split-tunnel routing. Prove all four operations from inside the sandbox: clone, fetch, push, and `docker pull` of `MCM_DEVCONTAINER_IMAGE` onto the **sandbox's** engine.

**If unreachable**, in order: (1) `DOCKER_SANDBOXES_PROXY=system` routing; (2) a Tailscale subnet-router or hostname exposure. If neither works, **stop the feature here** — record the finding in `research.md`, close US2 with scenario 7 satisfied, and retain the current environment. That is a legitimate result, not a failure to try hard enough.

**Verify GREEN**:

```bash
ssh mcm.sbx 'cd /workspaces/mcm && git fetch && git push --dry-run && docker pull "$MCM_DEVCONTAINER_IMAGE"'
```

**Expected GREEN**: all three succeed; `docker images` on the sandbox engine lists the pulled digest.

**Also run** — `--dry-run` proves negotiation and auth but not write, and US2-AC3 says *pushed*:

```bash
ssh mcm.sbx 'cd /workspaces/mcm && git push origin HEAD:refs/heads/sbx-reachability-probe && git push origin --delete sbx-reachability-probe'
```

**Expected**: both succeed — a real write to the forge and its cleanup.

```bash
ssh mcm.sbx 'bash /workspaces/mcm/.devcontainer/verify/verify-sandbox-egress.sh'
```

**Expected**: 0 failures — allowlist reachable, `example.com` refused and audited, host loopback unreachable.

### T024 — Provision credentials by the fallback mechanism, enumerated

**Type**: Config change | **Time**: 45 min | **Risk**: Medium

**Spec reference**: FR-012, research.md#D-07

Provision all six values the current environment forwards via `${localEnv}`, into a gitignored env file sourced in the sandbox shell before `devcontainer up` — **D-07 preference (3)**:

| Value | Consequence if absent |
| --- | --- |
| `MCM_DEVCONTAINER_IMAGE` | container build fails (`base name should not be blank`) — **required** |
| `FORGE_REGISTRY_HOST` | forge allowlist entry skipped; no forge access |
| `ANTHROPIC_API_KEY` | agent falls back to ollama; golden record unavailable |
| `TMDB_API_KEY` | agent TMDB flows no-op; the assistant dock stays hidden |
| `MCM_FORGE_TOKEN` | CI diagnostics tooling reports missing scope and exits |
| `MCM_FORGE_ISSUE_TOKEN` | backlog tooling degrades to read-only |

**Deliberately preference (3), not (1).** Preference (1) — host-keychain secrets with proxy header injection — is strictly better, but whether injection reaches sibling containers is unknown until T049 (R7). Provisioning by the fallback first means this phase does not depend on an unanswered question, and T049 upgrades what it can once the answer exists.

⚠️ Nothing may rely on these riding the SSH session: since v0.37.1 SSH does not forward credential env vars unless `ssh.acceptEnv` is configured. This repository has already been bitten by the same shape of silent-empty failure (the "fully quit VS Code after `setx`" trap).

**Done when**: all six resolve inside the sandbox shell; the env file is covered by the root `.gitignore`; and a deliberate `ssh mcm.sbx 'echo $ANTHROPIC_API_KEY'` returns **empty**, proving nothing depends on SSH forwarding.

**Checkpoint**: US2 complete — the migration is viable. Nothing beyond this point is worth attempting until G1 is green.

---

## Phase 5: User Story 3 — Unprivileged dev container on the sandbox's own engine (P1)

**Goal**: the dev container runs unprivileged with no engine inside it, drives the sandbox's engine, and keeps the existing toolchain, caches and workflows.

**Independent test**: bring the dev container up from a clean clone; assert no daemon inside, unprivileged from the VM, invisible from Windows, toolchain and caches unchanged.

**Contains G2 (engine seam) and G3 (workspace path).**

- [X] T025 [US3] Write `.devcontainer/verify/verify-engine-seam.sh` (in-container, `--vm-check`, `--host-check` modes) per contracts/verify-harness.md — **RED confirmed: 5 assertions fail on DinD**
- [X] T026 [US3] Write `.devcontainer/verify/verify-workspace-path.sh` with the sibling-probe assertion — **RED confirmed via the injected-mismatch form**
- [X] T027 [US3] Create `.devcontainer/sandbox/devcontainer.json` — `docker-outside-of-docker:1`, `"runArgs": ["--network=host"]`, no `privileged`, no `DOCKER_CONFIG`

> ### T025 — the obvious discriminator does not work, and the task's expected RED was wrong
>
> **"Is a docker socket present?" passes in BOTH topologies.** Measured on the current DinD dev
> container: `/var/run/docker.sock` **exists** there — the *nested* daemon creates it — and
> `docker info` answers happily. The task's predicted RED line `✗ no docker socket present` is
> therefore unobtainable, and an assertion written that way would have been green in both
> environments, i.e. asserting nothing.
>
> What actually differs is whether the socket is a **bind mount**:
>
> | | socket file | in `/proc/mounts` |
> | --- | --- | --- |
> | DinD | present (created by the nested dockerd) | **absent** |
> | sandbox | present (mounted from the microVM) | **present** |
>
> Assertion 3 therefore tests the **mount**, not the file.
>
> **Verify RED — 5 assertions fail, more than the 3 predicted.** In-container: `dockerd is running
> (1 process)`, `containerd is running (10 processes)`, `docker socket is NOT bind-mounted`.
> Via `--vm-check`: `Privileged: true`, and an **engine-ID mismatch** — in-container
> `57d6a747…` vs host engine `549976e4…`, which is precisely the extra nesting level this feature
> deletes.
>
> ### T026 — the plain RED is unobtainable on DinD, for a structural reason
>
> The plain run **passes on the DinD container (0 failures)**, and that is *not* a defective check:
> under DinD the nested dockerd **shares the dev container's filesystem**, so a sibling's
> `-v /workspaces/mcm:/probe` genuinely resolves to the working tree. DinD cannot produce the
> path-mismatch failure at all. (The task's predicted `pwd -P is /workspaces/MovieCollectionManager`
> also does not occur — the current container is already at `/workspaces/mcm`.)
>
> The genuine RED is the documented injected-mismatch form, and it fails 2 assertions:
>
> ```text
> MCM_WORKSPACE_PATH=/tmp/empty-probe bash .devcontainer/verify/verify-workspace-path.sh
>   ✓ pwd -P inside the container is /tmp/empty-probe
>   ✗ sibling probe listed 0 entries
>   ✗ probe listing has no pnpm-workspace.yaml — the sibling mounted the WRONG content
> ```
>
> That run also *demonstrates* the failure mode rather than merely describing it: **the mount
> succeeded**. No error, no warning — just wrong content, which is exactly why assertion 3 exists
> and why asserting mountability alone would reproduce the bug.
- [~] T028 [US3] Clone the repository on the VM at `/workspaces/mcm` and bring the dev container up with `devcontainer up --workspace-folder /workspaces/mcm --config .devcontainer/sandbox/devcontainer.json` — clone ✅ (done at T022); `devcontainer up` in progress, see below

> ### T028 — the container BUILD is now governed by egress policy, which nothing anticipated
>
> Recorded as **[research.md D-16](research.md)**. On the Docker Desktop path the dev-container build
> runs on the **Windows engine**, outside every egress control this project has — `init-firewall.sh`
> governs the *running* container, never the build. In the sandbox the build runs **inside the
> governed microVM**, so `apt-get` and feature installers meet the deny-by-default policy for the
> first time. No part of the spec, plan or proposal predicted this.
>
> **The dependencies surfaced one layer at a time** — each fix revealed the next, which is the thing
> to know before attempting this on a fresh workstation:
>
>
> | # | Failure | Cause | Resolution |
> | --- | --- | --- | --- |
> | 1 | `Something wicked happened resolving 'deb.debian.org'` | the feature apt-installs the docker CLI + compose plugin; the toolchain image ships **neither** | allowlist (operator-approved) |
> | 2 | every `apt-get update` erroring on `cli.github.com` | a pre-existing apt source in the image — **not fatal, but it buries the real error** | allowlist |
> | 3 | `curl: (6) Could not resolve host: packages.microsoft.com` | `"moby": true` installs Moby from Microsoft's repo, not Docker CE | allowlist |
> | 4 | standalone `docker-compose` download, curl exit 6 | the feature's default `dockerDashComposeVersion: v2` fetches a GitHub release artifact **after** apt already installed the `docker compose` plugin | **`"dockerDashComposeVersion": "none"` — a removal, not a widening** |
>
> **(4) is the one to copy the reasoning from.** The obvious fix was a fifth allowlist entry. Instead
> the dependency was checked and found redundant: the repository contains **no** invocation of the
> legacy hyphenated `docker-compose` binary — every call site, including all the `up-*`/`down-*` Nx
> targets, uses `docker compose` (the plugin, already installed by apt). Disabling the download
> removes a build-time network dependency *and* one more reason to widen egress.
>
> Two diagnostic notes worth keeping: the policy blocks at **DNS** (`No address associated with
> hostname`), which is a distinctive signature; and `gpg: no valid OpenPGP data found` in (3) was a
> **downstream symptom** of the failed key fetch, not a separate keyring fault to chase.
>
> **The end state is to retire entries 1–3 entirely** by baking the docker CLI and compose plugin
> into `toolchain.Dockerfile` and dropping the `features` block. That was not done now only because
> it needs a CI image rebuild, republish and re-pin, which would block G2/G3 behind an out-of-session
> dependency. Until then, the allowlist makes Debian package mirrors reachable from the VM at
> runtime — a broader surface than the registry entries, and stated as such in the entry's `reason`.
- [ ] T029 [US3] **G2 GATE** — run `verify-engine-seam.sh` in all three modes and confirm green
- [ ] T030 [US3] **G3 GATE** — run `verify-workspace-path.sh` and confirm the sibling probe sees the repository
- [ ] T031 [P] [US3] Update `.devcontainer/verify/verify-host-isolation.sh` to be sandbox-aware — no Windows path visible at all
- [ ] T032 [P] [US3] Update `.devcontainer/verify/verify-personal-layer.sh` to assert the RTK binary is present on the `mcm-claude` volume
- [ ] T033 [P] [US3] Update `.devcontainer/verify/verify-firewall-allowlist.sh` to read `egress-allowlist.json` instead of re-listing domains inline
- [ ] T034 [P] [US3] Parameterise `.devcontainer/verify/verify-portable-runner.sh` by config so both `devcontainer.json` and `sandbox/devcontainer.json` can be checked — mechanical only; the sandbox variant's second-runner claim is settled at G4 (T037), not here
- [ ] T035 [US3] Remove the Compose v5 parity pin from `.devcontainer/toolchain.Dockerfile` — **Done when**: the pin is gone, the image rebuilds, and `docker compose version` inside the dev container reports the sandbox engine's plugin without error
- [ ] T036 [US3] Run the full twelve-script harness in the new dev container and confirm every check green

### T025 — Write the engine-seam check

**Type**: New file (test) | **Time**: 2 hrs | **Risk**: Medium

**Spec reference**: spec.md#user-story-3, contracts/verify-harness.md

**Scenarios covered**:

- US3-AC1: no container-engine daemon runs inside the dev container
- US3-AC2: the dev container is not privileged
- US3-AC3: container operations execute on the sandbox's engine
- US3-AC4: the Windows engine sees neither the dev container nor anything it creates

**File**: `.devcontainer/verify/verify-engine-seam.sh`

Implement the seven assertions in the harness contract across three modes. This **replaces** `verify-engine-isolation.sh`, whose pass condition (no docker socket mounted) is now false by design — the new architecture mounts one on purpose, and the reachable engine is the microVM's, not the host's. Per the repository rule, the guard is updated at the cause: the replacement must assert the new premise with at least equal force, not simply drop the old assertion.

Keep and widen the `--host-check` mode. It is the only **non-fabricable** proof, because it reads the real Windows engine.

**Verify RED** (run in the **current DinD** dev container — the check must fail there):

```bash
bash .devcontainer/verify/verify-engine-seam.sh
```

**Expected RED**: exits 1 — `✗ dockerd is running inside the container`, `✗ no docker socket present`, and (via `--vm-check`) `✗ Privileged: true`. Three assertions failing.

> If this passes on the DinD container, the check is asserting nothing. A check that is green in both environments distinguishes nothing.

### T026 — Write the workspace-path check

**Type**: New file (test) | **Time**: 1 hr | **Risk**: Medium

**Spec reference**: spec.md#user-story-3 (AC6), FR-017, contracts/verify-harness.md, research.md#D-03

**Scenarios covered**:

- US3-AC6: a sibling container asked to mount a path from the working tree resolves to the intended content

**File**: `.devcontainer/verify/verify-workspace-path.sh`

Three assertions, per the harness contract: `pwd -P` equals `$MCM_WORKSPACE_PATH` (default `/workspaces/mcm`); a sibling probe (`docker run --rm -v "$MCM_WORKSPACE_PATH:/probe" alpine ls /probe`) succeeds; and the probe's listing contains a known repository marker (`pnpm-workspace.yaml`).

The third assertion is the one that matters. A path mismatch **does not raise an error** — the sibling mounts an empty directory, the run proceeds, and the result is confidently wrong. Asserting only that the mount *succeeded* would reproduce exactly the failure this check exists to catch.

**Verify RED** (run in the **current DinD** dev container, where the workspace is at a different path and `docker` is the nested engine):

```bash
bash .devcontainer/verify/verify-workspace-path.sh
```

**Expected RED**: exits 1 — `✗ pwd -P is /workspaces/MovieCollectionManager, expected /workspaces/mcm` and `✗ sibling probe listed 0 entries — path does not exist on the engine host`. Two assertions failing.

> To confirm the third assertion is not trivially green, run once with `MCM_WORKSPACE_PATH=/tmp/empty-probe` (an existing empty directory): the mount succeeds and the marker assertion must still fail — `✗ probe listing has no pnpm-workspace.yaml`. If it passes there, the check is asserting mountability rather than correctness.

### T027 — Create the sandbox dev-container variant

**Type**: Config change | **Time**: 1 hr | **Risk**: Medium

**Spec reference**: FR-013, FR-014, FR-015, FR-016, FR-019, research.md#D-01, #D-02, #D-10

**Prerequisite**: T025, T026 complete and verified RED.

Copy `.devcontainer/devcontainer.json` to `.devcontainer/sandbox/devcontainer.json` and apply the delta:

| Change | Detail |
| --- | --- |
| Feature | `docker-in-docker:2` → `docker-outside-of-docker:1`; replace the FR-004/FR-011 privileged-rationale comment with a note that the engine is the sandbox's |
| Network | add `"runArgs": ["--network=host"]` — "host" is the **sandbox VM** |
| `DOCKER_CONFIG` | **remove** — the credsStore workaround's cause is gone (headless CLI builds the container) |
| `capAdd` | keep `NET_ADMIN`/`NET_RAW` while `init-firewall.sh` lives (D-05); note the retirement path |
| Volumes, `remoteUser`, `containerEnv`, lifecycle hooks | unchanged |
| `workspaceMount`/`workspaceFolder` | still **omitted** — `--workspace-folder` supplies the matching default |

`.devcontainer/devcontainer.json` is **not modified** by this task. It must keep working on Docker Desktop until adoption (FR-019).

**Done when**: `devcontainer up --config .devcontainer/sandbox/devcontainer.json` builds and starts on the sandbox engine, and the Docker Desktop path still opens unchanged.

### T029 — G2 gate: the engine seam

**Type**: Implementation / gate | **Time**: 1 hr | **Risk**: High

**Spec reference**: SC-001, SC-002

**Prerequisite**: T025 verified RED, T027, T028.

**Verify GREEN** (in the new dev container):

```bash
bash .devcontainer/verify/verify-engine-seam.sh
```

**Expected GREEN**: `0 failures — 5 in-container assertions passed`, engine ID recorded.

**Also run** (VM-side, then host-side):

```bash
ssh mcm.sbx 'bash /workspaces/mcm/.devcontainer/verify/verify-engine-seam.sh --vm-check'
```

**Expected**: `✓ Privileged: false`.

```powershell
docker ps -a    # Windows engine — must list nothing from the sandbox
bash .devcontainer/verify/verify-engine-seam.sh --host-check
```

**Expected**: `PASS host-side` — no probe, no stack container, no dev container.

Any failure here is a design defect, not a tuning problem. Do not proceed to US4.

### T030 — G3 gate: workspace path identity

**Type**: Implementation / gate | **Time**: 30 min | **Risk**: High

**Spec reference**: FR-017, US3-AC6, research.md#D-03

**Prerequisite**: T026 verified RED, T028.

**Verify GREEN**:

```bash
bash .devcontainer/verify/verify-workspace-path.sh
```

**Expected GREEN**: `0 failures` — `pwd -P` is `/workspaces/mcm`, the sibling probe lists the repository, and `pnpm-workspace.yaml` is visible through it.

This gate exists because a path mismatch **does not error**. The sibling mounts an empty directory, the run proceeds, and the result is confidently wrong. Fix before any workload runs.

### T031 — Make the host-isolation check sandbox-aware

**Type**: Test refactor | **Time**: 45 min | **Risk**: Low

**Spec reference**: FR-010, contracts/verify-harness.md

**Scenarios covered**:

- US3-AC4 / FR-010: the workstation's filesystem and credentials are unreachable from inside

**File**: `.devcontainer/verify/verify-host-isolation.sh`

Keep the existing assertions (`MCM_DEVCONTAINER=1`, non-root `coder`, no host filesystem or credential mount). Add one: **no Windows path is visible at all** — no `/mnt/[a-z]` mount, no `/host_mnt`, and no path in `/proc/mounts` resolving to a drive letter. Today's environment can legitimately carry a bind mount from `E:\` on the local-checkout path; the sandbox must never.

**Verify RED** (run in the **current DinD** dev container **on the bind-mount path**, i.e. opened from the Windows checkout rather than a named volume):

```bash
bash .devcontainer/verify/verify-host-isolation.sh
```

**Expected RED**: exits 1 — `✗ Windows host path visible in /proc/mounts: /workspaces/MovieCollectionManager` (one new assertion failing; the pre-existing assertions still pass).

> On the named-volume path this new assertion passes for the wrong reason. Run the RED from the bind-mount path, or the check is not proven to fail.

### T032 — Assert RTK is present in the personal layer

**Type**: Test refactor | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-018; constitution §Common Technology Stack — Token Compression

**Scenarios covered**:

- US3-AC7: the developer's personal layer is preserved, matching current behaviour

**File**: `.devcontainer/verify/verify-personal-layer.sh`

Add an assertion that the RTK binary exists on the `mcm-claude` volume (`~/.claude/tools`) and answers `rtk --version`. RTK is constitution-mandated for every AI-assisted shell session, and it is installed by the out-of-repo dotfiles rather than baked into the image — so an environment that lost it looks completely healthy while violating a MUST principle. Nothing currently asserts it.

**Verify RED** (run in a container whose `mcm-claude` volume has no dotfiles layer — e.g. a fresh volume, or temporarily rename `~/.claude/tools`):

```bash
bash .devcontainer/verify/verify-personal-layer.sh
```

**Expected RED**: exits 1 — `✗ RTK not found on the personal volume (~/.claude/tools/bin/rtk)`.

> The existing script tolerates an empty personal layer by design (FR-014: the container is team-capable without dotfiles). Decide and document which it is: RTK **required** (fails an empty layer) or **warned**. This task takes the required reading, because the constitution makes it a MUST — and records that choice in the script header.

### T033 — Make the allowlist check read the canonical list

**Type**: Test refactor | **Time**: 45 min | **Risk**: Low

**Spec reference**: FR-007, contracts/egress-allowlist.md

**Scenarios covered**:

- US2-AC1: the enforced allowlist derives from the project's canonical destination list

**File**: `.devcontainer/verify/verify-firewall-allowlist.sh`

Replace the script's own inline expectation with a read of `.devcontainer/egress-allowlist.json`. A check that carries its own copy of the expectation cannot detect drift in the thing it is checking — it will happily pass while the canonical list and the live ruleset disagree, which is precisely the R8 failure this extraction exists to prevent.

**Verify RED** (run against a deliberate divergence — add a destination to `egress-allowlist.json` that the live ipset does not contain, then run the **current** script):

```bash
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected RED**: exits **0** — `PASS` — while the canonical list and the ipset disagree. That false pass *is* the RED: the check is blind to drift.

> This RED is a passing run, not a failing one, so it must be asserted deliberately. Record the injected divergence and the observed exit 0; then remove the divergence before implementing.

### T034 — Parameterise the portable-runner check by config

**Type**: Test refactor | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-019, research.md#D-15, contracts/verify-harness.md

**Scenarios covered**:

- US3-AC9: the existing configuration keeps working on the workstation's own engine

**File**: `.devcontainer/verify/verify-portable-runner.sh`

**Mechanical change only.** Take the config under test as a parameter (defaulting to the current behaviour) so both `.devcontainer/devcontainer.json` and `.devcontainer/sandbox/devcontainer.json` can be checked. The script's assertions — `read-configuration`, `devcontainer up`, then the proofs via `devcontainer exec` — are already entirely CLI-side and apply unchanged to both configs. For the sandbox variant they become *more* load-bearing, because the CLI is now the primary build path rather than the alternate one.

**Do not narrow the claim in this task.** Whether the sandbox variant retains a second runner is a **G4 measurement** (T037), not a design decision — see research.md D-15. Declaring it CLI-only here would pre-decide that gate and quietly surrender the anti-lock-in property FR-008 exists to hold.

**Verify RED** (run the current, unparameterised script against the sandbox variant):

```bash
bash .devcontainer/verify/verify-portable-runner.sh .devcontainer/sandbox/devcontainer.json
```

**Expected RED**: the argument is ignored and the script checks the repo-root default instead — it reports `✓ committed devcontainer.json resolves…` for the **wrong config**. A pass that answers a different question than the one asked is the defect.

> Confirm it is genuinely reading the wrong file: temporarily make the sandbox variant invalid JSON. The current script must still report PASS. If it fails, it is already reading the argument and this task is unnecessary.

**Verify GREEN**:

```bash
bash .devcontainer/verify/verify-portable-runner.sh .devcontainer/devcontainer.json
bash .devcontainer/verify/verify-portable-runner.sh .devcontainer/sandbox/devcontainer.json
```

**Expected GREEN**: each run names the config it checked and passes against **that** config; an invalid sandbox variant now fails the second run.

**Also**: the script header records that its assertions are CLI-side, that the extension half of FR-008 is verified by daily use rather than by this script, and that D-15/G4 owns the question of the sandbox variant's second runner.

### T036 — Run the full harness

**Type**: Config change / verification | **Time**: 45 min | **Risk**: Low

**Spec reference**: FR-020, SC-002

Run all **twelve** scripts enumerated in [contracts/verify-harness.md](contracts/verify-harness.md) § Aggregate run — by name, not by globbing the directory. A glob silently shrinks when a file is renamed or lost, reports success, and has checked less than it claims.

**Done when**: twelve scripts report a result, all twelve are green, and the run fails loudly if fewer than twelve reported. A skipped check counts as a failure.

**Checkpoint**: US3 complete — `privileged` and the nested engine are gone, and it is proven from all three vantage points.

---

## Phase 6: User Story 4 — Reaching the assistant from the workstation's editor (P2)

**Goal**: open VS Code on Windows, land in a dev-container terminal, run the coding assistant.

**Independent test**: connect through and confirm the in-container markers and assistant version; then exercise the fallback once.

- [ ] T037 [US4] **G4 GATE** — connect VS Code Remote-SSH to `mcm.sbx`, reach the dev container by **both** *Attach to Running Container* and *Reopen in Container*, and record which of the two work (D-15)
- [ ] T038 [US4] Confirm `rtk gain` reports active compression in the in-container shell — **Done when**: `rtk gain` returns >80% compression after a test run, satisfying the constitution's Token Compression requirement
- [ ] T039 [US4] Exercise the sshd-in-container fallback once (`sbx ports mcm --publish 2222:2222`) — **Done when**: a terminal is reached over the fallback route, and the runbook records it as exercised with the date, not as theoretical
- [ ] T040 [US4] Pin the `sbx` version and add a release-notes review step to the update ritual (R5) — **Done when**: the pinned version is recorded in the delta runbook and the review step is written into the update procedure

### T037 — G4 gate: the two-hop editor chain, and which extension operations work

**Type**: Config change / gate | **Time**: 1.5 hrs | **Risk**: Medium

**Spec reference**: FR-022, US4-AC1, US4-AC2, research.md#D-08, #D-15

Both hops are standard in isolation; their composition is not documented by Docker. This gate cannot stop the migration — the sshd fallback (T039) is fully functional — but it decides two separate things, and the second is easy to miss:

**(a) Can a terminal be reached at all?** Remote-SSH to `mcm.sbx`, then the Dev Containers extension, then confirm in the in-container terminal:

```bash
echo $MCM_DEVCONTAINER    # 1
whoami                    # coder
claude --version
```

…and that the three configured extensions load.

**(b) Which extension operation reached it — attach, reopen, or both?** These are different capabilities and only one of them is a *runner*:

| Operation | What it does | If it works |
| --- | --- | --- |
| **Attach to Running Container** | connects to a container the CLI already built | the baseline; expected to work |
| **Reopen in Container** | **the extension builds**, from inside the Remote-SSH session, on the sandbox engine | the sandbox keeps a second runner — FR-008's anti-lock-in property survives |

Test *Reopen in Container* deliberately, against a **stopped** dev container so the extension has to build rather than silently attach to a running one. That distinction is the whole measurement; a "reopen" that finds the container already up proves nothing.

**Record the outcome in research.md D-15**, replacing its `[gate — P4]` marker:

- **Both work** → delete D-15; the dual-runner property survives in its new direction (CLI daily, extension alternate) and no scoping of `verify-portable-runner.sh` is needed.
- **Attach only** → the sandbox environment is **hostage to `@devcontainers/cli`**, inside a VM whose Node was provisioned by hand in T023. Record the constraint, and add a **CLI-recovery path** to the delta runbook (T053): how to restore a working builder when the CLI breaks — `sbx template save` restore, or reinstall from the allowlisted npm registry. Today a broken CLI is survivable by opening the folder in VS Code; under this outcome it is not, and the runbook must say what to do instead.
- **Neither works** → the sshd fallback (T039) becomes the documented primary route.

**Done when**: a dev-container terminal from the host editor reports `1`, `coder`, and a working `claude --version`; both extension operations have been attempted with the container stopped beforehand; D-15 records the measured result; and the runbook names the primary route plus, if applicable, the CLI-recovery path.

---

## Phase 7: User Story 5 — Full workload parity, with sibling egress governed (P2)

**Goal**: the real workload runs at acceptable speed, and the previously unfiltered sibling egress is proved closed.

**Independent test**: run the runbook's validated sequence against sibling stacks, timed against the baseline; issue a disallowed request from inside a sibling container.

**Contains G5 (sibling egress — the security payoff) and G6 (performance).**

- [ ] T041 [US5] Bring up the stacks as siblings: `gen-dev-secrets` → `gen-dev-env` → `up-auth` → `docker-build mcm-app` → `up-mcm` — **Done when**: every step exits 0, `docker ps` lists the stacks alongside the dev container, and a subsequent `down-mcm`/`down-auth` removes them cleanly
- [ ] T042 [US5] Run the integration tier with the three documented URL exports unchanged — **Done when**: the tier passes with **0 skips** (a credential-driven skip is a missing file, not a missing capability)
- [ ] T043 [US5] Run the web E2E suite via the Playwright official-image recipe with the identical-path mount — **Done when**: the suite passes and no root-owned artifact is left in `test-results/`
- [ ] T044 [US5] Run one agent E2E spec against Anthropic — **Done when**: the spec passes against a gateway rebuilt from current source (a container recreated from a non-rebuilt image silently runs old code)
- [ ] T045 [US5] Bring up `dev-ollama` as a sibling and confirm gateway reachability — **Done when**: `host.docker.internal` resolves to the VM gateway from inside the gateway container and reaches `dev-ollama` on 11434
- [ ] T046 [US5] Write the sibling-egress probe in `.devcontainer/verify/verify-firewall-allowlist.sh` — a refused request originating **inside a sibling container**
- [ ] T047 [US5] **G5 GATE** — prove the sibling refusal is blocked **and** audited in `sbx policy log`
- [ ] T048 [US5] **G6 GATE** — record migrated wall-clock in `baseline-measurements.md` and compare against T003 — **Done when**: every stage from T003 has a paired migrated timing and a computed ratio; a ratio >1.5× is escalated with the measurements, not absorbed
- [ ] T049 [US5] Determine whether proxy header injection reaches sibling containers (R7), record the posture in `research.md`, and upgrade any credential that can move to D-07 preference (1)
- [ ] T050 [US5] Update `scripts/devcontainer-android.sh` to refuse explicitly when `/dev/kvm` is absent — **Done when**: it exits 0 with a message naming the absence, the reason (no nested virtualization in the microVM), and both alternative routes (CI, or the retained Docker Desktop environment)
- [ ] T051 [US5] Prove the environment survives a workstation reboot — **Done when**: after a host restart, `sbx start mcm` returns the sandbox with its images, volumes, workspace clone and shell history intact, the dev container restarts, and the delta runbook states what a reboot does and does not preserve

### T046 — Write the sibling-egress probe

**Type**: Test | **Time**: 45 min | **Risk**: Low

**Spec reference**: spec.md#user-story-5, FR-025, contracts/egress-allowlist.md

**Scenarios covered**:

- US5-AC5: a sibling container's non-allowlisted request is refused, and an audit entry is produced

**File**: `.devcontainer/verify/verify-firewall-allowlist.sh`

Add a fourth probe row: run a throwaway sibling (`docker run --rm curlimages/curl`) and request a non-allowlisted destination. It must be refused. This must be a **real probe from a real sibling** — inferring it from the policy's stated scope proves nothing, and the whole security claim of this feature rests on this one assertion.

**Verify RED** (run in the **current DinD** dev container, where the residual is open by design):

```bash
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected RED**: exits 1 — `✗ sibling container reached example.com — nested-container egress unfiltered`. This is the documented 037 residual failing on purpose, which is exactly what makes the GREEN meaningful.

### T047 — G5 gate: the closed residual

**Type**: Implementation / gate | **Time**: 45 min | **Risk**: High

**Spec reference**: FR-025, SC-005

**Prerequisite**: T046 verified RED.

**Verify GREEN** (in the sandbox dev container):

```bash
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**Expected GREEN**: `0 failures` — including `✓ sibling container refused example.com`.

**Also run**:

```powershell
sbx policy log | Select-String example.com
```

**Expected**: the sibling's refusal appears in the audit log. Blocked-but-unaudited does not satisfy FR-008; if the block is silent, the posture claim is weaker than stated and must be recorded that way.

### T049 — Resolve the credential posture (R7) and upgrade what can move

**Type**: Config change | **Time**: 1 hr | **Risk**: Low

**Spec reference**: FR-027, research.md#D-07

**Prerequisite**: T024 (credentials provisioned by the fallback), T041 (siblings running).

Put `ANTHROPIC_API_KEY` in `sbx secret` **only** — removed from the sandbox env file — and run one agent E2E scenario. If the agent gateway's calls succeed, the egress proxy's header injection reaches sibling containers and the key need never exist inside the VM: move every credential that supports injection to preference (1). If they fail, keep preference (3) and record that the key is VM-resident.

Either outcome is acceptable. What is not acceptable is leaving it ambiguous — the posture statement in the runbook depends on knowing which is true.

**Done when**: `research.md` D-07 records the measured answer in place of its `[gate — P5]` marker, every credential sits at the highest preference level that works, and the runbook's posture statement matches.

**Checkpoint**: US5 complete — the environment works, and the headline security improvement is proven rather than asserted.

---

## Phase 8: User Story 6 — Reproducible recreate, documented, old path retired (P3)

**Goal**: anyone can recreate the environment from nothing, diagnose it, and find one current description of it.

**Independent test**: from a workstation with the tooling but no sandbox, follow the documentation to a working dev container within 15 minutes, with no undocumented step.

- [ ] T052 [US6] Snapshot the proven environment (`sbx template save mcm`) — **Done when**: `sbx run -t <tag>` recreates a working sandbox and the recreate procedure is written down
- [ ] T053 [US6] Write `docs/runbooks/devcontainer-sandbox.md` — lifecycle, two-layer triage order, port publishing, teardown semantics, disk pruning, foot-guns, and the two workstation gotchas
- [ ] T054 [US6] Rewrite the posture section of `docs/runbooks/devcontainer.md` and archive the DinD sections (lock deadlock, credsStore, Compose parity)
- [ ] T055 [P] [US6] Update `CLAUDE.md` — the environment gate entry and knowledge index — **Done when**: no gate or index entry describes the nested engine as current, and `node scripts/check-openwiki-governance.mjs` passes
- [ ] T056 [P] [US6] Update `README.md` with the new environment description — **Done when**: the environment section describes the sandbox-hosted dev container and names the emulator exception
- [ ] T057 [P] [US6] Update the OpenWiki **source** documents so the generator regenerates the bundle correctly — **Done when**: the cited source documents carry the new posture and no generated page under `openwiki/` was hand-edited
- [ ] T058 [US6] Extend `specs/060-devcontainer-docker-sandbox/rollback.md` with the rollback for every migration phase
- [ ] T059 [US6] Prove recreate-from-nothing ≤ 15 min warm — **Done when**: a timed run from template to working dev container is recorded, with zero steps outside the documentation
- [ ] T060 [US6] After two consecutive incident-free weeks (spec.md FR-032 defines "incident"): collapse to a single `devcontainer.json`, delete `.devcontainer/verify/verify-engine-isolation.sh`, and stop offering the Docker Desktop path for assistant sessions — **Done when**: an incident log covering the two weeks is recorded, `.devcontainer/sandbox/` is folded into `.devcontainer/devcontainer.json`, `verify-engine-isolation.sh` is deleted, the full harness is re-run green post-collapse, and `rollback.md`'s P6 entry names the revert commit

### T053 — Write the delta runbook

**Type**: Documentation | **Time**: 3 hrs | **Risk**: None

**Spec reference**: FR-030, SC-008

Must contain, at minimum:

- **Triage order** for a blocked request: `sbx policy log` **first**, then the in-VM ipset staleness reflex. Without a stated order, two allowlists cost more time than they save (R8).
- **Lifecycle**: create / stop / start / template / rm, and what each preserves — including **what a host reboot preserves** (T051). `sbx rm` is total: the VM, the engine, every sibling, every named volume, and the workspace clone. **Unpushed work is lost.**
- **Ports**: `sbx ports` publishing, and the LAN-device answer from T061 — either a `netsh portproxy` remedy or an explicit "unsupported" (R9).
- **Foot-guns**: `docker rm -f` on the dev container's own container ends the session (R11); recovery is `devcontainer up` from the VM or a template recreate.
- **CLI-recovery path — required only if T037 landed attach-only.** If the extension cannot build the sandbox variant, `@devcontainers/cli` is the environment's *sole* builder, running on a hand-provisioned Node (T023). Document how to restore a working builder when it breaks: restore from `sbx template save`, or reinstall from the allowlisted npm registry. On the Docker Desktop path this case is survivable by opening the folder in VS Code; here it is not, so the answer cannot be left implicit.
- **Disk**: the envelope measured in T018 and a pruning practice (G7).
- **The two workstation gotchas**: `sbx` not on PATH in a fresh shell; `sandboxd` running-but-unresponsive. Both present as "the tool is broken" — which is why they need named entries rather than tribal memory.

**Done when**: the runbook contains all six sections and a developer who has never used `sbx` can follow it from install to working dev container.

### T054 — Rewrite the current runbook's posture section

**Type**: Documentation | **Time**: 1 hr | **Risk**: None

**Spec reference**: FR-021, FR-031, SC-008

The FR-011 posture statement — host-FS isolation STRONG, engine isolation MODERATE — is the honest self-assessment that justified the current design. It must be **restated, not deleted**: engine isolation from the host is now STRONG (hypervisor boundary), while isolation *within* the VM is deliberately weak and accepted because the VM is the disposable blast radius.

Archive rather than delete the DinD sections. They document real failures (the `meta.db` flock deadlock, the credsStore exit 255, the Compose parity pin) that remain true for anyone on the retained Docker Desktop path.

**Done when**: no passage describes the nested engine as the current environment, the new ledger is stated in FR-011's own honest style, and the retained-path sections are clearly marked as such.

### T058 — Record the rollback for every phase

**Type**: Documentation | **Time**: 45 min | **Risk**: None

**Spec reference**: FR-033

**Prerequisite**: T009 (the file exists).

FR-033 requires every migration phase to have a rollback that restores the previous working state. Extend `rollback.md` with one entry per phase, matching [quickstart.md](quickstart.md):

| Phase | Rollback |
| --- | --- |
| P1 sandbox bring-up | `sbx rm mcm` |
| P2 egress + forge gate | reset policy to the bring-up profile; `sbx rm mcm` |
| P3 dev container | `docker rm -f` the container in the VM; re-run `devcontainer up`; Docker Desktop config untouched |
| P4 editor chain | remove the managed `Host *.sbx` block; drop the published SSH port |
| P5 workload | `down-mcm`/`down-auth` in the VM, or `sbx rm mcm` |
| P6 adopt | `git revert` — see below |

Record the asymmetry honestly: **P6 step 5 is the only irreversible step**, because it deletes the fallback configuration. Before it, rollback is reverting documentation commits and the environment is unaffected. After it, rollback restores the nested-engine config from history — and that config must be **rebuilt and verified before being relied on**, because a configuration unexercised for a fortnight is a claim, not a fallback.

**Done when**: `rollback.md` has an entry per phase, the T007/T008 entry from T009 is retained, and the P6 asymmetry is stated rather than implied.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T061 Determine whether `sbx ports` can bind non-loopback for a physical LAN device; implement the `netsh portproxy` remedy or declare the workflow unsupported (R9) — **Done when**: a phone on the LAN reaches Metro on 8081, or the runbook states the workflow is unsupported and names the Expo-tunnel alternative
- [ ] T062 [P] Confirm the root `.gitignore` covers the sandbox-local env file and any kit carrying topology literals — **Done when**: `git status` is clean with those files present, and no new nested `.gitignore` was added
- [ ] T063 [P] Run `verify-committed-clean.sh` and the existing secret/topology gates — **Done when**: all pass, and a grep of the diff for the forge host and tailnet address returns nothing
- [ ] T064 Run `node scripts/check-openwiki-governance.mjs` — **Done when**: exit 0 with every concept provably derived or authoritative
- [ ] T065 Update `specs/060-devcontainer-docker-sandbox/research.md` with every gate's actual outcome — **Done when**: each of G1–G7 and each `[gate]` marker in D-07/D-08/D-11 is replaced by what happened, so the file records history rather than intent

---

## Dependencies

```text
Phase 1 (Setup) ──────────────────────────────────────┐
   T002 (host CPU/RAM) ────────────────────┐          │
                                            │          │
Phase 2 (Foundational: canonical allowlist) │          │
   T004 → T005 → T006 → T007 → T008 → T009  │          │
                                            │          ▼
Phase 3 (US1) ✅ complete                   └──► Phase 4 (US2)
                                                  T018 → T019 → T020 → T021 → T022 (G1)
                                                                        T023, T024
                                                                              │
                                          ┌───────────────────────────────────┘
                                          ▼
                                     Phase 5 (US3)
                                     T025,T026 (RED) → T027 → T028 → T029 (G2), T030 (G3)
                                     T031,T032,T033,T034 [P] → T035 → T036
                                                                    │
                                          ┌─────────────────────────┴────────────┐
                                          ▼                                      ▼
                                    Phase 6 (US4)                          Phase 7 (US5)
                                    T037 (G4) → T038,T039,T040             T041…T047 (G5), T048 (G6)
                                                                           T049 (needs T024), T050, T051
                                          └──────────────┬───────────────────────┘
                                                         ▼
                                                   Phase 8 (US6)
                                                   T052 → T053,T054 → T058 → T059 → T060
                                                         │
                                                         ▼
                                                   Phase 9 (Polish)
                                                   T061 → T053 (runbook update), T062…T065
```

### Hard ordering rules

- **T002 before T018.** The sizing decision needs the host's actual CPU/RAM totals; without them T018 hardcodes a floor that may under-provision.
- **T003 before cutover.** The baseline is the denominator of SC-006.
- **T009 immediately after T007/T008.** Those are the only tasks that modify a file the environment you are working in executes on every start.
- **T022 (G1) gates everything downstream.** If the forge is unreachable, the feature ends at US2 — do not start Phase 5.
- **T025/T026 must be RED before T027.** Writing the config first makes the checks trivially green and the TDD gate meaningless.
- **T046 must be RED on the current DinD container.** That RED *is* the documented 037 residual; without seeing it fail there, the GREEN proves nothing.
- **T024 before T049.** Credentials are provisioned by the fallback first, then upgraded once R7 is answered — not guessed at in Phase 4.
- **T061 before T053 is finalised.** The runbook's ports section needs the LAN answer.
- **T060 is time-gated**, not effort-gated — two consecutive incident-free weeks of daily use, per FR-032's definition.

## Parallel execution opportunities

| Phase | Parallel set | Why safe |
| --- | --- | --- |
| 1 | T002 ∥ T003 | different files; T003 is wall-clock-bound and can run while T002 is written |
| 5 | T031 ∥ T032 ∥ T033 ∥ T034 | four different verify scripts, no shared state |
| 8 | T055 ∥ T056 ∥ T057 | `CLAUDE.md`, `README.md`, OpenWiki sources — distinct files |
| 9 | T062 ∥ T063 | independent gates |

Everything else is sequential: this is a migration, and each phase's gate is the precondition for the next phase being worth attempting.

## Implementation strategy

**MVP = US2.** Not US3. The smallest increment that delivers real value is *the answer to whether this migration is possible at all* — G1 either clears the way or ends the feature, and it costs a fraction of the full migration to find out. Every subsequent phase is wasted effort if G1 fails.

**Then US3** — the migration proper, and the point at which `privileged` and the nested engine are actually gone.

**Then US4 + US5 in parallel** where the workstation allows; they touch different surfaces.

**US6 last, and partly time-gated.** Documentation is written as the phases complete, but the collapse to a single configuration waits out the two-week observation window. Retiring the fallback before it has been proven unnecessary is how a migration turns a good outcome into an outage.

---

## Completion Checklist

Before marking `060-devcontainer-docker-sandbox` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: No nested engine — zero daemons in-container, `"Privileged": false`, both asserted automatically
- [ ] **SC-002**: Verification suite passes in full, including the host-side proof that the Windows engine sees nothing
- [ ] **SC-003**: A developer reaches an in-dev-container terminal running the assistant from the host editor
- [ ] **SC-004**: The assistant creates, interrogates and destroys the full stack set; 100% invisible to the workstation
- [ ] **SC-005**: Allowlisted reachable; non-allowlisted refused with audit entry **including from a sibling container**; host loopback unreachable
- [ ] **SC-006**: Integration + web E2E + one agent E2E pass at ≤1.5× the measured baseline, unmodified service map
- [ ] **SC-007**: Recreate-from-nothing ≤15 min warm, zero undocumented manual steps
- [ ] **SC-008**: Runbooks, `CLAUDE.md`, OpenWiki and `README.md` all describe the new environment; no passage presents the nested engine as current
- [ ] **SC-009**: No credential, forge hostname or tailnet address in git; existing gates pass unchanged
- [ ] **SC-010**: Emulator loss recorded as a scoped exception with named alternatives; no other workflow regressed
- [ ] Every migration phase has a recorded rollback (`rollback.md`), and the P6 asymmetry is stated
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] **Twelve** verify scripts report a result and all are green (enumerated by name — a **skipped** check counts as a failure, and a glob that finds eleven must fail the run)
- [ ] `node scripts/check-openwiki-governance.mjs` — governance gate passes
- [ ] `pnpm nx e2e mcm-app` — full-stack web E2E regression green in the new environment
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)
