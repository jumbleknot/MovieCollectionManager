# CI Evidence Pipeline

**Feature 042, and every feature since that instrumented a job.** How CI **produces** the evidence a
session reads back with `scripts/ci-status.mjs`: the failure digest, the evidence bundle, per-step
logs and durations, and the gates that keep that machinery from eroding.

**Reading** CI — `ci-status` commands, exit codes, the states the API misreports, tokens, opening and
verifying a pull request — is [ci-diagnostics.md](ci-diagnostics.md). Start there when you are
diagnosing a run; come here when you are adding a job, wrapping a step, or wondering why a piece of
evidence is or is not in a bundle. This file was split out of `ci-diagnostics.md` on 2026-10-09
(item #682).

> **No forge host literal, token, or SSH target belongs in this file** (topology-scrub rule). Every
> command below resolves the host from the `origin` remote at runtime.

---

## The digest

Published per failing job, `if: always()` + `continue-on-error: true` in **all six workflows**
(16 jobs). Channel depends on the event:

| Event | Channel | Identity |
|---|---|---|
| `pull_request` | PR comment, **upserted** | `<!-- ci-digest:job=<job> -->` |
| `push` / other | **inside the bundle** as `digest.md` | derived: `{runId}--{jobSlug}` |
| **cancelled run** | **nothing published** | suppressed (see below) |

> **There is no commit status.** `POST /repos/…/statuses/{sha}` returns **403** for
> `CI_DIGEST_TOKEN` — it needs `write:repository`, which is most of the privilege that made
> `CD_PUSH_TOKEN` unacceptable across 16 jobs. Since the status only ever *named* the bundle and the
> reader already knows the run and job, it derives `{runId}--{jobSlug}` itself. Measured 2026-07-20.
>
> Use **`run.id`**, not `index_in_repo` — they differ (986 vs 985 on the run that proved this), and
> only `run.id` matches the `GITHUB_RUN_ID` the bundle was keyed with.

- **Upsert is keyed by job**: one job failing three times leaves **one** comment, edited twice. Two
  different jobs leave two comments.
- **Excerpts are tail-biased and capped** (200 lines / 32 KB per source). Failures surface at the
  *end*; a head-biased excerpt shows the boot banner. Truncation is always stated.
- **A cancelled run publishes nothing.** Its contexts read as `failure`, so without this a single
  rapid re-push would upsert a failure comment for every cancelled job.
- **Degradation is stated, not silent.** Container jobs have no Docker CLI, and only `app-ci/app-e2e`
  writes `~/mcm-ci-last-failure/` today, so "no container health" is normal — it appears under
  **Not collected** rather than as an empty section.

### Redaction is fail-closed

A PR comment is a **far more visible surface than a run log**, so everything published is redacted
first, then **verified**: the `secret-scan` detection rules are re-run over the redacted output, and
any surviving match **drops that excerpt entirely**. Losing a log excerpt is acceptable; leaking a
credential is not. The forge host is matched by *shape* (`*.ts.net`) and never embedded as a literal,
so the redactor cannot leak the host it protects.

---

## The evidence bundle

The digest is deliberately small. For a failure the excerpt cannot explain:

```bash
node scripts/ci-status.mjs failure --pr 82 --full
```

- Stored in the generic package registry as `ci-failures` / **`{runId}--{jobSlug}`** — **per run *and*
  job**, so two jobs failing in one run keep separate bundles rather than overwriting each other.
- **5 MB cap** — sized for **agent context**, not link time. (It was ≈40 s to retrieve while the
  tailnet was throttled to ~135 KB/s; post-fix that is under a second, so context is the only
  binding constraint.) Overflow trims the **largest source first**, keeps the
  tail, and records the truncation — a bundle never misrepresents itself as complete.
- **30-day retention**, pruned opportunistically at publish time. No scheduled pipeline exists for it.
  If failures stop entirely, expired bundles linger until the next failure publishes.
- `--full` writes the bundle to the scratchpad **and prints the path, not the contents**.

### 🚨 `logs/mc-service.log` line order is NOT event order — reconstruct with `duration_ms` (item #568)

**mc-service logs its domain event at the END of the handler**, in the same emit as the response. So a
slow request's `collection_created` appears in the file *after* everything that happened during it. The
line order is completion order; the interesting order is almost always **start** order, and the only
thing that recovers it is the `duration_ms` on the `request completed` line.

This is not a footnote. Item #568 was filed on a confident, fully-reasoned hypothesis — *"a concurrent
cleanup deleted a collection 54 ms before a live agent turn tried to add a movie to it"* — built by
reading four adjacent lines in file order. The proposed fix was per-worker collection isolation, a
substantial change to the E2E fixtures. Subtracting the durations showed the opposite: the `POST
/collections` whose `collection_created` line sat *below* the DELETE had taken **265 ms**, so it had
**started 137 ms before** the delete it appeared to follow, the collection was already visible when the
assertion read it, and the DELETE was the test's own `afterEach` firing *after* that assertion had
already failed. There was no concurrent actor and nothing to isolate.

Extract the window as a table rather than reading raw lines — the token payload also drowns the fields
that matter:

```bash
# start time = timestamp - duration_ms. Print both, and sort by the START when ordering matters.
python3 - <<'EOF' < /tmp/mcm-ci-status/<runId>--<job>/logs/mc-service.log
import sys, json
for line in sys.stdin:
    i = line.find('{')
    if i < 0: continue
    try: o = json.loads(line[i:])
    except Exception: continue
    f, sp = o.get('fields', {}), o.get('span', {})
    print(o['timestamp'], f"dur={f.get('duration_ms')}", f.get('status'),
          sp.get('method'), sp.get('path') or sp.get('name'), f.get('message'))
EOF
```

Two more fields in that file settle "who did this", and they settle it without inference:

- **`authorized_party` separates the actors** even though every E2E worker acts as the same subject.
  `movie-collection-manager` is the browser/BFF session (a test or its teardown); `agent-gateway` with
  `mc-service` in the audience is the agent's downscoped write token. In item #568 the delete was the
  former and the create the latter — same `subject`, different actor.
- **`preferred_username` names the WORKER** (`e2e_w3_…` is worker 3), which is what tells a test's own
  teardown from another worker's. Reliable since **feature 054 US4 (item #169, 2026-08-12)** made setup
  mint one identity per worker: run 4002 carries **7 distinct `preferred_username` values and 7 distinct
  `subject` values**, counted from the log.

  That has a consequence worth reaching for before any cross-worker theory, because it usually ends the
  question outright: **mc-service scopes collections by `owner_id = token.subject`**
  (`api/collections/list.rs`, `delete.rs`), so one worker cannot list, read or delete another worker's
  collection at all — a foreign delete is not a race to be narrowed, it is impossible. Whatever the log
  shows, if two lines carry different `subject` values they cannot be acting on the same collection.

And a corollary worth stating because it also reads as evidence: **sequential ObjectIds prove nothing
about who created what.** `…aa2`/`…aa3`/`…aa4` differing by one only means concurrent creations in the
same second. Item #568 cited the sequence as support for a cross-test interaction; it is consistent
with any number of independent writers.


### It packs `container-logs/` RECURSIVELY, and what it cannot carry it NAMES (item #241)

The packer originally read `~/mcm-ci-last-failure` with one flat `readdirSync` filtered to `*.log`,
`_ps.txt` and `*.health.json`, so a **directory** matched nothing and was dropped without a word.
Feature 062's device diagnostics land in exactly such a directory
(`container-logs/_mobile-diagnostics/<flow>-attempt<n>/`), so the Maestro view hierarchy, the failure
screenshots and the emulator logcat never reached the bundle — while the digest printed
`maestro debug output — not present`, which reads as *the capture did not happen*. Measured on run
**2049**: the runner held the whole tree; the retrieved bundle held 69 files, none of them from it,
and diagnosing it needed `ssh ci@homelab` — the out-of-band step this bundle exists to remove.

- **Nested files are admitted by format** (`.log .txt .json .ya?ml .md .xml .html`), because Maestro
  writes the hierarchy and command list as JSON, not `.log`. The **flat** rules are unchanged on
  purpose: widening them would collect every `*.health.json` twice, once as health and once as a log.
- **Screenshots travel base64** as `{path, base64}` manifest entries, up to **3 files / 1 MB each /
  2 MB total**, `❌`-marked captures first. `ci-status … --full` decodes them, so the extracted
  directory holds real PNGs. They are **never trimmed** — half a PNG is a corrupt file, not a smaller
  screenshot, so a binary that will not fit is dropped whole.
- **Ranking beats the cap.** Max-min fairness alone loses a 300 KB screenshot to a 20 MB mongo log
  the moment the screenshot exceeds an equal share. Step output, `_ps.txt` and the device evidence
  are therefore allocated first out of a **priority reserve of half the cap**, and that reserve is
  itself **fair-shared**; the rest is fair-shared too. Bulk device dumps are ranked *below* ordinary
  container logs **by size (over 512 KB)**, not by name. Both rules come from run **3434**
  (2026-09-15), a deliberately red mobile run on which the earlier design — measured only on a
  fixture — dropped the 126 KB view hierarchy, the 54 KB failure screenshot and two 337-byte
  `logcat-react.log`s while carrying a `device-logcat.txt` and three `logcat-full.log`s:
  1. **Demotion by exact basename missed the real dump.** `logcat-full.log` is the name
     `capture_mobile_diagnostics` writes; **Maestro 2.10 writes its own dump as
     `logs/device-logcat.txt`** (3.6 MB on attempt 2, 5.9 MB on attempt 3), so a bulk logcat ranked
     as *priority device evidence*. A name list rots at the next rename; size does not.
  2. **A first-come-first-served reserve** repeated the defect max-min fairness fixed for the pool
     below it. `selectSources` sorts by rank then path, `…/logs/device-logcat.txt` sorts before
     `…/screen-hierarchy/…`, so the dump reached the reserve first and the hierarchy got `no budget
     left at the cap`. Fair-sharing the reserve protects against the **next** misclassification, not
     only this one.

  The lesson generalises: the walk, the naming of drops and the three-way capture message were all
  correct on the real run — what the fixture could not test was the *interaction* between real file
  sizes and the allocation order. A fixture whose ordering does not reproduce the ordering that caused
  the bug tests nothing; the guard had to be reordered to the measured sort before it failed against
  the buggy code.
- **Every absence is stated**, in the digest and not only in the manifest: sources the cap dropped
  whole (`meta.droppedSources`, rendered into the digest's *Not collected* list), captures over the
  per-file/budget ceilings, files in an unsupported format, and — reader-side — entries past
  `ci-status`'s 500-entry ceiling. The device-capture line is now **three-way**: carried / captured
  on the runner but not folded into `container-logs` / genuinely not present.

---

## Per-step durations — how long a step *normally* takes (item #338)

```bash
node scripts/ci-status.mjs durations                          # app-e2e, last 25 published runs
node scripts/ci-status.mjs durations --job dast --runs 10
node scripts/ci-status.mjs durations --runs 40 --propose      # regenerate scripts/ci-step-ceilings.tsv
```

**What it answers, and why it did not exist before.** `app-e2e` runs every wrapped step under a
per-step ceiling (item #326) so a hang fails the STEP and still publishes a digest, instead of
killing the JOB and destroying the evidence. That mechanism is validated in
production. Its **value** was not: 2700 s was calibrated against an app-e2e **job** duration
(~29 min) misread as a `web-e2e` **step** duration (~5.2 min), leaving it roughly 5x looser than the
evidence supported — measured cost on 2026-09-02, a hung step burning the full 45 min remaining on a
capacity-1 runner. It could not be corrected, because **nothing recorded how long a step takes**:
the digest publishes only on failure, and this forge exposes no job logs.

**The sample.** `ci-log-step.sh` now writes one row per wrapped step per invocation into
`_step-durations.tsv` — `step · seconds · exit · ceiling` — on **every** run, success or failure. A
distribution built only from failures describes the failures, not the step. The digest uploads it as
**`step-durations.tsv`, a separate file in the bundle's version**, not inside `bundle.json.gz`: a
failure bundle reaches the 5 MB cap, and reading 25 of those to extract 25 tiny tables is a
calibration nobody performs twice.

Three things worth knowing before you trust a figure it prints:

- **A killed step is CENSORED, not observed, and is excluded from every percentile** — it is
  reported in its own `cens` column. A step killed at its ceiling lasted exactly the ceiling, so
  folding it in makes each ceiling a function of the previous one: a ratchet that tightens on every
  kill until the ceiling fails runs that would have passed. An ordinary *failure* is not censored —
  a step that failed an assertion at 300 s really did take 300 s.
- **The sample is what the retention window holds.** Bundles expire after 30 days, and every bundle
  published before item #338 carries no durations file at all — those versions are skipped silently,
  so the sample fills forward from the first run that recorded one. `runs sampled` in the output is
  the honest count; it is not the number requested.
- **Coverage is asymmetric by design.** `app-e2e` publishes on every run, green (counts bundle) and
  red (digest bundle). Every other job publishes only on failure, because the counts channel is
  self-limiting to `app-e2e` by construction and making durations a counts source would turn ~1
  package version per run into ~20.

### The ceilings themselves — `scripts/ci-step-ceilings.tsv`

Once ~40 runs had accumulated, the single job-wide value was replaced by **one ceiling per step**,
each carrying the sample it came from. The file is **generated, never hand-edited** — regenerate it
with `durations --propose` and commit the result.

```
# step                                ceiling  basis
maestro-agent-flows                      2580  n=27 max=844s x3=2532s -> 2580s; runs 3503..3103
app-e2e-build-embedded-bundle-e2e         900  n=27 max=281s x3=843s -> 900s;  runs 3503..3103
web-e2e                                   840  n=40 max=280s x3=840s -> 840s;  runs 3503..3103
mc-service-integration                    420  n=40 max=122s x3=366s -> 420s;  runs 3503..3103
…20 further steps, all at the 300 s floor
```

**The rule:** `max(observed) x 3`, rounded up to a whole minute, floored at **300 s**, and applied
only to a step with at least **10 observed (non-killed) samples**.

- **`max`, not p95** — p95 of 40 runs discards the two slowest observations, and those are exactly
  the runs a ceiling must not fail.
- **x3 is the largest retry bound any wrapped step has**, not a taste call: `ci-mobile-agent-flows.sh`
  runs each flow under `max=3`, and Playwright is `retries: 1`. A sample's maximum already contains
  whatever retries fired in it; multiplying by the bound covers the run where they all do. Sanity
  check against the figure that made this item cautious — run 2530's hypothesised ~25 min
  (1500 s) maestro — `2580 s` still clears it by 1.7x.
- **The 300 s floor exists because `timeout 0` means NO LIMIT.** Twenty steps run in under a second;
  `0 x 3 = 0` would delete the guard by its own arithmetic, and a 2 s step bounded at 6 s would red
  on ordinary contention.

**`CI_STEP_TIMEOUT_SECONDS` survives as the BACKSTOP, not the ceiling.** It bounds a wrapped step
with no calibrated row, so a table miss can never fall through to unbounded and restore the #326
defect. Today exactly one step is on it — `app-e2e-collect-container-logs`, which runs only on the
failure path and has n=2. It stays at 2700 s because an uncalibrated step's legitimate duration is
by definition unknown, and the asymmetry still holds there: a fast **false** red costs a ~35-40 min
re-run on this capacity-1 runner; a slow **true** failure costs only the difference between that
bound and the job's 75 min.

Three guards in `scripts/__tests__/ci-log-step.test.mjs` keep this honest: **#338k** re-checks the
below-the-job-ceiling arithmetic for *every* row rather than one value, **#338m** fails a row whose
basis does not state its sample, and **#338n** fails if a wrapped `app-e2e` step is neither
calibrated nor recorded as deliberately on the backstop.

### Recalibrating the table

**When.** Four triggers, and only these — a ceiling nobody is complaining about does not need
refreshing just because time passed:

- **A step was killed at its ceiling but the work was legitimate** — the digest says
  `⏱ timeout after Ns` and the step was slow, not hung. Resist fixing that one row; regenerate.
- **`#338n` fails the build** — a newly wrapped `app-e2e` step has no row and no backstop note.
- **A step got materially slower on purpose** — new specs, another Maestro flow, a bigger bundle.
- **The runner changed** — capacity or hardware moves every figure at once, so the whole table is
  stale, not one row of it.

**How.**

```bash
# 1. Read the distribution FIRST. Never regenerate blind — the diff is the review surface,
#    and you cannot review it if you do not know what the sample looks like.
node scripts/ci-status.mjs durations --job app-e2e --runs 40

# 2. Regenerate. Under --propose the progress line goes to STDERR, so the redirect is clean.
node scripts/ci-status.mjs durations --job app-e2e --runs 40 --propose > scripts/ci-step-ceilings.tsv

# 3. Review the DIFF, not the file. A row that moved a long way is a question, not a result.
git diff scripts/ci-step-ceilings.tsv

# 4. Verify before committing.
node --test scripts/__tests__/ci-log-step.test.mjs scripts/__tests__/ci-status.test.mjs
```

**Three traps, all measured rather than reasoned about:**

- **NEVER hand-edit a ceiling.** The guards check that a basis is *present* (#338m) and that the
  value clears the job ceiling (#338k). **Neither checks that a ceiling matches its own basis.**
  Measured: `web-e2e⇥60⇥n=40 max=280s x3=840s -> 840s` passes all 37 guards. A hand-edited number
  beside a stale basis is item #338's original defect — a figure whose stated justification
  describes a different measurement — reproduced inside the file built to prevent it. The file says
  `GENERATED, do not hand-edit` in its own header for this reason.
- **A step that keeps timing out gets LOOSER, not tighter.** Kills are censored, so a step killed
  often *loses observations* and can fall under the `n >= 10` floor. It then drops off the table
  onto the 2700 s backstop, recorded as a commented row. Measured: 9 observed + 31 killed yields
  `# slow-step⇥-⇥n=9 < 10 observed samples (31 killed)`. This is the anti-ratchet working exactly as
  designed — you cannot calibrate a step from its own kills — but the effect is the opposite of what
  "it keeps timing out" intuitively suggests, and the row looks like it went missing rather than
  like it was deliberately retired.
- **`--runs 40` is an upper bound, not a promise.** Bundles expire after 30 days; `runs sampled` in
  the output is the honest count. So **once the table is older than the retention window, the runs
  its basis names no longer exist** — the figures remain correct, but they stop being checkable.
  Regenerating is the only way back to a basis a reader can verify.

---

## `cd-deploy` is a special case

`cd-deploy` is `workflow_dispatch`-only, so it **posts no commit status**. `ci-status status --sha`
and `ci-status failure --sha` therefore show only the `guardrails` / `app-ci` contexts and report
"no failed jobs" for a cd-deploy failure — they enumerate commit-status jobs, and cd-deploy has none.

- **Find its per-job state** via `GET /actions/tasks` (filter `name` = `build-deploy` / `prod-apk`).
  `prod-apk` is non-blocking (nothing `needs` it — a flaky APK build never blocks the deploy).
- **Read its failure digest** by fetching the bundle **directly by run + job**, not via a commit
  status: `{server}/api/packages/{owner}/generic/ci-failures/<runId>--build-deploy/bundle.json.gz`
  with `MCM_FORGE_TOKEN` (read:package). Every build/scan/promote/webhook/probe/rollback step is now
  wrapped with `ci-log-step.sh`, so the digest names the failing step + shows its output (before
  that it fell back to stale app-e2e evidence).
- **Trivy `build-deploy` blocks on a FIXABLE Critical.** A recurring class: the vulnerable package is
  **not an app dependency** — it is `node-tar` bundled by BOTH npm and corepack's pnpm inside the
  `node:*-alpine` base of the mcm-bff image. `pnpm why <pkg> --prod -r` prints nothing ⇒ it is a
  base-image/manager bundle. Fix = remove the unused managers from the BFF **runner** stage (the
  runtime is `node server.js`, invoking neither) — a real elimination, not a Trivy suppression.
  Verify a Docker-image fix locally with `docker run aquasec/trivy image --exit-code 1 --severity
  CRITICAL --ignore-unfixed`.
- **Dispatch it directly to DEPLOY** when app-e2e flaked but the code is already green on its PR:
  `POST /actions/workflows/cd-deploy.yml/dispatches` `{"ref":"main","inputs":{"deploy":"true"}}`
  (the `git credential fill` token works). `app-ci`'s `trigger-cd` blocks on a *failed* app-e2e, so a
  flake stops the auto-deploy; a direct dispatch bypasses the gate. Since item #230 the gate also
  declines for two *correct* reasons — the commit is no longer the tip of `main`, or nothing
  deployable changed since the last deploy — so read the `cd-dispatch / trigger-cd` status before
  concluding a deploy was lost; a direct dispatch is the escape hatch when it genuinely was. Success ⇒ a `chore(cd): promote …
  [skip ci]` commit pins the new `*_DIGEST` in `infrastructure-as-code/docker/*/.env.deploy`, and with
  `deploy=true` the health probe already passed (no rollback-revert commit on `main`).

---

## Hardening (untrusted-PR threat model)

CI logs and bundle contents are attacker-influenceable (a PR author controls what runs in CI), the
digest is published to a more-visible surface (a PR comment), and it's read on a developer's machine.
So (added 2026-07-21 after a security review):

- **`--full` refuses a decompression bomb** — the reader caps gunzip output (64 MB) and the download
  (16 MB); the 5 MB writer cap is not trusted.
- **Reader output strips terminal control characters** — a log line or spoofed PR comment can't
  inject ANSI/OSC escapes (cursor-rewrite, clipboard, hyperlink spoof) into your terminal.
- **Digest authenticity is not assumed** — any PR commenter can type the `<!-- ci-digest:job=X -->`
  marker. The reader only treats a marker at the **start** of a comment as a digest, and surfaces the
  **comment author** so an unexpected one is visible. Marker presence is not proof.
- **Injection defences in the published digest** — excerpts use a dynamically-sized code fence (a
  printed ``` can't break out into live markdown) and embedded `ci-digest` markers are defanged (a
  log echoing another job's marker can't hijack that job's comment).
- **Redaction is broadened** — the fail-closed pass also withholds excerpts containing provider-token
  prefixes (ghp_/github_pat_/glpat-/xox/AKIA/AIza/PEM), and health + bundle-meta fields now run
  through it too. Still a residual: a novel secret shape in an uncovered form. FR-005 remains the
  requirement most worth scrutinising.
- **`CI_DIGEST_TOKEN` is reachable by PR CI** (standard secrets-on-PR exposure), mitigated by its
  narrow scope (write:issue + write:package, never `write:repository` / push-to-main). Consider
  requiring review approval before secrets-bearing PR jobs run.

## Coverage is enforced

The digest is one `if: always()` step per job, so it decays the moment a new job or workflow is added
without it. `scripts/check-ci-digest-coverage.mjs` (a `guardrails / naming` gate) fails CI if any job
lacks a guarded digest step — turning silent erosion into a red build with the job named. A job may
opt out only with a visible, justified marker:

```yaml
  some-job:
    # ci-digest-exempt: <why this job cannot meaningfully publish a digest>
```

A blank reason is rejected. So adding a CI job now forces a choice: give it a digest step, or write
down why it doesn't need one.

## Step logs are read IN-JOB — they do not need to survive teardown

A diagnosis that reached a PRD and nearly cost a redesign got this wrong, so the wrong story is kept
next to the right one.

**The tempting wrong story.** `ci-log-step.sh` writes to `$HOME/mcm-ci-step-logs/`, which for a
container-executor job lives inside the container and is destroyed at teardown. So — the reasoning
went — containerized jobs must be undiagnosable, and the fix is to relocate the logs somewhere the
host can read them.

**What is actually true.** The digest is **not a host-side reader**. `Publish failure digest` is a
step *inside the same job*, and in the container executor every step of a job runs in the **same
container**. The digest therefore reads the step logs from the same `$HOME`, before teardown, and
pushes the evidence out over the forge API — a PR comment, plus a generic-package bundle for the
full evidence. Nothing in that path requires the files to outlive the container.

Reproduce it end to end rather than taking this on trust:

```bash
tmp=$(mktemp -d)
HOME="$tmp" GITHUB_RUN_ID=999 bash scripts/ci-log-step.sh probe sh -c 'echo "REAL FAILURE"; exit 3'
T="$tmp" node -e 'import("./scripts/ci-failure-digest.mjs").then(m=>{
  const home=process.env.T, env={HOME:home,GITHUB_RUN_ID:"999"};
  console.log(m.readFailingStep(env,home));
  console.log(m.collectEvidence({home,cwd:process.cwd(),env}).excerpts);})'
# -> probe ; [ { source: 'step:probe', text: 'REAL FAILURE\n' } ]
```

**The `T=` assignment must come BEFORE `node`.** Written after it, it is argv, `process.env.T` reads
back undefined, the probe prints nothing, and it looks like it disproved the point.

**The measurement that misled.** "`~/mcm-ci-step-logs/` on the runner contains captures only from
`cd-deploy/build-deploy` and the devcontainer image build" is **true, and irrelevant**. Host-executor
jobs leave their logs lying on the host; container jobs consume theirs in-job and take them with
them. The absence of container-job leftovers on the host is evidence about **leftovers**, not about
**diagnosability**. Reading it as the latter is the whole mistake.

### The real requirement is per-STEP instrumentation

If the digest can read the logs, why was every guardrail failure undiagnosable? Because **most steps
were never wrapped**, so there was no log to read. Measured before feature 051: **85 of 136 `run:`
steps** produced no capture. `guardrails / naming` had 16 `run:` steps with 2 wrapped, and **neither
of the two was a gate** — so a naming-gate failure published the logs of two unrelated steps.

The old coverage gate passed all of it because it asked only "does this job publish a digest, and is
**at least one** step wrapped?". One was enough. It never asked whether the step that can actually
fail is wrapped. `check-ci-digest-coverage.mjs` now requires **every** `run:` step to be wrapped or
to carry a justified `# ci-log-step-exempt:` marker of its own.

### The same defect, one level down: per-COMMAND, not per-block (item #177 variant 4)

"Every `run:` step must be wrapped" was still decided by a **substring test against the whole
block** — `/ci-log-step\.sh/.test(step.run)`. So a multi-line `run:` block passed if the wrapper
appeared anywhere in it, and every command above that line ran unwrapped: **no log, and no
`_failed-step` marker either**, so the digest named nothing at all.

Measured 2026-08-29 — three live steps had a failure path outside their wrapper and the gate
reported all three clean:

| Workflow / job | The command that ran unwrapped |
| --- | --- |
| `cd-deploy / prod-apk` | `exit 1` on the BASE_DOMAIN guard |
| `devcontainer-image / build-publish` | `: "${REGISTRY:?…}"` |
| `wiki-maintain / maintain` | `exit 2` on a malformed dispatch input |

This is the same class as `guardrails / naming` passing with 2 of 16 **steps** wrapped, exactly one
level further down: 1 of N **commands**. All three now wrap the whole block with the heredoc idiom
below, so their guard failures are captured too. Pinned by `(x4)` in
`scripts/__tests__/check-ci-digest-coverage.test.mjs`.

### The gate checks PRESENCE, not REACHABILITY — say so out loud

This is a stated limitation, not an oversight, and it is written down here because a known limit
beats a general check nobody trusts (item #177's third acceptance criterion).

`check-ci-digest-coverage.mjs` reads YAML and shell **as text**. It can answer "is this command
inside the wrapper?" — it cannot answer "**can the wrapper actually run where this step runs?**".
Four ways the wrapping has been present and non-functional have shipped, none of them found by the
presence rule:

| Variant | Why the wrapping was inert | Caught by |
| --- | --- | --- |
| `working-directory:` on the step | `bash scripts/ci-log-step.sh` is repo-root-relative → bash exits 127 before the wrapper runs, so no log **and** no marker | `(x)` |
| Command begins with an env-var assignment | `MODEL_PROVIDER=x cmd` is shell syntax, not argv; `"$@"` tries to execute the assignment | `(x2)` |
| The job's `Checkout` is conditional | The script is not on disk on the branch where checkout is skipped | `(x3)` |
| A command runs outside the wrapper in the same block | The wrapper runs fine; it is simply not what executes the failing command | `(x4)` |

The first three are **shape-specific regression cases against the real workflows**, not a general
property — a fifth environmental variant would ship the same way. The fourth is a general rule, but
still a **heuristic**: it reads shell line by line rather than parsing it, so a command hidden inside
a single-line `case … esac`, or behind an `&&` on a control-flow line, is not seen. Treat all of it
as a floor, and when a job dies in seconds with no digest content, suspect the wrapper's
preconditions before suspecting the code.

### Wrapping a step

```yaml
# one command
- name: Resource-naming gate
  run: bash scripts/ci-log-step.sh naming-resource-naming-gate node scripts/check-resource-naming.mjs

# several plain commands — wrap each; they append to one log named for the step
- name: Inline-secret gate
  run: |
    bash scripts/ci-log-step.sh naming-inline-secret-gate node scripts/check-no-inline-secrets.mjs --selftest
    bash scripts/ci-log-step.sh naming-inline-secret-gate node scripts/check-no-inline-secrets.mjs

# a body that needs a shell (conditionals, loops, pipes, assignments)
- name: Verify KVM is available
  run: |
    bash scripts/ci-log-step.sh app-e2e-verify-kvm-available bash -e /dev/stdin <<'CI_LOG_STEP'
    if [ -e /dev/kvm ]; then ls -l /dev/kvm; else echo "::error::no kvm"; exit 1; fi
    CI_LOG_STEP
```

The heredoc form needs **no escaping** — the body passes through byte-for-byte, so quotes, `${{ }}`
expressions and shell constructs survive. Use **`bash -e`**, matching the runner default, *not*
`-euo pipefail`: adding `-u` and `pipefail` to a block that never had them can turn a green step red
on an unset variable or a SIGPIPE. Exit codes, `::error::` workflow commands and the `_failed-step`
marker all propagate through the wrapper — verified by execution, not by inspection.

**Choose a short, descriptive log name.** It becomes the digest excerpt's `source`, which is the
first thing a reader sees. Not a slugified copy of a 90-character step title.

**"It is only a setup step" is not a legitimate exemption.** `pnpm install --frozen-lockfile` failing
on a lockfile mismatch and `apt-get install` failing on a mirror are recurring CI failure modes whose
one-line cause is exactly what this machinery exists to surface. The legitimate exemptions are: steps
that run before `actions/checkout` (the script is not on disk yet), the digest step itself (wrapping
the reporter in what it reports on is circular), and `uses:`-only steps (no command to capture).

### Two costs of instrumenting a HOST-executor job, accepted deliberately

Container-job captures die with the container. Host-executor captures (`app-e2e`, `dast`,
`cd-deploy/build-deploy`, `devcontainer-image`) land in `$HOME/mcm-ci-step-logs/<run-id>/` on the
**persistent** runner and stay there:

- **They are unredacted.** Redaction happens at *publication* time in the digest, not at capture
  time — `ci-log-step.sh` does no redaction at all. Raw output sits on the runner for up to 7 days
  (a best-effort `find -mtime +7` prune inside the wrapper). These jobs handle real credentials.
- **Disk.** The wrapper writes the **full** output; the 200-line / 32 KB caps apply only to the
  digest *excerpt*. `app-e2e` already runs a "Free daemon disk space" step, so this adds to pressure
  that job is already managing.

Both were weighed and accepted for the diagnostic value — `app-e2e` is the longest and most
failure-prone job in the repository, and its stack bring-up and teardown failures were previously
invisible. If runner disk becomes a problem, the lever is the retention window in `ci-log-step.sh`,
not un-instrumenting the steps.

## A gate's verdict must not depend on the checkout

**The invariant**: a gate parses repository text, so its answer must be a property of the *commit* —
never of the contributor's `core.autocrlf`, working tree, or operating system. Two gates in this
repository violated that at the same time, in **opposite directions**, and one of them stayed hidden
for months because the direction it failed in was silence.

**The worked example — `check-ci-digest-coverage.mjs`, failing CLOSED.** The gate reported three jobs
as uncovered — `app-ci / changes`, `app-ci / trigger-cd`, `infra-image-scan / changes` — that are all
correctly exempt. It reproduced on a Windows checkout and never on Linux, so it was written up as an
unexplained local/CI divergence (PRD §1.3) and briefly recorded as *resolved* on the strength of a
green Linux run. The cause:

```js
const lines = text.split('\n');                          // leaves a trailing \r on a CRLF checkout
const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/;          // SURVIVES — \s* absorbs the \r
const markerRe  = new RegExp(`#\\s*${marker}:(.*)$`);    // FAILS — . will not consume \r,
                                                         //         and non-multiline $ wants EOF
```

The asymmetry is the whole bug. `\r` is a **line terminator** in JavaScript regular expressions, so
`.` refuses it and a non-multiline `$` refuses it — but `\s*` swallows it without complaint. The
parser therefore saw the jobs and not their exemptions, and nothing about the output looked wrong.

**The other direction — `check-openwiki-okf.mjs`, failing OPEN.** Its drift check guarded on
`Date.parse(fields.timestamp)` applied to the *untrimmed* value. On CRLF the timestamp arrives as
`…Z\r`, parses to `NaN`, and the guard concludes "no usable timestamp" — so the staleness comparison
silently never ran and the gate printed `✅ conformant`. The neighbouring validator escaped the
identical bug only because it happened to call `.trim()` first. **A gate reporting green while not
checking is the worse of the two failures**, and it is much harder to notice: a false red gets
investigated, a false green gets merged.

**The two rules that follow.**

1. **Split on `/\r?\n/`, never `'\n'`** — and fix it *at the split*, not by bolting `\r?` or the `m`
   flag onto whichever pattern happens to be broken today. The next pattern added to the file would
   inherit the trap. `check-komodo-sync.mjs`, `check-topology-scrub.mjs` and
   `check-no-argv-secrets.mjs` already do this; `check-openwiki-governance.mjs` takes the equivalent
   route of `.replace(/\r\n?/g, '\n')` before splitting.
2. **Normalize a value where it is READ, once — not at each use.** A second `.trim()` at the call site
   fixes one validator and leaves the asymmetry in place for the next one. The okf gate now trims
   every front-matter value in `extractFrontMatter`, and the pre-existing per-call trims were removed
   so they cannot drift apart again.

**`.gitattributes` is a second layer, not a substitute.** It declares `eol=lf` for `*.sh`, `*.yml`,
`*.yaml` and `*.md`, which stops the condition being produced — but it governs **future checkouts
only**. It cannot reach a working tree that already exists, so an existing Windows clone must be
re-normalized once:

```powershell
git rm --cached -r .
git reset --hard
git status        # expect clean; if not, the normalization IS the diff
```

**Prove it by feeding the parser directly.** A test that writes a fixture file and reads it back
proves whatever the checkout happened to do, which is the thing under suspicion. Build the LF string,
derive the CRLF variant with `.replace(/\n/g, '\r\n')`, and assert both reach the same verdict —
asserting the **LF** side finds something first, or a regression to "finds nothing either way" passes
as a fix. Both cases are RED on Linux against the unfixed code; no Windows host is needed.

**And name the platform.** Both of these were misread because a result measured on one operating
system was reported as a general one. A pass claim that does not say where it was observed is not yet
a pass claim.

## Maintenance notes

- **All scripts are zero-dependency**, `node:` built-ins only. `guardrails` runs them with nothing
  installed, and a test needing a non-root dep is the exact `ajv` failure feature 041 removed.
- **`scripts/__tests__/*.test.mjs` runs in CI** (`guardrails / naming`, added by feature 041). New
  tests are gated automatically, but must be deterministic, offline and token-free.
- **Do not "tidy" the fragmented string literals.** Test fixtures assemble planted credentials and
  tailnet-shaped hosts from fragments at runtime, because `secret-scan` and `check-topology-scrub`
  scan the whole tree and cannot distinguish a test fixture from a real leak. Collapsing them into
  single strings fails the gates — this happened three times while building this feature.
- **Only INSTRUMENTED steps mirror their output.** A step wrapped with `scripts/ci-log-step.sh`
  writes its combined stdout+stderr to a per-run, **per-job** directory the collector reads at the
  HIGHEST priority — the failing step's own output outranks any container log. Wrap a step like this:

  ```yaml
  # one command
  run: bash scripts/ci-log-step.sh <log-name> <command> [args...]

  # a whole multi-command block — everything between the delimiters runs INSIDE the wrapper, so a
  # guard that `exit`s early is captured too. Use `bash /dev/stdin` (no `-e`) when the block reads
  # `$?` and dispatches on it.
  run: |
    bash scripts/ci-log-step.sh <log-name> bash -e /dev/stdin <<'CI_LOG_STEP'
    : "${SOME_VAR:?set it}"
    <command>
    CI_LOG_STEP
  ```

  Instrumented steps: `app-e2e` (agent-integration, mc-service-integration, web-e2e,
  maestro-agent-flows) and `guardrails` (secret-scan, agent-gates lint/test/golden, naming script
  tests, sast gate). The wrapper also records **which** wrapped step failed, so the digest names it
  instead of `_not reported_`. **A step that is not wrapped contributes no output**, and the digest says so
  under *Not collected* rather than staying silent. Add the wrapper to any step whose failure you
  would otherwise have to read in the web UI.

  > ⚠️ The wrapper sets `pipefail` deliberately. `cmd | tee` returns **tee's** exit status, so
  > without it a FAILING step reports SUCCESS and CI goes silently green — strictly worse than
  > missing logs. `scripts/__tests__/ci-log-step.test.mjs` pins this; removing `pipefail` fails it.
- **The step-log directory is scoped by run AND by job** —
  `$HOME/mcm-ci-step-logs/<run-id>/<job>/`. `app-e2e` and `dast` are two jobs of one run on the same
  self-hosted runner and share `$HOME`, so a run-scoped directory gave them one `_failed-step` file
  and one pool of step logs between them: whichever failed first wrote the marker, and the other
  published it as its own. Measured on run **#1683** — the `app-e2e` digest reported
  `dast-install-latest-docker`, a step in the **dast** job (item #180). There is deliberately **no
  run-scoped fallback**: one would keep reading the sibling's marker on exactly the overlapping runs
  the scoping is for. Writer (`ci-log-step.sh`) and reader (`stepLogDir` in `ci-failure-digest.mjs`)
  derive the path independently and must move together; `(g4)`/`(g5)` and `(y3)` pin both halves.
- **On a red `app-e2e`, read the `Run health` row FIRST** (item #173). Roughly one run in seven
  *collapses*: every agent/dock spec fails at once, `flaky=0`, and the gateway receives about a
  quarter of its usual turns because the client stops **sending** them. `scripts/e2e-turn-tally.sh`
  labels that, and its verdict is now a digest field rather than a line in a job log this forge's API
  cannot serve. `verdict=collapsed` means the failures say nothing about your diff and a re-run is
  warranted — the one case where the re-run reflex is right. `indeterminate` is normal on a pull
  request (gate tier only, feature 056) and is published with its reason rather than guessed at. A
  collapsed run always **fails**, so a run that produced no digest was not a collapse — which is how
  "no collapse in the last ten runs" is read.
- **The digest is size-capped for the comment channel.** A PR comment / commit status has a ~64 KB
  limit; a full `app-e2e` digest measured 90 KB. The digest markdown is trimmed to fit with a note,
  while the bundle keeps every log as a separate file — so nothing is lost, only relocated.
- **A failed publish is recorded in the bundle** (`meta.publish = {published, channel, reason}`).
  The bundle is readable over the API; the job log is not. Without this, a publish failure is visible
  only to a human in the web UI — which is how T040's cause stayed unproven across two smoke runs.
- **The digest is also echoed to the job log** inside a `::group::`, so a human can read it in the
  browser even when publication fails entirely.
- **`--selftest` is a thin smoke check**, not a duplicate of the suite. `scripts/__tests__/` is
  authoritative.
