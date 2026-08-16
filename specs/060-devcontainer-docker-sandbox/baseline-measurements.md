# Baseline measurements — Docker Desktop (DinD) dev container

**Feature**: 060-devcontainer-docker-sandbox | **Measured**: 2026-08-15 / 2026-08-16 (UTC)

This file is the **denominator of SC-006**. Without it the ≤1.5× budget is unfalsifiable, and G6
cannot be evaluated in either direction. T048 records the migrated timings alongside these and
computes the ratio.

**The single most important rule for T048: run the identical commands against the identical
workload composition.** They are recorded verbatim below for that reason. A ratio computed against
a different command, a different tier selection, or a different set of running stacks is not a
ratio — it is two unrelated numbers divided by each other.

---

## Environment measured

| Property | Value |
| --- | --- |
| Workstation | 12th Gen Intel Core i7-12700K — 12 physical / **20 logical** cores, **31.8 GB** RAM |
| OS | Windows 11 Home 10.0.26200 |
| Host container engine | Docker Desktop **29.7.2** |
| Nested (DinD) engine | **29.6.2-1** — the engine that actually ran the workload |
| Dev container memory ceiling | **15.51 GiB** (observed via `docker stats`) |
| Dev container | `practical_shamir`, `Privileged=true`, `NetworkMode=bridge` |
| Workspace path | `/workspaces/mcm` — a **named volume** (`vsc-remote-containers`), not a bind mount |
| Thermal / load state | interactive workstation, no other heavy job running |

### Code under measurement

| Property | Value |
| --- | --- |
| Commit measured | `879d2987` (dev container's clone, on `main`) |
| Feature branch HEAD | `abae6ede` |
| Relationship | `879d2987` is an **ancestor of** `abae6ede` |
| Difference, excluding `specs/060-*` | 3 files only: `.specify/feature.json`, `CLAUDE.md` (1 line), `openwiki/.maintenance-state.json` |
| `pnpm-lock.yaml` blob | `bc15195a60c84c20bb8d4b000a125b6ca0e355bf` — **identical** in both trees |
| Playwright resolved version | **1.62.1** (`pnpm exec playwright --version`) |

**Why this satisfies the "measure on the merged tree" requirement.** The concern was that a
pre-merge baseline would compare two different codebases, because the merge carried a ~9,500-line
lockfile change. It does not apply here: the lockfile blob hash is *byte-identical* between the
measured commit and the branch HEAD, and the only differences outside the spec directory are three
documentation/state files that no measured stage touches. The measured tree is post-merge for every
purpose this baseline serves.

### Warm, not cold — and deliberately so

**27 images were already cached** on the DinD engine before the run. This is the *warm* baseline:

- it is the daily-work condition, and therefore the condition the 1.5× budget should govern;
- it is reproducible, whereas a cold run's time is dominated by network throughput;
- the migrated run at T048 will also be warm, after its first pull.

A cold baseline would be dominated by pull time and would **flatter** the sandbox, because the
sandbox's own cold pulls are a one-time cost. If a cold comparison is ever wanted it must be
captured on both sides.

---

## Results

| Stage | Wall-clock | Exit | Composition |
| --- | ---: | ---: | --- |
| `up-auth` | **43 s** | 0 | auth stack to all-healthy |
| `docker-build mcm-app` | **1024 s** | 0 | ~17 min — see the note below, this dominates |
| `up-mcm` | **25 s** | 0 | app + bff-nonsecure to `--wait` healthy |
| integration tier | **32 s** | 0 | 30 suites, **120 passed / 120 total** (jest time 26.4 s) |
| web E2E (`E2E_TIER=gate`) | **196 s** | 1 | **134 passed / 1 failed / 17 skipped** of 152 |
| **Total measured** | **1320 s ≈ 22.0 min** | | |

The web-E2E stage was run twice and measured **195 s** then **196 s** — reproducible to within 1 s.

### Exact commands (T048 must re-run these verbatim)

```bash
# 1. up-auth — nx target, then poll until every container of the project is healthy
pnpm nx up-auth infrastructure-as-code

# 2. docker-build
pnpm nx docker-build mcm-app

# 3. up-mcm — the runbook's §1 form, with BOTH profiles and --wait, so the timing means "ready"
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml \
  --env-file infrastructure-as-code/docker/stacks/mcm.env \
  --profile app --profile bff-nonsecure up -d --wait

# 4. integration tier — the three URL exports are load-bearing (see CLAUDE.md gate 4)
export KEYCLOAK_SERVICE_CLIENT_SECRET=$(grep '^KEYCLOAK_SERVICE_CLIENT_SECRET=' \
  infrastructure-as-code/docker/stacks/auth.env | cut -d= -f2-)
export BFF_BASE_URL=http://localhost:8082
export AGENT_CONFIG_ENC_KEY=$(grep '^AGENT_CONFIG_ENC_KEY=' frontend/mcm-app/.env.docker | cut -d= -f2-)
export KEYCLOAK_URL=http://localhost:8099
export MONGO_URL=mongodb://localhost:27018
export REDIS_TEST_URL=redis://localhost:6379/1
pnpm nx test:integration mcm-app

# 5. web E2E — official Playwright image, identical-path mount, gate tier
docker run --rm --network host --env-file ./frontend/mcm-app/.env.e2e.local \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v /workspaces/mcm:/workspaces/mcm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e E2E_BFF_TARGET=dev-container -e CI=true -e E2E_TIER=gate \
  -e E2E_AGENT_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY -e TMDB_API_KEY \
  -e KEYCLOAK_URL=http://localhost:8099 -e KEYCLOAK_REALM=grumpyrobot \
  -e KEYCLOAK_SERVICE_CLIENT_ID=mcm-bff-service -e KEYCLOAK_SERVICE_CLIENT_SECRET="$svc" \
  -e KEYCLOAK_CLIENT_ID=movie-collection-manager \
  -w /workspaces/mcm/frontend/mcm-app \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  node_modules/.bin/playwright test --project=chromium --reporter=line
```

Stacks were torn down (`down-mcm`, `down-auth`) **before** timing began, so `up-auth` and `up-mcm`
measure a real bring-up rather than a no-op against already-running stacks. Neither `down` target
passes `-v`, so named volumes and the seeded Keycloak realm survived.

---

## What the numbers mean, and the traps in them

### `docker-build` is 78% of the total, and it is I/O-bound, not CPU-bound

1024 s of the 1320 s total is one stage. It was stalled for ~12 minutes on a single step:

```text
#24 [runner 13/13] RUN addgroup -S mcm && adduser -S mcm -G mcm && chown -R mcm:mcm /app/runtime
```

The `chown -R` process sat in state **`D`** (uninterruptible sleep — blocked on I/O), accumulating
CPU at ~4.6% of one core. This is nested-overlayfs cost: **DinD overlay2 → Docker Desktop's WSL2
ext4 → Windows**, with every inode change paying the full stack.

**This is the single most interesting number for G6**, because it is exactly what the migration
should improve: the sandbox has *one less nesting level* and a native Linux filesystem. If the
migration is going to win anywhere, it is here — and if `docker-build` does **not** improve
substantially, that is a signal worth investigating rather than a result to absorb. Conversely, a
naive "a VM must be slower" expectation is not supported by this measurement.

### The integration tier passes 120/120 — and at least 9 of those tests did nothing

⚠️ **This directly affects T042**, whose Done-when is *"the tier passes with 0 skips"*.

Jest reports **`Tests: 120 passed, 120 total`** and exits 0. It reports **zero skips**. But the log
contains 14 `SKIP:` lines from tests that detect an unreachable dependency, `console.warn` a skip
message, and then **return successfully**:

| Soft-skipped because | Tests affected |
| --- | --- |
| `ollama not reachable at http://host.docker.internal:11434` | 4 |
| `OpenSearch unreachable` | 4 |
| `gateway not reachable at http://movie-assistant-gateway:8000` | 1 |

**Jest's skip counter cannot see these.** They are passes by construction. This is the repository's
own standing gate — *a skipped test reads as a pass unless something forces it to fail* — in its
natural habitat, and the obvious implementation of T042 would report success while nine tests did
nothing.

**T042 must therefore assert on `grep -c 'SKIP:'`, not on the jest skip count**, and compare that
count against this baseline of ≥9. Note also that if the sandbox makes any of these dependencies
*reachable*, more tests will actually execute and the 32 s figure will no longer be comparable —
that is a composition change, not a slowdown, and must be reported as such.

### The web-E2E failure is a workload-composition gap, not a regression

The one failing test is:

```text
assistant.spec.ts:78 › Assistant dock (feature 012) › sends a message and renders the
                       streamed AG-UI assistant reply
Test timeout of 90000ms exceeded — locator('[data-testid="assistant-msg-assistant"]') not found
```

It fails because **the agent stack was not running**. The bring-up sequence measured here (and the
one T041 specifies) is `up-auth` → `docker-build` → `up-mcm`; it does **not** include
`MODEL_PROVIDER=anthropic pnpm nx up-agents-prod`. With no gateway, the dock never receives a reply.

This is recorded rather than fixed, because **T048's comparison must use the same composition**. The
migrated run will have the same gap and the ratio stays honest. Do not "fix" the baseline by adding
the agent stack on one side only.

The **17 skipped** tests are Playwright-level skips within the gate tier and are likewise part of
the composition to reproduce.

### The Playwright pin failed the first run — loudly, which was luck

The first web-E2E attempt failed in 31 s with `rc=125`:

```text
Unable to find image 'mcr.microsoft.com/playwright:v1.62.1-noble' locally
dial tcp 150.171.70.10:443: i/o timeout
```

Two independent causes, both worth carrying forward:

1. **The pin moved and the cache did not.** The DinD engine held **only `v1.60.0-noble`** while the
   repo now resolves **1.62.1**. Using the authoritative pin produced a *loud* failure. Had the
   cached `v1.60.0-noble` tag been used instead, the failure would have been the silent variant —
   browser launch fails, **zero tests run**, and the gate reports `no Playwright summary found`
   rather than a count.
2. **`mcr.microsoft.com` was never in the egress allowlist.** It only ever worked because the image
   was already cached. This is now fixed — see the note in `.devcontainer/egress-allowlist.json`,
   and the T004 entry in `tasks.md`. Under the sandbox this would have been fatal rather than
   inconvenient, because the in-VM `iptables -P OUTPUT ACCEPT` escape does not exist when policy is
   enforced host-side.

The image was obtained via the runbook's documented cold-pull escape (relax egress → pull → re-apply
the firewall). The pull itself took **41 s** for ~3.4 GB.

---

## Sandbox disk envelope (G7) — **outstanding, owed by T018**

Not yet measurable: `sbx` is blocked (see `phase-0-host-prep.md` § Gotcha 2). To be recorded here:

| Field | Value |
| --- | --- |
| Host CPU / RAM totals | **20 logical cores / 31.8 GB** *(recorded — T002)* |
| Sandbox default sizing (as actually applied by `sbx`, not as inferred) | *pending T018* |
| Chosen sizing = `max(default, floor)` | *pending T018* |
| `df -h /` inside the VM | *pending T018* |

Reference point for the sizing decision: the Docker Desktop dev container ran this entire workload
within a **15.51 GiB** ceiling, so the 16 GB floor is genuine parity rather than a guess.

---

## Migrated measurements (T048) — to be completed

| Stage | Baseline | Migrated | Ratio | ≤1.5×? |
| --- | ---: | ---: | ---: | --- |
| `up-auth` | 43 s | | | |
| `docker-build mcm-app` | 1024 s | | | |
| `up-mcm` | 25 s | | | |
| integration tier | 32 s | | | |
| web E2E (gate) | 196 s | | | |
| **Total** | **1320 s** | | | |

A ratio > 1.5× is escalated **with the measurements**, not absorbed. Re-sizing is the first remedy;
abandonment is the last, and only with numbers behind it.
