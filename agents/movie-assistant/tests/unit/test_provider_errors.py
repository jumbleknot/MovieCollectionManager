"""Provider-error description and the single ERROR record (065 US1, FR-001 … FR-004).

Item #325: an out-of-credit provider 400 was swallowed with ZERO log lines naming it. These
assertions pin the two facts an engineer needs — the HTTP status and the provider's error `type` —
against the REAL SDK exception shapes, not stand-ins. A stand-in would let the extraction be written
against an attribute the provider does not actually expose.
"""

import logging

import anthropic
import httpx
import pytest

from src.provider_errors import describe_provider_error, log_provider_error

CREDIT_MESSAGE = "Your credit balance is too low to access the Anthropic API."


def _provider_error(cls, status: int, error_type: str, message: str = CREDIT_MESSAGE):
    """Build a genuine `anthropic` error the way the SDK does, from a real httpx response."""
    body = {"type": "error", "error": {"type": error_type, "message": message}}
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(message, response=httpx.Response(status, request=request, json=body), body=body)


# --- T001 / T003: the three shapes are distinguishable ------------------------------------------


def test_credit_exhausted_400_yields_status_and_type():
    """The exact shape measured on 2026-08-31 (app-e2e run 2450)."""
    described = describe_provider_error(
        _provider_error(anthropic.BadRequestError, 400, "invalid_request_error")
    )
    assert described.status == 400
    assert described.type == "invalid_request_error"
    assert described.kind == "provider_http"


@pytest.mark.parametrize(
    ("cls", "status", "error_type"),
    [
        (anthropic.BadRequestError, 400, "invalid_request_error"),
        (anthropic.RateLimitError, 429, "rate_limit_error"),
        (anthropic.InternalServerError, 529, "overloaded_error"),
    ],
)
def test_each_provider_shape_reports_its_own_status_and_type(cls, status, error_type):
    described = describe_provider_error(_provider_error(cls, status, error_type, "boom"))
    assert (described.status, described.type) == (status, error_type)


def test_the_three_shapes_differ_in_both_fields():
    """SC-001 'distinguishable' means BOTH fields differ — the remedies are opposite.

    400 is operator action (top the account up); 429/529 are retries. A test asserting only that
    each returns *something* would pass while every shape reported identically.
    """
    described = [
        describe_provider_error(_provider_error(cls, status, error_type, "boom"))
        for cls, status, error_type in (
            (anthropic.BadRequestError, 400, "invalid_request_error"),
            (anthropic.RateLimitError, 429, "rate_limit_error"),
            (anthropic.InternalServerError, 529, "overloaded_error"),
        )
    ]
    assert len({d.status for d in described}) == 3
    assert len({d.type for d in described}) == 3


# --- T004: no fabricated status ------------------------------------------------------------------


def test_a_bug_in_our_own_code_is_not_reported_as_a_provider_status():
    """FR-003. A fabricated status would send an engineer to the provider's status page for a
    defect in this repository."""
    described = describe_provider_error(ValueError("a bug of ours"))
    assert described.status is None
    assert described.type is None
    assert described.kind == "unexpected"


def test_a_provider_error_with_no_usable_body_still_reports_its_status():
    """A truncated/HTML error body must degrade to 'status known, type unknown' — never raise.
    The error path is the worst possible place for a second exception."""
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = anthropic.BadRequestError(
        "gateway error",
        response=httpx.Response(400, request=request, text="<html>502</html>"),
        body=None,
    )
    described = describe_provider_error(exc)
    assert described.status == 400
    assert described.type is None
    assert described.kind == "provider_http"


# --- T005: exactly one ERROR record, and it leaks nothing -----------------------------------------


def test_log_provider_error_emits_exactly_one_error_record_naming_status_type_and_frame(caplog):
    """FR-001/FR-002. The frame is what tells the classifier's swallow apart from the stream's."""
    exc = _provider_error(anthropic.BadRequestError, 400, "invalid_request_error")
    logger = logging.getLogger("test.provider_errors")
    with caplog.at_level(logging.ERROR, logger="test.provider_errors"):
        log_provider_error(logger, exc, frame="classifier")

    records = [r for r in caplog.records if r.name == "test.provider_errors"]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.ERROR
    message = record.getMessage()
    assert "400" in message
    assert "invalid_request_error" in message
    assert "classifier" in message
    assert "BadRequestError" in message


def test_the_record_carries_no_user_text_and_no_request_body(caplog):
    """FR-004 / the never-log list. A provider echoes request content in some error messages, and
    the error path has no exemption from the logging invariants."""
    body = {
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": "request rejected: add Nosferatu to my Horror collection",
        },
    }
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = anthropic.BadRequestError(
        "request rejected: add Nosferatu to my Horror collection",
        response=httpx.Response(400, request=request, json=body),
        body=body,
    )
    logger = logging.getLogger("test.provider_errors.leak")
    with caplog.at_level(logging.ERROR, logger="test.provider_errors.leak"):
        log_provider_error(logger, exc, frame="stream")

    message = " ".join(r.getMessage() for r in caplog.records)
    assert "Nosferatu" not in message
    assert "Horror" not in message
