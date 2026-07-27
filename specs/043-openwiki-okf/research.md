# Phase 0 Research: OpenWiki + OKF Knowledge Layer

**Feature**: 043-openwiki-okf · **Date**: 2026-07-26

All findings below are from **direct inspection of the published `openwiki@0.2.3` package**
(`npm pack openwiki@0.2.3`, extracted and read), not from the vendor blog posts the proposal cited.
Where the shipped code and the blog disagree, the code wins and the disagreement is noted.

---

## R1 — Where the generation-instructions document lives

**Decision**: `openwiki/INSTRUCTIONS.md` — **inside** the bundle directory, not at the repository root.

**Rationale**: `README.md` states the repository brief is stored at `openwiki/INSTRUCTIONS.md`, that
OpenWiki reads it for scope and priorities, and that **it is not generated documentation and is not
rewritten during init, update, or chat runs** unless explicitly asked. A separate personal-mode brief
exists at `~/.openwiki/INSTRUCTIONS.md` (`dist/onboarding.js`) — different file, different mode, not
used here.

**Consequence for the gate**: `openwiki/INSTRUCTIONS.md` is a hand-authored file living inside the
bundle with **no OKF front matter**. The conformance gate MUST exempt it from concept validation, or
it will fail the repository's own instructions file on every run.

**Alternatives considered**: repository-root `INSTRUCTIONS.md` (what the proposal guessed) — wrong,
would simply be ignored by the tool.

---

## R2 — Driving generation non-interactively

**Decision**: bootstrap and maintain with `openwiki code --update --print`, configured entirely by
environment variables. **Never run the interactive `--init`.**

**Rationale**: three separate README statements combine to remove the interactive dependency:

1. `--update` **creates the initial `openwiki/` docs when none exist** — the README says explicitly
   that `--init` is not needed in CI for this reason.
2. `-p` / `--print` is a one-shot non-interactive run that prints the final output instead of holding
   the terminal open (the CLI is otherwise an `ink` TUI and stays open for follow-ups).
3. Provider and model are selectable from the environment — the README's own example is
   `OPENWIKI_PROVIDER=<provider> openwiki code --init`, and `OPENWIKI_MODEL_ID` selects the model.

Interactive first-run onboarding exists only to write `~/.openwiki/.env`; supplying the same values
as environment variables bypasses it.

**Consequence**: this resolves the spec's second open assumption *and* removes the need for a
`~/.openwiki/.env` file in either workspace, which is what keeps FR-027 (no new secret material in
the workspace) satisfiable.

**Alternatives considered**: scripting the interactive prompts (fragile, TUI-dependent); committing a
`~/.openwiki/.env` (creates the secret file FR-027 forbids).

---

## R3 — How the tool edits `CLAUDE.md` and `AGENTS.md`

**Decision**: let OpenWiki manage its own block; verify placement once, then treat it as owned.

**Rationale**: on every `code` run the tool maintains both files at the repository root, creating each
if absent. If a file already exists it **only rewrites its own `<!-- OPENWIKI:START -->…<!--
OPENWIKI:END -->` block** and leaves everything else untouched, appending the block the first time.

**Consequence**: the FR-021 managed-block risk is materially lower than the proposal assumed — the
tool uses sentinel-delimited ownership, the same convention Nx and Spec Kit use. The real check is
*placement*: the appended block must land **after** `<!-- SPECKIT END -->` (currently `CLAUDE.md:573`)
and must not interleave with the Nx block (`CLAUDE.md:544–567`). This is a one-time diff review, not
a recurring hazard.

**Residual**: `AGENTS.md` currently has no Spec Kit or Nx block, so it carries no interleaving risk.

---

## R4 — Telemetry (not mentioned anywhere in the proposal)

**Decision**: disable telemetry explicitly in **both** workspaces via `OPENWIKI_TELEMETRY_DISABLED=1`,
set by the invocation wrapper rather than by developer setup. Do **not** widen the container egress
allowlist. **`DO_NOT_TRACK` is deliberately not used by this feature** — see the naming note below.

**Rationale**: the package depends on `posthog-node` and the README confirms telemetry is **on by
default**, sending an `openwiki_run` event keyed by a random install ID in `~/.openwiki/install-id`.
The vendor documents that file contents, repository names and data, credentials, prompts, model
output, error messages, file paths, URLs, and IP addresses are **never** collected — only the command,
the outcome, a coarse error category, and (at setup) the provider and connector names.

Even taking that at face value, two repository rules apply. First, `posthog.com` is **not** in the dev
container's `ALLOWED_DOMAINS`, so in-container runs would attempt a blocked call — the Windows host
has no such policy and **would** transmit. Relying on the firewall would give inconsistent behavior
across the two supported workspaces. Second, the repository's standing rule is never to widen the
allowlist for a tool's convenience. Disabling by configuration satisfies both.

**Verification path**: the CLI accepts `--telemetry-file=<path>`, which writes the exact payload a run
would send to a local JSON file. That is the evidence mechanism for SC-013 — an empty or absent
payload file proves nothing was transmitted, without packet capture.

**Alternatives considered**: relying on the container firewall (inconsistent across workspaces, and
silently wrong on the host); allowlisting the analytics host (directly violates the repo rule).

### R4a — Exact opt-out semantics (read from `dist/telemetry/gates.js`)

```js
isTelemetryDisabled() =>
  isTruthyEnv(process.env.OPENWIKI_TELEMETRY_DISABLED) || isTruthyEnv(process.env.DO_NOT_TRACK)
```

`isTruthyEnv` treats `""`, `"0"`, and `"false"` (trimmed, case-insensitive) as *not set*; **any other
value is truthy**. Either variable alone is sufficient — they are OR'd, not AND'ed.

Two further facts from the same file, both load-bearing:

- **CI runs still transmit.** `noticeSuppressed()` hides the first-run notice in CI, but the code
  comment is explicit: *"Only an explicit opt-out stops sending."* CI runs are sent under a per-provider
  sentinel ID. Irrelevant today (this feature adds no CI generation job) but **directly relevant to the
  deferred Phase 3 follow-on**, which must set the variable in the workflow environment.
- **Config-file fallback exists**: `~/.openwiki/.env` is seeded into `process.env` at startup, but only
  for keys not already set — a shell export wins over the file (`dist/env.js`). Either route works.

### R4b — Why `DO_NOT_TRACK` is not used here

`DO_NOT_TRACK` is **not an OpenWiki variable**. It is the cross-tool console do-not-track convention
that many unrelated CLIs honor, so the name is an **external contract** — renaming it to something
OpenWiki-specific would simply stop working. The constitution's Behavior-Descriptive Identifiers
principle already exempts exactly this case: environment-variable names are exempt "where renaming
would break compatibility."

That said, for **this** tool it is pure redundancy: `OPENWIKI_TELEMETRY_DISABLED=1` fully disables
telemetry on its own. `DO_NOT_TRACK`'s only added value is *cross-tool* suppression, which is a
repository-wide posture decision with a blast radius far beyond this feature.

**Decision**: use only `OPENWIKI_TELEMETRY_DISABLED=1` — one specific variable, one specific job,
scoped to the tool this feature adopts. Setting `DO_NOT_TRACK` repository-wide remains available as a
separate deliberate choice, and should be argued on its own merits rather than inherited from here.

### R4c — Enforcement point: the invocation wrapper, not setup documentation

The container can set the variable through committed `devcontainer.json` `containerEnv`, but the
Windows host has no equivalent committed surface — leaving it as a documented manual step means
FR-030's "every environment" degrades to "every environment where the developer remembered," and a
teammate on a fresh host transmits silently.

**Decision**: expose generation and update as **Nx targets** that set `OPENWIKI_TELEMETRY_DISABLED=1`
themselves. This matches the established house pattern (`dast`, `sast`, `infra-scan`, `check:naming`
are all Nx-wrapped scripts) and the repository's Nx-first rule, and makes the opt-out enforced by
construction in both workspaces instead of dependent on setup docs being followed.

The `containerEnv` entry is retained as defense in depth for ad-hoc direct CLI use in the container.

---

## R5 — Runtime and installation

**Decision**: pin `openwiki@0.2.3`. Container gets it baked into `toolchain.Dockerfile`; the first
generation runs from an ad-hoc install, per the spec's sequencing clarification.

**Rationale**: the package declares `engines.node >= 22`; the dev container runs **v24.18.0** — compatible,
no Node upgrade needed. The npm global prefix is `/usr/local`, which is why the toolchain image
installs as root at build time (the existing `npm install -g @anthropic-ai/claude-code` at
`toolchain.Dockerfile:67` is the precedent to follow). An ad-hoc install in a running container needs
elevation or a user-writable prefix.

**Note on the package manager**: the repository hard-blocks `npm`/`yarn` for *workspace installs* via
the `only-allow pnpm` preinstall hook. That guard governs installs **inside** the workspace; a global
tool install is outside it, and the existing toolchain image already uses `npm install -g`. Following
that precedent in the image is consistent; the host install uses `pnpm add -g` per the proposal.

---

## R6 — Tool state and container recreation

**Decision**: **no named volume.** Treat `~/.openwiki` as disposable and document it.

**Rationale**: `dist/openwiki-home.js` puts everything under `~/.openwiki` (mode `0700`): `.env`,
`install-id`, `onboarding.json`, `connectors/`, `skills/`, a personal `wiki/`, and an
`openwiki.sqlite` (the LangGraph checkpointer, per the `@langchain/langgraph-checkpoint-sqlite`
dependency). **In code mode the wiki itself lives in the repository**, not in the home directory — so
what is lost on container recreate is onboarding state and conversation checkpoints, neither of which
this feature depends on, because R2 makes every run environment-configured and one-shot.

**Consequence**: resolves User Story 3, acceptance scenario 3, in the "safely rebuilt" direction. A
named volume would persist an `install-id` and a `.env` we deliberately do not want to accumulate.

---

## R7 — OKF reserved filenames: the blog is wrong

**Decision**: the reserved history file is **`log.md`** (singular). The gate must use that name.

**Rationale**: the shipped code references exactly two reserved names — `index.md` and `log.md`. The
proposal noted that the vendor blog says `logs.md`; the blog is wrong, or describes an older shape.

**Consequence**: a gate written against `logs.md` would silently never find the history file. Three
file classes exist in a bundle and the gate must treat them differently:

| File | Class | Gate treatment |
|---|---|---|
| `INSTRUCTIONS.md` | hand-authored brief | exempt from concept validation entirely (R1) |
| `index.md` | generated directory summary | validate as a concept **and** require it to list its siblings |
| `log.md` | generated change history | validate front matter; exempt from the "must be listed in index" rule |
| everything else `.md` | concept | full validation |

---

## R8 — The front-matter contract the gate must mirror

**Decision**: mirror `dist/okf/frontmatter.js` exactly. Do not invent stricter rules.

**Rationale**: reading the shipped validator:

- `type` is the **only** required field, and must be a **non-empty string**.
- `title`, `description`, `resource`, `timestamp` are optional; when present each must be a non-empty string.
- `tags`, when present, must be an array of non-empty strings.
- When a page has no parseable front matter or no `type`, the tool **injects** one with `type: "Reference"`.
- A page that already declares a usable `type` is **left unchanged**, even when optional fields are junk.

**Consequence**: the gate must not fail a page merely for missing `title`/`description` — the
generator itself tolerates that, and a stricter gate would fight its own generator on every run. The
repository's *additional* requirements (ISO-8601 `timestamp`, resolvable `resource`, per-directory
`index.md`) are layered **on top** and are ours to enforce, which is exactly why a separate gate
exists rather than relying on the tool's internal validation.

---

## R9 — Gate implementation idiom (established in-repo)

**Decision**: `scripts/check-openwiki-okf.mjs`, plain ESM, matching the nine existing `check-*.mjs` gates.

**Rationale**: the house pattern, confirmed by reading `check-ci-digest-coverage.mjs`,
`check-dast-findings.mjs`, and their tests:

- Header comment documenting invocation and **exit codes: `0` clean / selftest passed · `1` violation
  / selftest broken · `2` bad args or unparseable input**.
- A `--selftest` mode that proves its own detection logic before the real run.
- `yaml` is already a root dependency and is imported by several gates — no new dependency.
- Tests live at `scripts/__tests__/<name>.test.mjs` using **`node:test` + `node:assert/strict`**, and
  they drive the **real CLI as a subprocess** via `spawnSync` against fixtures in a temp dir. This is
  a contract-level test, not a unit test of internals — and it is what makes the fixture-driven
  RED→GREEN required by the fail-closed clarification straightforward.

---

## R10 — Where the gate runs in CI

**Decision**: a **new `okf` job** in `.forgejo/workflows/guardrails.yml`, mirroring the existing
`naming` job.

**Rationale**: `guardrails.yml` already runs `secret-scan`, `naming`, and `agent-gates` as separate
jobs, each invoking `bash scripts/ci-log-step.sh <step-name> <command>` and each ending with a
`Publish failure digest` step (`always()` + `continue-on-error`, running
`scripts/ci-failure-digest.mjs`). A new job must carry that digest step or
`check-ci-digest-coverage.mjs` — which the `naming` job runs — fails the build. That is FR-017, and it
is enforced, not advisory.

Branch protection requires the glob `guardrails*`, so a new job in this workflow becomes a required
context automatically with no operator action.

**Correction (verified 2026-07-27)**: an earlier draft of this note claimed the new test file must be
named explicitly in the workflow. It does not. The `naming` job runs
`bash scripts/ci-log-step.sh naming-script-tests node --test scripts/__tests__/*.test.mjs` — the glob
is expanded by **bash**, not by `node --test`, so **a new `scripts/__tests__/*.test.mjs` file is gated
automatically with no workflow edit** (this is exactly why feature 041 wrote it that way). The new
`okf` job is therefore only needed to run the **gate itself** against the real bundle and publish its
own failure digest; the gate's unit tests are already covered.

Consequence for the tests: because they run on every push in a container with no forge access, they
must be **deterministic, offline, token-free, and limited to `node:` built-ins plus `yaml`**.

**Alternatives considered**: folding the gate into the existing `naming` job (cheaper, but conflates
two unrelated gates and makes the failure digest ambiguous); a local-only Nx target (rejected by the
spec's clarification — a gate that stops being run is the failure mode this repo has been bitten by).

---

## Open item carried into implementation

**Generation cost and page quality** remain unmeasured; no useful target can be set before one real
run. Bounded by the spec: iterate `openwiki/INSTRUCTIONS.md` and regenerate rather than accepting weak
output. The first run should be treated as a calibration run, and its cost recorded in the evidence
document alongside the SC-003/SC-004 results.
