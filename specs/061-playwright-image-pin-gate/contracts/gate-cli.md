# Contract — `check-toolchain-consistency.mjs` CLI, after this feature

**Feature**: 061-playwright-image-pin-gate

The gate is a CLI, and CI depends on its argument handling, its exit codes and its output shape. This
contract records what stays fixed and what this feature adds. Everything under "Unchanged" is a
pre-existing commitment that must survive the change.

---

## Invocation

```bash
node scripts/check-toolchain-consistency.mjs              # scan; the real gate
node scripts/check-toolchain-consistency.mjs --selftest   # prove the gate can fail
```

`--selftest` remains the **only** accepted flag. Any other argument exits `2` with
`Unknown argument(s): …`.

> **Pre-existing doc drift, deliberately not fixed here.** The file's usage comment also advertises
> `--dir <d>`, which the parser rejects. `findDrift(root)` does take a root parameter — it is used by
> the unit tests — but it is not reachable from the CLI. Out of scope for this feature; recorded so
> the next reader does not attribute it to this change.

## Exit codes — unchanged

| Code | Meaning |
|---|---|
| `0` | Clean. Every checked relation agrees. |
| `1` | Drift found, or `--selftest` detected that the gate can no longer fail. |
| `2` | Bad arguments, or an input could not be read/parsed at all. |

The distinction between `1` and `2` is load-bearing: `1` means *the repository is wrong*, `2` means
*the gate could not form an opinion*. A new failure mode must pick the right one — a missing or
unparseable `pnpm-lock.yaml` is `2` (cannot run), whereas a lockfile that parses but yields zero or
several `@playwright/test` resolutions is `1` (a finding, per FR-004).

## Output shape — unchanged

Failure, on stderr:

```
✗ toolchain-consistency gate FAILED: <n> pin(s) disagree:
  <file>:<line> — <problem>
  …
```

Success, on stdout: a single `✓` line that **enumerates what was proved**.

## What this feature changes

### 1. A fourth relation is checked

`findDrift()` composes one more finding source, exactly as it already does for `findNxPinDrift()`:

```js
findings.push(...findPlaywrightPinDrift(root));
```

### 2. The success line is extended

**This is part of the contract, not cosmetics.** The existing line enumerates each relation it
proved:

```
✓ toolchain-consistency gate passed (every Node pin satisfies engines.node; pnpm is single-sourced;
  nx agrees with nx.json installation.version)
```

It must gain a clause for the Playwright pair. A gate that checks four relations and claims three
leaves a reader unable to tell whether the fourth ran — which is the same "a green tick proves less
than it appears to" failure this repository has already been bitten by.

### 3. New exported functions

Exported for unit testing, named for behaviour per the constitution's Behavior-Descriptive
Identifiers principle. Requirement provenance belongs in a JSDoc comment on each, never in the name.

```js
/** The single @playwright/test version pnpm-lock.yaml resolves to. Throws if it is not unique. */
export function resolveLockfilePlaywrightVersion(root)

/** Every non-comment Playwright image-tag occurrence in one file's text. */
export function collectPlaywrightImagePins(text, file) // -> [{ file, line, value }]

/** Findings where the resolved runner version and an image tag disagree. */
export function findPlaywrightPinDrift(root)           // -> [{ file, line, problem }]
```

### 4. `--selftest` gains cases

The mode's contract — *demonstrate the gate can fail; exit 1 if the demonstration stops
demonstrating* — is unchanged. It gains the cases enumerated in `research.md` R7, all driven by
in-memory fixture strings, consistent with how the existing selftest asserts `collectPins()` against
literal lines. It writes no files.

## Compatibility requirements

| Requirement | Why |
|---|---|
| `guardrails.yml` needs **no step change** | The two existing lines already run `--selftest` then the real scan. |
| `scripts/preflight.mjs` needs no change | It already lists `check-toolchain-consistency`, so the local pre-push path picks the new relation up for free. |
| Existing exports keep their signatures | `check-toolchain-consistency.test.mjs` imports them; breaking one turns a real regression into an import error. |
| Findings stay POSIX-normalised | `posixLocation()` exists because a platform-native path made the suite go red "for a reason no developer caused". New findings must route through it. |
| The gate stays offline and deterministic | No network, no clock. Its stated boundary is *internal agreement*; "is there a newer version" is Renovate's job. |
