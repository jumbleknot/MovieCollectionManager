# Phase 0 Research: Infra-image version pins

**Feature**: 063-infra-image-version-pins · **Date**: 2026-08-30

All four unknowns the spec left to the plan are resolved below. Every finding was measured against the
live upstream registries or renovate@44's own distribution, not taken from documentation.

---

## R1 — Which version tag replaces each floating reference

**Decision**: the eight-row table below. Each version tag was selected because its manifest digest is
**byte-identical** to the digest the floating reference resolves to today, so the migration changes
notation only.

**Method**: `HEAD /v2/<repo>/manifests/<tag>` against `registry-1.docker.io`, comparing the
`Docker-Content-Digest` header to the digest currently pinned in the compose file. Token from
`auth.docker.io`. `hub.docker.com` is **not** reachable from the dev container (egress policy), which
is why the registry v2 API is used rather than the friendlier Hub API.

| current reference | version tag | shared digest (prefix) |
|---|---|---|
| `axllent/mailpit:latest` | `v1.31.0` | `sha256:c96991d9…` |
| `curlimages/curl:latest` | `8.21.0` | `sha256:7c12af72…` |
| `grafana/otel-lgtm:latest` | `0.32.0` | `sha256:d6b20e35…` |
| `minio/mc` | `RELEASE.2025-08-13T08-35-41Z` | `sha256:a7fe349e…` |
| `minio/minio` | `RELEASE.2025-09-07T16-13-09Z` | `sha256:14cea493…` |
| `openpolicyagent/opa:latest` | `1.20.1` | `sha256:39daf255…` |
| `openpolicyagent/opa:latest-debug` | `1.20.1-debug` | `sha256:f6aa14fd…` |
| `unleashorg/unleash-server:latest` | `8.1.0` | `sha256:16f3ffb9…` |

Re-verified at plan time; all eight still match.

**Alternatives considered**: pinning to the *newest* published version rather than the currently-running
one. Rejected — it bundles a content change into a notation change, so a CI failure could not be
attributed to either. Currency is Renovate's job the moment the pin exists; the first bump it proposes
does that work under normal review.

> ⚠️ **A trap worth recording.** `GET /v2/<repo>/tags/list` returns tags **alphabetically, not
> chronologically**. Taking the last N entries therefore misses newer releases: it reported mailpit's
> newest as `v1.9.9` when it is in fact `v1.31.0`, because `v1.9.9` sorts after `v1.31.0`. Candidate
> tags must be sorted numerically before probing. The first pass of this research got this wrong.

---

## R2 — Versioning strategy for the date-tagged family (minio)

**Decision**: `versioning: "regex:..."` with named capture groups mapping the ISO date to
major/minor/patch, applied to `minio/minio` and `minio/mc`.

**Rationale**: `loose` was the preferred option because it orders without asserting semantics, but it
**cannot parse these tags at all**. Verified in renovate@44's own dist — `modules/versioning/loose`
matches on `/^[vV]?(\d+(?:\.\d+)*)(.*)$/`, so a tag beginning `RELEASE.` fails `_parse` and returns
null. An unparseable version is not "ordered without semantics", it is invisible.

`regex` is present in renovate@44's versioning module list and is the only supported scheme that can
read this shape.

**The cost, which must be recorded rather than hidden**: mapping year→major, month→minor, day→patch
makes a January release look like a *major* upgrade and any other month like a *minor* one. That is
calendar arithmetic wearing semantic clothing. It satisfies FR-003 only in the mechanical sense, and
FR-004 exists precisely because it does not satisfy it in the useful sense. The configuration comment
must say so, so a future reader does not trust a "major" label that means only "the year changed".

**Alternatives considered**:
- `loose` — cannot parse; measured, not assumed.
- Leaving minio floating — rejected: it fails FR-001 without an upstream reason, since version tags
  demonstrably exist.
- `docker` versioning — designed for semver-shaped docker tags; same parse problem.

---

## R3 — Does pinning minio cost currency?

**Decision**: No. Pin it.

**Evidence**: the newest `RELEASE.*` tag in each repository *is* the one already running —
`RELEASE.2025-09-07T16-13-09Z` for `minio/minio` (1145 release tags) and
`RELEASE.2025-08-13T08-35-41Z` for `minio/mc` (471). Upstream stopped publishing community releases
after 2025-09; the floating tag has not been tracking anything for roughly a year.

This was checked because the dates *looked* like neglect on our side. They are not, and the plan
records it so a future reader does not "fix" a pin that is already at the newest release.

---

## R4 — What the floating-tag report should say about a `RELEASE.*` pin

**Decision**: leave the classifier alone; declare minio's two references as **declared exceptions**
under FR-001 and count them in SC-006.

**Rationale**: the classifier calls a tag floating when it does not begin with an optional `v` and a
digit. `RELEASE.2025-…` does not, so it would still be reported floating after the pin. The tempting
fix is to widen the pattern until the report reads clean — and that is exactly the move the spec's
edge cases forbid, because the classifier's job is to be suspicious of tags it cannot order, and
`RELEASE.*` genuinely is a tag it cannot order without help.

Declaring the exception keeps the report honest (it still flags what it cannot verify) and keeps
SC-006 meaningful (an exact count against a declared list, not a number massaged downwards).

**Alternatives considered**: extending `isFloatingTag` to recognise `RELEASE.<date>`. Rejected on the
grounds above, and because it would couple a general-purpose classifier to one vendor's tag
convention. Revisit only if a second image family adopts the same shape.

---

## R5 — Keeping paired references together

**Decision**: one package rule matching `openpolicyagent/opa` for both refs, with `allowedVersions`
excluding the variant tag namespaces Renovate must not drift onto.

**Rationale**: `openpolicyagent/opa` publishes 3573 tags including `-dev`, `-rootless` and
`-debug` variants. The repository uses two of them (`1.20.1` and `1.20.1-debug`) which must move as a
unit, and the remaining variants must never be proposed.

This repository has paid for the half-bump shape four times (items #194 nx, #204 Playwright, #225
pnpm, and the vault allowlist key in PR #289). In every case a mechanism *existed* that looked
sufficient and was silently overridden by a later, broader rule. FR-009 therefore requires the guard
to assert the **resolved** group and update type, not the presence of a rule — the weaker check passed
in all four prior instances.
