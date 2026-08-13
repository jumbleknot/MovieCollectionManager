# Phase 1 data model: restore the dependency-security maintenance loop

**Feature**: `057-dependency-security-loop` · **Date**: 2026-08-13

No database and no persisted state — every entity here is a shape parsed from a file on each run. That
statelessness is a design constraint, not an accident: it is why "unmatched for N consecutive runs"
was rejected during planning, and why classification is a pure function of `(entry, today, findings)`.

---

## Entity: Allowlist entry

A time-boxed, justified suppression of one scanner finding. Two concrete shapes, one shared lifecycle.

### SAST/SCA shape — `security/sast/allowlist.yaml`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `scanner` | string | yes | e.g. `pnpm-audit`, `semgrep`, `pip-audit` |
| `id` | string | yes | Exact rule or advisory id (`GHSA-*`, `CVE-*`, `PYSEC-*`, `RUSTSEC-*`) |
| `locationPattern` | regex string | yes | Matched against `path:line` or `package@version` |
| `justification` | string | yes | Blank → `GateError`, exit 2 |
| `addedBy` | string | yes | Surfaced by the new reporting |
| `expiry` | `YYYY-MM-DD` | no | Absent = permanent acceptance |

### Infra-image shape — `security/infra-images/allowlist.yaml`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `image` | regex string | yes | Image reference pattern |
| `id` | regex string | yes | Advisory id pattern |
| `justification` | string | yes | As above |
| `addedBy` | string | yes | As above |
| `expiry` | `YYYY-MM-DD` | no | As above |

**The shapes are why the gates cannot be merged.** They share only the expiry field and its semantics,
which is exactly the slice the new module owns. Each gate keeps its own compilation and passes a
normalized `{ id, addedBy, expiry, scanner }` view to the shared classifier.

### Lifecycle states

Derived, never stored. `today` is ISO `YYYY-MM-DD`; lexicographic comparison is valid for that format
and is what both gates already rely on.

```text
                     expiry absent
                          │
                          ▼
   ┌──────────── active (suppresses, silent) ────────────┐
   │                                                      │
   │  expiry - today > WARNING_WINDOW_DAYS                │
   ▼                                                      │
 active ──── expiry - today <= WINDOW ───▶ expiring ──── expiry < today ───▶ expired
             (suppresses, REPORTED)         (suppresses,                     (does NOT
                                             REPORTED)                        suppress;
                                                                              re-block is
                                                                              EXPLAINED)
```

| State | Suppresses? | Gate exit code | Reported in normal run | Reddens `--check-expiring` |
| --- | --- | --- | --- | --- |
| `active` | yes | unchanged | no | no |
| `expiring` | **yes** | **unchanged** | yes — `EXPIRING SOON` | yes |
| `expired` | no | finding re-blocks as normal | yes — names former expiry + `addedBy` | yes |

**Boundary rule** (removes the ambiguity in "14 days"): both ends inclusive. `expiry - today == 14`
is `expiring`. `expiry == today` is `expiring`, not `expired` — an entry suppresses through the whole
of its final day. `expiry < today` is `expired`. Three selftest cases pin these exactly.

### Orthogonal property: matched / unmatched

Independent of the lifecycle above — an entry can be `active` *and* unmatched.

| Condition | Reported unmatched? |
| --- | --- |
| Entry suppressed ≥1 finding this run | no |
| Entry suppressed nothing, **and its scanner produced ≥1 finding** | **yes** |
| Entry suppressed nothing, and its scanner produced **no** findings | **no** — the guard from clarification Q2 |

That last row is the whole point: a skipped, failed or clean scanner would otherwise flag every one of
its entries, and the weekly check would go red saying "stale entry" when the truth is "scanner did not
run". It catches two real cases — a stale entry left behind after a genuine remediation, and the
measured namespace-drift trap where pip-audit switched from CVE ids to PYSEC aliases and matching
entries *"did not expire, they just quietly matched nothing"*.

### Current population (measured 2026-08-13)

| File | Entries with `expiry` | Dates |
| --- | --- | --- |
| `security/sast/allowlist.yaml` | 5 | `fast-uri` 08-31, `ip-address` 08-31, `image-size` ×2 09-07, `click` 10-12 |
| `security/infra-images/allowlist.yaml` | 3 | all 10-24 |

**Eight, not the seven** item #154's prose claims — its own table sums to eight and the files agree
with the table.

---

## Entity: Override floor

A minimum version forced onto a transitive dependency, in `pnpm-workspace.yaml`'s `overrides:` map.
Exists **only** as a security control.

### Two shapes, and only one is in the guard's scope

| Shape | Example | Halves | In guard scope |
| --- | --- | --- | --- |
| **Keyed floor** | `fast-uri@<3.1.4: '>=3.1.4 <4'` | vulnerable-range key + patched-range value | **yes** |
| **Plain pin** | `react-dom: 19.2.3`, `postcss: '>=8.5.18'`, `'@expo/dom-webview': ^56.0.5` | value only | **no** |

| Half | Meaning | Parsed as |
| --- | --- | --- |
| Key suffix after the last `@` | The vulnerable range being excluded | exclusive upper bound — the version after `<` |
| Value | The patched range being forced | inclusive lower bound — the version after `>=` |

### The invariant

> **key's exclusive upper bound == value's inclusive lower bound**

Verified against the live file: **10 keyed floors, 10 agreements, 0 mismatches.** The guard is
therefore green on arrival and fails only when one half moves without the other.

| Package | key upper | value lower |
| --- | --- | --- |
| `form-data` | 4.0.6 | 4.0.6 |
| `hono` | 4.12.25 | 4.12.25 |
| `undici` | 6.27.0 | 6.27.0 |
| `brace-expansion` | 5.0.9 | 5.0.9 |
| `js-yaml` (3.x) | 3.15.1 | 3.15.1 |
| `js-yaml` (4.x) | 4.3.1 | 4.3.1 |
| `shell-quote` | 1.9.0 | 1.9.0 |
| `axios` | 1.18.0 | 1.18.0 |
| `fast-uri` | 3.1.4 | 3.1.4 |
| `nanoid` | 3.3.17 | 3.3.17 |

**Failure mode the invariant exists to catch**: raising the value to `>=3.1.5 <4` while leaving the
key at `<3.1.4` produces an override that *looks* remediated but no longer excludes the version it
names. This is the override-map instance of the half-bump that PR #141 produced in the nx pair.

### Related, but not part of the entity

`minimumReleaseAgeExclude` (`pnpm-workspace.yaml:28`) is a flat list of `name@version` strings
exempting a resolved version from the release-age cooldown. It **already contains `fast-uri@3.1.4`**,
so raising that floor means editing an existing element, not appending a new one. A stale entry here
is harmless but misleading.

---

## Entity: Warning window

| Property | Value |
| --- | --- |
| Length | **14 days** |
| Definition site | exactly one — `WARNING_WINDOW_DAYS` in `scripts/allowlist-expiry.mjs` |
| Consumers | both gates, via import |
| Boundaries | inclusive at both ends (see lifecycle above) |

Chosen deliberately over 21 and 28 days: keeping entries *out* of the window most of the time is what
keeps a red check meaningful. The accepted cost is that a remediation needing its own branch and build
— `image-size` being the live example — gets two weeks' notice rather than three.

**Derived prediction**: with Story 3 deleting the two 08-31 entries, the earliest remaining expiry is
09-07, which enters the window on 08-24. The scan runs Fridays, so the first red run is **Friday
2026-08-28**. Anything else means the constant or the classification is wrong.

---

## Entity: Schedule window (Stories 1-2)

Not persisted; derived from two files and compared by the new guard test.

| Source | Value | In UTC |
| --- | --- | --- |
| `renovate.yml` cron (nightly) | `0 3 * * *` | 03:00 daily |
| `renovate.yml` cron (**new**) | `0 7 * * 5` | 07:00 Friday |
| `renovate.json` `schedule` (today) | `* 3 * * 5` @ `America/New_York` | 07:00-07:59 Fri (EDT) / 08:00-08:59 (EST) |
| `renovate.json` `schedule` (**new**) | `* 2-4 * * 5` @ `America/New_York` | 06:00-08:59 (EDT) / 07:00-09:59 (EST) |

**Invariant the guard asserts**: at least one workflow cron falls inside the permitted window under
*both* offsets. Today zero do — which is the RED the fix turns green, and the reason the correction is
a test rather than a comment.
