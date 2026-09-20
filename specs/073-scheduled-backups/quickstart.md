# Quickstart: validating feature 073

**Feature**: 073 | **Plan**: [plan.md](./plan.md) | **Data model**: [data-model.md](./data-model.md)

How to prove this feature works. Scenarios map to the spec's Success Criteria; each states what
passing actually looks like, because "the command exited 0" is not evidence here.

---

## Before anything else — the instrument checks

This repository has lost more time to trusting an instrument than to real bugs. Four apply directly:

- **A skipped test reads as a pass.** Watch the SKIP COUNT, not just the failure count. Set
  `MCM_REQUIRE_LIVE_STACK=1` to turn a credential-driven skip into a failure.
- **`node --test <file> --test-name-pattern "x"` silently runs EVERYTHING** — everything after the
  script path becomes the script's own argv. Put node's flags **before** the path. This one turns a
  Verify RED into "all green" while filtering nothing.
- **A missing `.env.local` is not a missing capability.** If a tier reports "creds not set", run the
  generator before concluding this environment cannot run it.
- **From a worktree, any `pnpm nx` target needs a real install in that worktree** —
  `CI=true pnpm install --frozen-lockfile`, ~4 minutes. The `node_modules` symlink covers
  `node --test` and the gate scripts but not nx, which dies with `ERR_PNPM_UNSAFE_MODULES_DIR`
  naming the main checkout — a path error that is really a foreign-tree error.

---

## Prerequisites

```bash
# Bring up the dev stacks, including the two new test destinations
node scripts/gen-dev-env.mjs
docker compose --profile mcm -f infrastructure-as-code/docker/backups/compose.yaml up -d

# Required new environment (see .env.local)
#   BACKUP_CREDENTIAL_ENC_KEY        32 random bytes, base64 — NOT the agent-config key
#   BACKUP_TICK_SECRET               guards the internal tick route
#   BACKUP_ALLOWED_DESTINATION_HOSTS comma-separated; the guard denies private ranges by default,
#                                    so the test MinIO and WebDAV hosts must be listed here
#   BACKUP_MAX_MOVIES                default 25000
#   BACKUP_MAX_UNCOMPRESSED_BYTES    default 67108864
node scripts/gen-dev-secrets.mjs
```

**Do not set `ANTHROPIC_API_KEY`** in any environment here. The key is carried as
`MCM_ANTHROPIC_API_KEY` and mapped only at the point of use — setting the plain name makes Claude
Code silently bill per-token against a valid subscription (CLAUDE.md).

---

## Scenario 1 — Destination CRUD and probe (US1, SC-001)

```bash
pnpm nx test mcm-app --testPathPattern='backup-(destination|driver)'
pnpm nx test:integration mcm-app --testPathPattern='backup-driver'
```

**Passing looks like**: driver integration tests exercise a **real MinIO and a real WebDAV
container** — no HTTP mocking, no in-memory substitute (constitution §Test Type Integrity). If those
suites pass with the containers down, they are not integration tests and the result is worthless.

---

## Scenario 2 — The SSRF guard (SC-011)

```bash
pnpm nx test mcm-app --testPathPattern='backup-destination-url-guard'
```

**Passing looks like** — all four must be asserted, not assumed:

1. A literal `169.254.169.254` is rejected.
2. `http://[::ffff:169.254.169.254]/` is rejected — WHATWG `new URL()` canonicalizes this to the
   hex form `::ffff:a9fe:a9fe`, so a dotted-decimal regex never fires
   (`openwiki/gotchas/agent-config-ssrf-guard.md`).
3. **A hostname that RESOLVES to a blocked address is rejected.** This is the case the existing
   Ollama guard cannot catch — it is DNS-blind by documented design. If this test passes against a
   guard that never calls a resolver, the test is wrong, not the guard.
4. **The connection is pinned to the vetted address.** Resolve-then-connect without pinning is a
   TOCTOU window, and a guard with that window is theatre. Assert the address actually connected to.

---

## Scenario 3 — Back up now, and verify the artifact (US2, SC-002)

```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-runner'
```

**Passing looks like**: exactly one object at the destination; its manifest `sha256` recomputes to
the same value; its per-collection counts equal the live counts from mc-service. Compare against
**live data**, not against the same in-memory structure used to build the artifact — that proves
nothing.

Manual check:

```bash
mc alias set mcmtest http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc ls --recursive mcmtest/mcm-backups/
mc cat mcmtest/mcm-backups/<jobId>/<ts>.json.gz | gunzip | jq '.manifest'
```

---

## Scenario 4 — Size ceiling fails loudly (FR-015)

```bash
BACKUP_MAX_MOVIES=5 pnpm nx test:integration mcm-app --testPathPattern='backup-ceiling'
```

**Passing looks like**: the run fails with a reason naming **both the ceiling and the measured
value**, and **no object is written**. A truncated artifact that looks complete is the failure this
test exists to prevent — assert the object count at the destination is zero, not merely that the
call threw.

---

## Scenario 5 — Restore is faithful and non-destructive (US3, SC-002/SC-003/SC-004)

```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-restore'
```

**Passing looks like**, in this order:

1. Snapshot the full live state **before** restoring.
2. Restore; new collections appear named `<name> (backup <timestamp>)`.
3. Re-read live state and diff against step 1 — **zero differences** in pre-existing collections.
   This is SC-003 and it is the guarantee the whole feature rests on.
4. The restored copy matches movie count, every metadata field, and every external identifier.
5. Flip one byte inside the gzip and restore again: it is refused with **zero collections created**.
   Assert the count, not just the thrown error.
6. Set `formatVersion: 99` and restore: refused, nothing created.

---

## Scenario 6 — Schedule arithmetic, including DST (US4, SC-006)

```bash
pnpm nx test mcm-app --testPathPattern='backup-schedule'
```

**Passing looks like** — pure unit tests, no clock, no network:

- **Spring forward**: 02:30 daily in `Europe/London` on the day 02:30 does not exist → the next
  valid instant after the gap.
- **Fall back**: 01:30 daily on the day 01:30 happens twice → the **first** occurrence, and
  `nextRunAt` advances past the second. One occurrence, one run.
- **Monthly 31st** in a 30-day month → clamped to the last day. **Never a skipped month** — a
  skipped month is a silent backup gap.
- A zone the runtime does not recognise is rejected at save time.

---

## Scenario 7 — Unattended, exactly once (US4, SC-005)

Time is **driven, not awaited** — the tick route takes an explicit `now`, so this test has no sleep
in it. A scheduling test that sleeps is a flaky test.

```bash
# One tick, two concurrent callers simulating two BFF instances
curl -s -XPOST -H "Authorization: Bearer $BACKUP_TICK_SECRET" \
  "http://localhost:8081/bff-api/backups/tick?now=2026-09-21T03:00:00Z" &
curl -s -XPOST -H "Authorization: Bearer $BACKUP_TICK_SECRET" \
  "http://localhost:8081/bff-api/backups/tick?now=2026-09-21T03:00:00Z" &
wait
```

**Passing looks like**: the two responses sum to `claimed: 1`, not `claimed: 2`. One reports
`leader: false`, which is a normal outcome and not an error. Exactly one artifact exists afterwards.

Also assert **with no session present** — the run must succeed using only the stored standing
permission. Clear every cookie first, or the test proves nothing about unattended operation.

Without the secret:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -XPOST http://localhost:8081/bff-api/backups/tick
# expect 404 — not 401. The route must not advertise its own existence.
```

---

## Scenario 8 — Retention (US5, SC-007/SC-008)

```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-retention'
```

**Passing looks like**: `keepLast=3`, four successful runs → exactly 3 objects, and the one removed
is the **oldest**. Then force a failing run → **still 3 objects**. SC-008 is the one that matters: a
failed run must never be the reason a good version disappears.

---

## Scenario 9 — Consent and revocation (SC-012)

**Passing looks like**: after disabling the last schedule, the previously stored refresh token is
**rejected by Keycloak when used**. Verify by attempting to use it — observing a local `$unset` is
not evidence that anything was revoked. This is the failure mode the spec singles out: a silently
retained offline token.

---

## Scenario 10 — Isolation and audit hygiene (SC-009/SC-010)

```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-authz'
```

**Passing looks like**: user B receives **404, not 403**, for every one of user A's destinations,
jobs, versions and runs — a 403 confirms the resource exists.

For SC-009, capture all BFF output across the full flow and grep it:

```bash
docker compose logs bff-service > /tmp/bff-backups.log
grep -icE 'secretAccessKey|app-password|refresh_token|<a known test secret>' /tmp/bff-backups.log
# expect 0
```

The audit sink already strips every key containing `token` plus an explicit redact list — but assert
it for the new events rather than assuming inheritance.

---

## Scenario 11 — Web E2E (US1–US6)

```bash
pnpm nx e2e mcm-app-e2e --grep '@gate' --testPathPattern='backups'
```

**Passing looks like**: configure → test connection → back up now → restore, driven through the real
UI. Every new spec **must carry a tier tag**; an unclassified test fails rather than defaulting into
the gate (`openwiki/invariants/testing-tiers.md`). These are deterministic and non-model, so
`@gate`.

Note `--grep-invert` is accepted by Playwright 1.60 here and **silently does nothing** — do not use
it to split tiers. `E2E_TIER` in `playwright.config.ts` is the mechanism.

---

## Full gate before opening the PR

```bash
pnpm nx affected -t lint test build --skip-nx-cache
pnpm nx test:integration mcm-app
pnpm nx e2e mcm-app-e2e --grep '@gate'
```

Run the tiers **your diff touches**, derived from what changed — not the ones you remember. A tier
you did not think of is a tier that did not run.
