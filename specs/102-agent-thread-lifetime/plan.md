# Plan 102: Agent thread lifetime

**Spec**: [spec.md](./spec.md)

## Approach

### A. Token key (#973), `agents/movie-assistant`

- `src/agui_identity.py`: `SUBJECT_TOKEN_KEY = "__mcm_subject_token"`, with the reason in its comment.
  `inject_subject_identity` writes it, and `user_id` is unchanged. `FILE_HANDLE_KEY =
  "__mcm_file_handle"`, written by `inject_import_file`.
- `src/runtime_nodes.py`: `_subject_token` reads `SUBJECT_TOKEN_KEY`, and the import node reads
  `FILE_HANDLE_KEY`.
- Tests that build a `configurable` by hand switch to the constant.
- New `tests/unit/test_checkpoint_token_absence.py` (unit tier, so the gating `nx test` runs it) drives `build_graph` with a node that
  interrupts and a checkpointer through run and `Command(resume=…)`. Config comes from
  `inject_subject_identity` and the other `inject_*` helpers. It asserts the token is absent from the
  `repr` of the saver's storage, writes and blobs, and from every `CheckpointTuple.metadata`, and that
  the node saw the token both times.

### B. Bounded saver (#974), `agents/movie-assistant`

- New `src/checkpoint_retention.py`: `BoundedInMemorySaver(InMemorySaver)` with an injectable monotonic
  clock and an `OrderedDict[thread_id, last_write]`. `put` and `put_writes` touch, then sweep idle and
  over-cap threads, never the thread just written. `get_tuple` and `list` evict an expired thread
  lazily before answering. The async methods of `InMemorySaver` delegate to these sync ones (verified
  in 4.3.1), so overriding the sync methods covers both. `retained_thread_count()`.
  `bounded_checkpointer(env)` reads `AGENT_THREAD_RETENTION_SECONDS` / `AGENT_CHECKPOINT_MAX_THREADS`.
- `src/graph.py`: the default checkpointer becomes `bounded_checkpointer(os.environ)`.
- `src/observability.py`: `register_checkpoint_gauge(saver)`, an observable gauge
  `agent.checkpoint.threads`. `gateway.create_app` registers it for the built graph's checkpointer.
- `src/agui_identity.py` `prepare_stream`: when the input carries a resume (AG-UI `resume[]` or legacy
  `forwardedProps.command.resume`) and `agent_state.created_at is None`, return the two events
  `RUN_STARTED` and `SanitisedRunErrorEvent(code="conversation_expired")` and no stream.
- Tests: `tests/unit/test_checkpoint_retention.py` (idle eviction, cap/LRU, the written thread spared,
  lazy read eviction, env parsing, gauge through an `InMemoryMetricReader`), and a case in
  `tests/unit/test_agui_identity.py` for the expired resume driven through the real agent and graph.

### C. Owner claim (#975), `frontend/mcm-app`

- `src/config/env.ts`: `agentThreadRetentionSeconds` from `AGENT_THREAD_RETENTION_SECONDS` (default
  86400).
- `src/bff-server/cache-service.ts` `claimAgentThreadOwner`: one `EVAL` of a script that returns the
  owner after set-if-absent or refresh-if-owner. A non-string result → `AuthError` 503.
- `src/bff-server/agent-thread-owner.ts`: TTL = 2 × retention, and the comment states the invariant.
- Tests: `cache-service.test.ts` (the script call and its arguments, the nil → 503 case, the error →
  503 case) and `agent-thread-owner.test.ts` (the TTL is twice the retention). A Lua script
  under a mocked client proves only the call. So the script's own behaviour (claim, refresh on owner,
  no refresh for another user, B refused after A's use past the old TTL) is run against a real Redis
  with `EVAL` in `tests/integration`, if one is reachable, or with `redis-server` in a container.

## Rollback

Revert the merge. No schema or data change. The checkpointer is in-process, so a restart after the
revert returns to an unbounded `MemorySaver`. Redis keys keep their shape, and the only change is that
TTLs get longer.
