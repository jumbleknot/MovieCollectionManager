# Phase 0 Research — 051 CI diagnostics closure

**Date**: 2026-08-09 · **Method**: code reading plus local reproduction. Every claim below states how
it was established. Where something could only be established on the CI runner, it is listed in
§R7 as an open question with the probe that answers it — not asserted.

---

## R1 — PRD §3.1 rests on a misdiagnosis. Do NOT move step logs. **DECIDED: reject**

**The PRD's claim**: `ci-log-step.sh` writes to `$HOME/mcm-ci-step-logs/`, which lives inside the
container and is destroyed at teardown; therefore containerized jobs are undiagnosable, and the fix
is to write the logs under the workspace so the host can see them.

**What is actually true**: the digest is not a host-side reader. `Publish failure digest` is a step
**inside the same job**, and in the container executor every step of a job runs in the **same
container**. The digest therefore reads the step logs from the same `$HOME`, before teardown, and
pushes the evidence out over the forge API — as a PR comment or commit status, plus a generic
package for the full bundle. Nothing in that path requires the files to outlive the container.

**How this was established** — reproduced locally end to end, not inferred:

```
$ HOME=<tmp> GITHUB_RUN_ID=999 bash scripts/ci-log-step.sh probe-step \
    sh -c 'echo "REAL FAILURE OUTPUT: thread panicked at src/lib.rs:42"; exit 3'
  wrapper exit=3
  <tmp>/mcm-ci-step-logs/999/_failed-step
  <tmp>/mcm-ci-step-logs/999/probe-step.log

$ node -e '<call readFailingStep + collectEvidence with the same HOME>'
  failing step -> "probe-step"
  excerpts    -> [ { source: 'step:probe-step',
                     text: 'REAL FAILURE OUTPUT: thread panicked at src/lib.rs:42' } ]
```

Supporting code facts: [scripts/ci-failure-digest.mjs:315-316](../../scripts/ci-failure-digest.mjs#L315-L316)
derives the log directory from `env.HOME` at digest time;
[.forgejo/workflows/app-ci.yml:209-228](../../.forgejo/workflows/app-ci.yml#L209-L228) shows the
wrapped steps and the digest step in one job; the full bundle is pushed to the forge's **generic
package registry** from inside the job
([ci-failure-digest.mjs:614-635](../../scripts/ci-failure-digest.mjs#L614-L635)), not collected from
the host afterwards.

**What the PRD's own measurement actually showed.** "`~/mcm-ci-step-logs/` on the runner contains
captures only from `cd-deploy/build-deploy` and the devcontainer image build" is true and consistent
with the above: host-executor jobs leave their logs lying on the host, container jobs consume theirs
in-job and take them with them. The absence of container-job leftovers on the host is evidence about
**leftovers**, not about **diagnosability**. Reading it as the latter is the misdiagnosis.

**Decision**: reject §3.1. Do not relocate step logs.

**Alternatives considered**:

- *Verify workspace persistence on the runner and move the logs anyway.* Rejected. It buys nothing
  the digest does not already have, and it costs: a new leak surface (workspace-relative logs on a
  persistent runner, which the PRD itself names as a residual risk), a `.gitignore` entry, and a
  retention sweep that must be re-proven in a new location.
- *Move only the `_failed-step` marker.* Rejected for the same reason — the marker is read in-job too.

**Consequence for the spec**: FR-004 (verify workspace persistence first) is **discharged by
answering the underlying question differently** — the persistence question is moot because
persistence is not required. FR-005/006/007/009 are restated in the plan against the real gap (R2).
This is exactly the outcome FR-004 existed to produce: the assumption was checked before anything was
built on it.

---

## R2 — The real gap is instrumentation coverage, not persistence. **DECIDED: this is Story 2's work**

If the digest can read the logs, why was every guardrail failure undiagnosable? Because **most steps
are not wrapped at all**, so there is no log to read.

Measured across `.forgejo/workflows/` by scanning each containerized job's `run:` steps and
classifying them as wrapped / digest / bare:

| Job (container executor) | `run:` steps | wrapped | **unwrapped** |
| --- | ---: | ---: | ---: |
| `guardrails / naming` | 16 | 2 | **13** |
| `guardrails / sast` | 11 | 1 | **9** |
| `wiki-maintain / maintain` | 11 | 2 | **8** |
| `guardrails / agent-gates` | 7 | 3 | **3** |
| `infra-image-scan / infra-image-scan` | 7 | 3 | **3** |
| `app-ci / mc-service-checks` | 6 | 3 | **2** |
| `app-ci / trigger-cd` | 3 | 0 | **2** |
| `cd-deploy / prod-apk` | 4 | 1 | **2** |
| `guardrails / secret-scan` | 3 | 1 | **1** |
| `app-ci / affected` | 4 | 2 | **1** |
| `guardrails / okf` | 5 | 2 | **2** (both pure setup) |

`guardrails / naming` is the clearest case, and it was verified by reading the file rather than
trusting the scan: **every actual gate step runs bare** — the resource-naming gate, the
Komodo-sync topology gate, the topology-scrub gate, the argv-secret gate, the port-collision gate,
the restart-policy gate, the CI-digest coverage gate, the toolchain-consistency gate, the DAST
selftest and the realm-consistency gate. The only two wrapped steps are `Script unit tests` and
`DAST leak-scan guard`. So when the job fails for the reason it exists to catch, the digest faithfully
publishes the logs of two **unrelated** steps and says nothing about the failure.

**Why the existing coverage gate does not catch this**:
`check-ci-digest-coverage.mjs` requires each job to publish a digest and to have **at least one**
wrapped step. One is enough to pass. It never asks whether the step that can actually fail is wrapped.

**Decision**: Story 2 becomes *instrument the steps that can fail, and tighten the gate that is
supposed to enforce it* — wrap the unwrapped `run:` steps in containerized jobs, and strengthen
`check-ci-digest-coverage.mjs` to require every `run:` step to be wrapped or carry an explicit,
justified exemption marker (the marker mechanism already exists and is already used).

**Alternatives considered**:

- *Wrap only the gate steps, leave setup steps bare.* Rejected. `pnpm install --frozen-lockfile` and
  `apt-get install` failing are real, recurring CI failure modes, and a lockfile error is precisely
  the kind of one-line fact this feature exists to surface.
- *Auto-wrap every step via a composite action or shell wrapper.* Rejected as too large and too
  invasive for the value; the explicit call is greppable and the gate can enforce it mechanically.

---

## R3 — The credential dependency is the true root cause of the 2026-08-01 silence. **DECIDED: keep §3.3**

With R1 and R2 established, the evening incident resolves cleanly: the digest **collected** its
evidence and then could not **publish** it. `CI_DIGEST_TOKEN` is an Actions secret; on the AGit-headed
run every secret was empty; the script fell back to printing the digest inline
([ci-failure-digest.mjs:670-673](../../scripts/ci-failure-digest.mjs#L670-L673)) — into job output
that the forge API cannot expose — and exited 0. Zero comments on the PR, no error, no signal.

So §3.3 is not defence-in-depth; it is the fix for the incident the PRD was written about. It stands.

**Decision**: when `CI_DIGEST_TOKEN` is absent, fall back to the run's automatically-provisioned
token and publish a **commit status** carrying the failing step's name and a short excerpt. When the
purpose-scoped token is present, behaviour is unchanged.

**What already exists** (so this is credential selection, not new machinery): the digest already has a
commit-status publication path for push events and already names `write:repository` as the scope that
endpoint needs ([ci-failure-digest.mjs:585-588](../../scripts/ci-failure-digest.mjs#L585-L588)).

**What is NOT yet established**: whether the auto token is itself populated on a secretless run, and
whether it can write the statuses endpoint. See R7 — this is the one load-bearing unknown, and it is
not answerable from this container.

---

## R4 — Item #158 is real, and there is a **second** silent skip in the same job. **DECIDED: fix both**

**Confirmed as reported.** The job sets `E2E_AGENT_PRODUCTION: '1'` at job level
([app-ci.yml:253](../../.forgejo/workflows/app-ci.yml#L253)) but the Playwright container invocation
([app-ci.yml:591-597](../../.forgejo/workflows/app-ci.yml#L591-L597)) forwards only
`E2E_BFF_TARGET`, `E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `CI`, `E2E_AGENT_PROVIDER`,
`ANTHROPIC_API_KEY`, `TMDB_API_KEY`. `agentStackEnabled()` tests
`process.env['E2E_AGENT_PRODUCTION'] === '1'`, so inside the container it is false, and
`agentStackRequired()` is false too because `E2E_REQUIRE_AGENT_STACK` is never set anywhere — so the
gate takes its skip branch instead of the loud-failure branch written for exactly this.

**New finding — the enumeration required by FR-003 turned up a second one.** Enumerating every
environment variable the web E2E suite reads and diffing it against the forwarded set:

| Read by the suite | Forwarded? | Verdict |
| --- | --- | --- |
| `E2E_AGENT_PRODUCTION` | **no** | **defect** — item #158, all `agent-*.spec.ts` skip |
| `KEYCLOAK_SERVICE_CLIENT_SECRET` | **no** (and not set at job level either) | **defect** — `admin-card.spec.ts` and `admin-registration.spec.ts` skip |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_SERVICE_CLIENT_ID` | no | acceptable — defaults in `keycloak-admin.ts` match the CI topology (`http://localhost:8099`, `grumpyrobot`), and the container runs `--network host` |
| `E2E_AGENT_OLLAMA_URL` | no | intentional — the provider is `anthropic` in CI |
| `E2E_LARGE_LIBRARY`, `E2E_LARGE_LIBRARY_SIZE` | no | intentional — opt-in performance scenario |
| `E2E_BFF_TARGET`, `E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `CI`, `E2E_AGENT_PROVIDER`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY` | yes | correct |

The admin specs skip on `test.skip(!keycloakAdminEnabled(), 'KEYCLOAK_SERVICE_CLIENT_SECRET not set
(admin user seeding)')`. The secret **does** exist in the forge — the same workflow consumes
`secrets.KEYCLOAK_SERVICE_CLIENT_SECRET` for the integration step at
[app-ci.yml:575](../../.forgejo/workflows/app-ci.yml#L575) — it is simply absent from the `app-e2e`
job's `env:` block, so there is nothing for a pass-through `-e` to forward. The fix therefore needs
**both** the job-level `env:` entry and the `-e` flag.

**Decision**: forward `E2E_AGENT_PRODUCTION`, set `E2E_REQUIRE_AGENT_STACK=1`, and add
`KEYCLOAK_SERVICE_CLIENT_SECRET` at job level plus forward it. Record the four intentional omissions
in a comment beside the invocation so the next reader does not have to re-derive this table.

**Backlog consequence**: no new item. The admin-spec skip is already covered by item #158's fourth
acceptance criterion — "consider whether the same `-e` omission affects other flags the suite depends
on" — which is exactly the check that found it. It is fixed under #158 and recorded in this table so
the criterion can be closed with evidence rather than with a judgement call.

---

## R5 — Item #157 is a two-line fix with a real trap. **DECIDED: compare resolved-to-resolved**

> **Superseded in scope by R8.** The decision below stands for the one assertion #157 named, but the
> operator's Windows sweep found six further defects. R8 is the authority on Story 5's scope.


[ci-status.mjs:786-787](../../scripts/ci-status.mjs#L786-L787) returns `resolve(base, …)`;
[ci-status.test.mjs:348](../../scripts/__tests__/ci-status.test.mjs#L348) expects `join(root, …)`.
On Windows `resolve` prepends the current drive and `join` does not, so they differ.

The trap is that the obvious fix — relaxing the assertion to a `.endsWith()` or a substring check —
would also stop the test detecting a genuine escape from the bundle root, which is the whole point of
the case: the block guards a zip-slip path that turns a compromised CI token into arbitrary file
write on a developer's machine. **Decision**: change the expectation to `resolve(root, …)` so both
sides normalize identically, and keep the throwing cases exactly as they are. Cases `(y2)`–`(y4)`
assert `throws`, so they are drive-agnostic already — but they are re-checked on Windows rather than
assumed.

**Verification**: Linux here; Windows by the operator. Item #157 stays open until the operator
confirms. A mutation check (deliberately make `safeBundleEntryPath` return a joined path and confirm
the case fails) proves the assertion still bites.

---

## R6 — Item #155 placement follows CLAUDE.md's own rule. **DECIDED**

- **Fact 1 (offline resolution + the lock-discipline corollary) → `docs/runbooks/devcontainer.md`.**
  `openwiki/runbooks/devcontainer.md` cites that file as its `resource`, and CLAUDE.md's rule is that
  a concept citing a resource is a derived summary, so the learning goes into the cited source and the
  concept picks it up on regeneration. The runbook already teaches the same diagnostic reflex —
  "check the firewall allowlist before suspecting the tool" — so this is an addition to an existing
  section, not a new one.
- **Fact 2 (whole-crate formatting scope trap) → a new canonical `openwiki/gotchas/` concept.** No
  upstream document covers Rust formatting convention here, which is the case CLAUDE.md says to add a
  concept for. It must carry the "format only what you touch" convention plus the pre-existing drift
  and lint-gate context, because without that a whole-crate format reads as a harmless tidy-up rather
  than a manufactured diff.
- **The stale toolchain-scope claim** sits adjacent to where fact 1 lands, so it is corrected in the
  same pass.
- The index is regenerated with `pnpm nx wiki-update`; `okf-lint` and
  `check-openwiki-governance.mjs` gate the result. `openwiki/policy.yaml` must permit the touched
  paths — checked before writing, not after.

---

## R7 — Open question, answerable only on CI

**Q: On a run where Actions secrets are empty, is the automatically-provisioned token populated, and
can it write `POST /repos/{owner}/{repo}/statuses/{sha}`?**

This is load-bearing for R3: if the auto token is also empty on such a run, a commit-status fallback
publishes nothing and Story 4 needs a different answer (the realistic alternative being to make the
*absence* itself loud — a distinguishable non-zero-cost marker plus a `ci-status` report that names
the secretless condition by name, which is Story 3's machinery reused).

**Why it cannot be answered here**: no Actions context in this container, and the repository currently
uses the auto token nowhere for API calls — `cd-deploy.yml:30` only records that it is *not* a
push-whitelisted user, which says nothing about its API scopes.

**The probe that answers it**: a temporary step on this branch that prints the token's **length** and
the HTTP status of a statuses write against a scratch commit — never the token itself. This is the
same probe shape used on 2026-08-01, and it is acceptable here because the branch already carries
deliberate-breakage commits that are reverted before merge.

**Sequencing consequence**: Story 4 is planned but not implemented until this probe returns. Stories
1, 2, 3, 5 and 6 do not depend on it and proceed in parallel.

---

## R8 — The Windows sweep. Seven defects in three classes, two of them live gate bugs

**Source**: operator-run measurement on a Windows host, 2026-08-09, Node v24.14.1. Read-only probes;
nothing was changed. This is the only measurement in this document not taken by the agent, and it is
the one that overturned a claim the agent had asserted.

**Baseline**: `node --test "scripts/__tests__/*.test.mjs"` → **408 tests, 392 pass, 15 fail, 1
skipped**, exit 1, across five files. (The glob form matters: `node --test <dir>` does not discover
tests on this Node build, and the glob is what CI uses anyway.)

### R8a — PRD §1.3 is NOT resolved. **The agent's earlier claim was wrong.**

This spec recorded §1.3 as closed on the basis of a Linux run: `✓ ci-digest coverage gate passed`,
exit 0. The Windows run produces the PRD's failure verbatim, naming **the same three jobs**:
`app-ci / changes`, `app-ci / trigger-cd`, `infra-image-scan / changes`. The PRD's author was
evidently on Windows; the agent measured on Linux and generalised.

**This is the feature's own thesis, committed by the feature.** A green result was accepted as
evidence from an environment that never exercised the failing path — which is exactly what SC-002 and
SC-005 forbid, and exactly what the two 2026-08-01 incidents did. It is recorded here rather than
quietly corrected, because the correction is more instructive than the fix. FR-031 exists because of
it: a pass claim must name the platform it was observed on.

**Root cause, verified by reading the code**:
[check-ci-digest-coverage.mjs:47](../../scripts/check-ci-digest-coverage.mjs#L47) does
`text.split('\n')`, leaving a trailing `\r` on every line of a CRLF checkout. The marker pattern
`#\s*<marker>:(.*)$` then cannot match: `.` does not consume `\r` (it is a line terminator in
JavaScript regular expressions), and `$` without the multiline flag matches only end-of-input. The
job-header pattern on the adjacent line, `^ {2}([A-Za-z0-9_-]+):\s*$`, survives because its `\s*`
absorbs the `\r`. **That asymmetry is the entire bug** — the parser sees the jobs but not their
exemptions, so it reports as uncovered three jobs that are correctly exempt.

Direction of failure: **closed**. Noisy and safe, but wrong, and it sent a PRD author after the wrong
diagnosis.

### R8b — The same class in a second gate, failing **open**

[check-openwiki-okf.mjs:254](../../scripts/check-openwiki-okf.mjs#L254) guards its drift check with
`!Number.isNaN(Date.parse(fields.timestamp))` on the **untrimmed** value. On CRLF input the timestamp
parses as `…Z\r` → `NaN` → the guard reads it as "no usable timestamp" and the staleness check never
runs. The gate then reports `✅ conformant`. V5 at
[line 237](../../scripts/check-openwiki-okf.mjs#L237) escapes this only because it calls `.trim()`
first.

Direction of failure: **open**. A gate reporting green while not checking — the exact failure class
this feature exists to close, found inside the feature's own toolchain. This is why Story 7 is P1.

### R8c — Root cause of the family, and the fix at both layers

[.gitattributes](../../.gitattributes) declares `eol=lf` for `*.sh` only, with a comment explaining
that a CRLF shebang breaks a container. The same reasoning was never extended to the file types the
gates *parse*. With `core.autocrlf=true`, every `.yml` and `.md` in a Windows working tree is CRLF.

**Decision (operator-directed): fix both layers.**

1. Declare normalization for the parsed file types in `.gitattributes`, so the condition stops being
   produced.
2. Make both parsers carriage-return tolerant, so a gate's verdict never depends on a contributor's
   local version-control configuration.

Layer 1 alone leaves the gates config-dependent; layer 2 alone leaves the next parser to inherit the
trap. **Operator note**: existing Windows clones need re-normalizing after this lands
(`git rm --cached -r . && git reset --hard`) — the declaration governs future checkouts, not files
already in a working tree.

### R8d — Path handling, three defects

| Location | Defect | Fix |
| --- | --- | --- |
| `ci-status.test.mjs:347` | `resolve()` result compared to a `join()` expectation; `resolve` prepends the drive | Compare resolved-to-resolved (R5) |
| `check-toolchain-consistency.mjs` findings output | Emits the platform separator (`.forgejo\workflows\ci.yml`) where the test expects a stable one | Normalize the **emitted** location to forward slashes — it is a report for a human, and a stable representation is worth more than the platform's native one. Fix the source, not the assertion |
| `wiki-maintain.test.mjs:24` | `await import(SCRIPT)` on an absolute path — `ERR_UNSUPPORTED_ESM_URL_SCHEME`, protocol `e:`. Aborts the whole file before any case runs | `pathToFileURL()`. Verified: that helper appears **nowhere** in the repository, so this pattern is worth checking for elsewhere |

Note the second is a **source** fix, not a test fix. The test is asserting the more useful contract.

### R8e — A capability probe that answers the wrong question

`ci-log-step.test.mjs:21` probes `bash -c 'exit 0'` to decide whether to skip. On this host `bash`
resolves to WSL's bash, which starts successfully — and then cannot see `E:\…`, so all nine cases
fail with status 127 rather than skipping. Git Bash is installed but is not what is on `PATH`.

This is the same shape as the gate in CLAUDE.md about proving "it can't run in this environment": the
probe answers *does a shell exist* when the question is *can that shell reach my files*. **Decision**:
probe the capability actually needed — have the candidate shell stat the script under test — and skip
with a reason naming the unmet condition.

### R8f — A tripwire keyed on the filesystem rather than on version control

`gen-dev-env.guard.test.mjs:98` asserts `frontend/mcm-app/.env.example` is absent. Verified here: the
path is **gitignored** (`.gitignore:13`, `*.env.*`) and does not exist in the repository. The operator
has an untracked local copy, so the guard fires for them and not in CI.

The guard's own message — "if an `.env.example` is ever added, this guard and the generator advice
should be revisited together" — makes the intent clear: it is watching for the file being **added to
the repository**. **Decision**: test tracking (`git ls-files`), not working-directory presence. Lowest
severity of the seven, and a genuine defect.

### Scope decision

All seven land in this feature, at the operator's direction. R8a/R8b become Story 7 (P1, gate
correctness); R8d/R8e/R8f become Story 5 (P3, developer experience).

---

## Summary of decisions

| # | Decision | Effect on the spec |
| --- | --- | --- |
| R1 | Reject PRD §3.1 — do not relocate step logs; the premise is false | FR-004 discharged; FR-005/006/007/009 restated against R2 |
| R2 | Story 2 becomes step-instrumentation coverage + a stricter coverage gate | New requirement surface; measured baseline recorded above |
| R3 | Keep §3.3 — the credential is the actual root cause | FR-013/014/015 unchanged, gated on R7 |
| R4 | Fix #158 **and** the newly found admin-spec skip; document intentional omissions | FR-001/002/003 unchanged; scope grows by one defect |
| R5 | Compare resolved-to-resolved; prove the assertion still bites | Superseded in scope by R8 |
| R6 | Placement per CLAUDE.md's "where a new learning goes" | FR-025..028 |
| R7 | Auto-token capability is unproven — probe before implementing Story 4 | Story 4 sequenced behind a probe |
| **R8a** | **PRD §1.3 is reopened — the agent's "resolved" claim was a Linux-only measurement** | New Story 7; SC-008; FR-031 |
| R8b | A second gate in the same class fails **open** — silent skipped staleness check | Story 7, P1 |
| R8c | Fix line endings at both layers — declaration *and* tolerant parsing | FR-021..024 |
| R8d/e/f | Three path defects, one wrong-question probe, one filesystem-vs-tracking tripwire | FR-016..020 |
