# Data model: Version-pin guard (107)

These are in-memory values produced by one run of `scripts/check-version-pins.mjs`. Nothing is
persisted except the exclusions file.

## Pin

One hand-written version occurrence in a scanned file.

| field | type | notes |
| --- | --- | --- |
| `file` | string | repository-relative, forward slashes |
| `line` | integer | 1-based |
| `shape` | `assignment` \| `action-input` \| `command-spec` | the rule that recognised it (research R3) |
| `name` | string | variable name; `owner/action:input` for action inputs; tool name for command specs |
| `value` | string | the version as written (`v0.76.2`, `26.13.1`) |

**Validation**:
- For `action-input` and `command-spec`, `value` matches `^v?\d+\.\d+(\.\d+)?` followed by an optional
  suffix.
- For `assignment` outside JS files, a digits-only value (`^\d+$`) is also a pin, because the name
  already says it is a version. This catches build-number pins such as
  `ANDROID_CLT_VERSION=11076708`, which the dotted rule would miss. JS files keep the dotted rule:
  there, digits-only constants are this repository's own format versions
  (`export const PARSER_VERSION = 2` in `scripts/lib/cc-usage/parse-transcript.mjs`), not pins on an
  upstream release.
- `name` must contain `VERSION` or `PIN` as a whole underscore-separated token (`(^|_)(VERSION|PIN)(_|$)`),
  so `SPINNER_INTERVAL` is not a pin.
- A comment line yields no pin.

## Coverage

Why a pin is managed. A pin carries at most one coverage, and the first match wins in this order:

| kind | fields | meaning |
| --- | --- | --- |
| `custom` | `manager` (its `depNameTemplate`) | a customManager's `matchStrings` captured `currentValue` on this line (research R1) |
| `builtin` | `manager` (`github-actions:<action>`) | an `action-input` on a known action (research R2) |

## Exclusion

One entry in `.forgejo/version-pin-exclusions.json`. The schema is in `contracts/exclusions-file.md`.

| field | type | rule |
| --- | --- | --- |
| `file` | string | exact repository-relative path |
| `name` | string | exact pin name, with no wildcard (FR-005) |
| `reason` | string | non-empty after trimming, and at least 20 characters, so "n/a" cannot pass |

## Verdict

| field | content |
| --- | --- |
| `managed` | pins with a Coverage |
| `excluded` | pins matched by an Exclusion, each carrying its reason |
| `unmanaged` | pins with neither, which fail the check (FR-004) |
| `staleExclusions` | exclusions matching no pin, which fail the check (FR-006) |
| `redundantExclusions` | exclusions whose pins all have a Coverage, which fail the check (FR-006) |
| `invalidExclusions` | entries missing a field, carrying a wildcard, or with too short a reason, which fail the check (FR-005) |

The check passes when the last four are all empty.

In the `--json` output (contracts/cli.md), `managed`, `excluded` and `unmanaged` are not separate
arrays. They are the values of `pins[].status`. The three exclusion lists appear under their own names.

### State transitions of a pin over its life

```text
added unmanaged ──► (check fails) ──► manager added      ──► managed
                                  └─► exclusion recorded ──► excluded
excluded ──► manager later added ──► redundant exclusion (check fails) ──► exclusion deleted ──► managed
excluded ──► pin deleted          ──► stale exclusion     (check fails) ──► exclusion deleted
```
