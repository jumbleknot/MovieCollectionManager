"""Organizer node: collection/movie writes (HITL-gated).

Implements: T041 (add path + create-if-missing), T050 (batch/update/remove + chunking
+ approval-time re-validation). Write allowlist: movie-mcp writes — always routed
through approval_gate, never autonomous.
"""

# TODO(T041/T050): plan writes, build Proposal(s) via proposals.py, hand to approval_gate.
