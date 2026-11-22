# Data Model: Repo-scoped CI evidence-bundle package

## Evidence package

An owner-level generic package in the Forgejo registry.

| Field | Value |
|-------|-------|
| name | `<repo>-ci-failures`, where `<repo>` = lowercased repository name (R1). This repo: `mcm-ci-failures`. Legacy, read-only: `ci-failures`. |
| owner | the repository owner (`jumbleknot`) |
| type | `generic` |
| version | `<runId>--<jobSlug>` (unchanged, `bundleVersion()`) |
| files | `bundle.json.gz` (≤ 5 MB) and the durations file (`DURATIONS_FILE`, newer runs only) |

**Validation**: `<repo>` must be non-empty after lowercasing; otherwise naming throws (FR-002). The
version format is unchanged.

**Lifecycle**:

```text
repo-scoped:  failing job ──publish──▶ version ──(age > 30 d)──▶ pruned by the digest
legacy:       (no writes after cutover)  version ──(age > 30 d)──▶ pruned by the digest ──▶ empty
                                                                    ▶ drop the legacy name (R6)
```

## Listed version (reader view)

What `ci-status` and the digest's prune work with after listing.

| Field | Source |
|-------|--------|
| version | forge listing |
| created_at | forge listing (the prune's age test) |
| name | the package it was listed from. Used to build its fetch, durations and delete URLs. |

**Rules**: exact-name filter per package (R2). Dedupe by `version`, repo-scoped wins (R4). Durations
ordering stays run id, descending.

## Bundle reference and link (digest comment)

| Field | Format |
|-------|--------|
| bundleRef | `<package>:<version>`. New comments: `mcm-ci-failures:<v>`. Old ones: `ci-failures:<v>`. |
| bundleUrl | `<server>/<owner>/-/packages/generic/<package>/<version>` |

Old references stay valid while their legacy version exists (FR-011). Nothing parses `bundleRef`;
`ci-status` fetches by run id and job.

## Retention entry

| Field | Rule |
|-------|------|
| name | each evidence package listed separately |
| keepDays | ≥ `evidenceWindowDays` for every evidence package |
| keepNewest | ≥ `DEFAULT_DURATION_RUNS` × bundle-publishing jobs for every evidence package |

"Evidence package" = name `ci-failures` or ending in `-ci-failures` (R5). The committed config lists
`mcm-ci-failures` and `ci-failures` with identical windows.
