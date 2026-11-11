# Runbook — OpenWiki knowledge-bundle maintenance

**Features 044 and 098.** How the OKF bundle at `openwiki/` is kept current. Since feature 098
(ADR-0004) that is the **coding session's** job, in the same PR as the change that made a summary
stale; the generator remains only as a **manual rebuild of pages an operator names**. Also: how to
run and read a rebuild, and where a new learning goes now that `CLAUDE.md` is an index.

Related: [ci-diagnostics.md](ci-diagnostics.md) · [devcontainer.md](devcontainer.md) ·
[ADR-0004](../decisions/ADR-0004-session-maintained-wiki.md) · `openwiki/INSTRUCTIONS.md` (the
generation brief) · `openwiki/policy.yaml` (the regeneration policy) · the
[`wiki-refresh` skill](../../.claude/skills/wiki-refresh/SKILL.md).

---

## Refresh

**Changing a file that is a derived page's `resource` means refreshing that page in the same PR.**
A *derived* page summarises exactly one file, named by its `resource:` front matter, and records that
file's fingerprint as `resource-sha256:` — the SHA-256 of the file as it sits in the working tree,
after CRLF→LF normalisation. A *canonical* page has no `resource`, is listed under `authoritative:` in
`openwiki/protected.yaml`, and is maintained by hand; nothing below applies to it.

```bash
node scripts/wiki-refresh.mjs --stale              # every derived page that is not fresh; exit 1 if any
node scripts/wiki-refresh.mjs --diff <page>        # the source's change since the page was last recorded
#   … edit only what that diff invalidates, following openwiki/INSTRUCTIONS.md …
node scripts/wiki-refresh.mjs --record <page>      # write resource-sha256 + timestamp; the body is untouched
```

`<page>` is `openwiki/runbooks/x.md` or `runbooks/x.md`. The tool is offline, free and model-free; it
rejects an unknown flag (exit 2) and `--help` only prints usage.

- **`--diff`'s base.** The newest commit whose bytes match the recorded fingerprint, searched back
  through `git log --follow`. A page with no fingerprint yet diffs from the newest source commit at or
  before its stamp (the newest of `generated.at` and `timestamp`), and says so on the `base:` line.
  With neither, it prints the whole file with a notice.
- **A fingerprint-only record is correct** when the diff changes nothing the page says — a reworded
  comment, a reformat, a fix in code the page does not describe. Record without editing the body; the
  reviewer sees exactly that. Of the 11 pages the cut-over refreshed, 8 were fingerprint-only.
- **Several pages can share a source.** `docs/MCM-Architecture.md` feeds `architecture/system-overview.md`,
  `projects/mc-service.md` and `projects/mcp-servers.md`; `--stale` names all three.
- **Never hand-type a hash.** Only `--record` writes `resource-sha256`.

### What the `okf` check enforces (V17, G14)

**V17** (`check-openwiki-okf.mjs`, the required `guardrails / okf` context) fails a derived page when:

| Finding | Fix |
|---|---|
| `no source fingerprint` — `resource-sha256` missing, or not 64 lowercase hex | refresh the page, then `--record` |
| `stale against <resource>` — the hash no longer matches the file | `--diff`, edit, `--record` |
| `its source <resource> no longer exists` | re-point `resource:` at the file that now holds the subject and `--record`, or retire the page |
| `is not a single file` — the `resource` is a directory | re-point it at one file, or make the page canonical |
| `forbidden field sources` / `verified` — retired with Claims | `--record` strips them |

`--stale` and V17 call the same function (`staleDerivedPages` in `scripts/openwiki-fingerprint.mjs`),
so the tool and the check cannot disagree. V17 replaced V12, the commit-date drift **warning**, which
never failed a build and so let drift accumulate on `main` between generator runs.

**G14** (`check-openwiki-governance.mjs`) fails a derived page whose `resource` is a directory, or a
file a bot rewrites: the files Renovate's default managers match (`package.json`, lockfiles,
`Cargo.toml`, `pyproject.toml`, Dockerfiles, compose files, `.forgejo/workflows/**`, `renovate.json`,
toolchain pins), CD's `**/.env.deploy`, and every `managerFilePatterns` entry in `renovate.json`'s
`customManagers`, read at check time. Otherwise a bot's PR would go red on V17 with no session there to
refresh the page. Cite the human-written document that explains the subject instead.

### What was retired, and why

Feature 098 (ADR-0004) retired the unattended machinery and openwiki's own bookkeeping. **Deleted
and gitignored**: `openwiki/.claims/` (the Claims sidecars), `openwiki/.page-manifest.json`,
`openwiki/.last-update.json` and the run record `openwiki/.maintenance-state.json`; the `sources:` and
`verified:` front-matter fields. **Checks removed**: V16 (Claims durability), V12 (drift warning, now
V17) and G13 (Claims only on derived pages). **Code removed**: range planning and the run marker, the
backlog, low-effort escalation, refresh cooldowns, drift re-planning and parking, the quiet-trigger
(`wiki-quiet.mjs`), the Claims audit and `.openwikiignore`. The measured progression that led here —
$167.80 over 106 runs in 30 days for 39 distinct pages, and run 5104 paying ~$1.44 for one landed page
— is ADR-0004 §2.

`openwiki/policy.yaml`'s `openwiki/**` entry is `actor: [agent, generator]`: sessions write the
bundle routinely, and the generator writes on a manual rebuild. G3 still confines `generator` to
`openwiki/`.

---

## 1. A manual rebuild of named pages

Use a rebuild when a page needs **regenerating**, not refreshing: a new page, or one so far behind
its source that a hand refresh would be a rewrite. It is **paid** and operator-only.

**In CI**: dispatch `wiki-maintain` (Actions → *wiki-maintain* → Run workflow) with the required
**`pages`** input, a comma-separated list of `area/page.md`:

```text
pages: runbooks/renovate.md,projects/sast.md
```

**Locally**:

```bash
pnpm nx wiki-maintain infrastructure-as-code --args="--pages runbooks/renovate.md,projects/sast.md --dry-run"
pnpm nx wiki-maintain infrastructure-as-code --args="--pages runbooks/renovate.md"   # PAID (§1a)
```

The named pages are grouped into one slice per area, and each slice's run message carries the pages it
asks for. Before anything is spent the run **refuses** (exit 2) an empty list, a page that does not
exist, and a canonical page (a rebuild has nothing to rebuild it *from*). Every page that lands gets a
current `resource-sha256` and loses any `sources:`/`verified:` openwiki wrote, so it passes V17. The
report lists `landed:` and `not landed:`; nothing is written outside the bundle, and no run state is
kept between rebuilds.

| Flag | Use |
|---|---|
| `--pages <area/page.md,…>` | The pages to rebuild. Required |
| `--dry-run` | Print the exact command per slice and invoke **nothing** |
| `--propose` | Push the result to the proposal branch and open or update its PR (CI sets this) |
| `--json` | Machine-readable output |

### 1a. Which model writes the bundle (feature 078)

The provider is **configuration**, not code. `scripts/wiki-provider.mjs` is the single table:

| `MCM_WIKI_PROVIDER` | Model | Key (first non-empty; mapped at the point of use) |
|---|---|---|
| `anthropic` — the **local** default (unset) | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, `MCM_ANTHROPIC_API_KEY` |
| `fireworks` — the **CI** default (the workflow sets it, at page concurrency 4) | `accounts/fireworks/models/deepseek-v4p1-flash` | `FIREWORKS_API_KEY`, `MCM_FIREWORKS_API_KEY` |

Three more knobs, all validated before any paid call — a malformed value exits 2, it is never read as
a default; an empty value is unset (how an Actions repository variable that was never set arrives):

- `MCM_WIKI_PAGE_CONCURRENCY` (1–8, default 1) — openwiki ≥ 0.6.0 writes that many pages in parallel.
  DeepSeek's wall-clock gap to Sonnet (~3.4×) is **call count**, not latency (078 research R3), so
  concurrency is the lever that closes it.
- `MCM_WIKI_SERVICE_TIER=priority` (Fireworks only) — +25% price. Measured on this workload it bought
  **no** speed (R3), so it is not the default.
- `MCM_WIKI_REASONING_EFFORT` (Fireworks only: `none`, `low`, `high`, `max`; unset = the model's own
  default, `high`) — sent as `reasoning_effort` by the usage tap, because openwiki 0.6.0 refuses an effort
  for its `fireworks` provider. The preflight sends it too, so a value Fireworks rejects fails before paid
  work. A run's usage line and record carry `effort=<value>` when it is set. **Under trial** (item #525):
  latency is roughly output tokens ÷ generation speed, and a lower effort means fewer reasoning tokens
  per call — but possibly a weaker page. In CI it is the `reasoning-effort` input of a dispatch, applied to
  every invocation of that run; do not set the repository variable until a trial's page has been reviewed.

**In CI** these are repository **variables** (Settings → Actions → Variables), so switching back to
Anthropic is a settings change, not a commit; the keys are the secrets `ANTHROPIC_API_WIKI_MAINTAIN`
and `FIREWORKS_API_WIKI_MAINTAIN`. **Locally**, export the variables and run the Nx target as usual; the
dev container carries `MCM_FIREWORKS_API_KEY` from `~/.mcm-sandbox-env`.

**Why the Nx target names no provider.** nx builds a target's child env as
`{ ...process.env, ...targetEnv }` — a provider in the target's `env` would silently overwrite the
job's choice (078 research R4). The target runs `scripts/wiki-generate.mjs`, which resolves the table,
gives the generator **only** the selected provider's key, and passes `WIKI_RUN_MESSAGE` as one argv
element with no shell.

**Preflight.** Before the first paid slice, a rebuild makes one minimal call to the
selected model (`node scripts/wiki-generate.mjs --preflight` does the same by hand). A failure exits
**2** with nothing spent beyond that call, and names the provider's error type — a withdrawn model id, a revoked
key or a blocked egress host costs one token, not a slice.


### Sizing a rebuild, and why the message must carry the SUBJECT

A rebuild sends one slice per area, and every invocation pays a fixed planning pass (~$0.33 on Sonnet,
83% of a one-page run, feature 078), so a page is cheapest rebuilt alongside others **in its area** —
but keep the whole dispatch to a few pages (§2). Creation is dearer than a rebuild of an accurate page,
which needs no per-page source investigation.

More important than the count: **a filename is not a specification.** Given only
`gotchas/session-lifecycle-and-eviction.md`, the generator spends its whole budget working out what
that page should say — three runs died mid-research, one of them after printing *"Now I have enough
evidence for all 8 pages"*, having written nothing in 643 seconds. Where a subject is known, the run message carries a
one-line **subject** per page. That single change was the difference between **0 pages in 643s** and
**3 pages in 367s**.

### Why the generator used to write nothing half the time — and what to check if it starts again

Through feature 044 roughly **half** of single invocations produced nothing, exited 0, and were
reported by Nx as success. That was recorded here as the generator being *non-deterministic*. **It was
not.** The cause, found on 2026-08-01, was a fixed and silent per-turn output-token ceiling:

- OpenWiki never sets `maxTokens`, so `@langchain/anthropic` picks a default by prefix-matching the
  model id against a hard-coded table, **falling back to 4096** on a miss.
- `claude-sonnet-5`, which the `wiki-update` target pinned at the time (feature 043), was **absent
  from that table**. Every turn was capped at 4096 output tokens.
- A turn truncated at the cap *before* it opens a `tool_use` block yields an assistant message with
  **zero tool calls** — precisely LangGraph's ReAct stop condition. The graph exits cleanly, OpenWiki
  exits 0, Nx prints `Successfully ran target`, and no page is written.
- Nothing reports this. OpenWiki never inspects `stop_reason`; Nx sees exit 0; the verifier can say a
  page is missing but never why.

Measured on the wire at turn 25 of a real run: `stop_reason=max_tokens`, `output_tokens=4096`, no tool
call. Full write-up and reproduction steps:
[`HANDOFF-generator-reliability-ANSWER.md`](../../specs/044-openwiki-automation-migration/HANDOFF-generator-reliability-ANSWER.md).

**Fixed upstream at 0.5.2, and still pinned here anyway.** OpenWiki now supplies an explicit
`maxTokens` of its own — `resolveAnthropicMaxOutputTokens` returns 16384 for any
`claude-(haiku|sonnet|opus)-(4|5)` id — and `@langchain/anthropic`'s table has since grown a
`claude-sonnet-5` entry, so both layers that failed now hold. That is exactly why the target does
**not** rely on either: the fix is invisible at runtime, a model rename or a vendor change would undo
it in one line, and the symptom is a green build with an empty diff. `wiki-update` therefore sets
**`OPENWIKI_MAX_OUTPUT_TOKENS=16384`** explicitly, which OpenWiki reads ahead of everything else — so
that value, not any vendor table, is the one that reaches the model. The model is pinned at
**`claude-sonnet-5`** (`OPENWIKI_MODEL_ID` in `infrastructure-as-code/project.json`).

**The target's 16384 is a floor; a provider may raise it (item #719).** On Fireworks, DeepSeek V4.1 Flash
reasons inside its output budget, and a page worker that writes a whole page in one `write_file` turn can
need more than 16384. Dispatch 5115 (2026-10-11) measured exactly that: `runbooks/wiki-maintenance.md`
ended both attempts with `finish: length` at `output: 16384` (5,891 reasoning tokens plus about 10.5k of page
text) before the tool call, which openwiki reports as "exited without submitting". The 2026-08 4096 defect
recurred at a higher cap. The `fireworks` row in `scripts/wiki-provider.mjs` therefore sets
`maxOutputTokens: 65536`, and the launcher raises `OPENWIKI_MAX_OUTPUT_TOKENS` to it, never lowering an explicit
higher value. The `anthropic` row has no raise: the Anthropic TypeScript SDK refuses a **non-streaming** request
whose `max_tokens` implies more than ten minutes (about 21k), so a higher global cap could break that provider
outright. Output tokens are billed only when generated, so the raise costs nothing on turns that do not need it.
The worker trail (§2, "What a run cost") shows a truncated turn as `length[]`.

**The pin has made a round trip, and both moves were deliberate.** Feature 043 (2026-07-27) pinned
`claude-sonnet-5`. The 2026-08-01 fix above moved it to `claude-sonnet-4-6` — an id the vendor table
*did* match, which was the only way to escape the 4096 fallback before an explicit cap existed.
Feature 075 (2026-09-21) moved it back to `claude-sonnet-5`, which is safe now because the explicit
`OPENWIKI_MAX_OUTPUT_TOKENS` no longer depends on any table. A reference to `claude-sonnet-4-6` in an
older document or commit is that middle period, not a conflicting pin.

**Why that model** (feature 075, 2026-09-21). The move back is purely a cost one: same vendor, same credential, same workflow, same Deep Agents caching middleware
— only the id changes. Sonnet 5 lists at $2/$10 per MTok against Sonnet 4.6's $3/$15, with cache
reads at $0.20/MTok against $0.30. Generation is the single largest line on the model bill (53% of
$74.89 over the 30 days to 2026-09-20) and is already ~92% cache reads, so list *input* price is the
wrong number to compare and the cached-read rate is the one that decides: a straight ≈−33%, from
≈$1.72 to ≈$1.15 per run-day, at no quality risk.

Two things to know before changing it again:

- **Run the guard first, and read the SKIP COUNT, not just the exit code.** Two of its four cap
  assertions skip when OpenWiki is absent from `/usr/local/lib/node_modules`, and a skip reads as a
  pass. The `claude-sonnet-5` bump was verified at 20 passed / 0 failed / **0 skipped**.
- **Verifying a generator version bump before the image carries it**: bump the locked install first
  (§4, *How the generator's dependencies are pinned*) — it is a side install by construction, so the
  container's global copy that other sessions are using is never touched — and run the guard with
  `OPENWIKI_ROOT=$PWD/tools/openwiki-generator/node_modules/openwiki`. The installed-generator
  assertions then read the new version instead of skipping; count them.
- **On every generator bump, re-check the gaps we work around.** The table is in
  [`specs/078-wiki-generator-cost/research.md`](../../specs/078-wiki-generator-cost/research.md) R15: request-body
  options (`service_tier`), reasoning effort for `fireworks`, local token usage, and the managed `AGENTS.md`
  block. For each, the table says which file to grep and which upstream issue or PR to watch. If a gap has
  closed, retire that part of `scripts/wiki-usage-tap.mjs` or the R12 guard in the same change, and update R15.
- **OpenWiki sends no `temperature`**, which is why this bump was safe where the agent gateway's was
  not. Sonnet 5 and Opus 5 reject that parameter with a 400 and the gateway was sending it
  unconditionally — see [`specs/075-llm-cost-phase-1/research.md`](../../specs/075-llm-cost-phase-1/research.md)
  R13. A model id is only a drop-in for the parameters the caller actually sends; if a future
  OpenWiki release starts sending sampling parameters, re-check that before bumping again.

`scripts/__tests__/wiki-maintain.guard.test.mjs` now asserts all three: that the explicit cap is set
and large enough, that OpenWiki's own resolver still matches the pinned id, and that the id would not
land on the 4096 fallback if the explicit cap were removed. **If you change `OPENWIKI_MODEL_ID` or
`OPENWIKI_MAX_OUTPUT_TOKENS`, run that guard.**

**If zero-page runs return, do not add a fourth retry attempt — measure the wire.** Point
`ANTHROPIC_BASE_URL` at a pass-through proxy that logs each response's `stop_reason` and
`output_tokens`; that is how this was found, and it is the only place the truth is visible.


#### The retry that remains

A slice is attempted up to **3 times within one run** before its pages are reported `not landed`. This covers
the ordinary residual variance of a model doing open-ended work. Note that retrying is close to
*useless* against a ceiling like the one above — every attempt runs into the same wall, and the
apparent independence of attempts is an illusion — so a persistent failure rate is evidence to
investigate, not a number to raise the attempt count against. Retries are bounded by the job deadline
like everything else, and the attempt count is always reported:

```
[wiki-maintain] ✅ runbooks/ — 1 page(s) written and verified after 2 attempts
```

A `✗` line likewise says `after 3 attempt(s)`, so a slice that is genuinely unsatisfiable still looks
different from one that was merely unlucky.

**A rate-limited attempt waits instead of retrying at once (item #683).** A failed attempt where at least **half** of
its calls answered HTTP **429** is recognised from the usage tap's per-call `status` (never from the generator's text);
a stray 429 that the SDK's own retry absorbed inside a working attempt does not count. The retry then waits
**60 s** (120 s before a third attempt), but only while it would still leave the generator its 5 minutes before the job
deadline; otherwise the attempt is **not** retried. Run 4798 (2026-10-06)
had retried straight into an active 429 three times in 29 seconds and reported it as an ordinary "produced nothing".
Either way it is named: a `RATE-LIMITED (N call(s) answered HTTP 429)` line at the attempt, a `RATE-LIMITED` line under
the `✗`, and `rateLimited: {attempts, calls}` on the result in `--json` output. An attempt that produced
nothing **without** a 429 still retries immediately.

**A retry can never forgive what an earlier attempt did.** The working tree is snapshotted once,
before the first attempt, so a forbidden write on attempt 1 still fails the slice even if attempt 2
behaves. Re-snapshotting per attempt was tried and it laundered a policy violation into a success —
the existing policy-guard tests caught it immediately.


Investigate when the *same* page fails across several dispatches, or when a failure names something
other than missing pages — a conformance regression or a policy violation is a real defect, not a
flaky generator.

### Why never the bare CLI

Always go through the Nx target. `openwiki` invoked directly skips `OPENWIKI_TELEMETRY_DISABLED=1`
and the raised Node heap, **and OOMs**. `wiki-maintain` shells out to `pnpm nx wiki-update
infrastructure-as-code` for exactly this reason, and a unit test asserts no code path calls the CLI
directly.

> **Nx `--args` is appended to a shell command line unquoted.** Measured: `--args="--x=one two"`
> arrives as two separate arguments. That is why the generated run message is a single line with no
> backticks, `$`, or quotes — a markdown-formatted message would be command-substituted, and the
> generator would scope itself to the first word.

---

## 2. What the exit codes mean

| Code | Meaning | Is something wrong? |
|---|---|---|
| `0` | Every named page landed and verified (or `--dry-run`, or a selftest that passed) | No |
| `1` | A named page **did not land** — missing or left stale, the bundle became non-conformant, a write landed where policy forbids it (§3), or the proposal could not be published | **Yes** — the report's `not landed:` list says which |
| `2` | Bad usage (including an empty, unknown or canonical page), a missing credential, a malformed `MCM_WIKI_*` value, or a failed preflight. Nothing was spent | **Yes** |

There is no exit 3 any more: it meant "stopped at the budget with work in the backlog", and there is no
backlog. A page the job deadline kept from starting is `not landed`; dispatch it again.

### The job deadline, and how big a rebuild should be

The workflow's first step records `WIKI_JOB_DEADLINE`; each generator invocation runs under GNU
`timeout` with the time left minus an 8-minute reserve for verification and publishing, and an
invocation with under 5 minutes left is not started. A deadline stop does **not** by itself fail the
page: after `revertUnrequested` (§4), the page is judged like any other, by what landed. `timeout`
signals the whole process group, which matters because nx starts openwiki as a grandchild; that holds
while nx uses no pseudo-terminal, which it does only when stdout is a TTY — never in CI.

**Name few pages per dispatch** (item #613, measured over the 85 single-invocation runs from
2026-10-08): no invocation of 5 or more pages ever ended on its own.

| Pages in the invocation | Runs | Stopped at the job deadline |
|---|---|---|
| 1–2 | 59 | 22 (37 %) |
| 3–4 | 13 | 6 (46 %) |
| 5–8 | 13 | 9 (69 %) |

Sizing by the cited sources' line count was measured and rejected: across the 35 invocations that
ended on their own it correlates with duration at 0.39, no better than page count (0.37). The same page
varies up to 4.3× from run to run (`runbooks/server-setup.md` took 689, 1912 and 2958 s). A page with no
prior coverage needs about 1.65× the output per call and over 1.6× the calls; rebuild those **one per
dispatch**.

**Why a run hung for an hour (2026-09-30).** For an OpenAI-compatible provider (Fireworks) openwiki sets
no request timeout, so the OpenAI SDK's **10-minute** default applies, and at page concurrency above 1
openwiki retries **5** times: one model request accepted and never answered was about 60 silent
minutes. The generator's environment sets `OPENWIKI_PROVIDER_RETRY_ATTEMPTS=2` (an explicit operator
value wins), bounding that at about 30 minutes; the deadline bounds the rest. If a run is ever killed at
`timeout-minutes` anyway, the deadline arithmetic is wrong: re-measure before raising the timeout,
which is a decision about the shared runner.

**Nothing here is a monetary bound.** A run records an estimate of what it cost (below), but that is a
measurement, not a limit. The deadline bounds *runner occupancy* — there is one CI runner, and
`app-e2e` is ~35 minutes on it.

### What a run cost (feature 078)

OpenWiki reports no usage itself, so `scripts/wiki-usage-tap.mjs` is loaded into the generator process
and records per-call **counts** (never content). Each invocation's counts are priced from
`scripts/wiki-provider-prices.json` — a dated table; update `asOf` with every change — and the run total
lands in the job log:

```text
[wiki-maintain] usage runbooks/: 47 call(s), 183838 uncached / 2801438 cached / 43117 output tokens, ~$0.0883 (fireworks, prices 2026-09-27)
[wiki-maintain] run usage: ~$0.0883 over 47 call(s) in 1 invocation(s), fireworks, prices 2026-09-27
```

It is an **estimate** (it reconciled with the Fireworks bill to the cent on the 078 research probes).
`not captured` means the tap produced nothing — it is never written as $0. A line saying
`PARTIAL total` means some invocations were not captured. `failedCalls` counts non-200 responses:
rate limiting under page concurrency shows up there first.

**The per-call lines themselves are kept in the evidence bundle (item #682), and each names its page
(item #719).** In CI, each invocation's tap lines are appended to the job's step log `wiki-usage.log`,
under a `# invocation pages=… effort=…` header, so they arrive in `ci-failures:<runId>--maintain` as
`step:wiki-usage` (`node scripts/ci-status.mjs failure --run <id> --full`; a dispatched run posts no commit
status, so fetch `…/generic/ci-failures/<runId>--maintain/bundle.json.gz` from the package list instead).
Until 2026-10-10 only the sum survived — run 4960 failed after 447 calls with nothing finer to read.

Four page workers run concurrently, so a line is useful only if it says whose call it was. A page worker's
line carries `page` (the bundle path openwiki names in the worker's prompt, "You own exactly /openwiki/…"),
`finish` (the response's finish or stop reason, from a fixed set, else `other`), `tools` (the names of the
tools it called — only names the request declared, else `undeclared`) and `badArgs` (how many of those
calls' arguments do not parse as JSON). Still no content: no prompt, response, argument or error text.
`uncached + cached` is the prompt size; prompts of 170–260k tokens are routine, so prompt size alone has
not explained a failure (#719).

For every page that did not land, the run prints the worker's trail to the job log:

```text
[wiki-maintain] worker trail runbooks/renovate.md: 61 call(s), max prompt 241113, never called submit_page — last: tool_calls[write_file] → tool_calls[read_file] → stop[]
```

That tells apart the three ways a worker ends without submitting: a truncated turn (`length`), a turn
that simply stopped with no tool call (`stop[]`), and a tool call whose arguments do not parse (`✗args`) —
an error openwiki 0.7.1 swallows into the same "exited without submitting" outcome
(`runPageWorkerAttempt`). The figures in the example are illustrative. Counts, status, timing and those
identifiers only; nothing is written outside CI.

---

## 3. Reading a failure

A slice fails when **any** of four things is true, and the generator's exit status is not one of them:

1. **A requested page does not exist after the run.** The contract is the pages the slice
   *requested*, not "some page appeared": a run that wrote unrelated pages while ignoring the request
   fails, and an `index.md` alone counts as zero pages — feature 043's false-green run was 12 minutes
   of paid work, one `index.md`, exit 0, reported as success. Writing **nothing** is not by itself a
   failure: a refresh whose requested pages all exist and none is stale (cause 4) passes as
   `✅ … nothing needed changing (0 written)`.
2. **The bundle stopped being conformant** (`check-openwiki-okf.mjs`, rules V1–V15 and V17). The
   rebuild records each landed page's source fingerprint before this check runs, so V17 fails only a
   page the run left stale — or one it was not asked for.
3. **A written path was not permitted** by `openwiki/policy.yaml` — including a write into
   `docs/runbooks/`, which is `regenerate` but governed by an *agent*, not the generator.
4. **A requested page is still stale after the run** (items #587, #616): a named page left unwritten,
   or changed only in front matter, is named in the failure one page at a time — **whether or not the
   run changed the file**. A multi-page slice does not pass because *some* of its pages were written.
   Writing nothing is still honest for a page whose source has not moved: that is the
   `✅ … nothing needed changing` line, not a failure.

A page that did not land is listed under `not landed:`; nothing is carried to a later run, so
dispatch it again once the cause is fixed.

### In CI

```bash
node scripts/ci-status.mjs status --branch main       # is anything red?
node scripts/ci-status.mjs failure --pr <n> --full    # the published digest + evidence bundle
```

`wiki-maintain` publishes a feature-042 failure digest like every other job, so a failure is
diagnosable without touching the runner host. It is **not** a required context and never gates a
merge.

### Remediation — the one rule

**Fix `openwiki/INSTRUCTIONS.md` and re-run. Never allowlist rejected content.** If a page trips the
conformance gate, a leak scan, or the governance gate, the brief is the surface that changes; the
gates have no skip flag and no allowlist by design, because an allowlisted leak stays leaked.

---

## 4. What CI does

**Manual dispatch only.** `.forgejo/workflows/wiki-maintain.yml` has no schedule and no push trigger:
the daily schedule (078 US7) was removed on 2026-11-10 (PR #980), and with it the quiet-trigger, the
run-record marker commit and the record merge (feature 098). A dispatch checks out `main`, installs
the locked generator (below), rebuilds the pages in its `pages` input, and proposes what landed.

**Under a dispatch, read nothing from the event payload except the inputs.** Owner and repo come from
`GITHUB_REPOSITORY`; setting `FORGE_REPO` from `github.event.repository` made every scheduled fire fail
at the forge client (runs 6539–6569), and a guard test still fails on any other `github.event.*` read.
Each input is checked against a fixed character class before it reaches a shell.

**Runs never overlap.** `cancel-in-progress` is `false`, so a second dispatch queues behind the first.
Both continue the one open proposal (below), so the later one appends to it.

### How the generator's dependencies are pinned, and how they are bumped

The CI runner has no generator baked in, so the job installs one — **from a committed lockfile,
never resolved at run time** (item #704). `tools/openwiki-generator/` holds three exact pins
(`openwiki`, and its optional Mermaid peers `mermaid` and `jsdom` — see *Diagrams need their parser*
below) and the `pnpm-lock.yaml` for the whole tree. The job runs
`pnpm --dir tools/openwiki-generator install --frozen-lockfile`, puts that directory's
`node_modules/.bin` on `PATH`, and its verify step fails unless `command -v openwiki` resolves there.

Why: the step used to be `npm install -g openwiki@0.7.1 mermaid jsdom`. Only `openwiki` was pinned;
its transitive tree (`openai`, `deepagents`, `langsmith`, …) and `mermaid`/`jsdom` resolved to whatever
was newest at run time. Run 4950 (2026-10-09) died 404-ing on `openai@7.32.0`, resolved two minutes
after it was published, and the same gap let a minutes-old package run with the generator's model
credential in its environment. Two runs a day apart could also run different generator code with no
diff in this repository, which confounds every cost and reliability comparison.

**The cooldown.** The directory is its **own** pnpm workspace root — its own `pnpm-workspace.yaml`,
outside the root workspace's `frontend/*` and `packages/*` globs — so the root's settings (which
deliberately set no cooldown) do not apply and its own do. It sets `minimumReleaseAge: 4320` (three
days, Renovate's catch-all), which pnpm enforces twice:

- **At resolve time**, so a lockfile regeneration — Renovate's or yours — cannot pick a transitive
  younger than three days. This is the gap item #271 describes for the root workspace (Renovate's
  cooldown covers what it *proposes*, not what a lockfile regeneration drags in), closed for this
  directory. Measured on the first lock: `openai` resolved to 7.30.0, not 7.31.0 or 7.32.0.
- **At install time**: a frozen install verifies every locked entry against the policy and fails
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` ("The lockfile contains entries that the active policies
  reject") rather than install one inside the window.

`minimumReleaseAgeExclude` is reserved for **security-floor exceptions**, because the code runs with a
model credential. Each entry is one exact `name@x.y.z` that an `overrides:` floor in the same file
requires, so it admits that version and nothing else, and it becomes moot once the version clears the
window. The guard fails a name-only or ranged entry, or one with no matching floor. There is no entry
today. The only one so far, `@azure/identity@4.14.1` (an operator override of the cooldown on 2026-11-01, for
GHSA-xcx6-jx8p-x3h5: it is the first release requiring `@azure/msal-node` ^7.1.0), was removed on
2026-11-02 after it cleared the window at 2026-11-01 22:16 UTC. Its `overrides:` floor
(`'@azure/identity@<4.14.1': '>=4.14.1 <5'`) stays, because the floor is the fix and the exclusion only
let it in early. Never add one
because a fresh transitive is blocking a branch: wait the window out instead. `better-sqlite3` is the one package allowed to run
an install script (`allowBuilds`) — openwiki's LangGraph checkpointer loads its native binding at
runtime, and it ran under the old `npm install -g` too.

**Checking the guard yourself** (the live half of the proof; the static half is
`scripts/__tests__/wiki-maintain.guard.test.mjs`, which fails a cooldown under three days, an
exclusion that is not an exact, floor-backed version, a range instead of an exact pin, a lockfile that disagrees with the manifest, or any
run-time resolution in the workflow). Copy the three files somewhere scratch, raise the window past
the age of the lock, and install frozen — **from the repository root**, with `--dir`, so corepack
picks this repository's pnpm; run from inside the scratch directory it picks whatever pnpm is
newest, which is a different instrument:

```bash
d=$(mktemp -d) && cp tools/openwiki-generator/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml} "$d"/
sed -i 's/minimumReleaseAge: .*/minimumReleaseAge: 525600/' "$d/pnpm-workspace.yaml"
CI=true pnpm --dir "$d" install --frozen-lockfile; echo "exit=$?"   # expect exit=1 and the violation list
```

On 2026-10-10 that exited 1 with `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 203 lockfile entries
failed verification`; the same install with the committed window succeeds.

**Bumping.** Renovate manages it: the manifest and the dev container's
`npm install -g openwiki@<v>` (a `customManagers` regex entry) are grouped as `openwiki generator`, so
both openwiki halves move in one PR — `wiki-maintain.guard.test.mjs` fails if they differ. To bump by
hand, from the repository root:

```bash
pnpm --dir tools/openwiki-generator add openwiki@<v> --save-exact   # or mermaid / jsdom
# then edit .devcontainer/toolchain.Dockerfile's `npm install -g openwiki@<v>` to the same version
OPENWIKI_ROOT=$PWD/tools/openwiki-generator/node_modules/openwiki \
  node --test --test-reporter=tap scripts/__tests__/wiki-maintain.guard.test.mjs   # 0 failed, 0 skipped
```

A refresh of the transitive tree within the existing pins is
`pnpm --dir tools/openwiki-generator update`; the cooldown still applies. Either way, a bump changes
what writes the bundle: check `node scripts/wiki-maintain.mjs --selftest`, re-check the R15 gaps in
§1, and review one dispatched run before merging.
The dev container's global copy is still resolved fresh **at image build**, which is rebuilt rarely
and never holds a CI credential. Local runs use it by default; put
`tools/openwiki-generator/node_modules/.bin` first on `PATH` to run the locked tree locally instead.


### The proposal

One long-lived branch (`openwiki-maintenance`), one open pull request, **ever**. A run that finds it
open **continues the remote branch, rebases and appends** rather than opening a second — so a commit
you push onto that branch survives every subsequent update. It is **never auto-merged**: a human
reviews every wiki diff, and the proposal is gated by the normal guardrails like any hand-authored
change, V17 included.

**A reviewer may correct a page in place.** Edit it, then `node scripts/wiki-refresh.mjs --record
<page>` in the same commit. (Until feature 098 a hand edit of a Claims-covered page made openwiki refuse
every later run; that bookkeeping is gone.)

**The forge is the only state.** Which proposal is open is asked of the forge on every run, never
remembered: a run adopts the open PR for the branch and updates it, and a `POST /pulls → 409` is handled
by adopting the existing one rather than failing. (The run record used to cache the pointer; it was
lost once in a push race and the next run tried to open a second proposal.) Closing the proposal
without merging simply discards it; dispatch the pages again if they are still wanted.

**G11 on a page that was valid on `main` (item #777).** Symptom: `guardrails / okf` and `naming` fail with
`(G11) … is NEITHER derived nor authoritative` on a page that `main` cites a `resource` for, and its header now
reads `type: "Reference"`, a double-quoted `title`, and `openwiki_generated: true`, with no `resource`, `description`
or `tags`. Cause: the model wrote front matter that did not parse as YAML, and openwiki 0.7.1 rebuilt a minimal header
in its place without telling the agent (`repairOkfFrontmatter` → `rebuildMinimalConcept`). It hit #775, #791 and
#857. Since 2026-11-01 `verifySlice` restores `type`, `description`, `resource` and `tags` from `HEAD` on any page
carrying that marker, so this should no longer reach a proposal; the run log says `restored … from HEAD in <page>`.
If it still does, the page lost its keys **without** the marker. That was the model's own edit, and the governance
gate refuses it in the run. To fix it by hand, restore its header from `main` and `--record` it.

The runner is a fresh checkout, so the branch exists there only on the remote; the run checks it out
from there, and only while its proposal is **open** (a closed one's commits are not revived). Until 2026-09-28 it
looked only for a *local* branch, found none on every CI run, started from `main`, and the `--force-with-lease`
push replaced the open proposal — measured on proposal #594. The push now also refuses outright
(`pushing would discard N commit(s) from open proposal`) if the open proposal holds a commit the new head does not:
a red run, never a silent overwrite.

**When a proposal is created or updated.** Whenever any named page landed, including on a run where
another page did not (exit 1).

**Landing is judged per page, and a page that failed is put back before anything is proposed (items #685, #720).**
When a failure is attributable to particular pages — a named page missing, or still stale after the run — while
conformance and policy are clean, `verifySlice` splits every part by page: `failedPages` names the pages that did
not land, and every other named page, area-mates of a failed page included, is proposed. A failed page's file is
restored to its committed bytes first, so it cannot ride along on the proposal (#684, run 4801: the proposal stages
the whole working tree). A **whole-invocation** failure (conformance or policy) proposes nothing. Run 5010
(2026-10-10) set this shape: `runbooks/devcontainer-sandbox.md` exited without submitting, and the completed
`runbooks/ci-evidence-pipeline.md` and `runbooks/sast-scanning.md` were thrown away with it.

The area's `index.md` is not restored: it lists the failed page and its landed area-mates alike, so the proposed tree
still passes V9. Left alone, and so still possible on a proposal: a failed page that was dirty **before** the
invocation (its prior bytes are not in git), and an **untracked** new page (it has no committed state, and deleting it
would orphan its index link). Review those as such.

**A slice keeps only what it was asked for.** A generator stopped part-way (GNU `timeout` exit 124, or
137 after `--kill-after`) can leave a page it was never asked for half-written; on run 4606 (2026-10-04)
that broke conformance on `projects/keycloak.md`, a whole-invocation failure, and the requested page's
$0.96 regeneration was lost. `revertUnrequested` therefore restores every bundle path a **stopped** run
changed to its committed state (or deletes it if new), **except** the named pages and their areas'
`index.md`. After a run that exits **on its own**, it puts back any unrequested concept page the policy
lets the generator write — a rebuild proposes only what it was asked for, and openwiki no longer forces
pages in through stale Claims — but leaves a **forbidden** write in place, so verification still fails on
it. Paths that were dirty before the run are left alone either way.

---

## 5. Where a new learning goes

**The canonical home of its subject**, determined mechanically from the bundle:

1. Find the concept covering the subject (query by `type`/`tags`, or read the area's `index.md`).
2. **Does it carry a `resource`?**
   - **Yes** → it is a *derived summary*. Write the learning into the **cited source** — the runbook,
     the decision record, the architecture document — **and refresh the summary in the same PR**
     ([Refresh](#refresh)).
   - **No** → it is *authoritative*. Write the learning **into the concept**; there is no upstream
     document to write into.
3. **No concept covers it?** Add one, and where the subject has a canonical document, write the detail
   there and cite it. A new derived page is `--record`ed like any other.

So an operational learning belongs in the runbook, **not** in the page summarizing the runbook. A
concept that becomes a copy of its source has failed the generation brief.

A page states rules and what fields mean, never the current contents of live state; a copied value is
wrong by the next change (`openwiki/INSTRUCTIONS.md` §9). A measured value that explains a rule belongs
here, in the runbook, dated and with its run number.

**Do not write prose into `CLAUDE.md`** expecting a later run to relocate it. That file is an index and
a gate fails on content beyond its index and its three machine-managed regions. The rejected
alternative — grow the instruction file and clean up later — is recorded in `INSTRUCTIONS.md` §7.

### Protected passages

`openwiki/protected.yaml` lists the **authoritative** concepts and fingerprints the load-bearing
passages inside them. A refresh that reworded one **fails the governance gate** rather than depending
on a reviewer noticing. To change such a passage legitimately, update its text **and** its fingerprint
in the same change:

```bash
node scripts/check-openwiki-governance.mjs --fingerprint openwiki/<area>/<page>.md "<heading text>"
pnpm nx okf-governance infrastructure-as-code
```

A passage may only be protected on a concept with **no** `resource` — freezing a derived summary
against the document it summarizes would fail every legitimate refresh.

---


## 6. Link form — the one thing the generator gets wrong on its own

The generator writes `](/openwiki/…)`. **That is a dead link on this forge**, and it is not a
cosmetic preference: a leading `/` resolves against the **site** root, so the forge reads `openwiki`
as a *username* and 404s. Measured with `POST /api/v1/markup` (the endpoint that takes `Context`,
`BranchPath` and `FilePath`, so it renders exactly as the file view does — `/api/v1/markdown` takes
no file path and cannot answer this). 204 links across 61 of the bundle's 77 files were broken this
way before anyone checked, and `okf-lint` passed the whole time because it only verified the
`resource` front matter (item #491).

Three things now hold the line, and you should not need any of them by hand:

1. `openwiki/INSTRUCTIONS.md` §6 states the convention, so the generator is asked for the right form.
2. A rebuild's `verifySlice` normalizes whatever the slice wrote, deterministically, before the gate
   reads it — because the brief is an instruction to a model, not a guarantee.
3. `okf-lint` rules **V14** (site-root-absolute) and **V15** (does not resolve from its own file's
   directory) fail the build for anything that arrives by another route.

If you ever need the bundle-wide sweep — a bundle restored from elsewhere, say:

```bash
node scripts/wiki-maintain.mjs --normalize-links --dry-run   # what would change, writes nothing
node scripts/wiki-maintain.mjs --normalize-links             # do it
```

Offline and free; it needs no credential. It moves **only** the target inside `](…)`, never prose,
and it skips code fences and code spans. If it touches a page carrying a protected passage, the
governance gate will demand the fingerprint be re-cut in the same change — that is working as
intended, and `--fingerprint <concept> "<anchor>"` prints the new value.

---


## 7. Verifying the machinery itself

```bash
node scripts/check-openwiki-okf.mjs --selftest        # V1–V15, V17 still detect their cases
node scripts/check-openwiki-governance.mjs --selftest # G1–G12, G14 still detect their cases
pnpm nx okf-lint infrastructure-as-code               # bundle conformance, V1–V15 and V17
pnpm nx okf-governance infrastructure-as-code         # policy, protection, index — G0–G12, G14
node scripts/wiki-maintain.mjs --selftest             # the rebuild's verifier, offline, keyless
node --test scripts/__tests__/openwiki-fingerprint.test.mjs scripts/__tests__/wiki-refresh.test.mjs
node --test scripts/__tests__/wiki-maintain.test.mjs scripts/__tests__/wiki-maintain.guard.test.mjs
node --test scripts/__tests__/openwiki-links.test.mjs # body-link scanner and normalizer
```

`wiki-maintain --selftest` includes a **deliberately sabotaged generator** that exits 0 having written
nothing. If it ever passes, the zero-page detector is broken — the one failure mode that would let a
rebuild go quietly back to reporting false green.

---

## 8. The OKF v0.1 → v0.2 provenance migration (OpenWiki 0.5.x)

OpenWiki 0.5.x emits **OKF v0.2**, which replaces the flat `timestamp:` scalar with a structured
`generated: {by, at}` event:

- `finalizeGeneratedProvenance` stamps `generated` on every page whose **body changed** in the run,
  and in the same pass **removes that page's `timestamp` field**. It is a replacement, not an
  addition.
- A page whose body did not change keeps its prior stamp. So the bundle carries **both shapes at
  once**, one per page. `wiki-refresh.mjs --record` writes `timestamp`, which v0.2 tolerates.
- The root `index.md` declares `okf_version: "0.2"`.

A page's stamp is the **newest** of `generated.at` and `timestamp`, defined once in
`scripts/openwiki-stamp.mjs`. `verified.at` was a third candidate while Claims existed; it is not one
now, and `verified:` itself is a V17 finding. The stamp no longer decides freshness — the fingerprint
does — but `--diff` uses it as the base for a page that has no fingerprint yet.

### Diagrams need their parser installed, or they degrade silently

From 0.5.0 OpenWiki embeds Mermaid diagrams by default and validates every fence after a run. The
authoritative validator is the real `mermaid` parser, which is an **optional peer dependency**
alongside `jsdom`. Without them OpenWiki falls back to a lightweight built-in check, and any diagram
that fails validation is rewritten in place into a plain `text` fence with a short comment — the run
still exits 0 and every gate still passes.

Both are therefore installed beside the generator in `.devcontainer/toolchain.Dockerfile` **and**
pinned in CI's locked install (`tools/openwiki-generator/package.json`, §4), and
`scripts/__tests__/wiki-maintain.guard.test.mjs` fails if either environment drops them — if only one
environment has the parser, the two disagree about what a valid diagram is, and the one that writes
the bundle wins. Both sit outside the peer range openwiki 0.7.1 declares (`mermaid ^11.16`,
`jsdom ^29.1`) — the versions every CI run since mid-September actually resolved — and the real parser was
verified to load and reject a malformed fence from the locked install.

---

## 9. Claims, retired (feature 098)

OpenWiki 0.5.2 records **Claims** for the pages it writes: evidence-backed propositions in a JSON
sidecar per page under `openwiki/.claims/`, certified against the page's bytes by
`openwiki/.page-manifest.json` and a front-matter `verified:` event. From 2026-09-27 to 2026-11-10
this repository kept them, guarded by V16 (durability) and G13 (scope, ADR-0003).

They are **retired** (ADR-0004, superseding ADR-0003's Claims half). openwiki forces every page with a
stale Claim into every run, whatever was requested; with ~20 pages a week changing source, that forced
set grew with every merge and starved the requested pages (run 5104: 30 forced pages, ~$1.44 for one
landed page). A derived page now carries one source fingerprint instead, checked by V17.

A manual rebuild may still have openwiki write sidecars and a manifest in the runner's checkout. The
paths are **gitignored**, so they are never committed, and the rebuild strips `sources:`/`verified:`
from every page that landed. Nothing in this repository reads them.
