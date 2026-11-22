# Research: Repo-scoped CI evidence-bundle package

No `NEEDS CLARIFICATION` remained in the Technical Context. These are the design decisions the spec
left open.

## R1 — Where the repository name comes from

- **Decision**: reuse the identity each script already resolves. The digest's `forgeEndpoint()` takes
  `GITHUB_REPOSITORY` in CI, else parses the `origin` remote. `ci-status` builds `conn.repo` the same
  way. The package name is `${repo.toLowerCase()}-ci-failures`.
- **Rationale**: no new source of truth, and both scripts already fail loudly when neither source
  resolves (`could not resolve the forge API base`), which satisfies "never fall back to legacy".
- **Alternatives**: an env var such as `MCM_BUNDLE_PACKAGE`. Rejected: it is one more thing to set
  per repository, and a missing value would need a default, which is exactly the shared-name hazard.
  Hard-coding `mcm-ci-failures` is rejected by the spec (FR-002), and would be wrong the day the
  digest is copied to another repository.

## R2 — Which names the readers and the prune cover

- **Decision**: `bundlePackagesFor(repo)` returns `[<repo>-ci-failures, 'ci-failures']`. Every
  listing filters the forge's results by **exact** name.
- **Rationale**: Forgejo's `q=` package search matches substrings. Measured shape: the existing
  readers already filter `x.name === BUNDLE_PACKAGE` after a `q=` search for exactly this reason. A
  search for `ci-failures` returns `mcm-ci-failures` and `belay-ci-failures` too. Exact filtering is
  what keeps BELAY's versions out of MCM's listing and prune (SC-005).
- **Alternatives**: a prefix or suffix match (`*-ci-failures`) for readers. Rejected, because it
  would include `belay-ci-failures`.

## R3 — What drains the legacy package

- **Decision**: the digest's existing age-based prune (`selectExpiredVersions`, RETENTION_DAYS 30)
  runs over both names. Each expired version is deleted under the package it was listed from.
- **Rationale**: after cutover nothing writes `ci-failures`, so a count-based rule would freeze its
  last versions in place. Registry-retention's `keepNewest: 650` would keep the newest 650 legacy
  versions forever. The age-based prune is the only deleter that needs no new writes to make
  progress, and it already runs on every failing job, so the legacy package empties within 30 days
  of cutover. Retention's own entry for legacy stays as a floor, harmless because it never blocks the
  digest's prune.
- **Alternatives**: set legacy `keepNewest: 0` in retention. Rejected: the loader's floor guard
  (rightly) refuses it for an evidence package, and weakening the guard for one name is a guard
  edited for convenience. A one-off manual deletion is rejected: it loses the evidence inside its
  window, and it is a human step that can be forgotten.

## R4 — Duplicate versions across names

- **Decision**: readers dedupe by version string, keeping the repo-scoped entry. Fetch order is
  repo-scoped then legacy.
- **Rationale**: a run cannot publish to both under this design. A duplicate can only arise from a
  manual re-publish, or a run that straddles the deploy of the change (old code in one job, new code
  in a retried job: different versions, so in practice none). Dedupe keeps the durations sample
  honest (FR-008) for free.

## R5 — Retention guard scope

- **Decision**: the floor guard applies to any configured package named `ci-failures` or ending in
  `-ci-failures`. A separate unit test asserts that the committed YAML lists exactly the two names
  `bundlePackagesFor('mcm')` returns, with equal windows.
- **Rationale**: the guard protects a property of evidence packages, not of one name. Tying it to the
  suffix keeps it protecting the new name without a per-repository constant in the loader. Asserting
  the committed file's contents keeps FR-009 from regressing, without making every loader fixture
  carry both entries.
- **Alternatives**: make the loader require both names. Rejected: it couples config validation to the
  git remote, and breaks every existing fixture that omits evidence packages.

## R6 — When the legacy name can be dropped

- **Decision**: cutover = the merge of this feature to `main`. Earliest drop = cutover + 30 days (the
  digest's RETENTION_DAYS), confirmed by listing `ci-failures` and finding 0 versions. The drop
  removes `LEGACY_BUNDLE_PACKAGE` from `bundlePackagesFor`, the legacy retention entry, and the
  runbook's transition note. It is filed as a backlog item at close-out.
- **Rationale**: the date follows from R3. Confirming by listing, not by the calendar alone, covers
  a quiet month in which no job failed and so no prune ran.
