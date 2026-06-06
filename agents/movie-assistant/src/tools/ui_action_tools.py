"""UI-action tools: return a client instruction (navigate/prefill); no MCP server involved.

Implements: T059 (navigate_*, prefill_*). Allowlisted + role-authorized at the BFF;
prefill of unsaved state is HITL-surfaced.
Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md.
"""

# TODO(T059): navigate_to_collection / navigate_to_movie / prefill_add_movie.
