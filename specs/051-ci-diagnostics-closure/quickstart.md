# Quickstart — validating 051

How to prove each story actually works. Every check below is stated as an **observed result**, never
an exit status — FR-022 exists because the two incidents this feature closes were both prolonged by
treating a green run as evidence.

## Prerequisites

- The Linux dev container (Node ≥ 22.13; CI scripts need no install).
- For Story 1's full proof: a CI run on this branch, and the agent stack deployed by the job itself.
- For Story 5's full proof: a **Windows** host. Not available in this container — operator-verified.

---

## Story 1 — the E2E agent gate (#158)

**Local mechanism check** — run the CI invocation verbatim, with and without the flag:

```bash
# without the flag (today's CI behaviour)
docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
  -e E2E_BFF_TARGET=dev-container -e CI=1 \
  mcr.microsoft.com/playwright:v1.60.0-noble \
  sh -c "corepack enable && pnpm exec playwright test tests/e2e/web/agent-navigate-movie.spec.ts --list"
```

Expected today: the specs report as skipped. With `-e E2E_AGENT_PRODUCTION=1` added they execute.
With `-e E2E_REQUIRE_AGENT_STACK=1` and the stack down, the run **fails loudly** naming the missing
stack rather than skipping.

**Enumeration check** — this is the check that found the second defect, so it is part of validation,
not a one-off:

```bash
grep -rhoE "process\.env\.[A-Z0-9_]+|process\.env\[['\"][A-Z0-9_]+" frontend/mcm-app/tests/e2e/ \
  | sed -E "s/.*env[.\[]['\"]?//" | sort -u
```

Every name must appear in [contracts/e2e-env-forwarding.md](./contracts/e2e-env-forwarding.md) as
either forwarded or deliberately not forwarded. A name in neither column is an unclosed gap.

**CI acceptance**: a run shows a non-zero executed count and a zero skip count for the agent specs
and for `admin-card` / `admin-registration`.

---

## Story 2 — step instrumentation

**Reproduce the mechanism the PRD got wrong**, so the reasoning stays checkable:

```bash
tmp=$(mktemp -d)
HOME="$tmp" GITHUB_RUN_ID=999 bash scripts/ci-log-step.sh probe \
  sh -c 'echo "REAL FAILURE"; exit 3'; echo "exit=$?"
node -e 'import("./scripts/ci-failure-digest.mjs").then(m=>{
  const home=process.env.T, env={HOME:home,GITHUB_RUN_ID:"999"};
  console.log(m.readFailingStep(env,home));
  console.log(m.collectEvidence({home,cwd:process.cwd(),env}).excerpts);
})' T="$tmp"
```

Expected: `probe`, and an excerpt containing `REAL FAILURE`. This is what proves the digest reads the
capture in-job and that relocation is unnecessary.

**Gate check**:

```bash
node scripts/check-ci-digest-coverage.mjs --selftest   # fail + exemption paths proven
node scripts/check-ci-digest-coverage.mjs              # real scan, must pass on the finished tree
```

Then unwrap one step by hand and confirm the gate fails **naming that job and step**. Re-wrap.

---

## Story 3 — loud digest failure

```bash
node --test scripts/__tests__/ci-failure-digest.test.mjs
node --test scripts/__tests__/ci-status.test.mjs
```

Expected new cases: a forced publication failure yields the `failed` outcome with its sub-reason; a
successful run yields `not-needed`; and in both cases the process exit code is **0**.

**CI acceptance (SC-003)**: deliberately break the digest step on this branch, then run
`node scripts/ci-status.mjs failure --pr <n>` and confirm the report says the digest **ran and
failed** — not that none was published.

---

## Story 4 — secretless survival

**Blocked until the R7 probe answers.** Run the probe first (temporary commit, reverted):

```yaml
- name: PROBE — auto-token capability (TEMPORARY, revert before merge)
  run: |
    echo "auto token length: ${#GITHUB_TOKEN}"
    curl -s -o /dev/null -w "statuses write: %{http_code}\n" \
      -X POST -H "Authorization: token $GITHUB_TOKEN" \
      "$GITHUB_SERVER_URL/api/v1/repos/$GITHUB_REPOSITORY/statuses/$GITHUB_SHA" \
      -d '{"state":"success","context":"probe","description":"probe"}'
```

Never print the token itself — only its length and the HTTP status.

**Acceptance (SC-004)**: with `CI_DIGEST_TOKEN` unset, a failing job still surfaces the failing step's
identity. If the probe shows the auto token cannot do this, stop and renegotiate SC-004 with the
operator rather than weakening it silently.

---

## Story 7 — line-ending-independent gates

The whole point is to prove this **without** relying on a checkout, so feed carriage-return input
directly:

```bash
# the fails-closed one: exemption markers must be visible on CRLF input
node -e 'import("./scripts/check-ci-digest-coverage.mjs").then(m=>{
  const lf = "  myjob:\n    # ci-digest-exempt: because reasons\n";
  console.log("LF  ->", m.parseExemptions(lf));
  console.log("CRLF->", m.parseExemptions(lf.replace(/\n/g, "\r\n")));
})'
```

Expected after the fix: both print the same map. Before the fix, the CRLF line prints an empty map —
that is PRD §1.3.

```bash
# the fails-OPEN one: drift must still be reported on CRLF input
node --test scripts/__tests__/check-openwiki-okf.test.mjs
```

The new case converts the stale-concept fixture to carriage-return endings and asserts the drift
warning still names the stale file. Before the fix it prints `✅ conformant` and the check silently
does not run.

**Declaration layer**:

```bash
git check-attr text eol -- .forgejo/workflows/app-ci.yml openwiki/quickstart.md
```

Expected: `eol: lf` for both.

**Operator step after this lands** — the declaration governs future checkouts, not files already in a
working tree. On the Windows clone:

```powershell
git rm --cached -r .
git reset --hard
git status        # expect clean; if not, the normalization is the diff
```

---

## Story 5 — Windows parity (#157 and the sweep)

Linux, here:

```bash
node --test "scripts/__tests__/*.test.mjs"
```

**Mutation check** — the fix must not weaken the containment assertion. Temporarily make
`safeBundleEntryPath` return `join(base, …)` without its containment check and confirm the traversal
cases `(y2)`–`(y4)` **fail**. Revert.

**Skip-guard check** — prove the capability probe skips for the right reason rather than passing by
luck. Point the step-wrapper suite at a shell that cannot see the working tree and confirm it reports
a skip naming that condition, not nine failures.

**Tracking check** — create an untracked `frontend/mcm-app/.env.example`, run
`gen-dev-env.guard.test.mjs`, confirm it stays green; then `git add -N` it and confirm the guard
fires.

Windows, operator — this is the run that closes item #157:

```powershell
node --test "scripts/__tests__/*.test.mjs"
```

Baseline before the change: **408 collected, 392 pass, 15 fail**. Target: **0 failures**, made up of
nine reasoned skips (`ci-log-step` — the component runs only in Linux CI containers, so a skip naming
the unmet shell condition is the honest result) and six passes. Expect the **collected total to rise
above 408**: `wiki-maintain.test.mjs` aborts at load today, so its cases are not collected at all
until that import is fixed. A total that *falls* means a selector stopped matching — that is a
failure, not a pass.

Note `node --test scripts\__tests__` (directory form) does not discover tests on Node v24.14.1 — use
the glob, which is what CI uses.

---

## Story 6 — documentation (#155)

```bash
pnpm nx wiki-update            # regenerate the index — never hand-edit it
pnpm nx okf-lint
node scripts/check-openwiki-governance.mjs
```

Then confirm by search, the way a future session would actually look:

```bash
grep -rn -- "--offline" docs/runbooks/ openwiki/
grep -rn "rustfmt" docs/runbooks/ openwiki/
grep -rn "increment 2" docs/runbooks/devcontainer.md    # must return nothing
```

`openwiki/policy.yaml` must permit the touched paths — check that **before** writing, not after.

---

## Before opening the pull request

```bash
git log --oneline origin/main..HEAD           # no PROBE / deliberate-breakage commits remain
git diff origin/main..HEAD -- .forgejo/ | grep -i "probe\|deliberate\|FIXME"   # must be empty
node --test scripts/__tests__/*.test.mjs      # full script suite green
```

SC-008 is this check. A probe or breakage commit reaching `main` would be the same class of mistake
as the 2026-08-01 probe that was merged to read a token's length.
