# Quickstart: validating feature 057

**Feature**: `057-dependency-security-loop` · **Date**: 2026-08-13

How to prove each story works. Ordered so the offline checks come first — most of this feature is
verifiable in the devcontainer with no stack, no credentials and no CI run.

**Read this first**: a passing command is not evidence on its own. Several checks here fail *open* —
a gate that finds nothing prints the same green as a gate that ran nothing. Where that risk exists,
the expected output below names a **count** or a **specific line**, not just an exit code. Check the
count.

## Prerequisites

```bash
pnpm install --frozen-lockfile   # once
```

No running stack is needed for anything in Offline, which is Stories 1, 2, 4 (guard half) and 5.

---

## Offline — the tooling tier

### Everything at once

```bash
node --test scripts/__tests__/*.test.mjs
```

Expected: all pass. New files (`allowlist-expiry.test.mjs`, `check-override-consistency.test.mjs`,
`renovate-workflow.guard.test.mjs`) are picked up by the glob — no wiring needed. **If the new test
names do not appear in the output, the files are not being discovered** — that reads as a pass and is
the failure mode this note exists for.

### Stories 1-2 — the workflow guard (Node pin + schedule)

```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```

- **Before the fix** (on `main`): FAILS — no workflow cron falls inside the permitted window.
  This is the RED for Stories 1-2.
- **After**: passes, including the EST offset case.

Then confirm the existing toolchain gate accepts the new Node pin:

```bash
node scripts/check-toolchain-consistency.mjs --selftest
node scripts/check-toolchain-consistency.mjs
```

Expected: exit 0 both times. This gate already validates every `node-version:` in
`.forgejo/workflows` against `engines.node` (`>=22.13`), so a typo'd `24.14.1` fails here rather than
in CI.

### Story 4 — the consistency guard

```bash
node scripts/check-override-consistency.mjs --selftest   # proves it detects
node scripts/check-override-consistency.mjs              # scans the real map
```

Expected: both exit 0. The real map has **10 keyed floors, all agreeing** — the guard is green on
arrival by design.

To see it work rather than trust it, break one half in a scratch copy:

```bash
mkdir -p /tmp/ovr && cp pnpm-workspace.yaml /tmp/ovr/
sed -i "s|fast-uri@<3.1.4: '>=3.1.4 <4'|fast-uri@<3.1.4: '>=3.1.5 <4'|" /tmp/ovr/pnpm-workspace.yaml
node scripts/check-override-consistency.mjs --dir /tmp/ovr
```

Expected: exit 1, naming `fast-uri` and both halves. **Do not edit the real file to test this.**

### Story 5 — the warning tier

```bash
node scripts/check-sast-findings.mjs --selftest
node scripts/check-infra-image-findings.mjs --selftest
```

Expected: both exit 0, and the summary line names the new cases alongside the existing ones.

Then prove the exit code did **not** move — the binding constraint (FR-021, SC-007):

```bash
node scripts/check-sast-findings.mjs ; echo "exit=$?"
```

Expected: `exit=0`, with an `EXPIRING SOON` section present or absent depending on the date, but the
code unchanged either way. An entry inside the window must still suppress.

The dedicated mode, which is allowed to fail:

```bash
node scripts/check-sast-findings.mjs --check-expiring ; echo "exit=$?"
node scripts/check-infra-image-findings.mjs --check-expiring ; echo "exit=$?"
```

Expected **today (2026-08-13)**: `exit=0` from both — the earliest expiry is 08-31, 18 days out,
outside the 14-day window.

Expected **from 2026-08-24**: `exit=1` from the SAST gate, naming the `image-size` pair. See
*Predicted behaviour* below.

---

## Requires the scanners — Story 3

```bash
node scripts/sast-scan.mjs --scope full     # or: pnpm nx sast infrastructure-as-code
node scripts/check-sast-findings.mjs
```

Success is **neither advisory appearing at all** — not as a blocking finding, and not as a suppressed
one:

```bash
node scripts/check-sast-findings.mjs | grep -E 'GHSA-7p8r-x3mc-p8w7|GHSA-mwp4-54f8-5fhr' ; echo "matches=$?"
```

Expected: `matches=1` (grep found nothing). A hit under *either* heading means the work is not done —
appearing as suppressed means the entry was re-dated rather than the floor raised, which FR-010
forbids.

Confirm the entries are gone from the file, not just from the output:

```bash
grep -c 'GHSA-7p8r-x3mc-p8w7\|GHSA-mwp4-54f8-5fhr' security/sast/allowlist.yaml
```

Expected: `0`.

And that the lockfile actually resolved the floors:

```bash
grep -A2 -E "^  /?fast-uri@|^  /?ip-address@" pnpm-lock.yaml | head
```

Expected: versions at or above each advisory's fixed version — not merely the override text being
present in `pnpm-workspace.yaml`.

### The build check that unit tests cannot replace

These are JS-toolchain transitives, so a bad floor surfaces at **build** time (FR-013):

```bash
pnpm nx build mcm-app
```

Then the web E2E baseline per `docs/runbooks/e2e-testing.md`. Do not substitute `nx test` — it will
pass with a broken floor.

---

## Requires CI — Stories 1, 2, 4 (manager half)

These cannot be verified locally; they need the bot and the runner.

### The engine fix (US1)

Dispatch `renovate` and read the log.

Expected: exit 0, **no** `EBADENGINE` warning, **no** `Unsupported node environment`. Compare against
run 1587 (task 5278), which showed both.

### The schedule fix (US2)

Dispatch with `dryRun=true` first — it lists what it *would* open without opening anything:

```text
workflow_dispatch → renovate → dryRun: true
```

Expected: the log names branches it would create. Then the real Friday run, after which item #29's
"Awaiting Schedule" groups become open pull requests:

```bash
node scripts/backlog.mjs show 29
```

Expected: the eight groups move out of "Awaiting Schedule".

### The custom manager (US4)

Validate before proposing — the config validator is the cheap half:

```bash
npx --yes --package renovate@44 -- renovate-config-validator renovate.json
```

Then a dry run, and read the **extraction count for `pnpm-workspace.yaml` specifically**:

```text
workflow_dispatch → renovate → dryRun: true
grep the log for pnpm-workspace.yaml dependency extraction
```

Expected: a **non-zero** count. Baseline before this change is **zero**.

**This is the check that decides FR-014 vs FR-019, and it is the one most likely to fool you.** A
mis-keyed manager does not error — `renovate.json`'s own comment records that v41 renamed
`fileMatch` to `managerFilePatterns` and *"a config using the wrong key does not fail loudly, it
silently manages nothing"*. A zero count is indistinguishable from having made no change. If the
count is zero: document the limitation, file a backlog item, and do **not** merge the manager
(FR-019). Story 4 is independent of Story 3 precisely so this outcome cannot delay the dated
remediation.

### No pull request is newly blocked (SC-007)

Open any pull request and read the `infra-image-scan` job's **step list**:

Expected: the allowlist expiry step is **absent**, skipped by `if: github.event_name == 'schedule'`.
Read the step list rather than trusting the expression — a wrong `if:` that still evaluates true
produces a green PR today and a blocked one the moment an entry enters the window.

---

## Predicted behaviour of the new signal

Written down so it is falsifiable rather than a vague expectation.

| When | `--check-expiring` in the weekly run | Why |
| --- | --- | --- |
| First run after merge | **green** | Earliest expiry after Story 3 is 09-07, more than 14 days out |
| **Friday 2026-08-28** | **red**, naming the `image-size` pair | 09-07 enters the 14-day window on 08-24 |
| Friday 2026-09-04 | red, same pair | Until that upgrade lands |

If it goes red earlier or later than 08-28, the window constant or the classification boundary is
wrong — the prediction is a test, not a note.

The `image-size` pair going first is the mechanism working as designed: it has no published fix and
its remediation is an Expo/metro upgrade needing its own branch and a real build — exactly the case
item #154 said should not be discovered on the morning it starts blocking every PR.

---

## Full pre-push sweep

```bash
pnpm nx preflight infrastructure-as-code
```

Runs every cheap gate plus the `scripts/__tests__` tier. Deliberately excludes `app-e2e`, DAST, the
integration tiers and the full SAST scan — those need the CI runner or a live stack. Given the single
CI runner and a ~35-minute `app-e2e`, a red push for an offline-knowable reason is disproportionately
expensive.
