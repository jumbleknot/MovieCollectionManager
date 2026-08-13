# CLI contract: `scripts/check-override-consistency.mjs`

Guards the two halves of every security override floor in `pnpm-workspace.yaml`. Shaped after
`check-toolchain-consistency.mjs` — same flags, same exit codes, same `--dir` testing seam — because
it does the same job for a different lockstep pair.

## Usage

```bash
node scripts/check-override-consistency.mjs             # scan; exit 0 clean / 1 mismatch
node scripts/check-override-consistency.mjs --selftest  # prove detection; exit 0/1
node scripts/check-override-consistency.mjs --dir <d>   # scan a different repo root (tests)
```

## The rule

For every entry in `overrides:` whose **key carries an `@<range>` suffix**:

> the key's **exclusive upper bound** (the version after `<`) must equal
> the value's **inclusive lower bound** (the version after `>=`).

```text
fast-uri@<3.1.4: '>=3.1.4 <4'
          ^^^^^     ^^^^^
          must be equal
```

## Scope — what is checked and what is not

| Shape | Example | Checked |
| --- | --- | --- |
| Keyed floor | `fast-uri@<3.1.4: '>=3.1.4 <4'` | **yes** |
| Keyed floor, compound key | `js-yaml@>=3.0.0 <3.15.1: '>=3.15.1 <4'` | **yes** — only the `<` bound is compared |
| Plain pin | `react-dom: 19.2.3` | no |
| Plain floor, no key half | `postcss: '>=8.5.18'` | no |
| Scoped plain pin | `'@expo/dom-webview': ^56.0.5` | no |

**Scoping is the most likely way to get this wrong.** Three legitimate plain pins exist; treating them
as violations produces a guard that fails on correct input. The package-name split must use the
**last** `@` so scoped names (`@scope/name@<range>`) parse correctly.

## Measured baseline

**10 keyed floors, 10 agreements, 0 mismatches** as of 2026-08-13. The guard is green on arrival and
fails only on a real half-bump.

## Failure output

Names the entry, both halves, and what disagrees — enough to fix without opening the advisory:

```text
✗ override key/value mismatch: fast-uri
    key   fast-uri@<3.1.4    excludes below 3.1.4
    value >=3.1.5 <4         forces at/above 3.1.5
  The key still names 3.1.4 as the vulnerable boundary. Raise both halves together.
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Clean — every keyed floor's halves agree (or `--selftest` all-pass) |
| `1` | At least one mismatch, or selftest broken |
| `2` | Bad args, unreadable or unparseable `pnpm-workspace.yaml` |

## `--selftest` scenarios

| Case | Scenario | Expected |
| --- | --- | --- |
| (a) | Value raised, key left stale | exit `1`, names the entry |
| (b) | Key raised, value left stale | exit `1` — the mismatch is symmetric |
| (c) | Both halves agree | exit `0` |
| (d) | Plain pin with no key half | exit `0` — out of scope, not a violation |
| (e) | Scoped keyed floor (`@scope/name@<1.2.3`) | parsed on the **last** `@`; agreement detected |
| (f) | Value with no `>=` bound | exit `2` — unparseable, not silently skipped |

## CI wiring

```yaml
# .forgejo/workflows/guardrails.yml — naming job, beside the toolchain gate
- run: bash scripts/ci-log-step.sh naming-override-consistency-gate node scripts/check-override-consistency.mjs --selftest
- run: bash scripts/ci-log-step.sh naming-override-consistency-gate node scripts/check-override-consistency.mjs
```

Selftest-then-scan, matching lines 133-134. Unlike the expiry check this **does** run on pull
requests — that is the point: it must block a half-bumped proposal before merge, whether the bot or a
person wrote it (FR-018).

Its unit test at `scripts/__tests__/check-override-consistency.test.mjs` is discovered automatically
by the existing `node --test scripts/__tests__/*.test.mjs` glob (`guardrails.yml:147`).
