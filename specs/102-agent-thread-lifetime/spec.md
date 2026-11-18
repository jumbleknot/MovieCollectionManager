# Spec 102: Agent thread lifetime — token out of checkpoints, bounded retention, owner claim outlives the checkpoint

**Input**: backlog items #973, #974, #975 (all found 2026-11-08 during the spec 097 thread-owner analysis)
**Status**: Draft

## Why one spec

The three items describe one object, a conversation thread, held in two stores with unrelated lifetimes:

- the gateway's LangGraph checkpoint (`MemorySaver`, in-process, kept until restart), and
- the BFF's owner claim (`agent-thread-owner:<threadId>`, Redis `SET NX EX`, 24 h from FIRST use).

Item #973 is what the checkpoint holds (the bearer token), #974 is how long it holds it (for ever), and
#975 is who may read it once the claim lapses (anyone holding the id). Fixing them separately would fix
each store against a lifetime that the other is about to change.

## Problem

1. **#973.** `agui_identity.inject_subject_identity` puts the bearer token in
   `config["configurable"]["subject_token"]`. LangGraph 1.2.19 `get_checkpoint_metadata` copies every
   `str`/`int`/`float`/`bool` value of `configurable` into checkpoint metadata unless the key is in
   `EXCLUDED_METADATA_KEYS` or starts with `__`. So every checkpoint of every thread carries the raw token.
2. **#974.** `MemorySaver` never evicts. Resident memory grows with total usage since the last restart.
3. **#975.** The claim expires 24 h after the thread's first use, is never refreshed, and outlives
   nothing in particular. After it lapses, anyone presenting the thread id claims it and reads the
   previous owner's checkpoint. The race fallback `owner ?? userId` treats a vanished owner as the caller.

## User stories

### US1 — The bearer token is never checkpointed (#973, P1)

**Acceptance**

- **US1-AC1**: A run started with a subject token, driven through the real compiled graph and its
  checkpointer, then HITL-resumed, leaves the token in no checkpoint, metadata, channel value or
  pending write.
- **US1-AC2**: The token still reaches the tool nodes on run and on HITL resume. The existing exchange
  and identity-bridge tests stay green.

### US2 — Checkpoint retention is bounded and observable (#974, P2)

**Acceptance**

- **US2-AC1**: A thread idle (no checkpoint write) for longer than the retention window is evicted, and
  its checkpoints, writes and blobs are gone.
- **US2-AC2**: When more threads than the cap are retained, the least recently written are evicted
  first, and the thread being written is never the one evicted.
- **US2-AC3**: A HITL resume of a thread with no checkpoint (evicted, or lost to a gateway restart)
  ends with a terminal `RUN_ERROR` whose `code` is `conversation_expired`. It is not a 500, and the
  graph does not run as a silent fresh thread.
- **US2-AC4**: The gateway exports the retained thread count as an OpenTelemetry gauge.

### US3 — A thread's owner claim outlives its checkpoint (#975, P2)

**Acceptance**

- **US3-AC1**: Every authorized use refreshes the claim. A thread in active use past the old 24 h TTL
  keeps its owner.
- **US3-AC2**: The claim's TTL is twice the checkpoint retention window, so for as long as a checkpoint
  exists its claim exists.
- **US3-AC3**: Claim and refresh are one atomic Redis step. No path treats a missing owner as the
  caller. An inconclusive answer is refused with a retryable 503.
- **US3-AC4**: User A owns a thread, A's claim lapses, and user B presenting the id is refused, or gets
  an expired conversation holding none of A's state.

## Functional requirements

- **FR-001** (US1): The subject token rides in `configurable["__mcm_subject_token"]` and the import
  file handle in `configurable["__mcm_file_handle"]`, never under a key without the `__` prefix. The
  constants and the reason live where they are injected.
- **FR-002** (US2): The gateway's default checkpointer is a bounded in-memory saver with an idle
  window of `AGENT_THREAD_RETENTION_SECONDS` (default 86400, the session's absolute window) and a cap of
  `AGENT_CHECKPOINT_MAX_THREADS` threads (default 1000). Expiry is checked on every write and every
  read, so an expired thread is never served even if no write has swept it.
- **FR-003** (US2): A resume request against a thread with no checkpoint is answered with
  `RUN_STARTED` then a sanitised `RUN_ERROR` (`code="conversation_expired"`, fixed message).
- **FR-004** (US2): An observable gauge `agent.checkpoint.threads` reports the retained thread count.
  Eviction logs counts and reason only.
- **FR-005** (US3): `claimAgentThreadOwner` is one Lua script: set the claim if absent, refresh its TTL
  if the caller owns it, and return the owner. A nil result is refused with 503.
- **FR-006** (US3): The claim's TTL is 2 × `AGENT_THREAD_RETENTION_SECONDS`. The BFF reads the same
  variable name and default as the gateway.

## Decisions recorded

- **`__` prefix, not a scrub (#973).** A scrub after the write is exactly what the item rejects: it
  races the write, and a durable saver would already have persisted the row. `__`-prefixed keys are
  excluded inside `get_checkpoint_metadata` before anything is stored. Measured on LangGraph 1.2.19:
  the key still reaches nodes on run and on `Command(resume=…)`, and 0 of 4 checkpoints held it.
- **`user_id` stays in metadata (#973 criterion 4).** It is the Keycloak `sub`, an opaque identifier
  and not a credential. It already rides in LangFuse traces as the user, and it is the field that ties a
  checkpoint to its owner for any future audit. `ui_snapshot` and `agent_config` are dicts, so
  `get_checkpoint_metadata` never copies them. The test asserts this rather than assuming it.
  `file_handle` IS a string, and it is a bearer capability: an unguessable `import:file:<handle>` key
  that anyone holding it can read for 15 minutes (`transient-file-store.ts`). It is single-use, but
  until the import parses it, a checkpoint would hold a live handle. So it moves under `__` with the
  token. `filename` stays. It is a display name, not a capability.
- **Idle window, not age from creation (#974).** A conversation in active use must not expire
  mid-turn. The cap bounds the total even when every thread stays active.
- **The claim outlives the checkpoint, rather than the checkpoint being removed when the claim
  expires (#975 criterion 1).** The gateway cannot see Redis and the BFF cannot see the checkpointer,
  so "remove on expiry" would need a new cross-service call. Both sides slide on use. The claim is
  refreshed BEFORE each run, and the checkpoint is written DURING it. So the claim outlives the
  checkpoint whenever its TTL exceeds the retention window by more than the run's duration. A gateway
  restart only shortens the checkpoint's life, so the claim still outlives it.
- **The margin is a whole retention window (claim TTL = 2 × retention).** No run duration is bounded
  anywhere today: the BFF proxies the gateway stream without a timeout, and the gateway has none. So
  the margin has to be one that no run reaches. A run longer than the whole retention window (24 h by
  default) is far outside that. The cost is one small Redis key per thread kept a day longer.
- **Count cap, not bytes.** Byte accounting would mean serialising every checkpoint twice. The count
  plus the idle window bounds memory to cap × per-thread size, and the gauge makes growth visible.

## Success criteria

- **SC-001**: Each acceptance scenario has a test seen failing before its change and passing after.
- **SC-002**: `nx lint` and `nx test` pass for `movie-assistant` and `mcm-app`.

## Out of scope

- A durable checkpointer (Postgres/Redis saver). FR-001 is what makes that safe later.
- The client rendering a dedicated "conversation expired" view. The typed `RUN_ERROR` reaches it, and
  the existing error surface shows it.
- Item #970 (session-end proposal sweep).
