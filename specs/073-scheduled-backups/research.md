# Phase 0 Research: Per-user scheduled collection backups

**Feature**: 073 | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

Every decision below was taken against the code as it exists on `main` at `93657cee`, not against
the backlog item's proposal. Where the two disagree, the disagreement is called out.

---

## R1 — Where the scheduler tick lives

**Decision**: The tick's *logic* lives in a BFF API route (`/bff-api/backups/tick`), guarded by a
shared secret. The tick's *clock* lives in `frontend/mcm-app/server.js`, which runs
`setInterval` and calls that route over loopback.

**Rationale**: `frontend/mcm-app/server.js` is a plain long-lived Express process — the one place in
this system where a timer can exist at all. But it is CommonJS *outside* the Metro bundle: it
`require`s `@expo/server/adapter/express` and hands `dist/server` to `createRequestHandler`. It
cannot import `src/bff-server/*`, because those modules only exist inside the Metro-built bundle.
So the clock and the work have to be separated, and a loopback call is the seam between them.

Measured: `grep -rn 'setInterval' src/` returns **nothing**. There is no existing background-work
mechanism in the BFF to extend — this feature introduces the first one, and that is a real
architectural addition, not a small one.

**Consequences, stated plainly**:

- In **Metro dev mode `server.js` never runs**, so no tick fires. This is a genuine dev/prod
  asymmetry and must be documented rather than discovered.
- That asymmetry is turned into an asset for testing: because the tick is an addressable route,
  **E2E drives time explicitly** instead of waiting on a wall clock. A scheduling test that sleeps
  is a flaky test, and this repository has paid for flaky E2E more than once.
- The route is **not** part of the public API surface. It requires a `BACKUP_TICK_SECRET` bearer
  compared in constant time, returns 404 (not 401) without it so it does not advertise itself, and
  is excluded at the reverse proxy.

**Alternatives considered**:

- *Module-level `setInterval` inside a bundled BFF module* — starts only when some request first
  imports that module, silently never runs if nothing does, and runs N times under N route bundles.
  Rejected: unobservable failure mode.
- *A separate cron container or Komodo-driven schedule* — more moving parts and a second deployment
  artifact for one timer. Kept as the documented escape hatch if `server.js` ever stops being a
  long-lived process, since the tick route is the same either way.

---

## R2 — Exactly-once across instances

**Decision**: Two independent mechanisms, both required.

1. **Redis leader lock** — `SET backup:tick:leader <instanceId> EX 60 NX` around the tick.
   `cache-service.ts`'s private `RedisLike` interface already declares
   `set(key, value, 'EX', n, 'NX')`; this feature exports a narrow `acquireLock`/`releaseLock` pair
   rather than exposing the raw client.
2. **Per-job atomic claim** — `findOneAndUpdate({ _id, nextRunAt: { $lte: now }, claimedAt: null },
   { $set: { claimedAt: now } })`. A job is claimed by whichever instance's update returns the
   document; everyone else gets `null` and does nothing.

**Rationale**: The lock is an optimisation — it stops N instances doing N pointless scans. The
atomic claim is the *correctness* guarantee, and it holds even if the lock is lost, expires mid-tick,
or Redis is briefly unavailable. Relying on the lock alone would make correctness depend on a TTL
guess.

**Load-bearing constraint discovered**: `mongo-client.ts` documents that the BFF's Mongo is a
**standalone instance, not a replica set** ("no replica set → no elections to wait through"). So
**multi-document transactions are not available in the BFF store**. Every state change in this
feature must therefore be expressible as a single-document atomic update. `findOneAndUpdate` on one
job document is; a transaction spanning job + run history is not. Run-history records are written as
independent documents, and the job document holds only the summary of its last run.

A claim must also expire: `claimedAt` older than a run-timeout ceiling is reclaimable, or an instance
killed mid-run wedges that job permanently.

---

## R3 — How an unattended run reads the user's data

**Decision**: Keycloak **`offline_access`** refresh token, obtained through an explicit consent
redirect, stored AES-256-GCM-encrypted, exchanged for a short-lived access token at run time, and
revoked at the identity provider when the last schedule is disabled.

**Rationale**: `createMcServiceClient(jwt)` is the seam that makes this clean — it takes a bearer
token and nothing else, so a scheduled run that holds a freshly minted user access token is
indistinguishable from that user's own request. mc-service's DAC enforcement, the auth chain, and
every existing authorization test stay exactly as they are. No new role, no new audience, no
service-account backdoor.

**What already exists and is reused unchanged**:

- `keycloak.ts` → `refreshTokens(refreshToken)` (line 141) mints the access token at run time.
- `keycloak.ts` → `revokeToken(token, 'refresh_token')` (line 190) performs the revocation FR-023
  requires.
- `agent-config-crypto.ts` → `encryptSecret`/`decryptSecret` with a context-binding AAD.

**What does not exist and must be built**: a consent flow. The constitution's client auth model
(v2.0.0) keeps tokens in HttpOnly cookies with a **tokenless** server-side session record — so the
BFF holds no refresh token it could reuse, and there is nothing to promote. Enabling a schedule is
therefore a **second, separate OIDC round trip** carrying `scope=openid offline_access`, whose
result is *stored* rather than turned into a session. That is the right shape anyway: FR-022 wants
explicit, informed consent, and a distinct trip through Keycloak's consent screen is exactly that.

The new redirect URI must be registered — `ensureClientRedirectUris()` in `auth/init+api.ts` already
does this for three URIs and takes a list; this adds a fourth.

**Alternatives rejected** (both named in the backlog item, both correctly): a service-account
on-behalf-of path is a permanent hole in DAC and the highest-value target in the system; standing
token-exchange impersonation rights are the same hole with more steps.

**Residual risk to state in the plan**: an offline token is long-lived by construction. Mitigations:
it is encrypted with an AAD binding it to `${userId}:offlineRefresh`; it is never returned to a
client; it is revoked on disable, on job deletion, and on account deletion; and FR-024 forbids any
fallback path when it is gone, so a revoked token fails the run rather than silently escalating.

---

## R4 — The SSRF guard is NOT reusable as-is

**Decision**: Build a **new, DNS-resolving** guard for backup destinations. Do not reuse
`validateOllamaUrl`.

**This contradicts the backlog item**, which says "Reuse the existing Ollama-base-URL guard". The
item is wrong on the facts, and the repository already says so in its own words.

`openwiki/gotchas/agent-config-ssrf-guard.md` states it outright:

> **The guard is a BFF-only, DNS-blind check — this is a documented residual risk, not an
> oversight.** It validates the literal host string; it does not resolve DNS, so a hostname that
> resolves to a link-local/metadata address at request time is not caught (DNS rebinding).

Reading `agent-config-ssrf.ts` confirms it: it regex-tests `URL.hostname`, de-mapping IPv4-mapped
IPv6 forms — good work, and genuinely load-bearing — but it never resolves anything. Spec FR-005
requires validation "against the resolved network address — not the hostname text", and an
acceptance scenario names DNS-rebinding-shaped hostnames explicitly. The existing guard cannot
satisfy that, and pointing this feature at it would ship a control that reads as present and is not.

**What the new guard does**:

1. Resolve the hostname to **all** A/AAAA addresses.
2. Reject if **any** resolved address falls in a blocked range.
3. **Pin the connection to a vetted address** via a custom `lookup` in the connection agent, so the
   address checked is the address connected to. Without pinning, resolve-then-connect is a TOCTOU
   window and the check is theatre.
4. Re-apply at every use, and keep `redirect: 'manual'` — both already proven in
   `agent-config-probes.ts`.

**Policy differs from Ollama's, deliberately.** BYO-Ollama *must* allow private and loopback
addresses — that is its whole purpose. Backups are different: the likely destinations are a NAS or a
self-hosted MinIO, which are private-range, but so are `mc-service`, `keycloak-service` and the
Mongo store. So this guard **denies private and loopback by default** and admits the user's own LAN
through an operator-configured allowlist (`BACKUP_ALLOWED_DESTINATION_HOSTS`), mirroring the shape
of `AGENT_OLLAMA_ALLOWED_HOSTS`.

**Note the "test connection" consequence**: a probe that distinguishes "unreachable" from
"credentials rejected" is, to a hostile user, an internal port scanner. Default-deny on private
ranges is what keeps that from mattering.

**Follow-up worth filing separately**: the Ollama guard's DNS-blindness remains, and the agent
gateway's Python `ChatOllama` fetch is unguarded entirely. Out of scope here; this feature must not
quietly inherit the gap.

---

## R5 — Destination drivers and their dependencies

**Decision**: One `BackupDestinationDriver` interface (`put` / `list` / `get` / `delete` /
`testConnection`), two implementations, **no heavyweight SDK**.

| Concern | Choice | Why |
| --- | --- | --- |
| S3-compatible | Hand-written AWS **SigV4** signer over `fetch`, using `node:crypto` | Only 4 operations are needed. `@aws-sdk/client-s3` pulls ~50 transitive packages into a repository that has already had its **entire CI board go red** over one transitive dependency (CLAUDE.md). SigV4 is a deterministic, fully specified algorithm, and it is integration-tested against a real MinIO. |
| WebDAV | Plain `PUT`/`GET`/`DELETE`/`PROPFIND` over `fetch`, Basic auth | WebDAV is just HTTP verbs. No client library earns its supply-chain cost. |
| PROPFIND XML | `fast-xml-parser` | Node has no XML parser and a regex over XML is the wrong answer. Single small dependency, used in exactly one place. |
| Schedule/DST arithmetic | **Luxon** | See R6. |

**This is the plan's most debatable decision and is flagged as such.** Hand-writing a request signer
is not free, and "don't roll your own crypto" is a good instinct — though note SigV4 is HMAC over a
canonical string, not a cryptographic construction being invented. The mitigating structure is that
both drivers sit behind one interface, so replacing the signer with the AWS SDK later is one file,
not a redesign. If the operator prefers the SDK, say so and the change is contained.

---

## R6 — Schedule and DST arithmetic

**Decision**: Add **Luxon**. Do not hand-roll.

**Rationale**: SC-006 demands next-run correctness across DST transitions in both directions and for
monthly dates absent from some months — 100%, unit-tested. That is precisely the arithmetic not to
write by hand. Node 24 ships full ICU, so `Intl` *could* carry it, but reconstructing "the next
03:00 local in `Europe/London`, given that 03:00 may not exist or may exist twice" on top of `Intl`
means writing the bug-prone part anyway with none of the test corpus behind it.

**Named traps the implementation must handle explicitly**, each one a unit test:

- **Spring forward** — the configured local time does not exist that day. Rule: run at the next
  valid instant after the gap.
- **Fall back** — the configured local time exists twice. Rule: run at the *first* occurrence, and
  `nextRunAt` must advance past the second so the job does not fire twice for one occurrence.
- **Monthly 29/30/31** — the date is absent in some months. Rule: clamp to the month's last day.
  Never skip a month; a skipped month is a silent backup gap.
- **No raw cron** (FR-016) — a malformed expression silently means "never", which is the worst
  possible failure mode for a backup.

---

## R7 — Artifact format and the size ceiling

**Decision**: One gzipped JSON document per run: `{ manifest, collections[] }`, written to
`<prefix>/<jobId>/<ISO-8601 timestamp>.json.gz`. Built whole in memory, bounded by a ceiling.

**Integrity**: `sha256` over the **uncompressed** JSON body, recorded in the manifest, which also
carries `formatVersion`, `createdAt`, and per-collection counts. Verifying the uncompressed bytes
means the check survives a change of compression settings and catches a corrupt decompression too.

**Format version**: an integer, checked on restore. FR-032 requires refusing an unrecognised
version rather than best-effort interpretation.

**Key layout**: timestamped keys under a per-job prefix make retention "sort the list, delete the
tail" (R8) and make FR-011's "distinguishable from other jobs' artifacts and unrelated files"
structural rather than a convention.

**The ceiling** (operator decision, already taken): default **25,000 movies** or **64 MiB
uncompressed**, whichever is hit first, via `BACKUP_MAX_MOVIES` / `BACKUP_MAX_UNCOMPRESSED_BYTES`.
Two units because either can be the binding constraint — many sparse movies, or few with large
metadata. Exceeding either fails the run with an explicit reason naming the ceiling and the measured
value, so the error tells the operator what to raise. `FileTooLargeError` in
`transient-file-store.ts` is the existing precedent for this shape.

**Why a ceiling and not streaming**: the BFF process *is* the application server. An unbounded
backup run does not degrade backups, it takes the whole app down. The ceiling converts that into a
loud, attributable failure. Streaming is the documented follow-up.

**No partial artifact** (FR-014): the object is uploaded only after it is fully built and hashed. A
run that dies mid-build has written nothing, so there is no partial object to mistake for a version.

---

## R8 — Retention

**Decision**: After a **successful** run only, `list` the job's prefix, sort by key (ISO-8601 sorts
lexicographically, which is why that key layout was chosen), and delete everything past the newest N.

Pruning runs **after** the new artifact is confirmed written, never before — so a prune can never be
the reason a user ends up with fewer versions than they asked for. A prune failure is recorded on the
run as a separate field and does not fail the run (FR-027); the next successful run retries it, which
falls out of listing-and-sorting rather than needing retry state.

---

## R9 — Restore

**Decision**: Validate, then write through the ordinary mc-service API as the user.

Order is load-bearing (FR-031): download → decompress → parse → check `formatVersion` → recompute
`sha256` and compare → **only then** create anything. Nothing is written until the artifact has
proven itself.

Writes use `createCollection` then `createMovie` per movie, through `createMcServiceClient(jwt)` with
the user's own token — so all domain validation, DAC and audit apply unchanged (FR-033). Restored
names are `<original name> (backup <timestamp>)`; collection-name uniqueness is per-name and
case-insensitive at the index level (`openwiki/gotchas/mongodb-indexes-and-uniqueness.md`), so the
timestamp suffix keeps a repeated restore of the same version legal.

**Cost acknowledged**: this is N+1 HTTP calls, one per movie. At the R7 ceiling that is up to 25,000
sequential calls. Movie creation is bounded concurrency (small, fixed) with a per-movie failure
recorded rather than aborting the whole restore. This is the second reason the ceiling exists.

**Partial restore** (FR-029 edge case): if a restore fails partway, the collections already created
stay — named with the backup timestamp, so they are identifiable — and the run is recorded as
partial with counts. The guarantee that matters is that **pre-existing collections were never
touched**, which holds regardless, because restore only ever creates.

---

## R10 — Encryption at rest, and the constitution question the spec deferred

**Decision**: Reuse `agent-config-crypto.ts` unchanged, with new AAD field names.

The requirements checklist flagged this as needing an answer: the constitution requires encryption
keys "managed separately from the data they protect, using a dedicated key management service", and
this feature was told to mirror an existing precedent. **The precedent already complies.**
`agent-config-crypto.ts` says so in its own header: the master key comes from **Vault in production**
and a gitignored env file in dev — a different custody path from the Mongo store holding the
ciphertext. Nothing needs improving, and this feature adds a second key
(`BACKUP_CREDENTIAL_ENC_KEY`) on the same footing rather than widening the blast radius of the
agent-config key.

The AAD mechanism carries over directly: `secretAad()` binds a blob to `${userId}:${field}`, so a
document mixup fails GCM authentication instead of decrypting. New fields:
`${userId}:backupDestinationSecret:${destinationId}` and `${userId}:offlineRefresh`. Including the
destination id matters — without it, two of one user's own destination secrets are interchangeable.

---

## R11 — Test infrastructure

**Decision**: Real dependencies in every tier; constitution §Test Type Integrity forbids anything
else, and the one sanctioned substitution (the agent golden tier) does not apply here.

- **S3**: a MinIO service in the dev Compose stack. `infrastructure-as-code/docker/minio/Dockerfile`
  already exists (features 069/070, built from source and running non-root) — reuse that image
  rather than adding a third-party pull.
- **WebDAV**: a new small container in the same stack.
- **E2E tiering is mandatory**: `openwiki/invariants/testing-tiers.md` requires every E2E test to
  carry a tier tag, and an **unclassified test fails rather than defaulting into the gate**. These
  are deterministic, non-model tests, so they are `@gate`.
- **Time is driven, never awaited**: the tick route (R1) is called directly with a controllable
  "now", so the scheduling E2E has no sleep in it.

---

## R12 — Rate limiting and backpressure

**Decision**: Reuse the `rate-limiter.ts` Redis pattern for "Back up now" (FR-012). One concurrent
run per user (FR-013) falls out of the R2 claim mechanism applied per user rather than per job — a
`backup:running:<userId>` Redis key with a TTL matched to the run-timeout ceiling.

---

## Open items carried into `tasks.md`

- The exact backoff for a destination that fails mid-run — retry within the run, or fail and rely on
  the next scheduled occurrence. Leaning to the latter: a backup is not urgent, and a retry storm
  against a user's own NAS is worse than a missed nightly.
- Whether the tick's interval (proposed: 60 s) should be configurable. It bounds worst-case lateness,
  and SC-005 allows 5 minutes, so 60 s has margin.
