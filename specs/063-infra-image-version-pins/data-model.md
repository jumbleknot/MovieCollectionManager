# Phase 1 Data Model: Infra-image version pins

**Feature**: 063-infra-image-version-pins · **Date**: 2026-08-30

No persistent data. The "entities" are configuration values whose *shape* carries the meaning, so they
are modelled here as the states and transitions the guards must assert.

## E1 — Image reference

A pointer to a third-party container image in a compose file.

| Field | Meaning | Example |
|---|---|---|
| `repository` | registry path | `openpolicyagent/opa` |
| `tag` | version or floating label; absent means `latest` | `1.20.1-debug` |
| `digest` | immutable content pin, added by `docker:pinDigests` | `sha256:f6aa14fd…` |
| `variant` | suffix distinguishing a build of the same version | `-debug` |

**States**

- **Floating** — `tag` is `latest`, `latest-<variant>`, or absent. Not orderable, so no update can be
  classified.
- **Versioned** — `tag` is orderable. Updates carry an update type.
- **Declared exception** — floating, with a recorded reason. Counted, never silent.

**Transitions**

- Floating → Versioned: the migration. **Invariant: `digest` MUST NOT change** (FR-002, SC-002).
- Versioned → Versioned: an ordinary Renovate bump; `digest` changes and an update type exists.
- Versioned → Floating: forbidden. Nothing may reintroduce a floating reference without a declaration.

**Validation**

- V1: every reference is Versioned or a Declared exception (FR-001).
- V2: references sharing a `repository` move together, across variants and across local/prod files
  (FR-005).
- V3: no `-dev`, `-rc`, `-alpha`, `-beta`, `-nightly` or unused-variant tag is ever proposed (FR-006).

## E2 — Update classification

What Renovate decides an image change is.

| Value | Meaning | Available when |
|---|---|---|
| `major` / `minor` / `patch` | semantic risk level | repository uses a semantic scheme |
| `digest` | opaque content change | reference is Floating — **the defect this feature removes** |

**Calendar caveat (research R2).** For the date-tagged family, `major`/`minor`/`patch` are derived
from year/month/day. They are *orderable but not semantic*: a January release reports `major` because
the year advanced, not because anything broke. FR-004 requires this be recorded rather than presented
as a real risk signal.

## E3 — Suppression entry

A recorded acceptance of a known vulnerability, in `security/infra-images/allowlist.yaml`.

| Field | Meaning |
|---|---|
| `image` | **unanchored regex** matched against the full reference |
| `id` | advisory identifier pattern |
| `justification`, `addedBy`, `expiry` | provenance and lifetime |

**The property that matters**: because `image` is matched unanchored, a key like
`hashicorp/vault:1\.18` still matches `hashicorp/vault:1.18@sha256:…` — appending a digest does not
break it — but stops matching `1.21`. That is what makes a suppression **dischargeable**: it expires
by version movement rather than by a human remembering.

**States**

- **Dischargeable** — keyed to a version; ceases to match when the image moves.
- **Un-dischargeable** — keyed to a floating reference; can never stop matching. FR-007 requires each
  to be converted, or to record why it cannot be.

**Worked example, both directions**: the `hashicorp/vault:1\.18` key ceasing to match `1.21` is what
surfaced a real regression (five unsuppressed Criticals) during PR #289 — a dischargeable key doing
its job. The `grafana/otel-lgtm:latest` key is the opposite: its own justification states no pin or
bump can clear it.
