---
type: Runbook
title: Infra-image CVE scanning
description: Keyless vulnerability scanning of pulled third-party server images (Keycloak, Postgres, Redis, Mongo, Vault, and the rest of infrastructure-as-code) — the coverage gap left by SAST/SCA and the built-image scanner, gated on fixable Critical findings only.
resource: docs/runbooks/infra-image-scanning.md
tags: [security, cve, trivy, ci, runbook]
timestamp: 2026-08-30T03:02:00+00:00
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

Full scanner-vs-scanner coverage table, allowlist entry shape, baseline-seeding steps, and remediation
ownership: `docs/runbooks/infra-image-scanning.md`.
