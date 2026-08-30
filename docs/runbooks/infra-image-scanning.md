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
