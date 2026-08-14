# SAST & SCA Static Scanning — Operator Runbook (feature 033)

Keyless, config-as-code Static Application Security Testing (SAST) + Software Composition Analysis
(SCA). Complements DAST ([dast-scanning.md](dast-scanning.md)): where DAST exercises the *running* app,
this scans source and the dependency graph *at rest*. Four scanners → one normalized report → one
blocking `sast` CI gate. Config tree: [security/sast/](../../security/sast/).

| Kind | Scanner | Surface | How |
|---|---|---|---|
| SAST | Semgrep (OSS) | TS/JS tree (BFF + frontend) + Python agent layer | `uvx semgrep@<pin> scan` |
| SCA | cargo audit | Rust deps (root `Cargo.lock`) | `cargo audit --json` |
| SCA | pnpm audit | JS deps (root `pnpm-lock.yaml`) | `pnpm audit --json` (+ `--prod` for scope) |
| SCA | pip-audit | Python deps (`agents/movie-assistant`) | audits the **installed venv** (see gotcha) |

## Run it locally

Prereqs (no app stack needed — this is a static scan): Node ≥ 20, `uv`/`uvx`, a Rust toolchain with
`cargo-audit` (`cargo install cargo-audit --locked`), pnpm, and a **synced agent venv**
(`uv sync` in `agents/movie-assistant` — pip-audit audits the installed env).

```bash
pnpm nx sast infrastructure-as-code        # or: node scripts/sast-scan.mjs --scope full
node scripts/check-sast-findings.mjs       # the gate (exit 0 pass / 1 fail / 2 bad input)
```

Reports land in `security/sast/reports/` (gitignored): `findings.json` (gate input), `findings.sarif`,
`summary.txt`, and `<scanner>-native.json`. A full local run is ~2–6 min (pip-audit's OSV lookups are
the long pole).

Scope flags: `--scope full` (default, whole tree) vs `--scope changed --base <ref>` (Semgrep scans only
files changed vs `<ref>`; **SCA always runs full**). `--only <scanner,...>` restricts scanners for local
iteration. `--emit-allowlist` writes `reports/allowlist.proposed.yaml` (baseline-seeding aid).

## The CI gate

The blocking **`sast`** job in [.forgejo/workflows/guardrails.yml](../../.forgejo/workflows/guardrails.yml)
runs on every push/PR (auto-covered by the `guardrails*` branch-protection glob). Keyless — no
`${{ secrets }}`. Steps: install uv + Rust/cargo-audit fresh + `pnpm install` + `uv sync` the agent
venv → `check-sast-findings.mjs --selftest` → `sast-scan.mjs` (`--scope changed` on PRs, `--scope full`
on push; **SCA always full**) → `check-sast-findings.mjs` (the gate) → upload the `sast-report` artifact
(always, for triage). **No `paths:` filter** — a newly-published advisory can hit an unchanged dep, so
SCA must run regardless of what changed (FR-013).

Forgejo shows no per-step logs; if the `sast` job fails, reproduce locally and read the `sast-report`
artifact (`findings.json` + `summary.txt`). This is how 031's DAST CI was debugged.

## Triage / allowlist

The gate fails on any **blocking** finding (High/Critical that is SAST, or **runtime-scope** SCA) not in
[security/sast/allowlist.yaml](../../security/sast/allowlist.yaml). Medium/Low and **dev-scope** SCA are
warnings and never fail. To resolve a blocking finding: **fix it**, or triage it into the allowlist with
all required fields (`scanner`, `id`, `locationPattern` regex, `justification`, `addedBy`; optional
`expiry`). Suppression is gate-only — the finding stays visible in reports (FR-010). Full field rules,
expiry semantics, and baseline-seeding steps are in
[security/sast/README.md](../../security/sast/README.md#triage--allowlist-workflow).

## When `main` goes red on SAST you didn't change (advisory churn)

The SCA half runs **full every time** (a new advisory hits an *unchanged* dep — never path-gated,
FR-013), so the gate legitimately fails on freshly-published advisories against deps you never
touched. This is the gate working, not a defect — and it recurs. The playbook (used 2026-07-21, when
`main` went red four separate ways in one afternoon: brace-expansion, js-yaml, shell-quote, axios):

1. **Read the blockers self-serve** — don't hunt the runner logs:
   ```bash
   node scripts/ci-status.mjs failure --sha "$(git rev-parse origin/main)" --job sast   # or --pr N
   ```
   The digest names the failing step (`sast-gate`) and lists `Blocking (un-allowlisted): N` with each
   `[scanner] Sev ADVISORY — pkg@version`.

2. **Confirm each blocker is genuinely runtime.** Only **runtime-scope** SCA High/Critical blocks;
   dev/build-only deps are warnings. The gate is authoritative here — it derives scope from
   `pnpm audit --prod` across **all workspace packages**, so trust the digest's tag (`[pnpm-audit]`
   runtime vs `[pnpm-audit/dev]`). To cross-check by hand, you MUST go recursive:
   ```bash
   pnpm why <pkg> --prod -r   # -r spans the workspace; a runtime path shows e.g. `mcm-app (dependencies)`
   ```
   > ⚠️ **`pnpm why <pkg> --prod` WITHOUT `-r` runs at the repo ROOT only** and prints nothing for a
   > dep that's runtime-reachable via a *sub-package* (e.g. `mcm-app > @copilotkit/runtime >
   > @modelcontextprotocol/sdk > ajv > fast-uri`). That empty output is NOT "dev-only" — it's the
   > wrong scope. (This exact mistake wrongly accused the gate of a bug 2026-07-21; the gate was
   > right.) When in doubt, `pnpm audit --prod` is what the gate itself uses.

3. **Sweep for ALL runtime Highs at once — don't whack-a-mole.** More advisories may have landed than
   the one that happened to fail first (this cost three CI rounds before I swept):
   ```bash
   pnpm audit --json | node -e "…filter High/Critical…"   # then pnpm why --prod each to split runtime/dev
   ```

4. **Fix vs allowlist — but FIRST read the `OVERRIDE LEVERS` section, because the answer may not be a
   floor at all.** Since feature 058 the gate prints, for any finding whose package already carries an
   override:

   ```
   OVERRIDE LEVERS (advisory — does not affect this gate's result)
     Already permitted by an existing override — REFRESH THE LOCKFILE:
       • hono 4.12.29 — the override `>=4.12.25` ALREADY PERMITS 4.12.34; the lockfile is what pins
         4.12.29. The override needs no edit — refresh the lockfile: `pnpm update hono --lockfile-only`.
   ```

   > **This distinction cost ten days of red once already.** `fast-uri`'s override `>=3.1.4 <4`
   > already permitted the published fix 3.1.5; the *lockfile* pinned 3.1.4. The fix predated the
   > advisory by three days. A four-week allowlist acceptance was written for something
   > `pnpm update fast-uri --lockfile-only` would have cleared, because the gate named the vulnerable
   > version and the fixed version but not **which lever** to pull. `nanoid` repeated it eight days
   > later and reddened `main`. If the section says *refresh the lockfile*, editing the override is
   > wasted work — the range is already correct.
   >
   > It is **advisory only** and never changes the exit code, and it prints for **non-blocking**
   > findings too. That is the point: a finding in this state is cheap to clear *before* its severity
   > promotes it into a merge blocker. Renovate's scheduled `lockFileMaintenance` (also feature 058)
   > now clears most of them weekly without anyone reading this.

   Only when the section says **raise the floor** — or says nothing, because there is no override yet —
   does the rest of this step apply. A **fixable** High (a patched version exists) MUST be bumped, not
   allowlisted — allowlisting a fixable High is the wrong call. For a transitive dep, add a
   `pnpm.overrides` entry in `package.json` in the existing `pkg@<vuln: >=fixed` form, **pinned within
   the major** so nothing jumps a version:
   ```jsonc
   // package.json → pnpm.overrides  (matches form used for form-data/hono/undici)
   "brace-expansion@>=3.0.0 <5.0.7": ">=5.0.7",
   "axios@>=1.15.2 <1.18.0":         ">=1.18.0 <2"
   ```
   Then `pnpm install`, and re-verify `pnpm audit` reports zero High for the package. Only when **no**
   fix exists yet is a justified allowlist entry (with `expiry` for an imminent bump) correct.

5. **Note the local limit.** semgrep + cargo-audit + pip-audit aren't on the Windows dev box or the
   dev container, so the *full* gate is CI-authoritative; `pnpm audit` locally confirms only the
   pnpm-SCA portion. Push and let CI confirm.

**Structural fix — no longer just "worth considering" (feature 058, 2026-08-13).** This was a
recurring manual tax and two thirds of it is now automated. Renovate's `lockFileMaintenance` runs in
the Friday window and refreshes the lockfile **within existing ranges**, so a transitive fix an
override already permits is picked up without anyone reading an advisory. Two things to know:

- Its `schedule` key in `renovate.json` looks like a duplicate of the top-level one and **is not** —
  the option carries its own default (`before 4am on monday`) that beats the inherited value, and that
  window intersects neither cron under either DST offset. Delete it as redundant and the refresh is
  enabled and can never fire, silently. `renovate-workflow.guard.test.mjs` fails if it goes.
- These refresh PRs now run `app-e2e` (item #186): a bad transitive floor is a **build-time** break
  that `nx test` passes straight over, so the E2E tier is the only one that catches it.

What remains manual is the case the bot structurally cannot propose: a floor that must **rise** past
its own ceiling. The bot proposes only when the current range fails to satisfy the newest version, so
it will essentially never raise the lower bound of a keyed override — and when it rewrites one it
half-bumps, because it parses `fast-uri@<3.1.5` as an opaque depName and cannot rewrite it.
`check-override-consistency.mjs` fails that by name, which is the accepted cost recorded in
`renovate.json`.

## Non-obvious gotchas

- **pip-audit audits the INSTALLED venv, not a requirements file.** `pip-audit -r <requirements>`
  resolves the file in an ephemeral venv (downloads the whole 179-pkg graph, chokes on yanked versions —
  hangs >11 min). The orchestrator instead runs `uv run --no-sync --with pip-audit pip-audit -s osv`
  against the synced venv (~50 s) and intersects findings with the `uv export` dep-set to drop
  pip-audit's own injected deps. **CI must `uv sync` the agent layer first**, and a developer's venv must
  be synced for a local run.
- **Keyless & fail-CLOSED (R7).** All rule/advisory data is fetched anonymously at scan time (Semgrep
  registry, RustSec DB, npm advisories, OSV/PyPI). If any fetch fails, that scanner **fails fast**
  (exit 1, `scanners[].error` recorded) rather than reporting a false clean. Residual: an upstream
  outage blocks the gate — re-run when it recovers. No secret is ever required.
- **The gate passes VACUOUSLY in the dev container — a local green proves nothing about a new
  allowlist entry (047).** Semgrep cannot reach its rule registry through the egress allowlist, so
  it fails closed (per the point above) and `security/sast/reports/findings.json` ends up **empty**
  — the reason is recorded in `scanners[].error`, which is easy to miss. Running
  `check-sast-findings.mjs` then exits 0 on zero findings, which is not evidence that an allowlist
  entry matches anything. **To test an allowlist entry locally, hand the gate a synthetic
  `findings.json`** carrying the exact `scanner` / `id` / location triples you expect, plus a
  **negative control** (a finding the entry must NOT suppress). Otherwise push and let CI answer.
- **…but "the tier cannot run here" is the wrong conclusion — `--only` gets you the SCA half
  (2026-08-13).** The vacuous pass above is a fact about **Semgrep**, not about the gate. Only
  Semgrep needs `semgrep.dev`; `pnpm-audit`, `cargo-audit` and `pip-audit` resolve their advisory
  data from sources the egress allowlist already permits. So the whole SCA half runs to completion
  locally:

  ```bash
  node scripts/sast-scan.mjs --scope full --only pnpm-audit   # 55 findings, 2 blocking — a real report
  node scripts/check-sast-findings.mjs
  ```

  This matters because every dependency-floor remediation is an SCA finding, and those are exactly
  the changes you want to verify before pushing. Measured on feature 057: the full-scope run
  fail-closed on Semgrep and left a 0-finding report the gate passed vacuously, while `--only
  pnpm-audit` proved both target advisories were genuinely suppressed beforehand and genuinely gone
  afterwards. **Check the finding COUNT, not the exit code** — a report with 0 findings and a report
  with no blocking findings print the same green.
- **An override floor has TWO halves and both must move.** Entries in `pnpm-workspace.yaml`'s
  `overrides:` map are a range keyed on a range — `fast-uri@<3.1.5: '>=3.1.5 <4'` — where the key
  names the vulnerable span excluded and the value the patched floor forced. Raise the value alone
  and you get an override that reads as remediated while no longer excluding the version its own key
  names. `scripts/check-override-consistency.mjs` enforces `key's exclusive upper bound == value's
  inclusive lower bound` on every pull request, scoped to keys carrying an `@<range>` suffix (the
  plain pins `react-dom`, `postcss`, `@expo/dom-webview` have no key half and are out of scope).
  Renovate produces exactly this mismatch when it proposes a floor raise, so expect bot PRs against
  this map to need their key half fixed by hand.
- **Remediate, do not re-date.** Deleting or extending an `expiry` is how a time-box becomes
  permanent. The legitimate exception — no published fix exists — is modelled by the `image-size`
  pair and requires the evidence written into the justification. Check npm before assuming: on
  feature 057 both "needs an acceptance" advisories turned out to have published fixes.
- **You now get 14 days' notice before an expiry blocks anything.** Both gates report `EXPIRING
  SOON` / `EXPIRED` / `UNMATCHED ENTRIES` on a normal run **without changing their exit code**, and
  `--check-expiring` runs weekly in `infra-image-scan` (schedule-only, never on a pull request) and
  fails on any of the three. The window is `WARNING_WINDOW_DAYS` in `scripts/allowlist-expiry.mjs`,
  the single definition both gates import. `UNMATCHED ENTRIES` is the one to read closely: it catches
  the measured trap where an entry keyed on an exact advisory id **does not expire, it just quietly
  matches nothing** once a scanner switches identifier namespace (pip-audit moving from CVE ids to
  PYSEC aliases). Full detail in [`security/sast/README.md`](../../security/sast/README.md).
- **`p/secrets` stays OFF** — `secret-scan.mjs` owns credential detection (FR-006). Do not double-gate.
- **Rust code is out of Semgrep scope** — clippy (`pnpm nx lint mc-service`) covers Rust patterns;
  cargo-audit covers only Rust *deps*. Consequently `mcm-no-jwt-payload-tracing` enforces the no-JWT-
  logging invariant on TS/JS + Python only; the mc-service (Rust) residual stays with clippy + review.
- **No caching yet.** `actions/cache` is not mirrored on the runner, so cargo-audit is compiled fresh
  each run (~2–3 min). A monthly-keyed cache of `~/.cargo/bin/cargo-audit` + `~/.cargo/advisory-db` is a
  future optimization.
- **Paths are normalized to forward slashes** so allowlist `locationPattern`s are portable across the
  Windows dev host and the Linux CI runner.
