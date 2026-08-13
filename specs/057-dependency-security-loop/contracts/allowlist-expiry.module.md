# Module contract: `scripts/allowlist-expiry.mjs`

The single home for allowlist expiry semantics, imported by both gates. A flat sibling module, matching
how `ci-digest-redact.mjs` and `openwiki-policy.mjs` are shared — `scripts/` has no `lib/`.

Pure functions only: no file I/O, no clock reads, no process exit. `today` is always passed in, so
every case is testable without mocking time.

## Exports

```js
export const WARNING_WINDOW_DAYS = 14;
export function classifyExpiry(expiry, today);
export function daysUntil(expiry, today);
export function formatExpiring(entries);
export function formatExpired(entry);
export function formatUnmatched(entries);
export function selectUnmatched(entries, matchedIds, scannersWithFindings);
```

### `WARNING_WINDOW_DAYS`

`14`. **The only definition in the repository** (FR-024). Both gates import it; neither redeclares it.

### `classifyExpiry(expiry, today) → 'active' | 'expiring' | 'expired'`

| Input | Result |
| --- | --- |
| `expiry` absent / `undefined` | `'active'` |
| `daysUntil > WARNING_WINDOW_DAYS` | `'active'` |
| `0 <= daysUntil <= WARNING_WINDOW_DAYS` | `'expiring'` |
| `daysUntil < 0` | `'expired'` |

Both boundaries inclusive. `expiry === today` → `'expiring'` (an entry suppresses through the whole of
its final day). `daysUntil === 14` → `'expiring'`.

Only `'expired'` stops suppression, preserving today's behaviour exactly
(`check-sast-findings.mjs:80`, `check-infra-image-findings.mjs:89`).

### `daysUntil(expiry, today) → number`

Whole days from `today` to `expiry`; negative once past. Both arguments ISO `YYYY-MM-DD`. Computed on
UTC date boundaries — no local timezone, so a runner's TZ cannot shift a classification.

### `selectUnmatched(entries, matchedIds, scannersWithFindings) → entries[]`

Returns entries that suppressed nothing **and** whose scanner produced at least one finding this run.

An entry whose scanner appears nowhere in `scannersWithFindings` is **never** returned — the guard
from clarification Q2. A skipped, failed or clean scanner must not flag its whole entry set.

### Formatters

Return printable strings; never write to stdout themselves (the gates own their output). Required
content:

| Formatter | Must name |
| --- | --- |
| `formatExpiring` | entry `id`, `expiry`, days remaining, `addedBy` (FR-020) |
| `formatExpired` | that the finding **was suppressed until** `<expiry>` by an entry added by `<addedBy>` (FR-022) |
| `formatUnmatched` | entry `id` and `addedBy`, and that it matched nothing this run (FR-023) |

Output is finding metadata only — no secrets, consistent with both gates' existing constraint.

## Invariants

1. **Importing this module changes no gate's exit code.** Classification is advisory in a normal run;
   only `'expired'` affects suppression, and it does so exactly as today (FR-021).
2. **Pure.** No `Date.now()` inside classification — callers pass `today`.
3. **Shape-agnostic.** Takes a normalized `{ id, addedBy, expiry, scanner }` view; the two allowlists'
   differing native shapes stay in their own gates.

## Test coverage (`scripts/__tests__/allowlist-expiry.test.mjs`)

| # | Case | Expected |
| --- | --- | --- |
| 1 | no expiry | `'active'` |
| 2 | 15 days out | `'active'` |
| 3 | exactly 14 days out | `'expiring'` — upper boundary |
| 4 | 1 day out | `'expiring'` |
| 5 | expiry === today | `'expiring'` — lower boundary, still suppressing |
| 6 | expiry === yesterday | `'expired'` |
| 7 | `formatExpiring` output | contains id, date, day count, `addedBy` |
| 8 | `formatExpired` output | states the former suppression and who added it |
| 9 | unmatched, scanner had findings | returned |
| 10 | unmatched, scanner had **no** findings | **not** returned |
| 11 | matched entry | not returned regardless of scanner activity |
