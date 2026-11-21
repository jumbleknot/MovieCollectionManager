# Quickstart: validating feature 105

Run from a worktree of the feature branch in the dev container. Commands and expected results only;
contracts and the data model are in [contracts/](contracts/) and [data-model.md](data-model.md).

## Prerequisites

- Unit tiers: nothing beyond the dev container's Node.
- Integration tier: Docker available (the dev container's DinD path or the CI runner).
- Live validation: the `prod-dev-usage` stack deployed, the `dev-usage-capture` client in the production realm, and `MCM_USAGE_INGEST_URL` / `MCM_USAGE_TOKEN_URL` / `MCM_USAGE_CLIENT_SECRET` set in the container (runbook `docs/runbooks/dev-usage.md`).

## 1. Unit and guard tests (CI tier)

```bash
node --test scripts/__tests__/cc-usage-*.test.mjs
```

Expected: all pass, **0 skipped**. Covers parsing and de-duplication, labelling, privacy (no sentinel
string from the fixtures in any shipped batch), hook invariants (exit 0, empty stdout, interval skip),
the settings pin, concurrency (parallel hook runs equal one serial run), the rules.

## 2. Reference cross-check (SC-002)

```bash
node scripts/cc-usage.mjs oracle-check          # parser vs committed oracle, offline
pnpm nx cc-usage-oracle infrastructure-as-code  # on demand: regenerate the oracle with pinned ccusage
git diff --exit-code scripts/__tests__/fixtures/cc-usage/ccusage-oracle.json
```

Expected: `oracle-check` reports every fixture session matching on all four token types; regenerating
the oracle produces no diff.

## 3. Store contract (integration tier)

```bash
MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code
```

Expected: the stack comes up from `compose.yaml` with the CI Keycloak; the schema applies twice with no change; a Keycloak-issued token for `dev-usage-capture` is accepted and a token for any other client is refused; upserts are idempotent (re-posting a batch leaves row
counts unchanged); `DELETE` is refused; a request without a token is refused; views return the totals
of the posted rows. With `MCM_REQUIRE_LIVE_STACK=1`, a missing Docker fails the run instead of skipping.

## 4. Live capture (SC-001, SC-005, SC-009)

1. Start a new Claude Code session in a worktree of `main` after merge; do one short task; end it.
2. `node scripts/cc-usage.mjs doctor` → `configured: yes`, a last-ship time within the session, spool 0, no transcript with unshipped bytes.
3. Start two sessions at once in two worktrees; work in both; end both. `doctor` clean again; `usage sessions --since 1d` lists both once each.
4. Leave a session idle until the sandbox VM stops; start a new session later. That earlier session appears with status `partial [no-session-end]`, its turns present.
5. Check the transcript's `stop_hook_summary` lines: the `cc-usage.mjs hook` entries show `durationMs` < 1000 on non-shipping turns.
6. Survival (SC-009): note `features --since 30d` and the row counts from `sessions --since 30d --json`. Rebuild the dev container, then recreate the sandbox (`sbx rm` + create, per `docs/runbooks/devcontainer-sandbox.md`) and restore the env. After one new session, the counts for the older sessions are unchanged and `doctor` is clean.

## 5. In-session questions (SC-006)

In a session: invoke the `usage` skill and ask "how heavy is this session so far?" → a compact table
for **this** session in under 5 s. Unset `MCM_USAGE_INGEST_URL` in a test shell and run
`node scripts/cc-usage.mjs now --session <id>` → still answers; `sessions` prints the single
`store unreachable` line.

## 6. Attribution, features and dashboard (SC-007, SC-010, SC-011)

- `node scripts/cc-usage.mjs trend --by activity --since 2w` → unclassified ≤ 10% of weighted tokens.
- From the main checkout, run one session that works in two feature worktrees (one with a spec, one docs-only). Then `node scripts/cc-usage.mjs features --since 1d` lists both features — the docs-only one with `kind no-spec` and `tasks n/a` — plus a `no feature` row; the session's tokens are split between them.
- `node scripts/cc-usage.mjs feature spec:105` → contributing sessions, tokens by type and outcomes; the totals equal the sum of `sessions --feature <id>` attributed figures.
- The integration test asserts the conservation invariant: all features plus `no feature` equal all sessions, for every token type.
- Open the Grafana "Claude Code usage" dashboard on the tailnet → weekly trends by activity, feature, area and spec.

## 7. Findings (SC-008, after the two-week baseline)

`node scripts/cc-usage.mjs findings` → at least one finding with rule, evidence, sample size,
suggestion and watch metric (or `not enough data` per label below the minimum). `accept <id>`; after
more sessions, `findings --all` shows its before/after for both the watch metric and its counter-metric.
