# Contract: Renovate resolution for the formerly-floating images

**Feature**: 063-infra-image-version-pins

The interface this feature exposes is what Renovate **resolves** for a given dependency. Guards assert
the resolved value, never the presence of a rule — the weaker check passed in all four prior half-bump
incidents (items #194, #204, #225, and the vault allowlist key in PR #289).

## C1 — Update classification

| Given a dependency | Resolved `updateType` must be |
|---|---|
| `axllent/mailpit` `v1.31.0` → `v2.0.0` | `major` |
| `axllent/mailpit` `v1.31.0` → `v1.32.0` | `minor` |
| `curlimages/curl` `8.21.0` → `8.21.1` | `patch` |
| `grafana/otel-lgtm` `0.32.0` → `0.33.0` | `minor` |
| `openpolicyagent/opa` `1.20.1` → `2.0.0` | `major` |
| `unleashorg/unleash-server` `8.1.0` → `9.0.0` | `major` |
| any of the above, floating | **must not occur** — no reference may resolve as `digest`-only |

## C2 — Grouping and paired movement

| Property | Required value |
|---|---|
| group for all eight | `docker base images` (unchanged — they are not stranded into per-image PRs) |
| `openpolicyagent/opa` and `openpolicyagent/opa` `-debug` | same group **and** same proposed version |
| a reference in `compose.yaml` and its twin in `compose.prod.yaml` | move in one proposal |

## C3 — Tags that must never be proposed

For `openpolicyagent/opa`: any tag matching `-dev`, `-rootless`, or a pre-release marker
(`rc`, `alpha`, `beta`, `nightly`, `snapshot`). Only the plain and `-debug` variants are in use.

## C4 — Date-tagged family

| Property | Required value |
|---|---|
| `minio/minio`, `minio/mc` versioning | `regex:` with named groups over `RELEASE.<ISO-date>` |
| ordering | newer date sorts higher |
| classification | present but **calendar-derived**; the config MUST say so (FR-004) |
| floating-tag report | both remain **declared exceptions** (research R4) |

## C5 — The report

`node scripts/infra-image-scan.mjs --list` must report a floating count **exactly equal** to the number
of declared exceptions — currently 2 (`minio/minio`, `minio/mc`). Not "fewer than 8" (SC-006).
