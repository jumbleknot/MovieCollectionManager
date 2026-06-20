"""SC-004 / FR-016 token-leak scan (T031) — the automated quality-gate scan.

SC-004 requires "No user authentication token is ever found in conversation state, assistant
memory, traces, or logs — confirmed by an automated scan." This module is the static half of
that scan: an AST pass over the agent + MCP source that flags any `logging`/`print` call which
emits a **token-named variable** as a value (e.g. `logger.info(token)`, `f"...{subject_token}"`,
`print(resp.authorization)`). It catches a regression on ANY log site — exercised or not — which
a runtime-only check cannot.

It is paired (in `tests/unit/test_token_leak_scan.py`) with runtime sentinel checks that drive
the real token-handling paths and assert no token reaches the logs, and with the checkpoint
invariant (`state.forbid_token_fields` — no token-named field ever persisted).

Design notes:
- Only interpolated/passed **values** are inspected — string *literals* are ignored, so a log
  message that merely contains the word "token" (e.g. "token re-exchange failed: status=%s") is
  NOT a finding; only a logged token *variable* is.
- The token markers mirror `state._FORBIDDEN_KEY_MARKERS` (substring match) so the log scan and
  the state guard treat the same identifiers as sensitive.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

# Substrings that mark a logged identifier as a credential (mirrors state.forbid_token_fields).
TOKEN_MARKERS: tuple[str, ...] = (
    "token",
    "jwt",
    "authorization",
    "bearer",
    "secret",
    "password",
    "credential",
    # 018 US2: the per-user agent config + its decrypted provider/TMDB keys are secrets too.
    "api_key",
    "apikey",
    "agent_config",
)

# Calls that emit to logs / stdout: logger.<level>(...) / logging.<level>(...) / print(...).
_LOG_LEVELS = frozenset(
    {"debug", "info", "warning", "warn", "error", "exception", "critical", "log"}
)


@dataclass(frozen=True)
class LeakFinding:
    """A logging/print call that emits a token-named variable (SC-004 violation)."""

    file: str
    line: int
    call: str
    identifier: str


def _log_call_label(node: ast.Call) -> str | None:
    """A label for the emit sink (print / .<level>), or None when the call is not a log/print."""
    func = node.func
    if isinstance(func, ast.Name) and func.id == "print":
        return "print"
    if isinstance(func, ast.Attribute) and func.attr in _LOG_LEVELS:
        return f".{func.attr}()"
    return None


def _logged_identifiers(node: ast.Call) -> set[str]:
    """Lower-cased identifier names interpolated as VALUES into a log/print call.

    Collects `Name` ids and `Attribute` attrs from the args + keyword values (so both `token`
    and `obj.token` / f-string `{token}` are seen). String literals contribute nothing.
    """
    names: set[str] = set()
    for expr in [*node.args, *(kw.value for kw in node.keywords if kw.value is not None)]:
        for sub in ast.walk(expr):
            if isinstance(sub, ast.Name):
                names.add(sub.id.lower())
            elif isinstance(sub, ast.Attribute):
                names.add(sub.attr.lower())
    return names


def _is_sensitive(identifier: str) -> bool:
    return any(marker in identifier for marker in TOKEN_MARKERS)


def scan_source_text(text: str, *, filename: str = "<source>") -> list[LeakFinding]:
    """Scan one Python source string; return a finding per logged token-named variable."""
    findings: list[LeakFinding] = []
    tree = ast.parse(text, filename=filename)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        label = _log_call_label(node)
        if label is None:
            continue
        for identifier in sorted(_logged_identifiers(node)):
            if _is_sensitive(identifier):
                findings.append(LeakFinding(filename, node.lineno, label, identifier))
    return findings


def scan_paths(
    roots: Iterable[Path | str],
    *,
    skip_dir_parts: tuple[str, ...] = ("tests", "__pycache__", ".venv"),
    skip_filenames: tuple[str, ...] = ("token_leak_scan.py",),
) -> list[LeakFinding]:
    """Scan every `.py` under each root (skipping tests / the scanner itself) for token logging."""
    findings: list[LeakFinding] = []
    for root in roots:
        base = Path(root)
        if not base.exists():
            continue
        for py in sorted(base.rglob("*.py")):
            if any(part in skip_dir_parts for part in py.parts):
                continue
            if py.name in skip_filenames:
                continue
            findings.extend(scan_source_text(py.read_text(encoding="utf-8"), filename=str(py)))
    return findings
