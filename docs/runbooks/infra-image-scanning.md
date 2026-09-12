# Infra-Image CVE Scanning (feature 035)

Keyless, config-as-code vulnerability scanning of the **third-party server images the project pulls but does not build** — the coverage gap left by the other scanners. Complements, does not overlap, the existing gates.

## What it covers (and what it doesn't)

| Scanner | Layer | Scans |
|---|---|---|
| SAST/SCA (033) | at-rest source + **our** deps | Semgrep + cargo/pnpm/pip-audit over first-party code + our dependency graphs |
| DAST (031) | running app HTTP | OWASP ZAP against the live BFF / mc-service / gateway |
| `cd-deploy` Trivy (023) | **our built images** | the 6 `jumbleknot/*` images we build + push |
| **Infra-image scan (035)** | **pulled third-party images** | Keycloak, Postgres, Redis, Mongo, Vault, OpenSearch, ClickHouse, LangFuse, Grafana, OPA, Unleash, MinIO, Caddy, Mailpit — everything in `infrastructure-as-code/**` **except** the 6 built images and `${..}`-interpolated refs |

The 035 set and the `cd-deploy` set are **disjoint** (enforced by a unit test). Renovate keeps base images *current*; this scan detects a **published CVE against an already-pinned image**, which currency alone misses.

## How it runs

- **Weekly full sweep** (`schedule: cron '0 7 * * 5'` (Friday 07:00 UTC ≈ 3 AM ET)) — the authoritative run. A new advisory can hit an **unchanged** pinned image, so the sweep is **not path-gated** (same rule as the 033 SCA scan).
- **On-change PR/push check** — `.forgejo/workflows/infra-image-scan.yml` also triggers when `infrastructure-as-code/**`, the scanner scripts, or `security/infra-images/**` change, for fast feedback on a newly-introduced vulnerable image.
- **Keyless** (public images, Trivy fetches advisory data with no account — no `${{ secrets }}`) and **fail-closed** (a Trivy/pull/parse failure fails the job — never a clean report on failure).

### Which scanner owns an image — by coverage, not by namespace

**An image is scanned by whoever builds it; everything else is scanned here.** `cd-deploy`'s Trivy
step covers its six; `minio-image`'s covers `jumbleknot/minio` and gates its publish; this scan covers
everything else referenced under `infrastructure-as-code/**`. The invariant is that every image is
examined by **exactly one** of them — not zero, not two.

**Why a builder scans its own image rather than sending it here.** This scan is *keyless* by design —
no `${{ secrets }}` — and our images live in a **private** registry, so Trivy here cannot pull them.
Feature 069 tried it and CI proved the point (run 3121: `unable to find the specified image`). A
builder already holds the image locally and is already authenticated, so it needs no new credential
and blocks the **publish** instead of auditing after the fact.

Disjointness was always asserted. **Completeness was not**, and the exclusion rule quietly broke it.
Until feature 069 it read:

```js
if (ref.includes('jumbleknot/')) continue;   // our built images (cd-deploy owns them)
```

The comment names the right property. The code implements a different one — *"anything named like
ours"* rather than *"anything cd-deploy already scans"*. The two coincided only while every
`jumbleknot/*` image happened to be a cd-deploy image.

Feature 069 broke that coincidence: `jumbleknot/minio` is built by us and **not** by cd-deploy. Under
the old rule it was excluded here and absent there — published and examined by neither gate, with no
error anywhere and a zero-finding report that was truthful and meaningless.

The rule is now membership of `BUILT_IMAGE_NAMES`. The `bareName` extraction already handled both
shapes (`jumbleknot/mc-service:latest` → `mc-service`, excluded; `jumbleknot/minio:REL@sha256:…` →
`minio`, enumerated), so the fix was to **delete** the prefix line rather than add to it.

**This generalises.** Any future image built outside cd-deploy — a mirrored third-party image, another
from-source build — is now covered automatically. That is the point: the fix was to the rule, not to
the MinIO case.

Guarded by `scripts/__tests__/infra-image-scan.test.mjs`, which asserts the completeness case against
a **fixture** rather than the live tree. A live-tree assertion would stop testing anything the day
MinIO is the only such image and someone removes it.

### A green `infra-image-scan` usually proves nothing — check the DURATION

The required context `infra-image-scan / infra-image-scan` posts `success` on **every** PR, including
the ones where Trivy never ran. That is deliberate (feature 039 Gap 3: a job-level `if:` skip posts no
status at all, and the required pattern then blocks the PR for ever) — but it means the green tick
answers "did this PR touch an infra path", not "are these images clean".

The tell is the **job duration**, and it must be read from the **commit status description** — the
`Successful in …` string the forge writes for the `infra-image-scan / infra-image-scan` context:

| | status description | what it means |
|---|---|---|
| real sweep | `Successful in 2m30s`-`3m` | Trivy pulled and scanned every image |
| Trivy skipped | `Successful in 2s`-`14s` | the PR touched no infra path; the tick means nothing |

```bash
# Did THIS sha actually sweep? Read the job's own duration, per event.
API=…/api/v1/repos/jumbleknot/mcm
curl -sS -H "Authorization: token $MCM_FORGE_TOKEN" "$API/commits/<sha>/statuses?page=1&limit=100" \
  | jq -r '.[] | select(.context|test("infra-image-scan / infra-image-scan")) | "\(.context)  \(.description)"'
```

> ⚠️ **Do NOT compute this from `/actions/runs` as `stopped - started`.** Those timestamps are
> **workflow-level** and include inter-job queueing, which on this capacity-1 runner dwarfs the signal.
> Measured 2026-09-10 on one busy afternoon: PR #409 (docs-only, **Trivy skipped**) read **534 s** by
> that arithmetic while its job status said `Successful in 2s`; PR #410 (a **real** sweep) read 2339 s
> against a true `2m43s`. A "> 60 s ⇒ real sweep" rule built on it calls a skipped run a real one —
> a false green in the very check written to detect false greens. The 10-14 s figure quoted for a
> skipped run only holds when the runner is idle; the job duration holds always.

This is the mechanism behind a whole class of silent staleness. Measured 2026-09-10: two advisories
landed in Trivy's DB on 2026-09-09 and blocked 11 findings on images `main` already carried, yet
**nine consecutive `infra-image-scan` runs reported `success`** over the following day — every one of
them reporting a 2-14 s job duration. The last real sweep had been PR #362's. The weekly cron is the
safety net, but it fires once a week and attributes the failure to whatever branch it lands on.

Two consequences worth internalising:

- **A PR's green infra-image tick can be a stale green.** PR #360 was fully green from a 2026-09-08
  sweep and stayed "mergeable" for two days *after* the images it pins went dirty. Regenerate or
  rebase such a branch and the next real sweep reds it, for reasons that predate its diff.
- **To force a real sweep, touch an infra path.** Editing `security/infra-images/allowlist.yaml` is
  itself enough — which is why an allowlist change is self-confirming, per the note in the
  allowlist's own header.

## Local use (where Trivy is available)

Trivy is **not** on the Windows dev box — the authoritative scan is the Linux/CI job. On a Linux/WSL/macOS host with Trivy + Docker:

```bash
# Enumerate only (works ANYWHERE, no Trivy — confirm coverage)
node scripts/infra-image-scan.mjs --list
#   equivalently: pnpm nx infra-scan infrastructure-as-code -- --list

# Full scan → security/infra-images/reports/{findings.json,summary.txt,trivy-*.json}
node scripts/infra-image-scan.mjs            # add --emit-allowlist to also write allowlist.proposed.yaml
pnpm nx infra-scan infrastructure-as-code

# Gate: fail on any un-allowlisted FIXABLE Critical
node scripts/check-infra-image-findings.mjs
node scripts/check-infra-image-findings.mjs --selftest   # prove fail/suppress/expiry without Trivy

# Unit tests (pure enumeration + normalization — Windows-friendly)
node --test scripts/__tests__/infra-image-scan.test.mjs
```

### In the dev container: two silent blocks, and the way round both

Measured 2026-08-30 while diagnosing PR #289. The devcontainer *can* run this scan — it just cannot
run it the way CI does, and **both** obstacles fail silently rather than erroring:

1. **The Trivy install script produces no binary.** `contrib/install.sh` resolves the version from
   GitHub (`found version: 0.74.0`) and then downloads nothing — the release tarball comes back empty
   through the egress seam, exit 0. `$HOME/.local/bin/trivy` simply does not exist afterwards. Do not
   read the version line as success; check for the binary.
2. **Trivy's default DB mirror does not resolve.** `mirror.gcr.io` is not in the egress policy, so a
   scan dies with `dial tcp: lookup mirror.gcr.io ... no such host`. `ghcr.io` *is* reachable (a `401`
   from `/v2/` is the normal auth challenge, not a block).

So run Trivy from its own image and point **both** databases at ghcr. The Java DB is a separate
download with its own default mirror — omit `--java-db-repository` and JVM images
(`opensearchproject/opensearch`, Keycloak) fail *after* pulling, deep in layer analysis, which reads
like a scan failure rather than a config gap:

```bash
docker volume create trivy-cache
docker run --rm -v trivy-cache:/root/.cache/trivy aquasec/trivy:0.74.0 image --quiet \
  --scanners vuln \
  --db-repository ghcr.io/aquasecurity/trivy-db:2 \
  --java-db-repository ghcr.io/aquasecurity/trivy-java-db:1 \
  --severity CRITICAL --ignore-unfixed --format json \
  'hashicorp/vault:1.21@sha256:4e33...'
```

`--severity CRITICAL --ignore-unfixed` is deliberately the **gate's own** criterion (see below), so a
count from this command answers "would the gate block this image" rather than "how many CVEs does it
have". Keep the cache volume — the DB download dominates the runtime of a single-image scan.

This is the recipe that diagnosed PR #289 when the job published **no failure digest** despite its
digest step being `if: always()`.

## Version pins, and the two `[floating tag]` lines that are correct (feature 063 / item #297)

Every third-party infra image is referenced by a **version tag plus a digest** (`repo:tag@sha256:…`).
The digest comes from `docker:pinDigests` and gives reproducibility; the **tag** is what gives an
update a *type*. Without it Renovate files every change as `updateType: digest`, and two things break:
a rebuild that crosses a major is indistinguishable from a security patch at review time, and an
allowlist entry keyed to a floating ref can never be discharged (see below).

Eight references were floating until feature 063 and are now pinned. Each was pinned to the version
tag whose manifest digest **already equalled** the digest in the compose file, so the change was
notational — CI ran the same images afterwards that it ran before:

| reference | pinned to |
|---|---|
| `axllent/mailpit` | `v1.31.0` |
| `curlimages/curl` | `8.21.0` |
| `grafana/otel-lgtm` | `0.32.0` |
| `openpolicyagent/opa` | `1.20.1` and `1.20.1-debug` |
| `unleashorg/unleash-server` | `8.1.0` |
| `minio/minio` | `RELEASE.2025-09-07T16-13-09Z` |
| `minio/mc` | `RELEASE.2025-08-13T08-35-41Z` |

### The 2025 minio dates are not neglect

MinIO **stopped publishing community releases after 2025-09**. Those two tags are the newest each
repository offers — re-verified against `registry-1.docker.io` on 2026-08-30 (495 and 300
`RELEASE.…Z` tags respectively). The floating tag had not been tracking anything for about a year, so
pinning cost no currency at all. **Do not "fix" these pins forward; there is nothing ahead of them.**

### `minio/minio` and `minio/mc` still report `[floating tag]`, deliberately

`node scripts/infra-image-scan.mjs --list` reports a floating count of **exactly 2**, and both are
these. `isFloatingTag` calls a tag floating when it does not begin with an optional `v` and a digit;
`RELEASE.2025-…` does not, so a pinned minio ref is still flagged.

That is the classifier being right. Its job is to be suspicious of tags it **cannot order**, and a
`RELEASE.<date>` tag genuinely is one — ordering it needs the `regex` versioning scheme declared for
it in `renovate.json`, which the scanner does not read. Widening `isFloatingTag` to recognise the
shape would make the report read clean while teaching a general-purpose classifier to vouch for an
ordering it does not have, and would couple it to one vendor's tag convention. So the two are
**declared exceptions** instead: the `matchPackageNames` of the date-tagged versioning rule in
`renovate.json` *is* the declared list, and `infra-image-scan.test.mjs` asserts the floating set
equals it exactly.

**A floating count of 0 is therefore a FAILURE, not a success** — it would mean the classifier had
been widened to hide the exceptions rather than declare them. So is a count above 2.

### The minio update types are calendar arithmetic, not semantics

The regex versioning maps year→major, month→minor, day→patch. A January release will report **major**
because the year advanced, not because anything broke. Order these correctly; do not read the label
as a risk signal the way you would for `opa` or `unleash`. (`loose` was preferred and cannot parse
these tags at all — measured against renovate@44's own dist, its `_parse` returns null for anything
beginning `RELEASE.`, which is invisible rather than unordered.)

## The gate

`blocking = FIXABLE Critical` (a `FixedVersion` exists upstream). Unfixable Critical and all Medium/Low are **report-only warnings** — a bump can't clear an unfixable CVE, so it must not wedge the gate (same intent as `cd-deploy`'s `--ignore-unfixed`). The gate fails on any blocking finding not covered by a **live** (non-expired) allowlist entry.

## Allowlist-as-baseline (`security/infra-images/allowlist.yaml`)

The allowlist **is** the accepted baseline — suppression is gate-only; findings stay visible in `findings.json`. Entry shape:

```yaml
- image: 'quay\.io/keycloak/.*'   # regex vs the scanned repo:tag
  id: 'CVE-2026-1234'             # regex vs advisory id
  justification: 'awaiting Renovate bump to keycloak:26.6.0'
  addedBy: 'steve'
  expiry: '2026-09-01'           # optional; past-expiry stops suppressing (forces re-triage)
```

All four of `image`/`id`/`justification`/`addedBy` are required; a blank field or invalid regex is a gate error.

### Key a suppression to a VERSION, so an upgrade can discharge it

`image` is matched as an **unanchored** regex against the full scanned reference. That one property
decides whether a suppression can ever end:

- `hashicorp/vault:1\.18` still matches `hashicorp/vault:1.18@sha256:…` — appending a digest does
  **not** break a key — but stops matching `1.21`. When PR #289 bumped vault, five Criticals
  surfaced: a dischargeable key doing its job, loudly.
- `minio/minio` (bare repository name) matched **every tag of that image that will ever exist**. It
  could not stop matching, so it suppressed the advisory it was written for *and every future one in
  the same image*, silently and permanently.

The second shape is not an accepted risk with a review date, it is a permanent hole. Feature 063
re-keyed the three such entries (`grafana/otel-lgtm`, `minio/minio`, `minio/mc`) to their pinned
versions, and `infra-image-scan.test.mjs` now asserts both directions for them: each key still
matches the reference in the compose files today, **and** stops matching a later version.

**Re-keying is required whenever a pinned tag changes**, not optional tidy-up. An entry keyed to the
old tag matches nothing after the bump, the finding it covered becomes un-allowlisted, and the gate
blocks — while reporting the entry only as an `UNMATCHED ENTRIES` line, which reads like housekeeping
rather than like the cause. Check that line before assuming a new CVE appeared.

### A version-keyed entry cannot be re-keyed on `main` and in the bump PR at once

The rule above has a corollary that is easy to walk into, and it cost PR #362 ten findings on
2026-09-09. A version-keyed entry names **one** version, but during a bump two are live: `main` still
references the old tag, the Renovate branch references the new one. Whichever single version the key
names, **the other side blocks** — key it to the old one and the bump PR is red; key it to the new one
and `main` is red, including every unrelated PR, because `infra-image-scan / infra-image-scan*` is
required by a glob that matches the push-event context too.

The two obvious escapes are both wrong. Landing the re-key inside the Renovate branch does not
survive: Renovate force-pushes the branch when it regenerates, and with `rebaseWhen: conflicted` a
hand commit is either clobbered or blocks the regeneration. Widening the key to `0\.32\..*` re-creates
the permanent hole the section above exists to prevent.

What works is an **enumeration spanning the transition**, narrowed on merge:

```yaml
- image: 'grafana/otel-lgtm:0\.32\.[01]'   # 0.32.0 on main, 0.32.1 in PR #362
- image: 'postgres:18\.[36]-alpine3\.23'   # 18.3 on main, 18.6 in PR #362
```

Both sides go green, and the entry is still discharged by an upgrade (`0.33.0` stops matching), which
is the property `scripts/__tests__/infra-image-scan.test.mjs` asserts. Write the narrowing into the
justification — an enumeration left to grow one version at a time becomes the wildcard by instalments.

Do this only when the bump is **not** the remediation. Where the new version actually clears the
advisory, the entry is deleted rather than widened, and it is deleted *when the bump lands* — opa
1.20.2 clears CVE-2026-56854, so its entry stays keyed to `1\.20\.1` and is removed with PR #362.

### Triaging an advisory you cannot scan

Trivy is absent from the dev container, so an image that CI scanned dirty can rarely be re-checked
here, and a *sibling* version is often the one you actually need a verdict on: the scan covers what
the Renovate branch references, while `main` runs the version before it.

Read the version from the **build definition of the release**, not from the image. Keycloak
26.7.2-vs-26.7.3 (netty, CVE-2026-75595) resolved in one request: netty is not declared in Keycloak's
own POM — Quarkus pins it — and both release tags' root `pom.xml` declare `<quarkus.version>3.33.3.1`,
so the two carry the same netty and the un-scanned 26.7.2 is affected identically.

Two constraints on that move, both measured 2026-09-10:

- **Maven Central is not on the egress allowlist** (`repo1.maven.org` and `search.maven.org` both fail
  to connect, curl exit 000 — not a 403). `raw.githubusercontent.com` **is** reachable, so read the
  release tag's POM from the project's own repository instead.
- Say which it was. This is an inference from the build definition, **not** a scan of the image, and
  the justification must record that distinction — the whole class of wrong turns this repository
  keeps paying for is a description standing in for a measurement.

Prefer the direction that fails safe. An allowlist key covering a ref that turns out clean suppresses
nothing extra (it still counts as matched via the version that *did* produce the finding); a key that
omits an affected ref blocks the board.

### Seeding the baseline (first landing — on CI)

Trivy isn't local, so seed from the **first Linux/CI scan** (feature-033 platform lesson):

1. Land with an **empty** allowlist. The CI job runs `--emit-allowlist`, writing `security/infra-images/reports/allowlist.proposed.yaml` (every current blocking finding as a ready-to-paste entry).
2. Retrieve the report from the CI run (the reports dir is gitignored; pull it from the runner — the artifact is uploaded as `infra-image-scan-report`, or read it from the runner workspace over SSH).
3. Triage each blocking finding into `security/infra-images/allowlist.yaml` (justification referencing the responsible base-image bump; `expiry` where a bump is imminent).
4. Re-run the gate → green. Every entry maps to a real, still-visible finding (no phantom suppressions).

## Remediation (Renovate owns it)

A finding is fixed by a **Renovate base-image bump** (bump the pinned tag/digest). After the bump lands and the scan re-runs, **delete** the finding's allowlist entry — the gate stays green and a regression re-blocks. The scan does not bump anything itself.

## Operator: make it a required check

The **PR-triggered** `infra-image-scan` context should be added to `main` branch protection as a required check (Forgejo → repo → Settings → Branches). The **weekly** run is a scheduled safety net — its failure surfaces on the Actions list (wire an alert/issue if desired); it is not a PR gate. The agent cannot self-configure branch protection — this is a manual operator step.
