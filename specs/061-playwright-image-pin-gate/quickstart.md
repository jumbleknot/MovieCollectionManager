# Quickstart — validating the Playwright image-pin gate

**Feature**: 061-playwright-image-pin-gate · **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Everything here runs offline except step 4, which needs the npm registry. Total runtime is well under
a minute, against the ~35 minutes the drift previously took to surface.

**Prerequisites**: repo root, `pnpm install --frozen-lockfile` already run (the gate imports `yaml`,
a root devDependency), Node ≥ 22.13 — Node ≥ 24.11 additionally for step 4, which runs renovate@44.

---

## 1. The gate passes on a clean tree

```bash
node scripts/check-toolchain-consistency.mjs
```

**Expect** exit `0` and a `✓` line that **names the Playwright pair** among the relations it proved.
If the line does not mention Playwright, the relation is not wired into `findDrift()` — the gate is
claiming less than it checked, and you cannot tell whether it ran.

Passing "for the right reason" (SC-007) means these three agree:

```bash
grep -n "'@playwright/test@" pnpm-lock.yaml | head -2      # resolves 1.62.1
grep -n "mcr.microsoft.com/playwright:v" .forgejo/workflows/app-ci.yml   # two lines, v1.62.1-noble
```

## 2. The gate proves it can fail

```bash
node scripts/check-toolchain-consistency.mjs --selftest
```

**Expect** exit `0` and a `✓ … --selftest passed` line. This is the in-CI proof that the gate is
capable of rejecting a mismatched pair — a gate that cannot fail is not a gate.

## 3. The deliberate-break drill — the one that actually matters

Steps 1 and 2 both pass on an unmodified tree, so neither distinguishes a working gate from a gate
that returns "clean" unconditionally. This step does.

```bash
# Break ONE of the two occurrences — a partial bump is the case the item calls out explicitly.
sed -i '0,/playwright:v1\.62\.1-noble/s//playwright:v1.60.0-noble/' .forgejo/workflows/app-ci.yml

node scripts/check-toolchain-consistency.mjs; echo "exit=$?"
```

**Expect** exit `1`, and a message naming `1.62.1`, `1.60.0`, and
`.forgejo/workflows/app-ci.yml:<line>`. Diagnosis must need nothing but this message — no container
log, no second file (SC-002).

```bash
git checkout -- .forgejo/workflows/app-ci.yml     # ALWAYS restore
node scripts/check-toolchain-consistency.mjs      # back to exit 0
```

> Do not skip the restore. Leaving the break in place is the drift the gate exists to catch, and it
> will red every subsequent run.

## 4. The bot moves both halves — verified by result, not by reading config

```bash
# 4a. Validity. Same major CI runs (`npx --yes renovate@44`).
#     With no arguments the validator reads the repository config — that is intended here.
npx --yes --package renovate@44 -- renovate-config-validator

# 4b. Extraction. Offline: no token, no platform, no network. ~3 s.
LOG_LEVEL=debug RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=extract \
  npx --yes --package renovate@44 -- renovate > /tmp/extract-after.log 2>&1
echo "exit=$?"

grep -n "app-ci.yml" -A6 /tmp/extract-after.log | grep -n "playwright" 
```

**Expect** a `custom.regex` manager entry with `packageFile: .forgejo/workflows/app-ci.yml`,
`depName: @playwright/test`, `currentValue: 1.62.1` — appearing **twice**, once per occurrence.

**The before-state, measured on `main` @ `68a40784`, is what makes this evidence**:

| | Before | After |
|---|---|---|
| `@playwright/test` via `npm` manager | extracted, 2 packageFiles | unchanged |
| `.forgejo/workflows/app-ci.yml` | matched by `github-actions` **only** (reads `uses:`, not an image inside `run:`) | also matched by `custom.regex` |
| the image tag | **extracted by nothing** | extracted, ×2 |

**What 4b cannot prove**: grouping. It reports `lookup: 0` and `requests: 0`, so no branches are
computed. That is what step 5 is for.

## 5. Grouping and ordering — the durable assertions

```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
node --test scripts/__tests__/check-toolchain-consistency.test.mjs
```

**Expect** all pass. Between them these assert: both halves resolve to one group on patch, minor
**and** major; the last rule to group Playwright matches both `npm` and `custom.regex`; it carries no
`matchUpdateTypes`; the customManager still targets `app-ci.yml`; and — the control — `@nx/playwright`
still lands in `nx monorepo` while an unrelated npm package does not land in the Playwright group.

## 6. Everything the `naming` job will run

```bash
node --test scripts/__tests__/*.test.mjs
node scripts/check-toolchain-consistency.mjs --selftest
node scripts/check-toolchain-consistency.mjs
```

Or the whole local pre-push path, which already lists this gate:

```bash
node scripts/preflight.mjs
```

## 7. Runbook accuracy (FR-013)

```bash
grep -n "check-toolchain-consistency" docs/runbooks/devcontainer.md docs/runbooks/e2e-testing.md
```

**Expect** a hit in **each**. Both files already *state* the pin rule; the requirement is that they
now also **name the gate that enforces it**. A rule stated without its enforcement is the same
silent-drift shape in a different medium.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Cannot find package 'yaml'` | `pnpm install --frozen-lockfile` has not run. In CI the `naming` job runs it before any gate step. |
| Exit `2`, "could not run" | An input was unreadable or unparseable — the gate could not form an opinion. Distinct from exit `1`, which means the repository is wrong. |
| Gate fails naming a `specs/**` file | The scan has leaked outside `app-ci.yml`. `specs/**` contains the old `v1.60.0-noble` tag as a point-in-time record and is explicitly out of scope. |
| Step 4a fails on `engines.node` | renovate@44 requires Node ≥ 24.11. Steps 1–3 and 5 have no such requirement. |
| `renovate-workflow.guard.test.mjs` throws "packageRule uses '<key>', which this guard does not model" | Working as designed. Extend `ruleMatches()` before adding a new rule key, or the grouping assertions silently stop meaning anything. |
