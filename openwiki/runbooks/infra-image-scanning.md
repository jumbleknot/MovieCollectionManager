---
type: Runbook
title: Infra-image CVE scanning
description: Trivy's keyless, twice-weekly sweep over the third-party server images this project pulls but does not build (Keycloak, Postgres, Mongo, Vault, OpenSearch, Langfuse, Grafana, Unleash, Caddy, RustFS and the rest of infrastructure-as-code), plus how to read or triage a red result — one scanner per image, the fixable-Critical-only gate, the allowlist cohorts and how an entry is discharged, the bounded retry, the one pinned installer all three scanning workflows share, the shared per-image pipeline both the PR and the deploy call, the labelled container holds that keep the PR's run-scoped scan tags alive across another run's prune, and the publish-versus-promote split.
resource: docs/runbooks/infra-image-scanning.md
tags: [security, cve, trivy, ci, runbook]
sources:
  - id: openwiki-source-810a3627633783500597ffc6
    resource: repo://.forgejo/workflows/app-ci.yml
  - id: openwiki-source-80b643ca97b6e7e300789088
    resource: repo://.forgejo/workflows/cd-deploy.yml
  - id: openwiki-source-7bd434a17ed7c27916b1d2ae
    resource: repo://.forgejo/workflows/infra-image-scan.yml
  - id: openwiki-source-6e3646982d72c64cb5e2486d
    resource: repo://.forgejo/workflows/renovate.yml
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-f83bd1373e0f000fa5d548c0
    resource: repo://docs/runbooks/ci-diagnostics.md
  - id: openwiki-source-7c76000f237dd683a4fb0536
    resource: repo://docs/runbooks/infra-image-scanning.md
  - id: openwiki-source-23175e1d10427daa3344d3ec
    resource: repo://docs/runbooks/prod-control-tower.md
  - id: openwiki-source-045a0d186e0b60056b359b2e
    resource: repo://docs/runbooks/renovate.md
  - id: openwiki-source-4042a47526d6016cff835628
    resource: repo://infrastructure-as-code/docker/mc-service/compose.yaml
  - id: openwiki-source-0ff61f596da1302e58282fa2
    resource: repo://infrastructure-as-code/docker/observability/compose.yaml
  - id: openwiki-source-7ad99116ef3a9756b7c06307
    resource: repo://infrastructure-as-code/docker/opensearch/compose.yaml
  - id: openwiki-source-3b86829117dd0577834407fc
    resource: repo://infrastructure-as-code/docker/vault/compose.prod.yaml
  - id: openwiki-source-819b0a18008c0f90a7eaf2b3
    resource: repo://infrastructure-as-code/docker/vault/compose.yaml
  - id: openwiki-source-cc2828785988d51226a4241e
    resource: repo://renovate.json
  - id: openwiki-source-0a51228742c9892eef223b4e
    resource: repo://scripts/__tests__/app-image-scan.test.mjs
  - id: openwiki-source-9569e077273f937a713aad61
    resource: repo://scripts/__tests__/cd-scan-push-gate.guard.test.mjs
  - id: openwiki-source-27bdf2533d99346470f527d9
    resource: repo://scripts/__tests__/ci-install-trivy.test.mjs
  - id: openwiki-source-b6dd2f2ef27fe2526cd380f7
    resource: repo://scripts/__tests__/infra-image-scan.test.mjs
  - id: openwiki-source-9718a90a7733637f39e0b867
    resource: repo://scripts/__tests__/mongo-data-owner.guard.test.mjs
  - id: openwiki-source-ff0e1ec996f6a1fc5b3d0ba8
    resource: repo://scripts/__tests__/no-minio-references.guard.test.mjs
  - id: openwiki-source-6a31387312db2b158048d4d9
    resource: repo://scripts/__tests__/renovate-workflow.guard.test.mjs
  - id: openwiki-source-52c33ce59ba156d00cf24a1d
    resource: repo://scripts/__tests__/upload-artifact-retention.test.mjs
  - id: openwiki-source-60011cd55e5b787da8893ea3
    resource: repo://scripts/allowlist-expiry.mjs
  - id: openwiki-source-0af8f352da052e268e893ea2
    resource: repo://scripts/cd/promote-digest.sh
  - id: openwiki-source-b86ccae465a7267495c319ec
    resource: repo://scripts/cd/scan-app-image.sh
  - id: openwiki-source-fe6babf23c099d13c73c6b6f
    resource: repo://scripts/cd/scan-push.sh
  - id: openwiki-source-214c4d8d22f6d46c2e78f3b4
    resource: repo://scripts/check-infra-image-findings.mjs
  - id: openwiki-source-daf4f583f7313d88c7671f4b
    resource: repo://scripts/ci-install-trivy.sh
  - id: openwiki-source-70875ab1853f42b7c7d4b78a
    resource: repo://scripts/ci-status.mjs
  - id: openwiki-source-d1e0316ab362ff8dcec4fc0d
    resource: repo://scripts/infra-image-scan.mjs
  - id: openwiki-source-b202cb0e9ae4a5b1b46e466a
    resource: repo://scripts/lib/scanner-retry.mjs
  - id: openwiki-source-7d0fa5a3a30eb305011c4b8d
    resource: repo://scripts/publish-sweep-verdict.mjs
  - id: openwiki-source-4708763005c35901b04f5740
    resource: repo://security/infra-images/allowlist.yaml
  - id: openwiki-source-0a3ed93b2a41764b679ff58d
    resource: repo://security/infra-images/severity-map.yaml
  - id: openwiki-source-2e26935bed37e1316dc175a0
    resource: repo://specs/081-major-dependency-upgrades/tasks.md
generated: { by: "openwiki/0.7.1", at: "2026-11-07T19:55:04.696Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-11-07T19:55:04.696Z
---

# Infra-image CVE scanning

Trivy scans every third-party image the project pulls but does not build — everything under
`infrastructure-as-code/**` except images scanned by their own builder, and except a ref that is still
`${..}`-interpolated once the one host variable this scan can resolve has been substituted (see the
registry-host gotcha below). It is deliberately disjoint from
[SAST/SCA scanning](./sast-scanning.md), which covers first-party source and first-party dependency
graphs, and from [DAST scanning](./dast-scanning.md), which exercises the running app over HTTP.
Renovate keeps base images current; this scan catches a freshly published CVE against an
already-pinned image, which currency alone cannot.

**Cadence: twice weekly — Tuesday and Friday, 04:00 UTC — and the scheduled sweep is never
path-gated.** A new advisory can land against an image nobody changed, so the on-change PR/push check
exists only for fast feedback, not as the source of truth. The Friday run is ordered three hours ahead
of the Renovate window on purpose (see [Renovate](./renovate.md)), and that ordering is pinned rather
than commented: `renovate-workflow.guard.test.mjs` asserts the latest sweep cron fires **strictly
earlier** than the earliest window cron, with at least a two-hour gap, and that both are UTC-fixed
5-field expressions (item #487). The guard picks the window cron **structurally rather than by name**:
it keeps only the `renovate.yml` crons that fire exactly one hour-of-week slot, so the nightly
`0 3 * * *` — seven slots, the schedule-exempt security channel — drops out and the single-slot Friday
window cron is what the sweep is ordered against. Adding another single-slot cron to `renovate.yml`
therefore changes what the ordering is asserted against, and a sweep cron that lands later than it
fails the build. The same test also fails if the workflow stops recording *why* its cron sits where it
does — the file must still carry the `item #487` reference — because an unexplained time is the one a
later reader tidies. The Tuesday run (item #642) means an advisory published early in the week is
visible with three days in hand instead of surfacing at the moment the window's PRs already exist and
inherit a red nobody had seen — GHSA-vcvr-r3jv-pc5j, on the unchanged `langfuse:4` pins, was published
2026-09-22, was absent from Trivy's DB for the 2026-09-25 sweep, and first surfaced at 04:00 on
2026-10-02. It runs the same steps as Friday's, including the expiry check and the
`infra-image-scan/weekly` verdict, which Friday's run then overwrites before the window. Tuesday 04:00
is hour-of-week 52, far ahead of the window, so the ordering guard still compares against Friday 04:00.

**The object store is a pulled image again, and feature 080 is why.** From feature 069 until feature
080 the S3 object store was built from source and scanned by its own builder; feature 080 replaced it
with an upstream, digest-pinned `rustfs/rustfs` Docker Hub pull, so **RustFS is scanned here like every
other server image**, in every compose file that pins it. The from-source build, its workflow, its
promoter, its Renovate rule and its four allowlist entries were deleted in the same change, and
`scripts/__tests__/no-minio-references.guard.test.mjs` now fails on any *live* reference to the retired
machinery — the runbook keeps its case study inside an explicit `<!-- history:begin -->` block, which is
the only place such prose is allowed to survive. See "What feature 080 changed" below for the
transferable lessons; nothing in that section describes a mechanism that still runs.

## How a run flows

```mermaid
flowchart TD
  A["cron Tue + Fri 04:00 UTC"] --> C
  B["pull_request — no paths filter"] --> C
  D["push — infra paths only"] --> C
  C["changes job — dorny filter, PR-only"] --> E{"RUN_SCAN"}
  E -->|"infra path on a PR, or any non-PR event"| F["scanImage per enumerated image"]
  E -->|"non-infra PR"| G["every Trivy step skipped — required context still posts success"]
  F --> H["check-infra-image-findings.mjs — the gate"]
  H -->|"un-allowlisted fixable Critical"| I["gate red"]
  H -->|"nothing blocking"| J["gate green"]
  I --> K
  J --> K
  K["always() — the observability steps run even in the week the gate is red"]
  K --> L["scheduled runs only: the allowlist expiry check over both allowlists"]
  L --> M["every non-PR run: posts infra-image-scan/expiry carrying the measured event, gate and expiry outcomes"]
  K --> N["scheduled runs only: posts infra-image-scan/weekly carrying the sweep's verdict"]
```

Trigger-to-verdict flow. The `changes` job only ever *gates* the Trivy steps; the required
`infra-image-scan / infra-image-scan` context is posted by the job either way. The expiry check is
scheduled-only and runs *before* the recorder that measures it, so the recorder's `expiry_step` field
is a statement about a step that has already had its chance to run. Both statuses at the foot are
posted by `always()`-guarded steps — which is why they still run in the week the gate is red — and
neither can gate anything.

## Entrypoints

| entrypoint | what it does |
|---|---|
| `node scripts/infra-image-scan.mjs` | enumerate → Trivy each image → write `security/infra-images/reports/{findings.json,summary.txt,trivy-*.json}`. `--list` enumerates only (needs no Trivy, works anywhere); `--emit-allowlist` also writes `allowlist.proposed.yaml`; `--image <ref>` scans exactly one image instead of enumerating the tree (this is how a builder scans its own artifact, and how the shared per-image script below drives both callers). |
| `node scripts/check-infra-image-findings.mjs` | the gate: exit 1 on any `blocking` finding not suppressed by a live allowlist entry; `--check-expiring` is the report-only hygiene tier; `--selftest` proves fail/suppress/expiry without Trivy. |
| `bash scripts/cd/scan-app-image.sh <local-tag>` | the SHARED per-image scan-and-verdict block (spec 084 US3): runs the scan then the gate on one local image and returns two exit codes — `0` clean, `10` scanner error (nothing was assessed), `11` blocking finding, `2` usage. Both push-time consumers call it rather than reimplementing the pipeline: `scripts/cd/scan-push.sh` before each `docker push`, and app-ci's `app-image-scan` job on the six images `app-e2e` built. It is the per-*image* contract, not the only caller of the two commands: `infra-image-scan.yml` runs `infra-image-scan.mjs` and then `check-infra-image-findings.mjs` itself, once per full sweep of the enumerated tree. |
| `bash scripts/ci-install-trivy.sh <vX.Y.Z> <bindir>` | the ONE Trivy installer all three scanning workflows call, so the PR gates and the deploy scan cannot drift on the scanner. It downloads the pinned release tarball and checksums from GitHub, verifies the sha256, and refuses to finish unless the installed binary reports the pinned version — so a green install step means *this* version is on PATH, not that a version line was printed. |
| `pnpm nx infra-scan infrastructure-as-code` | the Nx target wrapping the orchestrator, alongside the `sast`/`dast` targets. |
| `security/infra-images/severity-map.yaml` | Trivy severity → normalized scale. An unmapped native value is a hard error in the orchestrator (no silent default); `UNKNOWN` maps conservatively to `Low` so it can never block. |

Exit codes are deliberate: `0` ok, `1` scan/gate-relevant failure (fail-closed), `2` bad args or
config error — including the unresolved-`REGISTRY_HOST` refusal below.

Reports land in the gitignored `security/infra-images/reports/`, and CI uploads that directory as the
`infra-image-scan-report` artifact with a 14-day retention — a diagnostic, not a record (spec 084
FR-019c). The upload is `always()`-guarded inside the scan path, so a red sweep still leaves its
findings readable.

## Gotchas

- **Not path-gated on the authoritative run — and an ordinary merge to `main` never re-scans.** A
  twice-weekly full sweep is the scan of record precisely because a new advisory can land against an
  image nobody changed; the on-change check on infrastructure edits exists only for fast feedback. The
  `push` trigger keeps its `paths:` filter while the `pull_request` trigger has none, so a non-infra
  merge runs no Trivy at all: a newly published advisory surfaces on whichever infra-touching PR (or
  cron) runs next — and because branch protection's glob also matches the push-event context, an infra
  CVE with no bearing on that PR's diff can make it unmergeable.
- **The `changes` job's PR-only `if:` is load-bearing — removing it silently kills the sweep.** The
  `dorny/paths-filter` step is gated on `github.event_name == 'pull_request'` because dorny derives its
  diff base from the PR event and, on any other event, falls back to the repository's default branch —
  which this forge does not put in the payload, so the action hard-errors. That used to kill `changes`
  on the cron, and since `infra-image-scan` is `needs: [changes]` the required job was skipped: the
  full sweep — the whole point of the un-path-gated safety net — never ran. Skipped, the filter
  output is empty and `RUN_SCAN`'s `github.event_name != 'pull_request'` clause forces the sweep, which
  is exactly the intended behaviour. A `push` is unaffected by dorny's diff base but is filtered out
  here anyway and loses nothing, for the same reason.
- **Scanner partition rule: by coverage, not by namespace.** An image is scanned by whoever *builds*
  it; everything else belongs here. `cd-deploy` owns its six app images (see
  [CI/CD pipeline](../projects/ci-cd-pipeline.md)); nothing else builds an image any more, so
  `BUILT_IMAGE_NAMES` is exactly those six and every pulled third-party image — RustFS included — is
  enumerated here. Those six are not unscanned, though: since spec 084 US3 the same per-image pipeline
  this page's gate uses runs on them at PR time through app-ci's `app-image-scan` job (see
  [CI self-serve diagnostics](./ci-diagnostics.md)), because until then a Critical introduced by a
  base-image bump passed every PR check and surfaced as a failed deploy on `main`, where nothing
  blocks. The exclusion rule used to be `if (ref.includes('jumbleknot/')) continue` — matching
  "anything named like ours" rather than "anything already scanned by a builder". Feature 069 broke that
  coincidence by adding a `jumbleknot/*` image built outside cd-deploy; under the old rule it was
  excluded here and absent from cd-deploy's set — published and examined by neither gate, zero findings,
  no error. The rule is now membership of `BUILT_IMAGE_NAMES`, and the guard asserts the list is exactly
  cd-deploy's six. Any future image built outside cd-deploy must be added to `BUILT_IMAGE_NAMES` or
  explicitly enumerated here — the invariant is exactly one scanner per image, not zero and not two.
  Completeness is asserted against a **hypothetical** fixture in
  `scripts/__tests__/infra-image-scan.test.mjs` (`jumbleknot/future-widget`), not against the live
  tree: the earlier fixture named a real image, and when that image's classification changed the test
  failed for a reason that had nothing to do with the property it asserts.
- **The registry host is interpolated in compose, and the scanner must resolve it or refuse to run.**
  `check-topology-scrub` forbids the real forge host in a committed file, so an image this project
  publishes to its own registry can only be referenced as `${REGISTRY_HOST}/…`. With `REGISTRY_HOST`
  set the ref is concretely pullable and is enumerated; without it the ref is skipped, and on a real
  scan that is a **hard failure** (`exit 2`), not a quiet reduction in coverage — a sweep that silently
  covers less than the tree and still passes is worse than one that fails loudly. The variable is
  matched by regex, not as a literal, so the guarded compose form (`${REGISTRY_HOST:?…}`, which contains
  spaces) resolves too. **The workflow stopped supplying `REGISTRY_HOST` in feature 080**, because its
  only consumer — feature 069's from-source object-store ref — is gone and every remaining
  `${REGISTRY_HOST}` ref in the tree is a cd-deploy image excluded for two other reasons (a second
  `${…}` and membership of `BUILT_IMAGE_NAMES`). Those are deliberately *not* reported as unresolved:
  a warning that cries wolf is one nobody reads. If a future compose ref genuinely needs the host,
  the scan exits 2 naming the ref rather than silently shrinking what it covers.
- **Only a fixable Critical blocks the gate.** An unfixable Critical (no upstream patched version yet)
  is a report-only warning, since a version bump can't clear it and it must not wedge the gate
  indefinitely. `normalizeTrivy()` marks `blocking = Critical AND a fix exists upstream` — the same bar
  as the `cd-deploy` built-image gate — and the gate trusts the report's `blocking` flag rather than
  re-deriving it.
- **A finding and a scanner fault are two different exit codes on two commands.** `scripts/infra-image-scan.mjs`
  invokes Trivy with `--format json` and **no** `--exit-code`, so a non-zero scan exit can only mean
  the scanner could not run; `scripts/check-infra-image-findings.mjs` then carries the verdict from the
  normalized report. The two meanings are split across two commands rather than one integer, and
  `scripts/cd/scan-app-image.sh` is where they are wired together as a single per-image contract: it
  maps a failed scan to exit `10` and a failed gate to exit `11`, and each caller turns those into its
  own operator message. That contract covers the *built* images; the full sweep of pulled images runs
  the same two commands directly from `infra-image-scan.yml`, so the split is a property of the two
  scripts, not of the shared wrapper. `cd-deploy`'s per-image loop calls the shared script **before**
  `docker push`, and app-ci's `app-image-scan` job calls the same script on the six images `app-e2e`
  built — one pipeline, so one Trivy pin, one set of flags and one allowlist for both the PR and the
  deploy. It is also why accepted findings on the deploy path live in
  `security/infra-images/allowlist.yaml` rather than in a `.trivyignore` nobody reviews. Pinned by
  `scripts/__tests__/cd-scan-push-gate.guard.test.mjs` (the gate runs before `docker push` and inside
  the per-image loop, the bare `trivy image --exit-code` form stays gone, and an unexpected exit code
  fails closed) and by `scripts/__tests__/app-image-scan.test.mjs`, whose drift guard fails if either
  caller starts scanning on its own.
- **The PR-time scan fails closed on an unknown app diff — "could not evaluate" is not "nothing to
  scan".** app-ci's `app-image-scan` reads `needs.changes.outputs.app` to decide whether there is
  anything to scan, but only after checking `needs.changes.result`: if the `changes` job did not
  succeed, whether the app images changed is *unknown*, and the job fails rather than taking the early
  pass. The early pass is reserved for the measured case — the filter said no app path changed, so the
  images are `main`'s, which the deploy gate already scanned. Past that decision the job verifies all
  six run-scoped tags with `docker image inspect` *before* scanning anything and fails naming every
  missing one, and each image then gets its own step under `always() && RUN_SCAN == 'true' &&
  SCAN_READY == 'true'` so one failing scan does not stop the rest. It runs on pushes to `main` as well
  as on pull requests, and `trigger-cd` requires its `success`, so a vulnerability-database change shows
  as a red on `main` *before* any dispatch rather than as a failed deploy. Pinned by
  `scripts/__tests__/app-image-scan.test.mjs`.
- **The PR's scan tags are pinned by a labelled container, because the runner is shared and every job
  starts by pruning (item #915, research R15).** The single `kvm` runner can take *another* run's
  `app-e2e`, `dast` or `build-deploy` between this run's `app-e2e` and its `app-image-scan`, and each of
  those begins with `docker image prune -af` — which deletes a **bare tag**, since the tag has no
  container. That is how PR #909 failed `missing scan tag(s)` twice on code nobody had scanned, after
  its own `app-e2e` had passed. The fix exploits a Docker property rather than a lock: `image prune -a`
  never removes an image that has a container, so the tag step also creates a stopped container named
  `app-scan-hold-<run id>-<name>` and labelled `mcm.app-scan-hold=run-<run id>` on the run-scoped tag
  (`docker rm -f` first, because a re-run attempt keeps the run id and would collide with the first
  attempt's hold). Three sites prune images — `app-e2e`, `dast` and `cd-deploy`'s `build-deploy` — and
  each first runs `docker container prune -f --filter label=mcm.app-scan-hold --filter until=24h`, so a
  cancelled run whose scan never ran pins its images for at most a day and a run still waiting for its
  scan keeps them. The scan job removes its holds **before** its tags under `always()`, because
  `docker image rm` on a tag whose image still has a container only untags it. `docker ps -a --filter
  label=mcm.app-scan-hold` on the ci daemon lists the holds, and a hold from a run that finished more
  than a day ago means a prune site has lost its sweep. `scripts/__tests__/app-image-scan.test.mjs`
  pins the ordering (sweep before prune), the label and age filters, the hold-before-tag removal, the
  count of image-prune sites, and refuses any workflow-level `docker system prune` or unfiltered
  `docker container prune` that would take the holds out wholesale.
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
  rather than producing a clean-looking report. "Keyless" means no credential reaches the scan: Trivy
  is invoked with no registry auth and no `${{ secrets }}` is handed to it. The workflow's only secret
  reference is `CI_DIGEST_TOKEN`, consumed by the feature-042 failure-digest step, which never touches
  the scan. Keyless is also *why* an image's own builder scans it rather than routing it here: our
  built images live in a private registry, so a scan with no credential cannot pull them (measured:
  `unable to find the specified image`). A builder already holds the image locally and is already
  authenticated, so it needs no new credential and gates the publish instead of auditing after it.
- **The allowlist is baseline, not permanent.** Suppression is gate-only; findings stay visible in the
  report, and a suppressed entry must be deleted once the underlying image is actually bumped — leaving
  a stale entry hides a regression rather than tracking a real accepted risk. Every entry needs
  `image`/`id`/`justification`/`addedBy`; a blank field or invalid regex is a gate error, and a past
  `expiry` stops suppressing. The policy is stated in `security/infra-images/allowlist.yaml` itself.
- **Key a suppression to a VERSION — or, where the version cannot carry it, to the DIGEST — so an
  upgrade can discharge it.** `image` is matched as an **unanchored** regex against the full scanned
  reference, and that one property decides whether a suppression can ever end. A version-anchored key
  survives a digest being appended and stops matching the next version: `hashicorp/vault:1\.18`
  matched `1.18@sha256:…` and stopped matching `1.21`, which is how PR #289's bump surfaced the
  Criticals that key was written for — a dischargeable key doing its job, loudly. A bare repository name
  (no tag) instead matches every tag that image will ever have — it suppresses the advisory it was
  written for *and every future one in the same image*, silently and permanently. That is not an
  accepted risk with a review date, it is a permanent hole.
  Where the reference is a floating major, or the advisory survives a version move, the **digest** is
  the dischargeable half: the OpenSearch entry is keyed to a digest rather than to `opensearch:3`, so an
  upstream rebuild — not a tag move — is what ends it, and it had to be re-keyed from the 2.x digest to
  the 3.x one when the OpenSearch 3 major did **not** clear the advisory. The Unleash entry named both
  version and digest (`^unleashorg/unleash-server:8\.2\.1@sha256:c6eaaede7242`), so any image change
  re-blocked: it was re-keyed 8.2.0 → 8.2.1 in the 2026-10-30 Renovate window after the new digest was
  re-measured and still carried proxy-addr 2.0.7 under the boolean `trust proxy` that keeps
  `CVE-2026-90711` unreachable — and it was then **discharged** on 2026-11-01, when the 8.3.1 rebuild
  (`sha256:025cd8b003a7`) shipped proxy-addr 2.0.8 as the only copy in the image and the entry was
  deleted rather than left to match nothing.
  `scripts/__tests__/infra-image-scan.test.mjs` asserts both directions for every formerly-floating
  repository: the key still matches today's pin **and** stops matching a later version derived by
  incrementing the pin's last number (a hand-written "next version" literal silently stopped meaning
  "later" when a bump moved past it). A tag carrying no number cannot be bumped this way; the helper
  fails loudly and asks for a declared exception rather than passing vacuously.
- **Re-keying an allowlist entry is required whenever a pinned tag changes, not optional tidy-up.**
  An entry keyed to the old tag matches nothing after the bump, the finding it covered becomes
  un-allowlisted, and the gate blocks — while reporting the entry only as an `UNMATCHED ENTRIES` line,
  which reads like housekeeping rather than like the cause. Check that line before assuming a new CVE
  appeared. Unmatched detection is also **scoped to the images the run actually scanned**
  (`generatedForImages`, item #423), because two jobs consult this one allowlist — the full sweep and
  the single-image `cd-deploy` scan-push loop, whose findings both carry the same literal scanner
  label — and each used to report the other's live entries as stale. The field is required, not
  defaulted: a producer that stops writing it fails the gate rather than silently restoring the old
  behaviour.
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
- **A hold can outlive its entries — once a clean tag ships, the GATE is the hold.** `hashicorp/vault`
  was held below 1.19 by a renovate.json `allowedVersions` ceiling from 2026-08-30 until 2026-10-20,
  precisely because the `vault:1\.18` entries could not match `1.21` and that bump added two new pgx
  Criticals. Feature 081 US8c re-measured `vault:2.2.0@sha256:e0acd3c6…` at **zero** Criticals of any
  kind, moved both refs to `2.2`, **deleted** the three seed entries rather than re-keying them (a
  re-keyed entry would match nothing and fail the expiry check), and lifted the ceiling. There is
  therefore no vault entry in the allowlist today, which is what makes `infra-image-scan` itself the
  hold: it now blocks any fixable Critical in a proposed vault tag. What replaced the ceiling is a
  major-approval gate — a vault MAJOR needs a dashboard tick (raft storage on a dormant prod stack),
  while patch and minor stay automatic and scan-gated.
- **A discharged hold is replaced, not deleted — and for mongo the re-own wrapper is what made the move
  safe.** `mongodb/mongodb-community-server` was hard-held below 9 by a renovate.json
  `allowedVersions: <9` ceiling added 2026-10-23 (item #819), because mongod 9.0.4 refused to start on
  this host's kernel (SERVER-121912) and 9.0 runs mongod as uid 1000 where 8.0.8 used 998, so it could
  not open an 8.0 volume. Spec 081 US8a (PR #817) discharged both premises in one change: the host moved
  to a 7.0.0 patch that 9.0.4's Ubuntu exemption admits (SERVER-131779), every mongo ref moved to the
  digest-pinned `9.0-ubi9`, each MongoDB service that mounts `/data/db` now starts as root only to re-own
  the volume and drops to the image's `mongod` user with `setpriv` before mongod runs, and the ceiling
  was lifted. What is asserted is the **successor**, not the absence — no `allowedVersions` on patch,
  minor or major, `dependencyDashboardApproval` true on a major and undefined on a patch — because a
  `<9` left behind would block the version actually deployed and make Renovate propose a downgrade, and
  because a hold deliberately discharged and one someone deleted look identical from the absence of a
  ceiling. `scripts/__tests__/mongo-data-owner.guard.test.mjs` is the second lock: it asserts both
  halves of the wrapper (start as root to re-own, drop before mongod) on the dev AND prod compose files,
  runs the wrapper against stubs so the assertion is about what it does rather than how it is spelled,
  and requires at least one matching service per file so a rename cannot make every assertion pass
  vacuously. The observability postgres rode the same successor rule when spec 081 US8b moved it to 18.
- **How to read the allowlist's cohorts — the file is a baseline, not a record of what is currently
  risky.** What matters is the *shape* of an entry, because that shape is what decides whether it can
  ever end:
  - **Baseline (no `expiry`).** The only entries allowed to suppress indefinitely, for an advisory no
    reachable tag clears — a Go-stdlib Critical inside a binary the postgres images ship is the standing
    example — and each one records its own measurement rather than assuming it. A bump cannot clear
    these, which is why they carry no date.
  - **Time-boxed (`expiry` in the near future).** The default shape for a newly published advisory on an
    unchanged pin. The date forces a re-check instead of an indefinite acceptance, and the 14-day
    warning window makes the weekly sweep red before it lapses. Cohorts are deliberately dated together
    so the re-triage is one sitting rather than a dribble.
  - **Version-keyed, or version+digest-keyed.** The key names the pin the run actually scans, so a bump
    re-blocks and forces a fresh scan rather than inheriting the suppression.
  - **Digest-only-keyed.** Used where the suppression has to be discharged by a **rebuild** rather than
    by a tag move. Renovate proposes from the registry rather than from this file, so every rebuild is
    still offered, the new digest is scanned unsuppressed, and the Renovate PR's own scan proves whether
    the rebuild carries the fix instead of inheriting the acceptance. The price is stated below: once
    the digest moves, the key matches nothing. The live example is the `CVE-2026-111497` brotli cohort,
    whose keys name the digest with no version at all (`^caddy:2\.11\.7-alpine@sha256:d8542f48d34a`,
    `^postgres:18-alpine@sha256:77f585114c32`,
    `^postgres:18\.6-alpine3\.23@sha256:697c180dbf24`).
  - **Discharged, not re-keyed.** Where a bump or a same-version digest refresh measurably clears the
    advisory, the entry is **deleted** rather than re-keyed — a re-keyed entry would match nothing and
    fail the expiry check, and deleting is the direction that restores blocking. Comment blocks left
    above an absent entry are the file's history, not a live suppression.
  - **Live inventory (2026-11-01): six entries.** Two un-expiring BASELINE entries carry the same
    Go-stdlib Critical (`CVE-2025-68121`) on `postgres:18\.6-alpine3\.23` and `postgres:18-alpine`, each
    recording its own measurement because no reachable tag clears it (the shipped binary carrying it is
    `usr/local/bin/gosu`). The other four are time-boxed to `2026-12-01`: the OpenSearch netty digest key
    (`CVE-2026-75595`) and three brotli digest keys (`CVE-2026-111497`) on caddy and both postgres lines.
    Everything else in the file is a comment block recording an entry that has been discharged — history,
    not a live suppression.
  - **The three tiers the gate reports** are `EXPIRING SOON` (inside the 14-day window, still
    suppressing), `EXPIRED` (no longer suppressing, and the line names the date and who added it), and
    `UNMATCHED ENTRIES` (suppressed nothing this run — which names three causes, not two: already
    remediated, the scanner changed identifier namespace, or the rule could not run and so found
    nothing). Only `expired` stops suppression; an entry suppresses through the whole of its final day,
    and classification is computed on UTC date boundaries so neither a runner's timezone nor a DST
    transition can move it.
- **A digest-keyed entry whose digest moves goes silent, not stale.** Unmatched detection is scoped to
  the images the run actually scanned (item #423), so an entry whose `image` regex matches none of them
  is out of scope by design and is *not* reported as `UNMATCHED`. Only the `EXPIRING`/`EXPIRED` tiers,
  computed over the whole allowlist, will ever surface it — so a digest-keyed entry whose rebuild has
  already landed is invisible until its own expiry window opens. That is the price of keying to content
  rather than to a version, and the recorded cue is to delete each such entry as its digest bump lands
  rather than renew it without re-scanning. The brotli cohort produced the measured case: the tree moved
  `rustfs/rustfs` 1.0.3 → 1.0.4 on 2026-10-30, so the `^rustfs/rustfs:1\.0\.3@sha256:9ca9559533b5` key
  suppressed nothing and was not reported as unmatched; the 2026-11-01 re-triage found it by reading the
  cohort and **deleted** it rather than renewing it. The three surviving brotli keys (caddy and both
  postgres lines) still name today's pins.
- **A published advisory on an unchanged pin is the file's normal shape, and whether the bump
  remediates it is measured, never assumed.** Advisories land against images already running in prod and
  turn `infra-image-scan` red for every compose / `renovate.json` PR at once, with nothing in the diff
  responsible. The same advisory can be cleared by a **same-version digest refresh** on one image while
  the newest upstream build of another still ships the pre-fix package, so "bump the tag" is not
  automatically the remediation: the new digests are scanned first, and only then is each entry re-keyed
  to the new pin or deleted. Where the new pin still carries the advisory the entry is re-keyed in the
  same change (same CVE, same expiry); where it does not, the entry is deleted, because a re-keyed entry
  that matches nothing keeps failing `--check-expiring` whatever its date. Every surviving justification
  states that the entry is deleted once a clean rebuild ships — a time-box that forces a re-check, not
  an accepted risk without one. The 2026-10-23 ca-certificates cohort has now emptied, and its members
  took different routes out: **Keycloak** cleared `CVE-2026-114406` by a same-version digest refresh in
  PR #838; the **mongo** `9.0-ubi9` entry was discharged on 2026-11-01, when upstream's UBI 9.8 rebuild
  of the same 9.0.4 (`9.0.4-ubi9-20261031T064800Z`, index `sha256:3d40c6fa895f` — the digest every mongo
  ref now pins) shipped the fixed `ca-certificates 2026.2.92_v9.0.319-90.3.el9_8`, scanned at zero
  fixable Criticals; and the **langfuse** web/worker entries were discharged on 2026-11-01 (item #895),
  when the images moved to `4.72.0` and the newest upstream build shipped a clean CA bundle — both
  scanned at zero fixable Criticals, so the three entries were deleted rather than re-keyed. Nothing here
  is inferred from a version number: each ending follows a scan of the exact new digest.
- **A cohort is re-triaged in one sitting, and the re-triage is where a stale key is actually found.**
  The 2026-11-01 re-triage (Trivy 0.76.1, ghcr DB, every newest rebuild scanned) is the shape to copy:
  of the six brotli entries, `curlimages/curl` and `httpd` had shipped clean rebuilds
  (`brotli-libs 1.2.1-r0` / `libbrotli1 1.1.0-2+deb13u1`) so both refs moved and both entries were
  **deleted**; `rustfs` had already moved and its entry was deleted as above; and the remaining three —
  caddy and both postgres lines — had **no** clean rebuild, so rather than renewing them on the clock
  each was renewed to `2026-12-01` on **measured non-reachability** recorded in its own justification
  (in each digest the only object linking `libbrotlidec` is `libcurl.so.4.8.0`: for caddy its only
  consumer is the curl CLI, which this service never runs — Caddy is a static Go binary and the
  healthcheck is `nc -z`; for postgres the only thing linking libcurl is the `libpq` OAuth-client module
  the server never loads, since the only client run here is `pg_isready` with no OAuth parameters).
  Renewing a suppression without a fresh scan is the thing the time-box exists to prevent.
- **The floating-tag exception set is EMPTY — that is correct, not a regression.** The date-tagged
  object-store images left the tree with feature 069, and their from-source successor left with feature
  080, so nothing is referenced by a tag the classifier cannot order. The old rule ("a floating count
  of 0 is a FAILURE") still guards against widening `isFloatingTag` to hide exceptions, but it no longer
  works by asserting a magic count: the guard asserts **set equality** between the refs the classifier
  calls floating in `infrastructure-as-code/**` and the declared exceptions read out of renovate.json's
  docker-datasource `regex:^RELEASE` rules, with the count derived from that same declaration so the
  two cannot disagree. Tests `(fd1)`–`(fd4)` assert the classifier's behaviour directly and do not
  depend on the count at all — a count of 0 with an empty declared list is passing; a count of 0 where
  the declared list is non-empty is the failure. The declared set is read from **docker-datasource**
  rules specifically, because that list means "image references whose tag the classifier cannot order";
  feature 069 briefly added a `github-releases` date-versioning rule describing the *source* release we
  compiled, which was deliberately excluded here and was deleted with feature 080.
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
- **A red scheduled sweep is visible on the commit — as a status that cannot gate (item #485).** A
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
  # event_name=schedule gate=<x>     expiry_step=failure   <- it ran and a check failed: read the log
  # event_name=schedule gate=failure expiry_step=skipped   <- an earlier step failed (item #484)
  # event_name=push     gate=success expiry_step=skipped   <- a push-triggered sweep; correctly skipped
  # event_name=<unset>  expiry_step=<unset>                <- the runner returned no value: a real fault
  ```

  The step runs both allowlist checkers in sequence — the SAST one and
  `check-infra-image-findings.mjs --check-expiring` — and that mode is **report-only**: it does not
  evaluate blocking findings, so the step can never fail for a reason the gate above is already
  responsible for, and it cannot turn a red gate green.

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
  allowlist problem. The exemption that closes it is keyed on an **explicit `reportAbsent` marker**,
  never on the field merely being missing: a report that *exists* and omits `generatedForImages` is
  still a hard error, which is the property item #423 wrote the scoping for in the first place.

  > The `event_name` value here is also the standing answer to a forge trap that has cost a session
  > once already: `/actions/runs` reports `event: push` for a cron run, and only `trigger_event` says
  > `schedule`. See [CI self-serve diagnostics](./ci-diagnostics.md) § "A scheduled run reports
  > `event: push`".
- **The PR-triggered context is required; the scheduled sweep is not a merge gate.** Branch protection
  requires `infra-image-scan / infra-image-scan` on `main` through a glob that also matches the
  push-event context, which is why an infra CVE with no bearing on a diff can make an unrelated PR
  unmergeable. The scheduled sweep posts no such context and is a safety net only; its verdict is the
  separate `infra-image-scan/weekly` status above. Configuring branch protection is an operator step in
  the forge UI (repo → Settings → Branches) — the agent cannot change it.
- **Trivy is not on every developer machine, so the scored scan is CI-authoritative** — don't treat a
  local enumeration (`--list`, which needs no Trivy and works anywhere) as equivalent to a real scan
  result. The Linux dev container is not one of the machines without Trivy: the binary is absent from
  `PATH` but Trivy runs from its own image, and a full local sweep of every pulled image is a
  documented recipe in [the source runbook](../../docs/runbooks/infra-image-scanning.md) (which also
  records the two silent blockers — a vendor install script that downloads nothing and reports no error,
  and the default DB mirror not resolving — and the ghcr mirrors and
  `--severity CRITICAL --ignore-unfixed` invocation that route round both). CI no longer shares the first
  blocker: it installs through `scripts/ci-install-trivy.sh`, so a blocked download is a named error
  rather than a missing binary.
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
- **The scanner itself is version-pinned, installed through one shared script, and Renovate is what keeps
  it from rotting.** `infra-image-scan.yml`, `cd-deploy.yml` and `app-ci.yml` each write the version once
  as a `TRIVY_VERSION` assignment and hand it to `scripts/ci-install-trivy.sh <vX.Y.Z> <bindir>`, so a
  bump cannot move one site and strand the other. There are **three** such sites since spec 084 US3:
  app-ci's `app-image-scan` job scans the PR's images with the scanner the deploy will use, so a green PR
  that ran a different Trivy than the deploy would prove nothing. All three currently agree on `v0.76.1`.
  The installer itself is the fix for a measured silent failure, not a preference: Trivy's own
  `contrib/install.sh` was fetched from a moving branch and piped into `sh`, and on PR #929 (runs 6696 and
  6702, 2026-11-04) it failed **twice with no error at all** — it fetches the tarball from `get.trivy.dev`
  rather than GitHub, logs a non-200 at DEBUG level, and `set -e` turns that into a silent exit. The shared
  script downloads the release assets directly, retries a transient failure, verifies the checksum, and
  names the URL and curl's exit when a download fails. The
  floating form this replaced (script from `main`, no tag) had no digest underneath either, and it cost
  real comparability: during item #297 the local sweep ran `aquasec/trivy:0.74.0` while CI ran an
  unknown version, so two scans of byte-identical images could not be reconciled. A `customManagers`
  entry (`depNameTemplate: aquasecurity/trivy`, datasource `github-releases`) covers all three
  workflow files, and `renovate-workflow.guard.test.mjs` asserts the *resolved* state rather than the
  presence of a version string: all three pinned, the tag handed to `ci-install-trivy.sh` equal to the
  installed `TRIVY_VERSION` in each, all three agreeing on one version (a disagreement means one gate can
  block what another passes, with neither result explaining the other), that none of them pipes the
  vendor's script again, and the manager's `matchStrings` actually capturing a `currentValue` in each
  file — a manager whose regex misses is indistinguishable from no manager at all.
  `scripts/__tests__/ci-install-trivy.test.mjs` pins the installer's own behaviour offline against
  `file://` fixtures: a good release installs the pinned version, a checksum mismatch installs nothing
  and says so, a failed download names the URL instead of exiting silently (the PR #929 failure), a
  binary reporting a different version fails, and a tag that is not `vX.Y.Z` is refused before anything
  is fetched.
- **Is the advisory still the severity you triaged it at?** The gate blocks on fixable **Critical**
  only, so an advisory re-rated Critical→High stops blocking without anything upstream changing — and
  in the gate's output that is indistinguishable from remediation. Read the installed package version
  before writing "remediated".

## What feature 080 changed — and the lessons that transfer

Feature 080 (item #560) replaced the from-source object-store image with upstream `rustfs/rustfs`,
digest-pinned in every compose file that pins it, and deleted the build, its workflow, its promoter,
its Renovate rule and its four allowlist entries. The full case study lives in
[the source runbook](../../docs/runbooks/infra-image-scanning.md); what matters here is that four of
its lessons are about the *shape*, not about that image.

- **Publishing is not promoting.** A rebuilt, published image is not a deployed one: PR #559 bumped the
  builder base image as a security bump, the workflow rebuilt and published, and every compose ref
  still pinned the pre-#559 digest three weeks later (item #577). Anything a build scans is a claim
  about the image *as built* until a promotion repoints the pins. `cd-deploy` keeps the two acts
  distinct for its own images: `scripts/cd/scan-push.sh` scans and gates the push through the shared
  `scripts/cd/scan-app-image.sh`, and `scripts/cd/promote-digest.sh` writes the resulting digests into
  the tracked `.env.deploy` files as a separate step. On a registry that drops a manifest once nothing
  tags it, a build must also be pushed under an immutable per-run tag or a rebuild orphans the digest
  the compose refs pin — `cd-deploy`
  pushes each image as `${REGISTRY}/${NS}/<repo>:${GITHUB_SHA}`, and the promoter repoints the refs by
  digest. Without that, updating a pin would be a weekly breakage rather than a deliberate act.
- **A count of things to repoint comes from the tree, never from a note.** The promoter's spec note
  recorded "all four refs repointed", correct when written; a later feature added two more and the note
  went stale with nothing noticing. A live tree scan that treats an empty result as a hard failure is
  the only shape that cannot silently match nothing — a promoter that repoints zero refs is
  indistinguishable from one that worked.
- **Choosing a tool to avoid a decision removes your control of the decision.** Resolving a published
  digest via `docker buildx imagetools inspect` failed over plain HTTP while `docker push` succeeded in
  the same job, because `imagetools` is a **client-side** operation that talks to the registry itself
  and ignores the daemon's `insecure-registries` configuration. The lesson generalises past that tool:
  ask the registry directly for the manifest **list**, and take the scheme from an explicit setting or
  the forge origin and **fail rather than defaulting**, because assuming https is exactly what broke
  the run that chose the tool.
- **A rule is not an update channel — extraction is.** A Renovate `packageRule` can resolve, and its
  guard can pass, while nothing extracts the dependency it describes: the rule is only a claim about
  what would happen if the dep were ever seen. Read the Dependency Dashboard's *Detected Dependencies*,
  which is Renovate telling you what it actually extracted. See [Renovate](./renovate.md) for the
  measured case (item #560) — also recorded in `renovate.json`'s `rustfs/rustfs` rule description — and
  for the visibility guard in `scripts/__tests__/infra-image-scan.test.mjs` that asserts it: a guard
  should assert visibility, not configuration.
- **The property is asserted twice, once generally and once for the image that replaced the build.**
  `scripts/__tests__/infra-image-scan.test.mjs`'s `(412)` test covers every compose file carrying an
  `image:`; `scripts/__tests__/renovate-workflow.guard.test.mjs`'s `(080b)` test adds the RustFS-specific
  case, deriving the file set from `git ls-files` rather than a hand-written list and requiring every
  file that pins `rustfs/rustfs` to match a `docker-compose` `managerFilePattern` *and* not be excluded
  by `ignorePaths`. A file added later in a directory nothing matches therefore fails the build instead
  of silently joining the set nothing proposes updates for. `docs/runbooks/renovate.md` records that
  this assertion was mutation-tested by narrowing the pattern, because a visibility check nobody has
  watched fail is the same as no check.

## Guards

| guard | what it pins |
|---|---|
| `scripts/__tests__/infra-image-scan.test.mjs` | pure enumeration + normalization: the partition/completeness case against a **hypothetical** fixture, `BUILT_IMAGE_NAMES` being exactly cd-deploy's six, `${REGISTRY_HOST}` resolution and its loud unresolved-ref report, `isFloatingTag` `(fd1)`–`(fd4)`, set equality of floating refs against renovate's declared exceptions, the two-directional allowlist-key assertion, the digest-pin count and Renovate's compose-file visibility, and the RustFS ref being enumerated digest-pinned. Runs without Trivy, so it is Windows-friendly. |
| `scripts/__tests__/infra-image-scan-retry.guard.test.mjs` | the retry: the exact measured stderr classifies transient, each measured string does so on its own, and the **control** cases — a real finding, a missing image, unparseable output — are never retried. |
| `scripts/__tests__/cd-scan-push-gate.guard.test.mjs` | the deploy path: no bare `trivy --exit-code`, the shared pipeline is used, the gate runs before `docker push` and inside the per-image loop, `set -euo pipefail` still governs the step, both failure modes are reported in words rather than left to an exit code, and a fixable Critical still blocks while an unfixable one does not and is never classified transient. |
| `scripts/__tests__/app-image-scan.test.mjs` | the shared per-image pipeline and its two callers (spec 084 US3): `scripts/cd/scan-app-image.sh` returns 0/10/11/2 with the right message, neither caller runs the scanner or the verdict itself, both scan exactly the six images `scan-push.sh` pushes, the job runs on `kvm` after `app-e2e` with `always()` and is not restricted to pull requests, a missing scan tag fails the job naming it, the run-scoped tags are removed under `always()`, and `app-ci / app-image-scan*` is in `ci-status`'s required globs with `scripts/cd/scan-app-image.sh` in the `app` path filter. It also pins the item #915 prune race: `app-e2e` holds each tagged image with a labelled, stopped container, every one of the three image-prune sites sweeps stale holds *before* pruning images and filters by both label and age, the scan job removes its holds before its tags, and no workflow prunes containers without the hold filter. |
| `scripts/__tests__/allowlist-expiry-wiring.guard.test.mjs` | the weekly `--check-expiring` step exists exactly once, stays schedule-guarded, and the `infra-image-scan/expiry` and `/weekly` contexts cannot match the required branch-protection glob. |
| `scripts/__tests__/allowlist-expiry.test.mjs` | the expiry lifecycle both gates share: the 14-day window, both boundaries inclusive (exactly 14 days out is `expiring`; `expiry === today` is still `expiring`, not `expired`), only `expired` stops suppression, whole-day arithmetic on UTC boundaries, and the wording of the `EXPIRING`/`EXPIRED`/`UNMATCHED` lines — including that the unmatched line names three causes rather than two. |
| `scripts/__tests__/ci-install-trivy.test.mjs` | the installer all three scanning workflows share: a good release installs the pinned version into `<bindir>`, a checksum mismatch fails loudly and installs nothing, a failed download names the URL and curl's exit rather than exiting silently (the PR #929 failure, reproduced offline over `file://`), a binary that reports a different version fails so a green step means the *pinned* version, and a tag that is not `vX.Y.Z` is refused before anything is fetched. |
| `scripts/__tests__/renovate-workflow.guard.test.mjs` | the cron ordering (item #487): the latest sweep cron fires strictly before the earliest Renovate window cron, with at least a two-hour gap, both are UTC-fixed 5-field expressions, and the workflow still states why the cron is where it is — so a later "tidy the crons together" cannot silently undo it. The window cron is selected structurally (exactly one hour-of-week slot), not by naming the nightly, so adding another single-slot `renovate.yml` cron moves what the ordering is asserted against rather than passing vacuously. Also the Trivy pin (item #303): all **three** installing workflows (`infra-image-scan.yml`, `cd-deploy.yml`, `app-ci.yml`) resolve to a `vX.Y.Z` tag handed to `scripts/ci-install-trivy.sh`, none of them pipes the vendor's `contrib/install.sh` again, they agree on the version, and they are actually captured by the `aquasecurity/trivy` customManager. Also Renovate visibility for the object store (item #560, test `(080b)`): every git-tracked compose file pinning `rustfs/rustfs` matches a `docker-compose` `managerFilePattern` and is not excluded by `ignorePaths`, with the file set derived from `git ls-files` rather than listed by hand. Also the discharged datastore holds, asserted as their **successors** rather than as absent ceilings (spec 081): no `allowedVersions` on any track for vault, opensearch, langfuse, the observability postgres or mongodb, a `dependencyDashboardApproval` gate on every major, an automatic patch stream, and — as the control — that neither hold has widened onto caddy or otel-lgtm. |
| `scripts/__tests__/publish-sweep-verdict.test.mjs` | the weekly verdict mapping as a pure function: gate-red, scan-could-not-run, job-failed-elsewhere, green, and the cancelled run that publishes nothing. |
| `scripts/__tests__/no-minio-references.guard.test.mjs` | that no live file names the retired object store, with a closed list of reasoned exemptions and history blocks that may — a stale exemption fails, exactly as a stale allowlist entry does. |
| `scripts/__tests__/mongo-data-owner.guard.test.mjs` | the MongoDB re-own wrapper that made the 8.0.8 → 9.0 move safe (spec 081 US8a): every service in the dev *and* prod compose files that mounts `/data/db` starts as `0:0` only to `chown` the volume and then drops to the image's `mongod` user with `setpriv`, with the wrapper executed against stubs so the assertion is about what it does rather than how it is spelled — and a per-file floor on the number of matching services so a rename cannot make every assertion pass vacuously. |
| `node scripts/check-infra-image-findings.mjs --selftest` | the gate's whole decision table without Trivy, and CI runs it **before** the real scan so a broken gate is not mistaken for a clean sweep. |

A guard is not decoration here: each one above exists because its absence was paid for — a silent
coverage hole, a retry that would have masked a finding, a gate that ran after the push, a cron that
could be tidied back into a race with the window, a rename that missed one runbook line.

Full scanner-vs-scanner coverage table, the allowlist entry shape and seeding steps, the local Trivy
recipe, and the remediation ownership: [the source runbook](../../docs/runbooks/infra-image-scanning.md).
