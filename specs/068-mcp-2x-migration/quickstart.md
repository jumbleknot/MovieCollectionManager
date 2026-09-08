# Quickstart: validating the MCP 2.x migration

How to prove each phase works, and — as important — how to tell a real result from an instrument
lying to you. Read [research.md](./research.md) R0 first if you are about to claim anything is
"verified secure" from this dev container.

## Prerequisites

- `uv` on PATH (0.12.x), Node 24, pnpm enabled via corepack
- The four Python projects synced: `uv sync` in `agents/movie-assistant` and in each of the three
  `mcp-servers/*` directories. **A missing sync is what a "cannot scan this project" error usually
  means** — check for the absent input before concluding the environment cannot do the job
- For the live tiers, the local stacks up (see [local-dev.md](../../docs/runbooks/local-dev.md)) and
  the gitignored `.env.local` files present — `gen-dev-env.mjs` skips them silently if absent

---

## Phase 1 — pip-audit covers four surfaces

### Run it

```bash
pnpm nx sast infrastructure-as-code          # or: node scripts/sast-scan.mjs --scope full
node scripts/check-sast-findings.mjs         # the gate: exit 0 pass / 1 fail / 2 bad input
```

Reports land gitignored in `security/sast/reports/`.

### What proves it worked

```bash
# Four surfaces, not one — count the distinct project prefixes in pip-audit findings
python3 -c "
import json; d=json.load(open('security/sast/reports/findings.json'))
p=[f['location'].split(':')[0] for f in d['findings'] if f['scanner']=='pip-audit']
print('surfaces seen:', sorted(set(p)))"
```

**Read the scanner metadata, not just the finding count.** Zero findings is the expected result
here — all four projects measured clean on 2026-09-08 — and zero findings is exactly what a scanner
that never ran also produces:

```bash
python3 -c "
import json; d=json.load(open('security/sast/reports/findings.json'))
for s in d['scanners']: print(s['scanner'], 'ran=', s['ran'], 'n=', s['findingCount'], 'err=', s.get('error'))"
```

`ran: true` with `error: null` for `pip-audit` is the claim. Anything else is a scan that did not
happen.

### Guard tests

```bash
node --test scripts/__tests__/sast-scan.guard.test.mjs
```

> **Do not** write `node --test <file> --test-name-pattern "x"` — everything after the script path
> becomes the script's own `argv`, so the filter is ignored and the whole file runs while appearing
> to run one test. Node's flags go **before** the path, or use `--test` with a glob. This turns a
> Verify RED into a false green.

The new guards must be **seen to fail** before the code they constrain is written:

1. an unqualified `location` fails the format assertion
2. a `pip-audit` suppression entry naming an unknown surface fails, naming the entry (a **static**
   shape check — runtime "matched nothing this run" is feature 057's `selectUnmatched`, which is
   report-only and suppressed when the scanner found nothing)
3. a Python project on disk that is absent from the surface list fails the scan

### Local vs CI

The gate uses the OSV advisory feed. `api.osv.dev` does not resolve in this dev container
(R0), so a local run must use `-s pypi` and is **not** the same instrument. Its sensitivity was
validated — it reports `PYSEC-2026-2132` for `click 8.2.0` with the CVE and GHSA aliases — but CI's
run is the authority. Say which one you ran.

---

## Phase 2 — the SDK migration

### Re-measure the resolution first

Upstream published `mcp 2.2.0` **and** `mcp 1.30.0` on the same day, so R7's table is a snapshot.
Re-run it before trusting it — in a scratch copy, never in the repo:

```bash
# after bumping the bound to >=2,<3 in a scratch copy of each project
uv lock --upgrade-package mcp     # prints the added/removed/updated set
uv export --frozen --no-hashes --no-emit-project --format requirements.txt
```

Diff the export against the same command on `main` and confirm the delta matches R7. A surprise
package is a finding, not a detail.

### Per-project suites

```bash
pnpm nx test movie-assistant       && pnpm nx lint movie-assistant
pnpm nx test movie-mcp             && pnpm nx lint movie-mcp
pnpm nx test spreadsheet-mcp       && pnpm nx lint spreadsheet-mcp
pnpm nx test web-api-mcp           && pnpm nx lint web-api-mcp
pnpm nx run-many -t test:integration -p movie-mcp,web-api-mcp,movie-assistant
```

**Run `lint` as well as `test` for all four.** They are separate targets, and a Python lint tier that
was never run has hidden findings in this repository before.

### The tiers that actually gate

```bash
pnpm nx test:golden movie-assistant                    # cassette-backed model tier
E2E_TIER=gate pnpm nx e2e mcm-app                      # the blocking merge signal
```

`E2E_TIER=gate` runs everything except `@model-decision`. The `@model-decision` tier is
non-blocking and runs separately on `main` — do not read its result as a gate, and do not try to
select tiers with `--grep-invert`, which Playwright accepts here and silently ignores.

### Watch the skip count

`MCM_REQUIRE_LIVE_STACK=1`, `E2E_REQUIRE_AGENT_STACK=1` and `MCM_REQUIRE_LIVE_MODEL=1` turn a skip
into a failure. Without them a suite that skipped everything reads as a pass. Set them, and read the
SKIP COUNT before believing a green tick.

---

## Targeted checks for this feature's specific risks

### Credentials still ride, and still ride independently

The gateway integration tests against live `movie-mcp` and `web-api-mcp` are the real assertion
(contract §3, INV-6). Confirm both directions explicitly: a movie-server call carries a bearer and
**no** API key; an external-API call carries the key and **no** bearer. A test that only asserts the
positive case passes even if the transport started defaulting a stale credential onto every request.

### No 1.x field name survives

```bash
grep -rn "isError\|structuredContent\|inputSchema" --include=*.py agents/ mcp-servers/ | grep -v "/.venv/"
```

Expected after Phase 2: **no matches**. There are 15 today (SC-005).

### Every tool annotation is still precise

The guard from FR-018 covers this, but the one-liner is worth knowing — a bare `dict` return
silently drops structured content on 2.x:

```bash
python3 -c "
import ast
for s in ('movie-mcp','spreadsheet-mcp','web-api-mcp'):
    t=ast.parse(open(f'mcp-servers/{s}/src/server.py').read())
    for n in ast.walk(t):
        if isinstance(n,(ast.AsyncFunctionDef,ast.FunctionDef)) and any(
                isinstance(d,ast.Call) and getattr(d.func,'attr',None)=='tool' for d in n.decorator_list):
            r=ast.unparse(n.returns) if n.returns else 'NONE'
            print(('BARE ' if r in ('dict','list','Any','NONE') else '     '), s, n.name, '->', r)"
```

15 tools, none bare, as of 2026-09-08.

### Docker service-name hosts still resolve

The DNS-rebinding disable moved configuration point; the posture must not have changed. With the
stacks up, a tool call addressed to `movie-mcp:8000` (not `localhost`) must be served, not rejected
with a host mismatch. A unit test cannot show this — it needs the containerized run
([e2e-testing.md](../../docs/runbooks/e2e-testing.md), dev-container mode is the deterministic
baseline).

### Cross-version safety, if you need to bisect

R4 measured all four client/server version combinations as working, so the gateway and the servers
may be separate commits within Phase 2. If you split them, no additional interop check is needed —
but re-run the measurement if the SDK version moves off 2.2.0.
