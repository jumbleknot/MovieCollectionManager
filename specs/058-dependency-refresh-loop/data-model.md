# Phase 1 data model — close the dependency-refresh gaps 057 left open

**Feature**: `058-dependency-refresh-loop` · **Date**: 2026-08-13

No database, no persisted state. The "entities" here are the in-memory shapes the advice module reads
and produces, plus the workflow-filter shape the guard test asserts over. All of them already exist as
files in the repository; this feature adds one derived shape (Lever Advice).

---

## 1. Override entry

**Source**: `pnpm-workspace.yaml` → `overrides:` (a YAML map). 14 entries today: 11 keyed, 3 plain pins.

| Field | Derivation | Notes |
| --- | --- | --- |
| `name` | key, split on the **last** `@` | `@expo/dom-webview` has its only `@` at index 0 → plain pin, not a keyed floor |
| `vulnerableRange` | key, after the last `@` | absent for a plain pin |
| `permittedRange` | the map value | e.g. `>=3.1.5 <4`, or a bare pin like `19.2.3` |
| `lowerBound` | version after `>=` in `permittedRange` | `null` when absent |
| `upperBound` | version after `<` in `permittedRange` | `null` when absent → unbounded above (e.g. `hono`) |

**Rules**

- **Lockstep (pre-existing, unchanged)**: for a keyed entry, `vulnerableRange`'s exclusive upper bound
  MUST equal `permittedRange`'s inclusive lower bound. Enforced by `check-override-consistency.mjs`.
  This feature does not touch the rule, only reuses its parsers.
- **Plain pins are out of scope, not violations.** Three entries have no `vulnerableRange`. They must
  neither fail the lockstep rule nor produce lever advice.
- **An unparseable half is refused out loud** by the existing guard (exit 2) and **passed over
  silently** by the advice module. The two differ deliberately: a gate that cannot read its input
  protects nothing, whereas an aid that cannot read its input must not obstruct the gate.

---

## 2. Dependency finding

**Source**: `security/sast/reports/findings.json` → `findings[]`, already normalized and scrubbed by
`sast-scan.mjs`. Only `kind: "sca"` entries are relevant.

| Field | Example | Used for |
| --- | --- | --- |
| `scanner` | `pnpm-audit` | selecting SCA findings |
| `kind` | `sca` | selecting SCA findings |
| `id` | `GHSA-8j4g-w8fx-2239` | identity in output |
| `location` | `hono@4.12.29` | **package name + resolved version**, split on the last `@` |
| `fixAvailable` | `>=4.12.34` | the fix floor |
| `severity` / `scope` | `Medium` / `runtime` | display only — advice does **not** filter on these |
| `blocking` | `false` | display only — advice is emitted regardless (FR-017) |

**Rules**

- `location` is parsed **per resolution**. A package may appear at several versions (`undici` at
  6.27.0 and 7.24.7); each is evaluated separately against the override (FR-019).
- `fixAvailable` may be absent or unparseable → no advice for that finding (FR-020).
- Neither `severity`, `scope` nor `blocking` gates advice generation. They are carried through for the
  reader only.

---

## 3. Lever advice *(new — the only shape this feature introduces)*

**Produced by**: `scripts/override-lever.mjs`, a pure function. **Consumed by**:
`check-sast-findings.mjs`, for output only.

| Field | Meaning |
| --- | --- |
| `package` | package name |
| `resolved` | the version the lockfile currently resolves |
| `permitted` | the override's permitted range, verbatim |
| `fixFloor` | the minimum fixed version parsed from `fixAvailable` |
| `action` | `'refresh-lockfile'` \| `'raise-floor'` |
| `message` | one human-readable line naming the range, the pin, and the command or edit that clears it |

### Decision table

Let `L` = override lower bound, `U` = override upper bound (`∞` when absent), `F` = fix floor,
`R` = resolved version.

| Condition | `action` | Rationale |
| --- | --- | --- |
| no override for `package` | *no advice* (`null`) | nothing to say that the finding does not already say |
| `F` unparseable, or `permittedRange` unparseable | *no advice* (`null`) | FR-020 — an aid must not guess |
| `R` outside `[L, U)` | *no advice* (`null`) | FR-019 — the override does not govern this resolution (`undici` 7.x) |
| `L ≤ F < U` and `R < F` | `refresh-lockfile` | the range **already permits** the fix; the lockfile is what is stale — **the measured incident** |
| `F ≥ U`, or `F < L` | `raise-floor` | the range cannot reach the fix; both halves must move |
| `R ≥ F` | *no advice* (`null`) | already remediated; the finding is stale rather than actionable |

### Invariants

- **Advisory only.** Producing advice MUST NOT change the gate's exit code (FR-018). The gate's
  contract remains: exit 1 iff an un-allowlisted blocking finding is present.
- **`raise-floor` names both halves.** A message that names only the value half reproduces the
  half-bump this repository already has a guard for (FR-016).
- **Deterministic and side-effect free.** Same inputs → same output. No clock, no network, no
  filesystem access inside the module; the caller supplies both inputs.

### Worked examples (measured 2026-08-13)

| Finding | Override | Outcome |
| --- | --- | --- |
| `hono@4.12.29`, fix `>=4.12.34` | `>=4.12.25` (U = ∞) | `refresh-lockfile` |
| `undici@6.27.0`, fix `>=6.28.0` | `>=6.27.0 <7` | `refresh-lockfile` |
| `undici@7.24.7`, fix `>=7.28.0` | `>=6.27.0 <7` | `null` — R outside range |
| `fast-uri@3.1.4`, fix `>=3.1.5` *(reconstruction)* | `>=3.1.4 <4` | `refresh-lockfile` — **the incident** |
| hypothetical `fast-uri@3.1.4`, fix `>=4.0.1` | `>=3.1.4 <4` | `raise-floor` — F ≥ U |
| `minimatch@9.0.3`, fix `>=9.0.6` | *(none)* | `null` |

---

## 4. Change-detection filter *(asserted, not produced)*

**Source**: `.forgejo/workflows/app-ci.yml`. Read by the guard test only; this feature adds no code
that consumes it at runtime.

| Shape | Location | Assertion |
| --- | --- | --- |
| `on.push.paths` | line ~38 | contains both `pnpm-lock.yaml` and `pnpm-workspace.yaml` (FR-005) |
| `jobs.changes.steps[].with.filters.app` | ~82–92 | contains both (FR-001, FR-002) |
| `jobs.changes.steps[].with.filters.mobile` | ~99+ | contains neither (FR-003), and is a subset of `app` (FR-004) |
| `jobs.app-e2e.if` | ~252 | references `needs.changes.outputs.app` (FR-006) |

The `filters` value is a YAML **string** inside `with:`, so the test must parse it as a second YAML
document rather than indexing into the outer parse. Getting this wrong yields a test that passes
vacuously — which is why every one of these assertions is mutation-tested (SC-003).
