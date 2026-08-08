# Contract — `scripts/backlog.mjs` command surface

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

This is the contract the skill, `speckit-taskstoissues`, and the operator consume. It is the *external*
interface of the feature; the forge-side contract it sits on is
[forge-endpoints.md](forge-endpoints.md).

Invocation: `node scripts/backlog.mjs <command> [flags]` (no Nx target — research D9/OQ-4).

## Global behaviour (applies to every command)

| Rule | Requirement |
| --- | --- |
| Output redaction | Every emitted line passes through `redactForPublication` + control-char stripping; the forge host is `<forge>` by construction (FR-007). Verified against the real remote URL during Phase 0: host **and port** collapse to `<forge>`, and the redactor is pattern-based, so it does not depend on any environment variable being set. |
| Raw payloads | Never printed. `--json` emits a curated subset of fields, never the API response body (FR-008 spirit; `ci-status.mjs` precedent). |
| Endpoint derivation | `{base, owner, repo}` from `git remote get-url origin` — scheme, host **and port** (research D1). No env-var-derived base, no literal. |
| Token selection | Writes require `MCM_FORGE_ISSUE_TOKEN`. Reads prefer it and fall back to `MCM_FORGE_TOKEN` (research D6). |
| Target repository | Every **write** asserts that the owner/repo it is about to address is the one derived from the working copy's origin, and refuses before issuing the call on any mismatch (FR-016). The write credential can reach items on other repositories by design (research D5), so this assertion — not the credential — is what keeps writes here. It is not a fan-out-only check. |
| Missing write token | Reads still work; the write is refused naming the missing variable and what is unavailable. Exit 3. Never blocks container startup (FR-005). |
| 401 / 403 | Message names the token used **and** the scope missing, and states that this is granular scope rather than expiry. No retry, no silent degrade (FR-006). Exit 4. |
| Unreachable forge | Reported as unreachable, distinct from an authorization failure, so the operator is not sent hunting a credential problem (spec Edge Cases). Exit 5. |
| Label / milestone names | Resolved against the repo's own lists before any use; an unknown name fails with the name quoted and valid values listed — because the API silently ignores unknown label filters (research D3). Exit 2. |
| Bodies and comments | From `--body-file <path>` or `-` (stdin) only. Never a `--body "text"` flag (FR-009). |
| Item numbers | Integer-validated before use. |
| Bulk operations | No command accepts a set of item numbers. One item per invocation, by design (spec Edge Cases). |

Exit codes: `0` success · `1` unexpected error · `2` usage/validation · `3` missing credential ·
`4` authorization · `5` transport.

## Commands

### `list [--state open|closed|all] [--label L …] [--milestone M] [--type T] [--q text] [--limit N] [--page N] [--json]`

Lists backlog items — **never pull requests** (`type=issues` always sent; omitting it returns 143 rows
where 1 is correct — research D2). Compact table: number, priority, type, state, title, milestone.

- Pages with `page`+`limit` together; `limit` ceiling is 50, default 30.
- The total comes from `x-total-count`, never from the row count. If the result is truncated, prints an
  explicit truncation line with the authoritative total (FR-008).
- `--q` is honoured server-side (measured). `--label` is validated locally first, then applied.

### `ready [--limit N] [--json]`

The single command behind "what can I work on next" (FR-011). Open, not bot-managed, not blocked by an
unresolved dependency, ordered by priority then number. Prints a warning line for any item where the
`status/blocked` label and the dependency graph disagree — the graph wins (see
[../data-model.md](../data-model.md), *Ready-work selection*).

### `show <n> [--json]`

One item, distilled: title, state, labels, milestone, author, blockers, blocked-items, body, comment
thread. Never the raw payload.

### `create --title T (--body-file F | -) [--label L …] [--milestone M] [--json]`

Creates an item and prints its number. Requires the write token. Title and every label/milestone name are
validated before the call. Before creating, checks for an existing **open** item with a closely matching
title and reports it instead of filing a duplicate (spec Edge Cases) — `--allow-duplicate` overrides.

### `update <n> [--state open|closed] [--title T] [--body-file F|-] [--add-label L …] [--remove-label L …] [--milestone M|none]`

The only mutation path for an existing item's own fields; closing is a state change on this command,
not a separate verb. When closing:

- The refusal for a blocked item is classified and surfaced distinctly, and the item is left open
  (FR-010). The classifier is written against the *observed* response, not a predicted one (research,
  open risk 2).
- If the item changed on the forge since it was read in this session, the divergence is surfaced rather
  than overwritten (spec Edge Cases).

### `comment <n> (--body-file F | -)`

Adds one comment. Body from file or stdin only.

### `dep <n> (--blocked-by <m> | --blocks <m>) [--remove]`

Adds or removes one dependency edge. Refuses an edge that would create a cycle. Both directions are
readable via `show`.

### `setup-labels [--dry-run]`

Creates any label of the taxonomy in [../data-model.md](../data-model.md) that the repository does not
already have (FR-012). **Idempotent**: an existing label is reported as present and left untouched — its
colour and description are never overwritten, because the operator may have adjusted them in the web UI.
`--dry-run` prints what would be created and writes nothing. Zero labels exist today (measured), so the
first run creates all eleven.

### `setup-milestone <name> [--description D]`

Creates the named milestone if it does not exist, and reports it if it does (FR-014). Idempotent, same
rule as above. The convention is the feature directory name (`NNN-slug`). This command exists because
`resolveNames` refuses an unknown milestone name — with zero milestones defined, every `--milestone`
value is unknown until something creates one, so `create --milestone` and the task fan-out are both
unusable without it.

### `validate-form`

Reports whether the repository's issue form parses, by reading the forge's own validator (FR-013).
Prints `valid` plus the validator's message. **Reads the default branch**, so it cannot pass from a
feature branch — that is a property of the forge, not a failure, and the command says so in its output
rather than leaving the reader to conclude the form is broken.

### `--help`

Carries the long-form detail deliberately kept out of the skill so the skill stays inside its token
budget (SC-009, NFR-002): full flag reference, exit codes, and the measured API quirks in one screen.

## Test seams (what `scripts/__tests__/backlog.test.mjs` drives)

Exported pure functions, no network, no token, deterministic — the same posture
`scripts/__tests__/ci-status.test.mjs` states in its header. Candidate exports:

| Export | Covers |
| --- | --- |
| `forgeEndpoint()` (exported from `ci-status.mjs` and reused) | remote shapes: http/https, with/without `.git`, with/without port, ssh form → correct base + owner/repo, and a clear error on an unparseable remote |
| `buildIssueQuery({state,labels,milestone,q,page,limit})` | `type=issues` always present; `page`+`limit` always paired; limit clamped to 50 |
| `readTotalCount(headers)` / `describeTruncation(total, rows)` | total from `x-total-count`, never row count; truncation line wording |
| `resolveNames(requested, available)` | unknown label/milestone name → error quoting the name and listing valid values |
| `describeScopeFailure(status, endpoint, tokenName)` | 401/403 → names token + scope + "granular scope, not expiry" |
| `describeMissingWriteToken()` | names `MCM_FORGE_ISSUE_TOKEN`, the remedy, and the read-only degradation |
| `assertWriteTargetsOriginRepo(target, origin)` | a mismatched owner or repo refuses before any call; the matching case passes through. The one test that stands between a deliberately far-reaching credential and someone else's tracker (FR-016) |
| `planMissingNames(desired, existing)` | idempotent setup: nothing to do when all exist, only the gap when some exist, everything on an empty repository; an existing entry is never queued for overwrite (FR-012, FR-014) |
| `describeFormValidation({valid, message})` | valid and invalid both reported; the default-branch caveat stated when the form is absent, so "not on the default branch yet" never reads as "the form is broken" (FR-013) |
| `classifyUpdateFailure(status, body)` | blocked-close distinguished from other 4xx (fixture captured live) |
| `selectReadyItems(items, blockersByNumber)` | bot-managed excluded, blocked excluded, label/graph disagreement warned, priority ordering |
| `readBodyFrom(pathOrStdin)` | file and stdin paths; refuses an absent file; enforces the size cap |
| every emit path | host literal never survives to stdout (a redaction assertion per command renderer) |
