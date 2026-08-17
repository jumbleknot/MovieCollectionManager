# Phase 1 data model — Playwright image-pin consistency gate

**Feature**: 061-playwright-image-pin-gate · **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

There is no persistence and no runtime state here. The "model" is the three values the gate derives
from two tracked files, and the rules that make a derivation valid. They are written out because the
gate's correctness is entirely a question of *what counts as a valid reading* — every failure mode in
the spec's Edge Cases is a case where a reading is absent, ambiguous, or vacuous.

---

## Entity: ResolvedRunnerVersion

The single `@playwright/test` version that `pnpm-lock.yaml` actually resolves to. The authority for
what the test runner expects, and therefore for which baked browser build must be present.

| Field | Type | Notes |
|---|---|---|
| `version` | string | Semver, e.g. `1.62.1`. Never a range. |

**Derivation**: parse `pnpm-lock.yaml` with `yaml`; take the keys of the `packages` map, falling back
to `snapshots` if `packages` is absent; select keys prefixed `@playwright/test@`; strip the prefix;
reduce to distinct values.

**Validation rules**:

| Rule | On violation |
|---|---|
| Exactly one distinct version must be found | **Finding.** Zero means the lockfile shape changed or the dependency was removed; several means the workspace resolved more than one runner and the pin cannot represent them all. Neither may be silently reduced to a pick. |
| The value must be a plain semver | **Finding.** A non-numeric value cannot be compared with a tag version and must be reported, not coerced. |
| `package.json` is **not** a fallback source | — Deliberate. Its `^1.36.0` range was unchanged across the measured failure; reading it would pass the exact PR this gate exists to catch. |

**Why the `packages` keys rather than a text match**: the lockfile contains compound peer-suffixed
keys that embed the package name inside another key, e.g.
`'@nx/playwright@22.7.8(…)(@playwright/test@1.62.1)(…)'`. A text match can be defeated by
indentation; a keys read cannot.

---

## Entity: ImagePinOccurrence

One appearance of the Playwright container image in `.forgejo/workflows/app-ci.yml`. The image tag is
what selects the baked browser build, so each occurrence is an independent claim about which browser
will run.

| Field | Type | Notes |
|---|---|---|
| `file` | string | POSIX-normalised, via the existing `posixLocation()`, so a finding reads identically on any platform |
| `line` | number | 1-indexed. Required by FR-005 so a failure is diagnosable from its message alone. |
| `value` | string | The version out of the tag, e.g. `1.62.1` — the `v` prefix and `-noble` suffix are anchors, not data |

**Derivation**: line scan of the workflow text for `mcr.microsoft.com/playwright:v<version>-noble`,
**skipping comment lines**.

**Validation rules**:

| Rule | On violation |
|---|---|
| At least one occurrence must exist | **Finding.** A gate that passes on having found nothing to compare has stopped working without saying so. |
| **Every** occurrence is checked, not the first | **Finding per disagreeing occurrence.** A partial bump must fail — this is the case the item calls out explicitly. |
| Occurrences are discovered by scan, never by a fixed count | — A third occurrence added later is covered automatically. |
| Comment lines are excluded | — Mirrors the existing `collectPins()`, which skips `/^\s*#/` so prose describing a past pin is never read as a pin. `app-ci.yml` carries heavy comment prose around this block. |
| Only `.forgejo/workflows/app-ci.yml` is scanned | — `specs/**` is out of scope: those files contain the old `v1.60.0-noble` string as a point-in-time record, and scanning them would fail the gate on history. |
| The `-noble` suffix is part of the anchor | — It is the OS variant that selects the image. Matching a bare `:v<x>` would treat a `-jammy` line as interchangeable. |

---

## Entity: Drift

The relation the gate exists to reject: `ResolvedRunnerVersion.version` and at least one
`ImagePinOccurrence.value` naming different versions.

Emitted in the repository-standard findings shape already used by `findDrift()` and
`findNxPinDrift()`:

```
{ file: string, line: number, problem: string }
```

**The `problem` string must name** the resolved lockfile version, the disagreeing tag version, and
what the consequence is — because the failure it replaces was diagnosable only by reading a container
log. SC-002 is met when the message alone is sufficient.

**Relationship**: one `ResolvedRunnerVersion` is compared against *n* `ImagePinOccurrence`s, yielding
0..n `Drift` findings. Agreement is `version === value` for every occurrence.

---

## State transitions

None. The gate is a pure function of two files at one instant: read → compare → exit 0 or 1. It holds
no state between runs, makes no network call, and depends on no clock — the same tree always produces
the same verdict.
