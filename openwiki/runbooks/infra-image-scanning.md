---
type: Runbook
title: Infra-image CVE scanning
description: Keyless Trivy scanning of the third-party server images the project pulls but does not build (Keycloak, Postgres, Redis, Mongo, Vault and the rest of infrastructure-as-code — NOT MinIO, which is built from source and scanned by its own builder) — the one-scanner-per-image partition rule, the fixable-Critical-only gate, the allowlist-as-baseline rules, the bounded retry that keeps a Trivy DB blip from redding a required context, and the publish-versus-promote split for the from-source MinIO image.
resource: docs/runbooks/infra-image-scanning.md
tags: [security, cve, trivy, ci, runbook]
verified:
  - by: openwiki/0.7.1
    at: 2026-10-11T15:19:14.150Z
sources:
  - id: openwiki-source-7bd434a17ed7c27916b1d2ae
    resource: repo://.forgejo/workflows/infra-image-scan.yml
  - id: openwiki-source-c950e0aee079c6db1d918078
    resource: repo://.forgejo/workflows/minio-image.yml
  - id: openwiki-source-7c76000f237dd683a4fb0536
    resource: repo://docs/runbooks/infra-image-scanning.md
  - id: openwiki-source-9569e077273f937a713aad61
    resource: repo://scripts/__tests__/cd-scan-push-gate.guard.test.mjs
  - id: openwiki-source-b6dd2f2ef27fe2526cd380f7
    resource: repo://scripts/__tests__/infra-image-scan.test.mjs
  - id: openwiki-source-8bd5c4ede704298934afbfaa
    resource: repo://scripts/__tests__/promote-minio-digest.test.mjs
  - id: openwiki-source-60011cd55e5b787da8893ea3
    resource: repo://scripts/allowlist-expiry.mjs
  - id: openwiki-source-fe6babf23c099d13c73c6b6f
    resource: repo://scripts/cd/scan-push.sh
  - id: openwiki-source-214c4d8d22f6d46c2e78f3b4
    resource: repo://scripts/check-infra-image-findings.mjs
  - id: openwiki-source-d1e0316ab362ff8dcec4fc0d
    resource: repo://scripts/infra-image-scan.mjs
  - id: openwiki-source-b202cb0e9ae4a5b1b46e466a
    resource: repo://scripts/lib/scanner-retry.mjs
  - id: openwiki-source-c130384127d992848d2ee4d2
    resource: repo://scripts/promote-minio-digest.mjs
  - id: openwiki-source-7d0fa5a3a30eb305011c4b8d
    resource: repo://scripts/publish-sweep-verdict.mjs
  - id: openwiki-source-4708763005c35901b04f5740
    resource: repo://security/infra-images/allowlist.yaml
generated: { by: "openwiki/0.7.1", at: "2026-10-11T15:19:14.150Z" }
---

# Infra-image CVE scanning

Trivy scans every third-party image the project pulls but does not build — everything under
`infrastructure-as-code/**` except images scanned by their own builder and any `${..}`-interpolated
reference. It is deliberately disjoint from [SAST/SCA scanning](./sast-scanning.md), which covers
first-party source and first-party dependency graphs, and from [DAST scanning](./dast-scanning.md),
which exercises the running app over HTTP. Renovate keeps base images current; this scan catches a
freshly published CVE against an already-pinned image, which currency alone cannot.

**Cadence: twice weekly — Tuesday and Friday, 04:00 UTC — and the scheduled sweep is never
path-gated.** A new advisory can land against an image nobody changed, so the on-change PR/push check
exists only for fast feedback, not as the source of truth. The Friday run is ordered three hours ahead
of the Renovate window on purpose (see [Renovate](./renovate.md)); the Tuesday run (item #642) means an
advisory published early in the week is visible with three days in hand instead of surfacing at the
moment the window's PRs already exist and inherit a red nobody had seen.

**MinIO (`minio/minio`, `minio/mc`) left this set in feature 069.** Upstream deleted both Docker Hub
repositories on 2026-09-11 (having moved to source-only distribution in October 2025). This project
now builds MinIO from source (`infrastructure-as-code/docker/minio/Dockerfile`), published by
`.forgejo/workflows/minio-image.yml`, which scans it and gates its own publish — through this same
pipeline (`scripts/infra-image-scan.mjs --image <ref>`), so it shares the severity map and the one
allowlist the weekly expiry check reads.

## Gotchas

- **Not path-gated on the authoritative run.** A twice-weekly full sweep is the scan of record
  precisely because a new advisory can land against an image nobody changed — an on-change check on
  infrastructure edits exists only for fast feedback, not as the source of truth.
- **Scanner partition rule: by coverage, not by namespace.** An image is scanned by whoever *builds*
  it; everything else belongs here. `cd-deploy` owns its six app images (see
  [CI/CD pipeline](../projects/ci-cd-pipeline.md)); `minio-image` owns the from-source MinIO image. The
  exclusion rule used to be `if (ref.includes('jumbleknot/')) continue` — matching "anything named like
  ours" rather than "anything already scanned by a builder". Feature 069 broke that coincidence by
  adding a `jumbleknot/*` image built outside cd-deploy; under the old rule it was excluded here and
  absent from cd-deploy's set — published and examined by neither gate, zero findings, no error. The
  rule is now membership of `BUILT_IMAGE_NAMES`. Any future image built outside cd-deploy must be added
  to `BUILT_IMAGE_NAMES` or explicitly enumerated here — the invariant is exactly one scanner per
  image, not zero and not two. Completeness is asserted against a fixture in
  `scripts/__tests__/infra-image-scan.test.mjs` (a live-tree assertion would stop testing anything the
  day MinIO is the only such image and someone removes it).
- **The registry host is interpolated in compose, and the scanner must resolve it or refuse to run.**
  `check-topology-scrub` forbids the real forge host in a committed file, so our own images can only be
  referenced as `${REGISTRY_HOST}/…` — and a blanket `${` skip would have made exactly the image the
  partition rule exists to cover invisible here. With `REGISTRY_HOST` set (CI) the ref is concretely
  pullable and is enumerated; without it the ref is skipped, and on a real scan that is a **hard
  failure** (`exit 2`), not a quiet reduction in coverage — a sweep that silently covers less than the
  tree and still passes is worse than one that fails loudly.
- **Only a fixable Critical blocks the gate.** An unfixable Critical (no upstream patched version yet)
  is a report-only warning, since a version bump can't clear it and it must not wedge the gate
  indefinitely. `normalizeTrivy()` marks `blocking = Critical AND a fix exists upstream` — the same bar
  as the `cd-deploy` built-image gate — and the gate trusts the report's `blocking` flag rather than
  re-deriving it.
- **A finding and a scanner fault are two different exit codes on two commands.** `scripts/infra-image-scan.mjs`
  invokes Trivy with `--format json` and **no** `--exit-code`, so a non-zero scan exit can only mean
  the scanner could not run; `scripts/check-infra-image-findings.mjs` then carries the verdict from the
  normalized report. This split is what both the `minio-image` builder and `cd-deploy` run per image
  before the push, and it is why accepted findings on the deploy path live in
  `security/infra-images/allowlist.yaml` rather than in a `.trivyignore` nobody reviews. Pinned by
  `scripts/__tests__/cd-scan-push-gate.guard.test.mjs`, which asserts the gate runs before
  `docker push` and inside the per-image loop.
- **A Trivy vulnerability-DB blip is bounded-retried, and the retry must not soften the gate.**
  Trivy fetches its DB over the network on every run and this scanner is fail-closed, so an upstream
  blip reds the required context — and recovery costs a full CI cycle, because `/rerun` and
  `/rerun-failed-jobs` are both 404 on this forge. `scanImage()` therefore runs through the shared
  `scripts/lib/scanner-retry.mjs` (three attempts, 2s/4s backoff, extracted from `sast-scan.mjs` rather
  than copied). Two properties are deliberate: **fail-closed survives** (exhausting the attempts still
  throws) and **the classification is narrow** (only a measured transport signature retries; Trivy
  absent, an image that cannot be found, or unparseable output fail on the first attempt). **The
  classifier is handed STDERR only** — Trivy writes the report to stdout, so classifying stdout would
  let a CVE's own title decide whether a scan is retried; writing the control tests caught the
  inherited signature list matching the advisory title *"…does not limit Service Unavailable
  responses"*, and the HTTP-status signatures now require the status code. The captured stderr in the
  failure message is the **tail** (`readTail`, last 2000 chars), never the head: Trivy opens with
  `INFO` lines, and a head-truncated sample ended mid-URL, exactly where the HTTP status would have
  been. No DB cache and no extra mirror were adopted: Trivy's default `--db-repository` is already a
  fallback list, and cross-run caching is not available on this forge.
- **Keyless and fail-closed**, matching the posture in
  [Secrets management](../invariants/secrets-management.md) and
  [SAST/SCA scanning](./sast-scanning.md) — a Trivy/pull/parse failure fails the job
  rather than producing a clean-looking report.
- **The allowlist is baseline, not permanent.** Suppression is gate-only; findings stay visible in the
  report, and a suppressed entry must be deleted once the underlying image is actually bumped — leaving
  a stale entry hides a regression rather than tracking a real accepted risk. Every entry needs
  `image`/`id`/`justification`/`addedBy`; a blank field or invalid regex is a gate error, and a past
  `expiry` stops suppressing. The policy is stated in `security/infra-images/allowlist.yaml` itself.
- **Key a suppression to a VERSION, so an upgrade can discharge it.** `image` is matched as an
  **unanchored** regex against the full scanned reference, and that one property decides whether a
  suppression can ever end: `hashicorp/vault:1\.18` still matches `1.18@sha256:…` but stops matching
  `1.21`, whereas a bare repository name (`minio/minio`, no tag) matches every tag that image will ever
  have — it suppresses the advisory it was written for *and every future one in the same image*,
  silently and permanently. That is not an accepted risk with a review date, it is a permanent hole.
  `scripts/__tests__/infra-image-scan.test.mjs` asserts both directions for every formerly-floating
  repository: the key still matches today's pin **and** stops matching a later version derived by
  incrementing the pin's last number (a hand-written "next version" literal silently stopped meaning
  "later" when a bump moved past it).
- **Re-keying an allowlist entry is required whenever a pinned tag changes, not optional tidy-up.**
  An entry keyed to the old tag matches nothing after the bump, the finding it covered becomes
  un-allowlisted, and the gate blocks — while reporting the entry only as an `UNMATCHED ENTRIES` line,
  which reads like housekeeping rather than like the cause. Check that line before assuming a new CVE
  appeared. Unmatched detection is also **scoped to the images the run actually scanned**
  (`generatedForImages`, item #423), because two jobs consult this one allowlist — the sweep and the
  single-image `minio-image` builder — and each used to report the other's live entries as stale.
- **A version-keyed entry cannot be re-keyed on `main` and in the bump PR at once.** A version-keyed
  entry names one version, but during a bump two are live: `main` still references the old tag, the
  Renovate branch references the new one. Whichever single version the key names, the other side blocks.
  The two obvious escapes are both wrong: landing the re-key inside the Renovate branch does not survive
  (Renovate force-pushes and clobbers it); widening the key to a wildcard re-creates the permanent hole.
  What works is an **enumeration spanning the transition**, narrowed on merge — e.g.
  `'grafana/otel-lgtm:0\.32\.[01]'` covers both versions, is still discharged by an upgrade to
  `0.33.0`, and the test asserts that property. Write the narrowing into the justification; an
  enumeration left to grow one version at a time becomes the wildcard by instalments. Do this only when
  the bump is **not** the remediation — where the new version actually clears the advisory, delete the
  entry when the bump lands.
- **The floating-tag exception set is now EMPTY — that is correct, not a regression.** The two MinIO
  images are no longer pulled, so they are no longer exceptions. The old rule ("a floating count of 0 is
  a FAILURE") still guards against widening `isFloatingTag` to hide exceptions, but the guard now works
  by asserting **set equality against the declared list** (which is empty), not by asserting a count.
  Tests `(fd1)`–`(fd4)` assert the classifier's behaviour directly and do not depend on the count. A
  count of 0 with an empty declared list is passing; a count of 0 where the declared list is non-empty
  is the failure.
- **Publishing a rebuilt MinIO image is not the same as promoting it into the stacks.** A push that
  edits the Dockerfile both publishes **and** promotes — `scripts/promote-minio-digest.mjs` runs,
  repoints every pinned ref it finds in the tree, and opens (or updates) one always-current pull
  request. The weekly canary publishes **only** — its digest changes every Friday regardless, since
  the `apk` installs float, so promoting it would mean a no-content PR most weeks. A
  `workflow_dispatch` run promotes only when its `promote` input is explicitly ticked; the default is
  false, because dispatch is also how the build is proven still working and that must stay read-only.
  Two measured traps in the promoter itself: (1) the digest it writes must be resolved from the
  registry as the **manifest list**, by asking `GET /v2/<ns>/minio/manifests/<tag>` directly — not via
  `docker buildx imagetools inspect`, which is a **client-side** operation that talks to the registry
  itself and ignores the daemon's `insecure-registries` config, so it fails over plain HTTP even
  though `docker push` succeeds in the same job; (2) the count of refs to repoint must come from a
  **live scan of the tree** (`findRefs()`, which throws rather than reporting an empty promotion), never
  from a stale count recorded in a spec note — a later feature can add more pinned refs than the note
  remembers.
- **MinIO's date-based update types are calendar arithmetic, not semantic versioning.** The regex
  versioning scheme maps year→major, month→minor, day→patch. A January release reports **major** because
  the year advanced, not because anything broke. Do not read the label as a risk signal the way you
  would for `opa` or `unleash`. (`loose` versioning cannot parse `RELEASE.…` tags at all — its `_parse`
  returns null, making them unordered rather than merely mislabelled.) Note: the project's own built
  MinIO image uses an orderable tag format (`2025.09.07-161309`) and needs no versioning exception;
  this rule still applies when reasoning about upstream MinIO releases in other contexts.
- **A green `infra-image-scan` tick usually proves nothing — check the duration.** The required context
  posts `success` on every PR, including ones where Trivy never ran. That is deliberate (a job-level
  `if:` skip posts no status at all, and the required pattern then blocks the PR forever) — but it means
  the green tick answers "did this PR touch an infra path", not "are these images clean". The tell is
  the **job duration**, and it must be read from the **commit status description** — the
  `Successful in …` string the forge writes for the `infra-image-scan / infra-image-scan` context: a
  real sweep reads `Successful in 2m30s`–`3m`; a skipped run reads `Successful in 2s`–`14s`. **Do NOT
  compute this from `/actions/runs` as `stopped - started`.** Those timestamps are workflow-level and
  include inter-job queueing, which on this capacity-1 runner dwarfs the signal — a "> 60 s ⇒ real
  sweep" rule built on it calls a skipped run a real one, a false green in the very check written to
  detect false greens. Measured: two advisories landed in Trivy's DB one day and blocked 11 findings on
  images `main` already carried, yet nine consecutive `infra-image-scan` runs reported `success`, every
  one with a 2–14 s job duration. A PR's green tick can therefore be a stale green, and it stays
  "mergeable" after the images it pins go dirty. To force a real sweep, touch an infra path — editing
  `security/infra-images/allowlist.yaml` is itself enough.
- **A red scheduled sweep is now visible on the commit — as a status that cannot gate (item #485).** A
  `schedule`-triggered run posts **no** `infra-image-scan / infra-image-scan` status, so a red `main`
  used to be silent until an unrelated Renovate PR ran the same sweep and became unmergeable.
  `scripts/publish-sweep-verdict.mjs` now posts `infra-image-scan/weekly` with a **real**
  `success`/`failure`, and it reads the **gate's** outcome, not just the job's: gate failure means
  blocking CVEs, scan failure means the sweep could not run (explicitly *not* a clean report), and a
  job failure outside both is reported as such; a `cancelled` run publishes nothing. It cannot gate
  anything — branch protection requires the glob `infra-image-scan / infra-image-scan*`, this context
  has no ` / ` separator, and protection is evaluated on PR heads.
- **Did the twice-weekly allowlist-expiry step run? Read its status, not its absence (item #418).** The
  expiry check over both allowlists is the only thing that ever reports an expired, expiring or
  unmatched suppression, and it runs on the **scheduled runs only**
  (`always() && github.event_name == 'schedule'`) — it must never run on a PR, or a dated entry would
  block every pull request a fortnight later. The `always()` is load-bearing (item #484): a bare `if:`
  meant a red CVE gate skipped the expiry warning in the very week it mattered most, because a failed
  step skips every later non-`always()` step. Since item #418 the job publishes the measurement
  directly, as the `infra-image-scan/expiry` status:

  ```bash
  API=…/api/v1/repos/<owner>/<repo>
  curl -sS -H "Authorization: token $MCM_FORGE_TOKEN" "$API/commits/<sha>/statuses?page=1&limit=100" \
    | jq -r '.[] | select(.context == "infra-image-scan/expiry") | .description'
  # event_name=schedule gate=success expiry_step=success   <- the cron ran both checks, and they passed
  # event_name=schedule gate=failure expiry_step=skipped   <- an earlier step failed (item #484)
  # event_name=push     expiry_step=skipped                <- a push-triggered sweep; correctly skipped
  # event_name=<unset>  expiry_step=<unset>                <- the runner returned no value: a real fault
  ```

  Every field is a **raw measurement** interpolated from the run context, never a restatement of what
  the `if:` is believed to do; `<unset>` is a real answer, distinct from returning the wrong one. The
  status is always `success` and never gates anything — it is a record, and a red status on `main`'s
  tip is not something an observability step has standing to raise. It is posted on every
  non-`pull_request` run; if the POST itself fails, the status is simply **absent**, which is its own
  tell. **`expiry_step=failure` covers two causes the status cannot separate**: an entry needs action
  (expiring within 14 days, already expired, or matching nothing), or the checker itself crashed —
  item #562, where from 2026-09-12 until 2026-10-02 both checkers threw on the absent report they
  announce as legitimate, and because the step runs `cmd1 && cmd2` under `bash -e` the infra-image half
  never ran at all. Look for a `GateError` stack trace in the step log before treating it as an
  allowlist problem.

  > The `event_name` value here is also the standing answer to a forge trap that has cost a session
  > once already: `/actions/runs` reports `event: push` for a cron run, and only `trigger_event` says
  > `schedule`. See [CI self-serve diagnostics](./ci-diagnostics.md) § "A scheduled run reports
  > `event: push`".
- **Adding this as a required PR check is a manual operator step** — the agent cannot configure branch
  protection itself; the scheduled run is a safety net, not a merge gate, until an operator wires the
  PR-triggered context into branch protection.
- **Trivy is not on every developer machine, so the scored scan is CI-authoritative** — don't treat a
  local enumeration (`--list`, which needs no Trivy and works anywhere) as equivalent to a real scan
  result. The Linux dev container is not one of the machines without Trivy: the binary is absent from
  `PATH` but Trivy runs from its own image, and a full local sweep of every pulled image is a
  documented recipe in `docs/runbooks/infra-image-scanning.md` (which also records the two silent
  blockers — the install script downloading nothing, and the default DB mirror not resolving — and the
  ghcr mirrors and `--severity CRITICAL --ignore-unfixed` invocation that route round both).
- **Triaging an advisory you cannot scan: scan first, and read the build definition only as a
  fallback.** "Trivy is absent from the dev container" is wrong — what is absent is the binary on
  `PATH`, and it runs from its own image; an inference is owed only when a *pull* genuinely fails (a
  private registry, a deleted tag, no disk headroom), not when a binary is missing. A sibling release
  tag is usually pullable and should simply be scanned. When an inference really is the only option,
  read the version from the **build definition of the release** (for Keycloak, the root `pom.xml` at
  the release tag on GitHub — Maven Central is not on the egress allowlist, but `raw.githubusercontent.com`
  is reachable), and **record in the justification that this is an inference, not a scan**. Prefer the
  direction that fails safe: a key covering a ref that turns out clean suppresses nothing extra; a key
  that omits an affected ref blocks the board.
- **Is the advisory still the severity you triaged it at?** The gate blocks on fixable **Critical**
  only, so an advisory re-rated Critical→High stops blocking without anything upstream changing — and
  in the gate's output that is indistinguishable from remediation. Read the installed package version
  before writing "remediated".

Full scanner-vs-scanner coverage table, the allowlist entry shape and seeding steps, the local Trivy
recipe, and the remediation ownership: `docs/runbooks/infra-image-scanning.md`.
