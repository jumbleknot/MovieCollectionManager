"""Structural output validation + PII / prompt-injection guards (T019).

Constitution §Prompt-injection defence requires guardrails on ALL user input and all
tool/MCP output, before/after each agent step. These validators are PURE (no LLM, no
network) so they are deterministic and unit-testable; the LLM-backed topic rails
(movie-domain confinement, FR-005) live in `rails.co` and are verified live in T060.

Three concerns:
- **PII** — detect/redact email, phone, and Luhn-valid credit-card numbers so PII in
  user input or untrusted external (tool/MCP) data never reaches logs, traces, or the
  model context.
- **Prompt injection** — heuristic detection of instruction-override patterns embedded
  in untrusted tool/MCP output (e.g. a movie overview from TMDB).
- **Structural** — validate tool/MCP output against a Pydantic schema; reject malformed
  shapes with a typed `StructuralValidationError`.

Call sites: `guard_user_input` at the conversation entry (supervisor) and
`guard_tool_output` at the MCP tool boundary (wired with the US1 tool transport, where
it is end-to-end testable — same split as T024/T027a).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pydantic import BaseModel, ValidationError


class GuardrailError(Exception):
    """Base class for guardrail failures (single catch point for callers)."""


class StructuralValidationError(GuardrailError):
    """Tool/MCP output did not match the expected Pydantic schema."""


# ── PII detection ────────────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# 13-16 digits with optional single space/dash separators (validated by Luhn below).
_CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?<![ -])")
# A run of digits with phone-ish separators; digit-count filtered to 10-15 below so
# years/runtimes/short ids and 16-digit cards are not mistaken for phone numbers.
_PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")

_PLACEHOLDERS = {
    "email": "[REDACTED_EMAIL]",
    "phone": "[REDACTED_PHONE]",
    "credit_card": "[REDACTED_CREDIT_CARD]",
}


@dataclass(frozen=True)
class PiiFinding:
    """A single PII match. `value` is the matched text — never log it."""

    kind: str
    value: str


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _digit_count(text: str) -> int:
    return sum(c.isdigit() for c in text)


def scan_for_pii(text: str) -> list[PiiFinding]:
    """Return PII findings in deterministic order: emails, credit cards, then phones.

    Phone candidates overlapping an email or credit-card span are dropped so a single
    span is reported once under its most specific kind.
    """
    findings: list[PiiFinding] = []
    claimed: list[tuple[int, int]] = []

    for m in _EMAIL_RE.finditer(text):
        findings.append(PiiFinding("email", m.group()))
        claimed.append(m.span())

    for m in _CARD_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group())
        if 13 <= len(digits) <= 16 and _luhn_ok(digits):
            findings.append(PiiFinding("credit_card", m.group().strip()))
            claimed.append(m.span())

    for m in _PHONE_RE.finditer(text):
        if any(m.start() < end and start < m.end() for start, end in claimed):
            continue  # overlaps an email/card span already reported
        if 10 <= _digit_count(m.group()) <= 15:
            findings.append(PiiFinding("phone", m.group().strip()))

    return findings


def redact_pii(text: str) -> str:
    """Replace every detected PII value with its typed placeholder."""
    redacted = text
    # Replace longest values first so a phone substring of a card can't double-redact.
    for finding in sorted(scan_for_pii(text), key=lambda f: len(f.value), reverse=True):
        redacted = redacted.replace(finding.value, _PLACEHOLDERS[finding.kind])
    return redacted


# ── Prompt-injection heuristics ──────────────────────────────────────────────

_INJECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("override-instructions", re.compile(r"ignore\s+(all\s+)?previous\s+instr", re.I)),
    ("disregard-instructions", re.compile(r"disregard\s+(your|all|the|previous)\s+instr", re.I)),
    ("role-reassignment", re.compile(r"you\s+are\s+now\b", re.I)),
    ("system-prompt-probe", re.compile(r"system\s+prompt", re.I)),
    ("system-directive", re.compile(r"(^|\n)\s*#*\s*system\s*:", re.I)),
    ("chat-control-token", re.compile(r"<\|?(im_start|im_end|system)\|?>", re.I)),
]


def detect_prompt_injection(text: str) -> list[str]:
    """Return the names of injection patterns found (empty list = clean)."""
    return [name for name, pattern in _INJECTION_PATTERNS if pattern.search(text)]


# ── Structural validation ────────────────────────────────────────────────────

def validate_structure[ModelT: BaseModel](data: object, model: type[ModelT]) -> ModelT:
    """Validate `data` against `model`; raise StructuralValidationError if malformed."""
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise StructuralValidationError(str(exc)) from exc


# ── Composed guards (the call-site API) ──────────────────────────────────────

@dataclass
class GuardResult:
    """Outcome of a guard pass: sanitized text + what was found."""

    text: str
    pii: list[PiiFinding] = field(default_factory=list)
    injection: list[str] = field(default_factory=list)


def guard_user_input(text: str) -> GuardResult:
    """Guard a user message: redact PII and flag any injection patterns."""
    return GuardResult(
        text=redact_pii(text),
        pii=scan_for_pii(text),
        injection=detect_prompt_injection(text),
    )


def guard_tool_output(text: str) -> GuardResult:
    """Guard untrusted tool/MCP output: redact PII and flag injection in external data."""
    return GuardResult(
        text=redact_pii(text),
        pii=scan_for_pii(text),
        injection=detect_prompt_injection(text),
    )
