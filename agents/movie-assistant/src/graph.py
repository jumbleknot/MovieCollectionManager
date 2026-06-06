"""Orchestration-Layer: the stateful supervisor graph.

Implements: T020. Compiles supervisor -> curator/organizer -> approval_gate with a
PostgreSQL checkpointer (agent-db) and native AG-UI emission. `graph` is the
compiled entrypoint referenced by langgraph.json.
"""

# TODO(T020): assemble StateGraph(GraphState), wire nodes, compile with the
#   Postgres checkpointer, and expose `graph` for langgraph-api / AG-UI.
graph = None  # placeholder until T020
