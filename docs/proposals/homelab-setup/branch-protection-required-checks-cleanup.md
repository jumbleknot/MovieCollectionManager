# Branch-protection required-checks — friction & cleanup options

**Status:** proposal / decision needed (operator owns the branch-protection config). Drafted 2026-07-07 after repeated merge friction on non-app PRs during the feature-029 tail.

## The problem

`main` branch protection has **`enable_status_check: true`** with required contexts = **`["app-ci*", "guardrails*"]`** (globs). Observed behaviour on this Forgejo version:

- **A required glob with ZERO matching contexts BLOCKS the merge** ("Not all required status checks successful") — it is *not* treated as satisfied. (An earlier assumption that "a zero-match glob = satisfied" does **not** hold here.)
- **`app-ci` is intentionally conditional** — it only triggers on its `pull_request` `paths:` (frontend/backend/infra/workflows/renovate.json/lockfiles), and inside it `app-e2e` is dorny-path-gated and `trigger-cd` is `push`-only.

So two recurring failure modes block legitimate, fully-validated PRs:

| # | Failure mode | Example |
| --- | --- | --- |
| **A** | A PR touches only paths NOT in app-ci's trigger (docs, `CLAUDE.md`, …) → **zero `app-ci/*` contexts** → the `app-ci*` glob is unmet → blocked. | #39 (docs) — guardrails green, no app-ci contexts, blocked. |
| **B** | app-ci runs, but the `trigger-cd` job (skipped on PRs, `if: event=='push'`) leaves an **orphaned `app-ci / trigger-cd: pending`** status that never finalizes → the `app-ci*` glob has a non-success match → blocked. | #37 (pnpm lockfile) — `affected`/`mc-service-checks` green, `app-e2e` skipped-OK, but `trigger-cd` stuck pending. |

We have hit this on four PR classes now: config (#30/#31), lockfiles (#36/#37), the trigger-cd orphan, and docs (#39). Each time the workaround was an **admin-override merge** or **adding another path to app-ci** (whack-a-mole).

## Why there is no single clean setting

The tension is fundamental: *"app-ci must pass"* as a **hard** gate + *"app-ci legitimately does not run on some PRs"* = blocked, unless the CI system supports **conditional-required** ("required only if reported"). This Forgejo version does not, for either a glob (mode A) or a never-finalized status (mode B). `trigger-cd` cannot simply move to its own `push`-only workflow either — it `needs:` app-ci's job results, and polling app-ci status from a separate workflow is exactly the 80-min-timeout race that was retired on 2026-07-03.

## Options (operator decides)

### Option 0 — Status quo: admin-override the rare non-app PR
No change. Keep overriding docs/config/lockfile PRs when app-ci doesn't post a satisfying set. **Cost:** a manual override every few PRs; the `trigger-cd` orphan (B) keeps biting even lockfile PRs. **Lowest effort, ongoing friction.**

### Option 1 — Minimal high-value: stop `trigger-cd` from being a required gate
Switch required contexts from the `app-ci*` glob to an **explicit list that omits `app-ci / trigger-cd`**, e.g.:
`guardrails / naming`, `guardrails / secret-scan`, `guardrails / agent-gates`, `app-ci / affected`, `app-ci / mc-service-checks`, `app-ci / app-e2e` (skipped reports success).
- **Fixes B** (the orphan no longer counts). **Does NOT fix A** (docs PRs still have none of the listed contexts → still blocked → still need override).
- **Cost:** the required list becomes context-name-specific (breaks if a job is renamed); the `(push)`/`(pull_request)` context variants must be handled. Admin-only change.

### Option 2 — Comprehensive: make app-ci run on every PR + Option 1's explicit list
Repo change: **remove app-ci's `pull_request` `paths:` filter** so its light jobs (`affected`, `mc-service-checks`) run on *every* PR (the heavy `app-e2e` stays gated by the dorny `changes` filter → still skips for docs/lockfiles). Then every PR produces the required `app-ci/*` contexts, and with Option 1's explicit list (no `trigger-cd`) **both A and B are fixed — zero overrides, ever.**
- **Cost:** `mc-service-checks` (Rust clippy + unit, ~5–10 min) and `affected` run on **every** PR including docs-only ones — wasteful CI time on the single runner. Could be trimmed later by path-gating those jobs, but that reintroduces the "absent context" problem for the gated PRs.
- The app-ci.yml change merges normally (it touches `.forgejo/workflows/**`, so app-ci runs on it).

### Option 3 — Looser gate: drop `app-ci*` from required entirely
Required = `guardrails*` only. Every PR merges once guardrails (naming/secret/agent) pass. app-ci still runs and still gates **deployment** (`trigger-cd` → `cd-deploy` only fires on green `main`), so a broken app PR would merge but **not deploy**.
- **Fixes A and B** with the least config. **Cost:** the *merge* gate no longer enforces build/lint/test — a red app-ci could land on `main` (caught only at deploy). Weakest safety.

## Recommendation

- **If the every-PR CI cost is acceptable → Option 2** (comprehensive, zero future friction, keeps full enforcement). This is the "do it right" choice.
- **Otherwise → Option 0 + do the Option-1 explicit-list change** to at least kill the `trigger-cd` orphan (mode B), and keep overriding the occasional docs/config PR (mode A is rare).
- **Avoid Option 3** unless the team accepts merge-time app-ci enforcement loss.

## Concrete Forgejo steps (for Option 1/2 — admin)

1. Forgejo → repo `jumbleknot/mcm` → **Settings → Branches → `main` → Edit protection**.
2. Under **"Enable Status Check"**, replace the two glob patterns (`app-ci*`, `guardrails*`) with the explicit context names you want required (copy them verbatim from a recent PR's checks list; include the `(pull_request)` variants; **omit `app-ci / trigger-cd`**).
3. (Option 2 only) Merge the repo PR that removes app-ci's `pull_request` `paths:` filter first, so those contexts exist on every PR.
4. Validate on a throwaway docs PR: it should now be mergeable without an override.

## Related

- The app-ci `paths:` gap (config + lockfile PRs) and its per-class fixes are documented in `CLAUDE.md` (CI/CD section). This proposal is the *systemic* alternative to continuing to add paths per class.
- CD trigger model (why `trigger-cd` is a job-in-app-ci, not a separate workflow): `CLAUDE.md` + [Phase-15-Operator-Checklist.md](Phase-15-Operator-Checklist.md).
