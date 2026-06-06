"""Supervisor node: intent routing ONLY — calls no domain tools.

Implements: T017 (routing), T046 (add/enrich routing), T053 (organize routing),
T058 ("this"/current-target resolution + clarify on ambiguity).
"""

# TODO(T017): classify intent and route to curator / organizer / a UI-or-generative
#   tool / approval_gate. Never call MCP domain tools here.
