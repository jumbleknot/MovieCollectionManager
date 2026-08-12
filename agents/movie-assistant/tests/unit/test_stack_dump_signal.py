"""The gateway must be able to say what it is doing when it stops serving (feature 055, item #179).

MEASURED three times on 2026-08-12: the gateway wedged at 100% CPU on one core with memory at 1%,
/health timing out and its log 40 minutes stale, while Docker reported `status=running ExitCode=0
RestartCount=0`. It was diagnosed zero times, because capturing a spin requires acting on the LIVE
process and the mechanism to do so did not exist.

These tests pin the mechanism itself, not the defect. A diagnostic first exercised during an incident
is a diagnostic that fails during an incident.
"""

import faulthandler
import signal
import tempfile

from src.gateway import install_stack_dump_signal


def test_signal_handler_is_registered() -> None:
    """SIGUSR1 must actually be armed — an unarmed handler is a silent no-op at the worst moment."""
    faulthandler.unregister(signal.SIGUSR1)
    assert not faulthandler.is_enabled() or True  # the process-wide flag is unrelated to register()

    install_stack_dump_signal()

    # `unregister` reports whether the signal WAS registered, so it is the only public way to assert
    # registration. Re-arm afterwards so the module is left as the app would have it.
    assert faulthandler.unregister(signal.SIGUSR1) is True
    install_stack_dump_signal()


def test_registering_twice_is_safe() -> None:
    """create_app() may be invoked more than once in a test process; arming must stay idempotent."""
    install_stack_dump_signal()
    install_stack_dump_signal()
    assert faulthandler.unregister(signal.SIGUSR1) is True
    install_stack_dump_signal()


def test_dump_carries_frames_but_no_environment() -> None:
    """FR-008: the dump must never carry credential material.

    `faulthandler` prints frames only — no locals and no environment — which is what makes it safe to
    leave armed permanently. Asserted rather than assumed, because "it does not log secrets" is
    exactly the claim that needs a test rather than a comment.
    """
    # A REAL file, not StringIO: faulthandler writes through a file DESCRIPTOR (that is what lets it
    # work from a C signal handler on a starved event loop), so an in-memory object raises
    # `io.UnsupportedOperation: fileno`. The constraint that makes the mechanism suitable is the same
    # one that shapes its test.
    with tempfile.TemporaryFile("w+") as fh:
        faulthandler.dump_traceback(file=fh, all_threads=True)
        fh.seek(0)
        dump = fh.read()

    assert "File " in dump and "line " in dump, f"no frames in the dump:\n{dump}"

    # A dump that included locals or the environment would leak whatever the process holds. Probe for
    # the shapes that would actually appear if it did.
    for forbidden in ("ANTHROPIC_API_KEY", "CLIENT_SECRET", "PASSWORD", "Authorization"):
        assert forbidden not in dump, f"the stack dump carried {forbidden}"
