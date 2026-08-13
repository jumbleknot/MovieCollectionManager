# Module contract: `scripts/override-lever.mjs`

Answers one question for a security finding: **which lever clears this — refresh the lockfile, or raise
the floor?** A flat sibling module in `scripts/`, matching how `allowlist-expiry.mjs` is factored out of
`check-sast-findings.mjs`. `scripts/` has no `lib/`.

Pure functions only: no file I/O, no clock, no network, no `process.exit`. Both inputs are passed in, so
every case is testable without touching the repository state the gate reads.

This module exists because the measured incident (`fast-uri`, 2026-08-03 → 2026-08-13, ten days red;
`nanoid`, `main` red) was **not** a missing override. The override range already permitted the published
fix in both cases; the lockfile was pinned below it, and nothing said so. See
[research.md R4/R5](../research.md).

## Exports

```js
export function parseLocation(location);          // "hono@4.12.29" → { name, version }
export function parseFixFloor(fixAvailable);      // ">=4.12.34"    → "4.12.34"
export function adviseLever(finding, overrides);  // → LeverAdvice | null
export function selectAdvice(findings, overrides);// → LeverAdvice[]  (per resolution, deduped)
export function formatAdvice(entries);            // → printable string
```

### `parseLocation(location) → { name, version } | null`

Splits on the **last** `@`, exactly as `parseOverrideKey` does, so a scoped package
(`@scope/name@1.2.3`) parses correctly. Returns `null` when there is no version half.

### `parseFixFloor(fixAvailable) → string | null`

The version after `>=`. Returns `null` for an absent, empty or unparseable value — which the caller
turns into "no advice", never into a guess (FR-020).

### `adviseLever(finding, overrides) → LeverAdvice | null`

`overrides` is the raw `pnpm-workspace.yaml` `overrides:` map. Range parsing reuses
`parseOverrideKey`, `inclusiveLowerBound`, `exclusiveUpperBound` and the version comparator exported
from `check-override-consistency.mjs` — **imported, never reimplemented**. A second range dialect in
this repository is how the two halves drift apart (FR-021).

Let `L` = override lower bound, `U` = override upper bound (`∞` when absent), `F` = fix floor,
`R` = the resolved version from `location`.

| Condition | Result |
| --- | --- |
| no override matches `name` | `null` |
| `F` or the override value unparseable | `null` |
| `R` outside `[L, U)` | `null` — the override does not govern this resolution |
| `R ≥ F` | `null` — already remediated |
| `L ≤ F < U` and `R < F` | `{ action: 'refresh-lockfile', … }` |
| `F ≥ U` | `{ action: 'raise-floor', … }` |

> **Correction (2026-08-13, during implementation).** This table originally also listed `F < L` as a
> `raise-floor` case. That is **logically unreachable**: reaching the branch requires `R ≥ L` (in
> range) and `R < F` (unremediated), so `F < L` would give `R ≥ L > F > R`. Confirmed exhaustively
> over the ordering space — zero satisfying combinations. `raise-floor` is entered **only** via
> `F ≥ U`. The module keeps the condition as a defensive `||` and test 8 documents the unreachability
> so a later reader does not re-derive it.

Matching is on the override's **package name** (post-`parseOverrideKey`), so both keyed floors and
plain pins are considered. Plain pins have no vulnerable-range half and must not be treated as one.

#### `LeverAdvice`

```js
{ package: 'hono', resolved: '4.12.29', permitted: '>=4.12.25',
  fixFloor: '4.12.34', action: 'refresh-lockfile', message: '…' }
```

**`message` requirements**

| `action` | Must name |
| --- | --- |
| `refresh-lockfile` | the permitting range, the version the lockfile pins, and that a lockfile refresh is the remedy |
| `raise-floor` | that the floor must rise, and **both halves** — the vulnerable-range key and the patched-floor value |

A `raise-floor` message that names only the value half reproduces the half-bump this repository already
has a guard for. That is the whole reason the message is specified rather than left to the caller.

### `selectAdvice(findings, overrides) → LeverAdvice[]`

Maps `adviseLever` over `kind: 'sca'` findings and drops the `null`s. Evaluated **per resolution**, not
per package name: `undici` resolves at both 6.27.0 and 7.24.7 while its override governs only
`>=6.27.0 <7`, so the 6.x row yields advice and the 7.x rows must not (FR-019).

Deduped on `package + resolved + action` — `hono@4.12.29` carries four advisories and must produce one
line, not four.

**Does not filter on `blocking`, `severity` or `scope`** (FR-017). The two live cases are non-blocking
today, which is precisely the state `fast-uri` was in before it became a ten-day red; blocking-only
advice would first appear once the finding is already reddening every branch.

### `formatAdvice(entries) → string`

Returns a printable block; never writes to stdout itself (the gate owns its output), matching
`allowlist-expiry.mjs`'s formatters. Prints finding metadata only — no secrets, consistent with the
gate's existing constraint.

## Invariants

1. **Importing this module cannot change any gate's exit code** (FR-018). `check-sast-findings.mjs`
   keeps its contract exactly: exit 1 iff an un-allowlisted blocking finding is present, exit 2 on bad
   input. Advice is output, never policy. Asserted by a test that runs the gate over a finding set whose
   only advice-eligible entries are non-blocking, and requires exit 0.
2. **Pure.** No clock, no I/O. The caller supplies both the findings and the override map.
3. **Silent on unparseable input**, deliberately unlike `check-override-consistency.mjs`, which refuses
   out loud (exit 2). A *gate* that cannot read its input protects nothing; an *aid* that cannot read
   its input must not obstruct the gate.
4. **Does not weaken `check-override-consistency.mjs`.** That guard's rule, scope and exit codes are
   untouched; only a comparator becomes exported. Its existing tests must pass unchanged as the proof.

## Test coverage (`scripts/__tests__/override-lever.test.mjs`)

| # | Case | Expected |
| --- | --- | --- |
| 1 | `fast-uri@3.1.4`, fix `>=3.1.5`, override `>=3.1.4 <4` | `refresh-lockfile` — **the measured incident, from the frozen fixture** |
| 2 | message for case 1 | names `>=3.1.4 <4`, `3.1.4`, and the refresh remedy |
| 3 | `hono@4.12.29`, fix `>=4.12.34`, override `>=4.12.25` (no upper bound) | `refresh-lockfile` |
| 4 | `undici@6.27.0`, fix `>=6.28.0`, override `>=6.27.0 <7` | `refresh-lockfile` |
| 5 | `undici@7.24.7`, fix `>=7.28.0`, override `>=6.27.0 <7` | `null` — resolution outside the range |
| 6 | fix floor `>=4.0.1`, override `>=3.1.4 <4` | `raise-floor` — F ≥ U |
| 7 | message for case 6 | names **both** halves |
| 8 | fix floor below the override's lower bound | `raise-floor` |
| 9 | resolved already ≥ fix floor | `null` — already remediated |
| 10 | package with no override (`minimatch@9.0.3`) | `null` |
| 11 | plain pin override (`react-dom: 19.2.3`) | not parsed as a keyed floor; no spurious advice |
| 12 | absent / unparseable `fixAvailable` | `null`, no throw |
| 13 | unparseable override value | `null`, no throw |
| 14 | scoped package name (`@scope/name@1.2.3`) | splits on the last `@` |
| 15 | four advisories on one resolution | one advice entry, not four |
| 16 | non-blocking finding, advice-eligible | advice produced (FR-017) |
| 17 | gate run over case-16 findings | **exit 0** — advice cannot change the exit code (FR-018) |
