"""The classification prompt's cached prefix must be byte-stable, and reach both providers.

Implements: T009, T010 / FR-006, FR-022, FR-025. Research: specs/075-llm-cost-phase-1/ R1, R11.

── WHY ─────────────────────────────────────────────────────────────────────────────────────────

The supervisor prompt is ~2,650 tokens of intent taxonomy that never changes, plus one line of user
text that always does. Splitting it so the static part is a separately-cacheable block turns the
dominant line on the gateway's bill into a cache read.

That saving is a PREFIX MATCH, and prefix matches fail silently. One interpolated value anywhere in
the static block — a timestamp, a counter, a re-ordered rule — and the cache-read rate drops to
zero. No exception is raised. No test fails. The bill just goes back up, and the only evidence is a
number on a vendor dashboard that nobody is watching. These tests are the alternative to watching
that dashboard.

Two properties, both offline and both unskippable:

  * the static block is byte-identical across calls (T010) — catches an interpolation at merge time;
  * the built messages survive the OLLAMA adapter (T009) — because `classify_intent` is shared with
    the DEFAULT provider, and `cache_control` is an Anthropic concept.

T009 is not hypothetical. Under replay `build_chat_model` returns a `ReplayChatModel` and NEVER
constructs `ChatOllama`, so no other gate in this repository executes that adapter. The property it
checks would otherwise be asserted nowhere — and its likely breaker is a dependency bump, not an
edit to this feature, so nobody would be looking.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage

from src.nodes.supervisor import build_classify_messages


def _system_block(messages: list) -> dict:
    """The single content block of the system message the builder produced."""
    system = messages[0]
    assert system.type == "system", f"expected a system message first, got {system.type!r}"
    assert isinstance(system.content, list) and len(system.content) == 1, (
        "the static prefix must be ONE structured content block — a bare string cannot carry a "
        f"cache marker, and several blocks split the prefix. Got: {type(system.content)}"
    )
    return system.content[0]


def test_the_cached_prefix_is_byte_identical_across_calls():
    """FR-006 / SC-006: the static block must interpolate nothing.

    If this fails, the prefix is unstable and EVERY call is billed at full price while appearing to
    work. Read the diff below as "something per-call leaked into the static block", not as a flake.
    """
    first = _system_block(build_classify_messages("find the movie Dune"))["text"]
    second = _system_block(build_classify_messages("how many movies do I have"))["text"]

    assert first == second, (
        "PREFIX INSTABILITY: the supervisor's static block differs between two calls that should "
        "share it byte for byte. Something per-call (a timestamp, an id, an f-string hole, a "
        "re-ordered rule) has leaked into the cached prefix. Prompt caching is a PREFIX MATCH, so "
        "this silently drops the cache-read rate to zero — no error, no other failing test, just "
        "full price on every classification. Fix the interpolation; do not relax this assertion.\n"
        f"  first  call, last 200 chars: ...{first[-200:]!r}\n"
        f"  second call, last 200 chars: ...{second[-200:]!r}"
    )


def test_the_static_block_is_marked_cacheable_and_the_user_turn_is_not():
    """FR-005: the marker covers the prefix, and everything volatile sits after it."""
    messages = build_classify_messages("find the movie Dune")

    block = _system_block(messages)
    assert block.get("cache_control") == {"type": "ephemeral"}, (
        f"the static block carries no ephemeral cache marker: {block.get('cache_control')!r}. "
        "Without it the prefix is re-billed in full on every call."
    )
    assert block["type"] == "text"

    assert len(messages) == 2, f"expected [system, human], got {len(messages)} messages"
    human = messages[1]
    assert isinstance(human, HumanMessage)
    assert human.content == "find the movie Dune", (
        "the user's text must be the human turn, AFTER the marker — anything volatile placed "
        "before it invalidates the cached prefix on every call"
    )


def test_the_user_text_never_reaches_the_cached_block():
    """The failure mode with teeth: user text inside the prefix makes the cache useless per-user."""
    prefix = _system_block(build_classify_messages("Zardoz is a 1974 film"))["text"]
    assert "Zardoz" not in prefix, (
        "user text leaked into the CACHED block. Every distinct user message would then produce a "
        "distinct prefix, so nothing would ever hit the cache — the exact opposite of the point."
    )


def test_the_built_messages_survive_the_ollama_adapter():
    """FR-022 / FR-025: one message shape serves BOTH providers (research R1/R11).

    `classify_intent` is shared with Ollama — the DEFAULT provider — and `cache_control` is an
    Anthropic concept. `langchain_ollama` dispatches content parts on `type` and ignores every
    other key on a `text` part, so the marker is dropped and the instruction text survives.

    This runs offline: `ChatOllama` constructs without connecting, and the converter is pure. It is
    the ONLY automated check on that property, because replay substitutes a `ReplayChatModel` and
    never builds this adapter at all. Its likely breaker is a `langchain-ollama` upgrade tightening
    the `else: raise ValueError` arm to reject unknown keys — at which point the default provider
    stops working and nobody is editing this feature.

    Deliberately consumes the REAL builder rather than a hand-made fixture: a fixture asserts a
    shape that can drift away from the prompt it is meant to protect.
    """
    from langchain_ollama import ChatOllama

    model = ChatOllama(model="qwen2.5", base_url="http://127.0.0.1:1")  # never connects
    converted = model._convert_messages_to_ollama_messages(
        build_classify_messages("find the movie Dune")
    )

    assert [m["role"] for m in converted] == ["system", "user"]

    system_text = converted[0]["content"]
    assert "cache_control" not in system_text, (
        "`cache_control` leaked into the text Ollama receives. langchain-ollama used to drop "
        "unknown keys on a text part; if that changed, the single-shape design no longer holds "
        "for the default provider and classify_intent needs a provider branch."
    )
    # The converter accumulates with `content += f"\\n{text}"` from an empty string, so the rendered
    # system content carries a LEADING NEWLINE the single-string prompt did not. Expected, not
    # corruption — asserted so a future change to that behaviour is visible rather than surprising.
    assert system_text.startswith("\n")
    assert "You route a user's message" in system_text
    assert converted[1]["content"] == "find the movie Dune"
