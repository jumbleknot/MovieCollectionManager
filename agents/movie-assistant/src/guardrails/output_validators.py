"""Structural output validation + PII/toxicity checks (Guardrails AI / Pydantic).

Implements: T019 (Python-layer guardrails). Applied to all user input and all
tool/MCP output before/after each agent step (prompt-injection defence).
"""

# TODO(T019): Pydantic schema validators + PII/toxicity guards.
