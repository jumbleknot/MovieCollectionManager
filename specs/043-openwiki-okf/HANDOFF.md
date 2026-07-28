# Handoff: OpenWiki Phase 3 — automated maintenance

**From**: feature 043 (merged 2026-07-28, PR #111, merge commit `a104245`)
**To**: a fresh session starting Phase 3
**Status of 043**: complete and on `main`. 45 concepts across 8 directories, all 17 canonical
documents cited, fail-closed conformance gate live in `guardrails.yml` as the `okf` job.

Read this **before** `specs/043-openwiki-okf/spec.md` — it is the short version of what 043 learned
the hard way, and Phase 3 will repeat those mistakes without it.

---

## What Phase 3 has to solve

Two problems 043 deliberately deferred. They are related: both are consequences of generation being
expensive and non-incremental.

### 1. Bounded-slice generation

**The tool cannot complete a large first pass in one invocation, and reports success when it gives
up.** Measured over 8 runs on this repository:

| Symptom | Detail |
|---|---|
| False green | Ran 12 min, planned, researched, terminated mid-sentence, **exit 0**, one `index.md` written |
| Heap exhaustion | Aborted at Node's ~4 GB default (`FATAL ERROR: Reached heap limit`, exit 134) after minutes of paid work |
| `--update` no-ops on a partial bundle | Sees one existing page, stamps `.last-update.json`, syncs the index, exits 0 in ~2.5 min |

**`CLI_EXIT=0` does not mean you got a bundle.** Always assert the result
(`pnpm nx okf-lint infrastructure-as-code`) and the page count — never the exit code.

What worked: an explicit page list of **6–8 pages** in the run message. Sizing data:

| Slice | Requested | Delivered |
|---|---|---|
| 7 pages, existing dir + a **new** dir | **0** ❌ |
| 4 pages, existing dir (same work, split) | 4 ✅ |
| 3 pages, new dir (same work, split) | 3 ✅ |
| 8 pages, one dir | 8 ✅ (twice) |
| 7 pages, one new dir | 7 ✅ |

**Size alone does not predict failure** — 8-page slices succeeded twice. The single slice that
produced nothing was the only one that **mixed finishing an existing directory with creating a new
one**. Splitting along that seam fixed it immediately.

Phase 3 needs to encode this: a scheduled job cannot issue one "regenerate everything" request.

### 2. Staleness handling

043 built a drift-triggered freshness step, measured it, and **reverted it**. Do not rebuild it
without reading why (`spec.md` → Out of Scope, and `SC-003-SC-004-EVIDENCE.md`):

- **Drift never clears on its own.** The generator rewrites only files it *changes*, so a concept it
  reads and judges accurate keeps its old `timestamp` and reports stale **forever**. Clearing it
  needs a mechanism that *asserts* verification without performing it — which can launder stale
  documentation as fresh, the exact failure the check exists to catch.
- **The signal fans out.** 12 of 45 concepts cite `CLAUDE.md`; one edit to that 70 KB file marked 16
  stale at once, regardless of which passage changed.
- **A pure rename produces permanent false positives.** The operator-doc relocation (git `R099`, no
  content diff) made two accurate pages report stale indefinitely.

**As of this handoff the gate reports 19 drift warnings on a freshly-merged `main`.** That is the
noise floor the current design produces — informational only, since nothing triggers on it.

**The decisive input**: OpenWiki's own answer to staleness is **scheduled regeneration** — a job that
scans commits since the last run and updates where needed. Frequency is the mechanism; per-concept
staleness is not the layer this is solved at. OKF's `timestamp` is a *last-modified* marker, not a
staleness signal. The drift trigger was a repo-local invention, which is why it needed bespoke
machinery to suppress its own false positives.

---

## Constraints Phase 3 inherits

These are settled decisions, not open questions. Changing one is a spec amendment.

| Constraint | Why |
|---|---|
| **CI is Forgejo**, `.forgejo/workflows/` | The shipped OpenWiki GitHub Action cannot be dropped in as-is. GitHub is a no-Actions push mirror. |
| **Never widen the egress allowlist** | Telemetry is disabled by configuration (`OPENWIKI_TELEMETRY_DISABLED=1`), never by allowlisting the analytics host. |
| **Always invoke via the Nx target** | `wiki-update` sets the telemetry opt-out, the pinned model, and `NODE_OPTIONS=--max-old-space-size=8192`. A bare CLI call transmits telemetry and OOMs. |
| **Never run `openwiki --init`** | `--update` creates the bundle when absent, avoiding the interactive wizard and the `~/.openwiki/.env` it would write. |
| **A leak-gate hit is fixed in `openwiki/INSTRUCTIONS.md` and regenerated** | Never allowlisted (FR-012). |
| **The gate is offline, keyless, fail-closed** | External `resource` links are shape-checked, never fetched. No skip flag. Do not add one. |
| **Every new CI job publishes a failure digest** | `check-ci-digest-coverage.mjs` fails the build otherwise. |
| **New `scripts/__tests__/*.test.mjs` are auto-gated** | The `naming` job's glob is shell-expanded — no workflow edit needed. They must be deterministic, offline, token-free, `node:` built-ins + `yaml`. |

**A job that needs `yaml` must `pnpm install` first.** The `okf` job failed its first CI run on
`ERR_MODULE_NOT_FOUND` for exactly this. Mirror the `naming` job's setup steps.

---

## What Phase 3 must decide

1. **Schedule + trigger.** Weekly off-peak mirrors `infra-image-scan.yml`. The runner is
   **capacity-1** and `app-e2e` is ~35 min — avoid contention with push-triggered CI.
2. **How to slice within a scheduled run.** A single "update everything" call is the known failure
   mode. Options: derive a page list from changed paths; iterate directory-by-directory; cap pages
   per run and carry the remainder forward.
3. **Credential.** This is the feature's **first non-keyless scheduled job**. It needs an
   `ANTHROPIC_API_KEY` in the Forgejo Actions secret store — call that out explicitly in the spec, as
   043 did for `CI_DIGEST_TOKEN`.
4. **PR creation.** The shipped action uses GitHub tooling. On the forge, reuse the documented API
   pattern with a scoped `write:repository` PAT (the `actions-cd-push` model). **Never auto-merge** —
   a human reviews wiki diffs.
5. **Cost control.** Measured: a true no-op is **1 s and free** (clean tree *and* matching
   `gitHead` short-circuits with no model call); an incremental run reacting to one commit is ~92 s;
   a stale-marker run is ~6–7 min; a 6–8 page generation slice is 5–17 min. **But the free path is
   rarely reachable** — `.last-update.json` only advances when wiki content changed, so a run that
   correctly finds nothing to document leaves a stale marker and the next run pays full cost again.
   Phase 3 should decide whether to advance the marker itself.

---

## Repository facts worth not rediscovering

- **`log.md` is singular.** The vendor blog says `logs.md`; the shipped code does not.
- **`openwiki/INSTRUCTIONS.md` is hand-authored** and never rewritten by the tool. It is the
  remediation surface and the only control over scope and redaction.
- **Generated `index.md` carries `okf_version` and no `type`**; per-directory indexes carry no front
  matter at all. The gate exempts both — do not "fix" that, it is measured generator behaviour.
- **Model is pinned** to `claude-sonnet-5` in the Nx target. Opus was tried; the binding constraint
  is request scope, not model capability — Sonnet ran a full 12 min and still could not finish a
  ~45-page first pass.
- **`~/.openwiki` is disposable** in code mode (the wiki lives in the repo). No named volume.

---

## Suggested first step

`/speckit-specify` for **feature 044**, scoped to the two problems above. The proposal that seeded
043 (`docs/proposals/openwiki-okf-adoption-plan.md` → Phase 3) is the input; this handoff and
`SC-003-SC-004-EVIDENCE.md` are the measured reality that proposal predates.

Confirm the feature number first — `specs/` is the source of truth, and 043 is taken.
