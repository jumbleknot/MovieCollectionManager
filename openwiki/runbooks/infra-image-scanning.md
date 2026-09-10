---
type: Runbook
title: Infra-image CVE scanning
description: Keyless vulnerability scanning of pulled third-party server images (Keycloak, Postgres, Redis, Mongo, Vault, and the rest of infrastructure-as-code) — the coverage gap left by SAST/SCA and the built-image scanner, gated on fixable Critical findings only.
resource: docs/runbooks/infra-image-scanning.md
tags: [security, cve, trivy, ci, runbook]
timestamp: 2026-09-10T00:00:00+00:00
---

# Infra-image CVE scanning

Trivy scans every third-party image the project pulls but does not build — everything under
`infrastructure-as-code/**` except the project's own built images and any `${..}`-interpolated
reference. It is deliberately disjoint (enforced by a unit test) from the `cd-deploy` scan of the
project's own built images, and from [SAST/SCA scanning](/openwiki/runbooks/sast-scanning.md), which
covers first-party source and first-party dependency graphs, not pulled base images. Renovate keeps
base images current; this scan catches a freshly published CVE against an already-pinned image, which
currency alone cannot.

## Gotchas

- **Not path-gated on the authoritative run.** A weekly full sweep is the scan of record precisely
  because a new advisory can land against an image nobody changed — an on-change check on
  infrastructure edits exists only for fast feedback, not as the source of truth.
- **Only a fixable Critical blocks the gate.** An unfixable Critical (no upstream patched version yet)
  is a report-only warning, since a version bump can't clear it and it must not wedge the gate
  indefinitely.
- **Keyless and fail-closed**, matching the posture in
  [Secrets management](/openwiki/invariants/secrets-management.md) and
  [SAST/SCA scanning](/openwiki/runbooks/sast-scanning.md) — a Trivy/pull/parse failure fails the job
  rather than producing a clean-looking report.
- **The allowlist is baseline, not permanent.** Suppression is gate-only; findings stay visible in the
  report, and a suppressed entry must be deleted once the underlying image is actually bumped — leaving
  a stale entry hides a regression rather than tracking a real accepted risk.
- **Trivy is not available on every developer machine** (notably not the Windows dev box), so
  enumeration-only checks work everywhere, but the actual scored scan is CI-authoritative — don't treat
  a local `--list` run as equivalent to a real scan result.
- **Adding this as a required PR check is a manual operator step** — the agent cannot configure branch
  protection itself; the weekly scheduled run is a safety net, not a merge gate, until an operator wires
  the PR-triggered context into branch protection.
- **In the devcontainer, both the install path and the default DB mirror fail silently.** Measured
  2026-08-30 diagnosing PR #289. (1) The Trivy install script (`contrib/install.sh`) resolves a version
  number and then downloads nothing through the egress seam — exit 0, no binary. Do not read "found
  version: 0.74.0" as success; check for `$HOME/.local/bin/trivy`. (2) Trivy's default DB mirror
  (`mirror.gcr.io`) is not in the egress policy; a scan dies with `no such host`. `ghcr.io` is
  reachable. (3) The Java DB has its own separate default mirror — omit `--java-db-repository` and JVM
  images (`opensearchproject/opensearch`, Keycloak) fail deep in layer analysis, reading like a scan
  failure rather than a config gap. The workaround is to run Trivy from its own Docker image, pointing
  both databases at `ghcr.io/aquasecurity/trivy-db:2` and `ghcr.io/aquasecurity/trivy-java-db:1`; use
  `--severity CRITICAL --ignore-unfixed` to match the gate's own criterion (so the count answers "would
  the gate block this image", not "how many CVEs does it have"). Full command in
  `docs/runbooks/infra-image-scanning.md`.
- **Re-keying an allowlist entry is required whenever a pinned tag changes, not optional tidy-up.**
  An entry keyed to the old tag matches nothing after the bump, the finding it covered becomes
  un-allowlisted, and the gate blocks — while reporting the entry only as an `UNMATCHED ENTRIES` line,
  which reads like housekeeping rather than like the cause. Check that line before assuming a new CVE
  appeared. Feature 063 re-keyed the three bare-name entries (`grafana/otel-lgtm`, `minio/minio`,
  `minio/mc`) to their pinned versions; `infra-image-scan.test.mjs` now asserts each key still matches
  the current compose reference and stops matching a later version.
- **A bare repository name in the `image` field is a permanent hole, not an accepted risk.**
  `minio/minio` (no tag) matches every tag that image will ever have — it suppresses the advisory it was
  written for *and every future one in the same image*, silently and permanently. Always key suppressions
  to a version: `minio/minio:RELEASE\.2025-09-07` matches the pinned reference but stops matching the
  next bump.
- **`minio/minio` and `minio/mc` always report `[floating tag]` — that is correct, not a bug.** The
  `isFloatingTag` classifier calls a tag floating when it does not begin with an optional `v` and a
  digit; `RELEASE.2025-…` does not, so pinned minio refs still appear as floating. A floating count of
  **exactly 2** is the passing state. **A count of 0 is a failure** — it means the classifier was
  widened to hide the exceptions rather than declare them. A count above 2 is also a failure.
  `infra-image-scan.test.mjs` asserts the floating set equals exactly the minio pair.
- **MinIO's date-based update types are calendar arithmetic, not semantic versioning.** The regex
  versioning scheme maps year→major, month→minor, day→patch. A January release reports **major** because
  the year advanced, not because anything broke. Do not read the label as a risk signal the way you
  would for `opa` or `unleash`. (`loose` versioning cannot parse `RELEASE.…` tags at all — its `_parse`
  returns null, making them unordered rather than merely mislabelled.)
- **A green `infra-image-scan` tick usually proves nothing — check the duration.** The required context
  posts `success` on every PR, including ones where Trivy never ran. That is deliberate (feature 039
  Gap 3: a job-level `if:` skip posts no status at all, and the required pattern then blocks the PR
  forever) — but it means the green tick answers "did this PR touch an infra path", not "are these
  images clean". The tell is the **run duration**: a real sweep takes **~2m30s–3m** (about 8 minutes
  wall-clock on a PR including queueing); a skipped one takes **10–14 s**. Measured 2026-09-10: two
  advisories landed in Trivy's DB on 2026-09-09 and blocked 11 findings on images `main` already
  carried, yet **nine consecutive `infra-image-scan` runs reported `success`** — every one of them
  10–14 s. A PR's green tick can be a stale green; PR #360 was fully green from a 2026-09-08 sweep and
  stayed "mergeable" for two days after the images it pins went dirty. To force a real sweep, touch an
  infra path — editing `security/infra-images/allowlist.yaml` is itself enough.
- **A version-keyed allowlist entry cannot be re-keyed on `main` and in the bump PR at once.** A
  version-keyed entry names one version, but during a bump two are live: `main` still references the
  old tag, the Renovate branch references the new one. Whichever single version the key names, the
  other side blocks. The two obvious escapes are both wrong: landing the re-key inside the Renovate
  branch does not survive (Renovate force-pushes and clobbers it); widening the key to a wildcard
  re-creates the permanent hole. What works is an **enumeration spanning the transition**, narrowed on
  merge — e.g. `'grafana/otel-lgtm:0\.32\.[01]'` covers both versions, is still discharged by an
  upgrade to `0.33.0`, and `infra-image-scan.test.mjs` asserts that property. Write the narrowing into
  the justification; an enumeration left to grow one version at a time becomes the wildcard by
  instalments. Do this only when the bump is **not** the remediation — where the new version actually
  clears the advisory, delete the entry when the bump lands. Measured cost: PR #362 on 2026-09-09.
- **Triaging an advisory you cannot scan: read the build definition, not the image.** Trivy is absent
  from the dev container, so a sibling version is often the one you need a verdict on. Read the version
  from the **build definition of the release** — e.g. for Keycloak, check the root `pom.xml` in the
  release tag on GitHub. Two constraints measured 2026-09-10: Maven Central is not on the egress
  allowlist (`repo1.maven.org` and `search.maven.org` both fail, curl exit 000); `raw.githubusercontent.com`
  **is** reachable, so read POM files from the project's own repository at the release tag. **Always
  record in the justification that this is an inference from the build definition, not a scan of the
  image** — the class of wrong turns this repository keeps paying for is a description standing in for
  a measurement. Prefer the direction that fails safe: a key covering a ref that turns out clean
  suppresses nothing extra; a key that omits an affected ref blocks the board.

Full scanner-vs-scanner coverage table, allowlist entry shape, baseline-seeding steps, and remediation
ownership: `docs/runbooks/infra-image-scanning.md`.
