# Contract: Evidence package naming and transition

**Feature**: 106-repo-scoped-ci-failures. Amends
[042 bundle-layout](../../042-ci-self-serve-diagnostics/contracts/bundle-layout.md) § Identity, where
the package was a constant.

## Identity

```text
/api/packages/{owner}/generic/{package}/{runId}--{jobSlug}/bundle.json.gz
/api/packages/{owner}/generic/{package}/{runId}--{jobSlug}/{DURATIONS_FILE}
```

| Component | Value |
|---|---|
| `{package}` (write) | `bundlePackageFor(repo)` = `${repo.toLowerCase()}-ci-failures`. This repository: `mcm-ci-failures`. |
| `{package}` (read, prune) | each of `bundlePackagesFor(repo)` = `[bundlePackageFor(repo), 'ci-failures']`, in that order |
| `repo` | `GITHUB_REPOSITORY`'s second segment in CI, else the `origin` remote's. Unresolvable means an error, never a default. |
| Version, files | unchanged from 042 |

## Exported surface (`scripts/ci-failure-digest.mjs`)

| Export | Contract |
|---|---|
| `LEGACY_BUNDLE_PACKAGE` | `'ci-failures'`. Read and prune only. Removed when the legacy name is dropped. |
| `bundlePackageFor(repo)` | returns the lowercased `<repo>-ci-failures`. Throws on an empty or non-string `repo`. |
| `bundlePackagesFor(repo)` | `[bundlePackageFor(repo), LEGACY_BUNDLE_PACKAGE]` |
| `isEvidencePackage(name)` | `true` for `ci-failures` and any `*-ci-failures`. Used by the retention guard. |

`BUNDLE_PACKAGE` (the constant) is removed. Its importers (`ci-status.mjs`) move to the functions
above.

## Behaviour

| Actor | Rule |
|---|---|
| Digest upload | repo-scoped name only. Never legacy. |
| Digest `bundleRef` / `bundleUrl` | name the repo-scoped package |
| Digest prune | list each name in `bundlePackagesFor` with an exact-name filter. Delete each expired version under the package it was listed from. Never another name. |
| `ci-status` listing | both names, exact filter, each item tagged `name`, deduped by `version` with the repo-scoped one winning |
| `ci-status failure --full` | GET repo-scoped; on 404 GET legacy; on 404 again, "no bundle exists" (unchanged wording) |
| `ci-status durations` | newest N by run id across the deduped list. Each durations file from `/{item.name}/{item.version}/`. |
| Retention loader | floor guard (keepDays ≥ evidenceWindowDays; keepNewest ≥ runs × jobs) for every `isEvidencePackage(name)` entry |
| Retention config | lists `mcm-ci-failures` and `ci-failures`, same window |

## Transition end

Earliest: cutover (merge to `main`) + 30 days (the digest's `RETENTION_DAYS`), and only once a listing
of `ci-failures` returns 0 versions. Then remove `LEGACY_BUNDLE_PACKAGE` from `bundlePackagesFor`, the
legacy retention entry, and the runbook's transition note.
