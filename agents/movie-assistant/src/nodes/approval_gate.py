"""HITL approval gate.

Implements: T042. On a write, interrupt() the graph, emit an AG-UI approval-request
carrying the proposal preview, and checkpoint to agent-db. The paused run holds NO
token. Resume (T044) re-validates and applies via movie-mcp with idempotency keys.
"""

# TODO(T042): interrupt + AG-UI approval-request; resume path applies/discards.
