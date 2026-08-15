"""Orchestration-Layer: the stateful supervisor graph.

Implements: T020 (compile + AG-UI), T046 (US1 add-flow wiring). Wires
supervisor → conditional → curator → organizer → approval_gate (HITL) and compiles with a
checkpointer. Served over AG-UI by src/gateway.py.

The graph STRUCTURE always includes the full add flow, but the curator/organizer/
approval_gate nodes are INJECTABLE: the defaults are tool-free responders (no candidate /
no proposal → the conditional routers fall through to END), so `build_graph()` with no args
keeps the pre-US1 behavior and the existing E2E regression stays green (SC-005). Real nodes
(built with MCP-backed tool closures) are injected by tests now, and by the gateway once the
agent layer is deployed — then the add flow (enrich → propose → interrupt → resume → apply)
activates. The subject token reaches the real nodes via `config["configurable"]` (task-safe),
never via checkpointed state (SC-004).

`build_graph(...)` keeps importing LLM-free: the default classifier is invoked only at runtime.
"""

import os
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.kill_switch import assistant_disabled
from src.nodes.import_disambiguation import is_cancel_import
from src.nodes.organizer import is_organize_cancel
from src.nodes.search import is_search_cancel
from src.nodes.supervisor import (
    resolve_option,
    route_after_approval,
    route_after_curator,
    route_after_organizer,
    route_for_intent,
)
from src.proposals import EnrichedMovieCandidate, Proposal


class GraphState(MessagesState):
    """Conversation messages + the working state for the active turn (US1).

    No token field — the subject token is an ephemeral run value passed via
    `config["configurable"]`, never checkpointed here (`state.forbid_token_fields`).
    """

    intent: str
    candidate: EnrichedMovieCandidate | None
    match_confidence: str
    target_collection_name: str
    pending_proposal: Proposal | None
    status: str
    options: list[dict[str, Any]]
    apply_result: Any
    # Multi-turn add lifecycle (T069/R14; 040 US4 adds "awaiting_ownership"; 047 US4 adds the
    # three follow-up stages; 059 US2 adds "awaiting_childrens" AT THE FRONT): "" |
    # "awaiting_pick" | "awaiting_collection" | "awaiting_childrens" | "awaiting_ownership" |
    # "awaiting_media" | "awaiting_ripped" | "awaiting_rip_quality".
    add_stage: str
    # 040 US4: the resolved add target (serialized CollectionRef), persisted across the ownership
    # Yes/No turn so a bare "yes"/"no" reply doesn't re-resolve to the wrong collection.
    add_target: dict[str, Any] | None
    # 047 US4: the ownership follow-up answers, collected BEFORE the write proposal is built so
    # the member confirms one complete change rather than an add followed by an edit. Plain
    # display values — no token, no PII (SC-004). All four are cleared by _ADD_STATE_RESET.
    add_owned_media: list[str]
    add_ripped: bool | None
    add_rip_quality: list[str]
    # 059 US2: the member's answer to "Is this a children's movie?", held across the rest of the
    # chain until the proposal is built. None until answered. Cleared by _ADD_STATE_RESET with
    # everything else, so a concluded or abandoned add cannot leak the answer into the next one.
    add_childrens: bool | None
    # The option values the CURRENT multi-select offered, so a typed reply (FR-036) resolves
    # against the same set the buttons showed rather than against a list the agent invented.
    add_multi_pending: list[str]
    # The disambiguation option the supervisor resolved this turn, handed to the curator so
    # it fetches details for the chosen sourceId instead of re-searching (ephemeral; cleared
    # once consumed). Carries no credential — SC-004 (`state.forbid_token_fields`).
    resolved_pick: dict[str, Any] | None
    # Remaining organize batches awaiting sequential approval (US2/FR-009b); each is a Proposal.
    pending_batches: list[Proposal]
    # Sanitized readable UI-state snapshot for context-aware "this" resolution (US3/R15):
    # {current_screen, collection_id, movie_id, active_filter_keys, nav_depth}. Non-secret,
    # structural only; the runtime organizer overwrites it from config["configurable"] each run
    # (carried via the BFF→gateway header bridge, never the run body).
    ui_snapshot: dict[str, Any] | None
    # Multi-turn SEARCH workflow (013 US7): "" | "awaiting_scope" | "awaiting_collection" |
    # "awaiting_pick". `search_scope` is a collection id or "web"; `search_query` is the title
    # carried across button-tap turns; `search_results` are the candidates awaiting a pick.
    # Pure-conversation state — nothing here carries a credential (SC-004).
    search_stage: str
    search_scope: str
    search_query: str
    search_results: list[dict[str, Any]]
    # Multi-turn ORGANIZE disambiguation (013 Inc5 new-bug-1): when a partial title matches several
    # owned movies, `organize_stage="awaiting_pick"` holds the candidates (`organize_options`) +
    # the pending operation (`organize_pending`) until the user taps one. Pure-conversation state.
    organize_stage: str
    organize_pending: dict[str, Any] | None
    organize_options: list[dict[str, Any]]
    # Multi-turn IMPORT disambiguation (014 US4): when a tab→collection / column / article can't be
    # confidently resolved, `import_stage="awaiting_import_choice"` holds the pending prompt
    # (`import_prompt`), the accumulated picks (`import_resolutions`), and the parsed context
    # (`import_context`: parsed tabs + collections snapshot) so a button-tap turn resolves the pick
    # in pure code WITHOUT re-parsing the single-use file handle. Carries movie data, not file
    # bytes or any credential (SC-004 / no file bytes in checkpoint).
    import_stage: str
    import_prompt: dict[str, Any] | None
    import_resolutions: dict[str, Any]
    # The parsed spreadsheet ({tabs, collections}) is stashed in the spreadsheet-mcp transient store
    # and only its small opaque handle is checkpointed here (040 US2 T024) — so a many-row import's
    # clarification turns don't re-serialize the whole dataset into state (the checkpoint-bloat /
    # "it timed out" cause). `import_context` is the legacy inline fallback (used only when a stash
    # call fails, so the import never regresses to a silent stop).
    import_handle: str
    import_context: dict[str, Any] | None
    # 047 US2. `import_unresolved_replies` counts CONSECUTIVE replies that resolved nothing for
    # the CURRENT prompt; at 2 the re-ask gains a "Cancel import" control (FR-009/FR-010) so the
    # member is never trapped in a question they cannot answer. Reset to 0 whenever a pick
    # resolves or the prompt changes. `import_decisions_remaining` is how many distinct decisions
    # are still outstanding, rendered into the question text (FR-008) — derived, but checkpointed
    # so a resumed turn does not recount. Both are small ints; neither carries user data.
    import_unresolved_replies: int
    import_decisions_remaining: int
    # Multi-turn NAVIGATE disambiguation (040 US1 / Item 4a): when "navigate to <collection>" is
    # ambiguous or has no single match, `navigate_stage="awaiting_collection"` holds the offered
    # collections (`navigate_options`) so a button-tap turn stays in the navigator and OPENS the
    # chosen collection — instead of the tap re-classifying as a movie search. Pure-conversation
    # state, no credential (SC-004). Mirrors search_stage/organize_stage/import_stage.
    navigate_stage: str
    navigate_options: list[dict[str, Any]]
    # 047 US3 (FR-014a/FR-016a). Counters only — no payloads — so the checkpoint stays small
    # while still holding enough to (a) render the in-place progress line and (b) report an
    # interrupted run on the next turn.
    #
    # These MUST be declared here: a key written by a node but absent from GraphState is dropped
    # silently, never reaches the AG-UI state snapshot, and the progress line simply never
    # appears — with no error anywhere. Measured in RQ-2; see research.md#rq-2-evidence.
    import_total: int
    import_applied: int
    import_run_id: str
    # "running" | "waiting" (FR-019b) — a throttled window is reported, not silently stalled.
    import_state: str


# Fields cleared when an add concludes (approve/reject/decline) so a finished add never leaks
# into the next turn (T069/R14, RC4). `intent` is recomputed by the supervisor each turn.
_ADD_STATE_RESET: dict[str, Any] = {
    "add_stage": "",
    "add_target": None,
    "options": [],
    "resolved_pick": None,
    "candidate": None,
    "match_confidence": "",
    "pending_batches": [],
    # 047 US4: the ownership follow-up answers. Cleared with the rest of the add state so a
    # concluded or abandoned add cannot leak "owned on Blu-Ray" into the NEXT movie the member
    # adds (US4-AC7) — the same discipline the existing add fields follow.
    "add_owned_media": [],
    "add_ripped": None,
    "add_rip_quality": [],
    "add_multi_pending": [],
    "add_childrens": None,
}

# The add stages whose pending question is answered by a bare value the classifier reads as
# out_of_domain ("yes", "no", "Selected: DVD, Blu-Ray"). Every one of them must keep the turn in
# the add flow rather than re-classifying it (040 US4 + 047 US4).
_OWNERSHIP_STAGES = frozenset(
    {
        # 059 US2: the chain's first question about the movie. Registered here so a bare "yes"
        # answering it stays in the add flow instead of being re-classified as a new request.
        "awaiting_childrens",
        "awaiting_ownership",
        "awaiting_media",
        "awaiting_ripped",
        "awaiting_rip_quality",
    }
)

# The ownership stages that ask a MULTI-VALUED question; the rest are Yes/No. `awaiting_childrens`
# is deliberately NOT here (FR-011): listed as multi-select, a plain "yes" would be resolved
# against an empty option list and the question could never be answered.
_MULTI_SELECT_STAGES = frozenset({"awaiting_media", "awaiting_rip_quality"})


def _answers_ownership_question(stage: str, text: str, state: Mapping[str, Any]) -> bool:
    """Whether `text` is an ANSWER to the ownership question currently pending (pure, no LLM).

    Used to keep an answer in the add flow regardless of how the classifier read it. Resolution
    is delegated to the same pure resolvers the organizer will use, so the supervisor can never
    accept something the organizer would then reject (or vice versa).
    """
    from src.nodes.organizer import parse_ownership_answer, resolve_multi_select

    if stage in _MULTI_SELECT_STAGES:
        offered = [str(v) for v in (state.get("add_multi_pending") or [])]
        return resolve_multi_select(text, offered) is not None
    return parse_ownership_answer(text) is not None

# Fields cleared when a SEARCH workflow concludes or is escaped (013 US7) so a finished search
# never leaks into the next turn (mirrors _ADD_STATE_RESET).
_SEARCH_STATE_RESET: dict[str, Any] = {
    "search_stage": "",
    "search_scope": "",
    "search_query": "",
    "search_results": [],
}

# Cleared when an ORGANIZE disambiguation concludes or is escaped (013 Inc5 new-bug-1).
_ORGANIZE_STATE_RESET: dict[str, Any] = {
    "organize_stage": "",
    "organize_pending": None,
    "organize_options": [],
}

# Cleared when an IMPORT disambiguation concludes (proposal built / nothing to import) or is
# escaped, so a finished import never leaks its parsed context into a later turn (014 US4).
_IMPORT_STATE_RESET: dict[str, Any] = {
    "import_stage": "",
    "import_prompt": None,
    "import_resolutions": {},
    "import_handle": "",
    "import_context": None,
    # 047 US2 — a concluded/abandoned import must not carry its unresolved-reply count or its
    # outstanding-decision count into the next one, or the very first question of a fresh import
    # would arrive already showing an escape.
    "import_unresolved_replies": 0,
    "import_decisions_remaining": 0,
}

# Cleared when a NAVIGATE disambiguation concludes (a collection is opened) or is escaped (the
# user asks for something else), so a finished navigation never leaks into a later turn (040 US1).
_NAVIGATE_STATE_RESET: dict[str, Any] = {
    "navigate_stage": "",
    "navigate_options": [],
}


def _default_classifier(messages: Sequence[Any]) -> str:
    """Classify the latest user request into an intent label using the supervisor model.

    Runtime-only (keeps import/compile LLM-free). Delegates the prompt/parse to
    `classify_intent` so the same decision is exercised by the golden gate (T032). Sources the
    provider/base-URL/key from the per-run agent config (018 review #2) — read from the
    node-task ContextVar the supervisor wrapper re-sets from config["configurable"] — so intent
    classification uses the user's OWN credentials, not the shared process env. None present →
    `os.environ` unchanged (the pre-018 shared-env behaviour the BFF gate prevents at runtime).
    """
    import os

    from src.models import build_chat_model, runtime_env, select_model_config
    from src.nodes.supervisor import classify_intent
    from src.runtime_context import get_agent_config

    env = runtime_env(get_agent_config(), os.environ)
    model = build_chat_model(select_model_config("supervisor", env), env)
    return classify_intent(model, messages)


def _supervisor_node(
    classifier: Callable[[Sequence[Any]], str],
    kill_switch: Callable[[], bool],
    circuit: Any | None = None,
) -> Any:
    def supervisor(state: GraphState, config: RunnableConfig | None = None) -> dict[str, Any]:
        # Bind the per-run agent config (018 review #2) so the classifier's model build sources
        # the user's own provider/key. LangGraph injects `config`; the graph-executor task does
        # not reliably inherit the ASGI-middleware ContextVar, so re-set it here (same task) the
        # way the curator/organizer/query wrappers do for their model builds.
        from collections.abc import Mapping

        from src.runtime_context import agent_config_scope

        configurable = (config or {}).get("configurable") or {}
        raw_cfg = configurable.get("agent_config")
        agent_config = dict(raw_cfg) if isinstance(raw_cfg, Mapping) else None
        with agent_config_scope(agent_config):
            return _classify(state)

    def _classify(state: GraphState) -> dict[str, Any]:
        # Kill switch (T061/FR-019/SC-009): short-circuit BEFORE any classify / tool work, so a
        # disabled assistant performs zero side effects. Clears any in-progress add.
        if kill_switch():
            return {"intent": "disabled", **_ADD_STATE_RESET}
        messages = state.get("messages") or []
        last = messages[-1] if messages else None
        # 050 / item #149 — the search-cancel control is routed ABOVE everything that can answer on
        # the model's behalf. Do not move it below any of the three; each one silently breaks it:
        #
        #   1. the CLASSIFIER — an escape hatch that can be classified away is not an escape hatch.
        #      Measured 2026-08-09: on qwen2.5 it read `exit search` as out_of_domain, so the member
        #      got "I can only help with your movie collections." (047's ownership guard exists for
        #      the same reason — prose-like replies classified differently on Ollama vs Anthropic);
        #   2. its EXCEPTION handler, which returns `degraded` before any routing runs — so a
        #      provider outage answers "get me out of here" with "I couldn't complete that";
        #   3. the error-rate BREAKER, which does the same and opens after repeated failures —
        #      exactly when a member is stuck and wanting out. A routed cancel makes no provider
        #      call, so letting it past costs the cooldown nothing.
        #
        # None of those is an acknowledgement (FR-002) or an exit (FR-007). Deliberately BELOW the
        # kill switch: a disabled assistant must still do nothing. Mirrors `is_cancel_import`.
        #
        # The `add_stage` guard is not decoration: the search node's exit clears the add lifecycle,
        # and 047 US4 exists because a misroute here once discarded a member's half-finished movie.
        #
        # Deliberate observability trade: `record_turn(intent)` runs after classification, so a
        # cancel no longer appears in the classified-intent metric — it is no longer a classified
        # turn.
        if (
            last is not None
            and getattr(last, "type", None) == "human"
            and is_search_cancel(str(getattr(last, "content", "") or ""))
            and not (state.get("add_stage") or "")
        ):
            return {"intent": "search"}
        # Error-rate circuit breaker (T030, Control Tower): when too many recent runs have failed
        # the breaker is open → short-circuit to the same graceful-degradation reply, giving the
        # provider/stack a cooldown. No new user surface; zero side effects.
        if circuit is not None and circuit.opened():
            return {"intent": "degraded", **_ADD_STATE_RESET}
        # Only classify a genuine user turn. A non-human last message means this run was
        # triggered by a client continuation (e.g. a render_movie_card tool round-trip), not a
        # new request — end quietly ("noop") instead of re-classifying it, which would mislabel
        # it out_of_domain and emit a spurious decline after a successful preview.
        if last is None or getattr(last, "type", None) != "human":
            return {"intent": "noop"}
        text = str(getattr(last, "content", "") or "")
        # Graceful degradation (T061/FR-018): a provider/reasoning failure becomes a
        # "couldn't complete" reply, never a crash or a misroute. Clears any in-progress add.
        # The outcome feeds the circuit breaker (T030) — a failure here is the error signal.
        from src.observability import record_turn, record_turn_failure

        try:
            intent = classifier(messages)
        except Exception:  # noqa: BLE001 — any provider/model failure degrades gracefully
            if circuit is not None:
                circuit.record(False)
            record_turn_failure()  # OTel metric (no-op until configured) — T030b
            return {"intent": "degraded", **_ADD_STATE_RESET}
        if circuit is not None:
            circuit.record(True)
        record_turn(intent)  # OTel run counter, labelled by classified intent — T030b
        stage = state.get("add_stage") or ""

        # Continue an in-progress add (multi-turn disambiguation, T069/R14).
        if stage == "awaiting_pick":
            pick = resolve_option(text, state.get("options") or [])
            if pick is not None:
                # An ordinal/year/title pick — hand the chosen option to the curator.
                return {"intent": "add", "resolved_pick": pick}
            # No resolvable pick: respect a clear switch (organize) or off-topic abandonment
            # (out_of_domain → decline escapes the pending pick); otherwise it is an in-domain
            # reply (a re-typed title or garbled pick) → curator re-enriches / re-offers.
            if intent in ("organize", "out_of_domain"):
                return {"intent": intent}
            return {"intent": "add"}

        if stage == "awaiting_collection" and intent != "organize":
            # The reply names the collection for the already-resolved movie (a bare collection
            # name classifies as out_of_domain, so that signal can't gate here) → curator threads
            # it to the organizer; only a clear `organize` switch escapes.
            return {"intent": "add"}

        if stage in _OWNERSHIP_STAGES:
            # 040 US4 / 047 US4: the reply answers one of the ownership questions — "Do you own
            # this movie?", the media-format or rip-quality multi-select, or "Is it ripped?".
            #
            # AN ANSWER TO THE PENDING QUESTION IS NEVER A NEW COMMAND, whatever the classifier
            # made of it. This check comes FIRST and is not a belt-and-braces nicety: 040's single
            # question was safe only by luck, because "yes"/"no" reliably classify as
            # out_of_domain. 047's replies are prose-like ("Selected: none", "Selected: DVD,
            # Blu-Ray") and a model can read them as `query` or `search` — at which point the
            # escape below fires, the pending add is discarded, and the member's movie is silently
            # never created. That is provider-dependent, so it passed on Ollama and failed on
            # Anthropic in CI. Mirrors the import guard, which resolves the pending prompt's
            # options before consulting the intent.
            if _answers_ownership_question(stage, text, state):
                return {"intent": "add"}
            # A clearly-new domain command abandons the pending add and clears its state
            # (US4-AC7), which is what stops "owned on Blu-Ray" leaking into the next one.
            if intent in ("enrich", "organize", "navigate", "import", "export", "query", "search"):
                return {"intent": intent, **_ADD_STATE_RESET}
            return {"intent": "add"}

        # Continue an in-progress SEARCH workflow (US7). A button tap or refinement re-enters the
        # search node, which advances its own stage / handles "exit search". A clear new action
        # (add/organize) escapes the workflow and clears its state. add_stage and search_stage are
        # mutually exclusive (a turn is either mid-add or mid-search).
        if state.get("search_stage"):
            # A reply that PICKS one of the offered results is not a new add/organize command — it
            # is a disambiguation pick (a button tap posts a bare "Title (Year)" that can classify
            # as `add`). Keep it in the search node, which resolves the pick in pure code. Only a
            # reply that does NOT match an offered result escapes to a genuinely new action (Bug 2:
            # a pick leaked to the curator's enrich preview, which carries no clickable TMDB link).
            if intent in ("add", "organize") and resolve_option(
                text, state.get("search_results") or []
            ) is None:
                return {"intent": intent, **_SEARCH_STATE_RESET}
            return {"intent": "search"}

        # Continue an in-progress ORGANIZE disambiguation (013 Inc5 new-bug-1). A reply that
        # resolves one of the offered movies (a button tap posts a bare "Title (Year)" that
        # classifies as `search`) is a PICK → stay in organize; any other reply is a genuinely new
        # command → escape and clear the pending picker.
        if state.get("organize_stage"):
            # A movie pick OR a "Cancel" button/typed-cancel stays in organize (the organizer
            # applies the pick or exits cleanly); any other reply is a new command → escape.
            if resolve_option(text, state.get("organize_options") or []) is not None or (
                is_organize_cancel(text)
            ):
                return {"intent": "organize"}
            return {"intent": intent, **_ORGANIZE_STATE_RESET}

        # Continue an in-progress IMPORT disambiguation (014 US4 / 040 US2 FR-013). A reply that
        # resolves the pending prompt's options (a button tap posts a bare option label) stays in
        # import. Otherwise DON'T silently abandon the in-progress import: a free-typed answer to a
        # comma/article question often classifies as `search` (it looks like a movie title), so
        # only a clearly-new WRITE/NAV command (add/organize/navigate/export) escapes — anything
        # else stays in import, and the import node RE-ASKS the pending question rather than
        # discarding the parsed spreadsheet and re-classifying as a brand-new request (the reported
        # "it just stopped" bug). Mirrors the conservative search-stage escape.
        if state.get("import_stage"):
            prompt = state.get("import_prompt") or {}
            if resolve_option(text, prompt.get("options") or []) is not None:
                return {"intent": "import"}
            # 047 FR-009/FR-010: the Cancel-import control is added at render time, so it is NOT
            # in `import_prompt.options` and would not resolve above. Route it to the import node
            # explicitly rather than relying on the classifier — an escape that depends on a model
            # call is not an escape.
            if is_cancel_import(text):
                return {"intent": "import"}
            if intent in ("add", "organize", "navigate", "export"):
                return {"intent": intent, **_IMPORT_STATE_RESET}
            return {"intent": "import"}

        # Continue an in-progress NAVIGATE disambiguation (040 US1 / Item 4a). The navigator asked
        # "which collection?" and offered bare-name buttons; a tap posts that bare collection name.
        # Without this guard the tap re-classifies as `search` (a bare name looks like a movie
        # title) and mis-searches inside the on-screen collection — the reported bug. A reply that
        # resolves one of the offered collections stays in `navigate` (the navigator opens it); any
        # other reply is a genuinely new command → escape and clear the navigate context.
        if state.get("navigate_stage"):
            if resolve_option(text, state.get("navigate_options") or []) is not None:
                return {"intent": "navigate"}
            return {"intent": intent, **_NAVIGATE_STATE_RESET}

        return {"intent": intent}

    return supervisor


def _responder(text: str) -> Any:
    def node(state: GraphState) -> dict[str, list[AIMessage]]:
        return {"messages": [AIMessage(content=text)]}

    return node


def _noop_gate(state: GraphState) -> dict[str, Any]:
    """Default approval gate when none is injected — unreachable without a pending proposal."""
    return {}


def _decline_node(state: GraphState) -> dict[str, Any]:
    """Out-of-domain decline. Also clears any in-progress add (the user switched topics) so it
    cannot leak into a later turn (T069/R14, RC4)."""
    return {
        "messages": [AIMessage(content="I can only help with your movie collections.")],
        **_ADD_STATE_RESET,
    }


def _degrade_node(state: GraphState) -> dict[str, Any]:
    """Graceful degradation (T061/FR-018): a provider/reasoning failure → a clear "couldn't
    complete" reply, never a silent or partial unauthorized action. Clears any in-progress add."""
    return {
        "messages": [
            AIMessage(content="Sorry — I couldn't complete that just now. Please try again.")
        ],
        **_ADD_STATE_RESET,
    }


def _disabled_node(state: GraphState) -> dict[str, Any]:
    """Kill switch engaged (T061/FR-019/SC-009): the assistant is disabled — reply that it is
    unavailable and do nothing else (zero side effects; existing app flows are unaffected)."""
    return {
        "messages": [AIMessage(content="The movie assistant is temporarily unavailable.")],
        **_ADD_STATE_RESET,
    }


def build_graph(
    classifier: Callable[[Sequence[Any]], str] | None = None,
    *,
    curator: Any | None = None,
    organizer: Any | None = None,
    navigator: Any | None = None,
    query: Any | None = None,
    search: Any | None = None,
    import_collection: Any | None = None,
    export_collection: Any | None = None,
    approval_gate: Any | None = None,
    checkpointer: Any | None = None,
    kill_switch: Callable[[], bool] | None = None,
    circuit: Any | None = None,
) -> Any:
    """Compile the supervisor graph. Unset nodes default to tool-free responders (pre-US1).

    `kill_switch` is checked at the supervisor entry per run (T061); the default reads the
    `AGENT_KILL_SWITCH` env flag (Unleash-backed in production — T030). When it returns True the
    supervisor short-circuits to the `disabled` node with zero side effects.

    `circuit` (an `ErrorRateBreaker`, optional) is the error-rate breaker (T030): when open the
    supervisor short-circuits to `degrade`; each turn's provider outcome is recorded into it.
    """
    classifier = classifier or _default_classifier
    kill_switch = kill_switch or (lambda: assistant_disabled(os.environ))
    curator = curator or _responder("curator: discovery & enrichment not yet implemented (US1).")
    organizer = organizer or _responder(
        "organizer: collection organization not yet implemented (US2)."
    )
    navigator = navigator or _responder(
        "navigator: in-app navigation not yet implemented (US3)."
    )
    query = query or _responder(
        "query: collection questions not yet implemented (US4)."
    )
    search = search or _responder(
        "search: movie search workflow not yet implemented (US7)."
    )
    import_collection = import_collection or _responder(
        "import: spreadsheet import not yet implemented (US2)."
    )
    export_collection = export_collection or _responder(
        "export: spreadsheet export not yet implemented (US3)."
    )
    approval_gate = approval_gate or _noop_gate
    checkpointer = checkpointer or MemorySaver()

    builder = StateGraph(GraphState)
    builder.add_node("supervisor", _supervisor_node(classifier, kill_switch, circuit))
    builder.add_node("curator", curator)
    builder.add_node("organizer", organizer)
    builder.add_node("navigator", navigator)
    builder.add_node("query", query)
    builder.add_node("search", search)
    builder.add_node("import_collection", import_collection)
    builder.add_node("export_collection", export_collection)
    builder.add_node("approval_gate", approval_gate)
    builder.add_node("decline", _decline_node)
    builder.add_node("degrade", _degrade_node)
    builder.add_node("disabled", _disabled_node)
    builder.add_node(
        "clarify",
        _responder(
            "I can add a movie to one of your collections or look up details about a movie. "
            "What would you like to do?"
        ),
    )

    builder.add_edge(START, "supervisor")
    builder.add_conditional_edges(
        "supervisor",
        lambda state: route_for_intent(state["intent"]),
        {
            "curator": "curator",
            "organizer": "organizer",
            "navigator": "navigator",
            "query": "query",
            "search": "search",
            "import_collection": "import_collection",
            "export_collection": "export_collection",
            "decline": "decline",
            "degrade": "degrade",
            "disabled": "disabled",
            "clarify": "clarify",
            END: END,
        },
    )
    builder.add_conditional_edges(
        "curator", route_after_curator, {"organizer": "organizer", END: END}
    )
    builder.add_conditional_edges(
        "organizer", route_after_organizer, {"approval_gate": "approval_gate", END: END}
    )
    # Import builds a (possibly batched) proposal exactly like the organizer, so it reuses the
    # same routing: a pending proposal goes to the HITL gate; otherwise the turn ends (014 US2).
    builder.add_conditional_edges(
        "import_collection", route_after_organizer, {"approval_gate": "approval_gate", END: END}
    )
    builder.add_conditional_edges(
        "approval_gate", route_after_approval, {"approval_gate": "approval_gate", END: END}
    )
    builder.add_edge("navigator", END)
    builder.add_edge("query", END)
    builder.add_edge("search", END)
    # Export is read-only — it produces a download UI-action and ends (no HITL write gate).
    builder.add_edge("export_collection", END)
    builder.add_edge("decline", END)
    builder.add_edge("degrade", END)
    builder.add_edge("disabled", END)
    builder.add_edge("clarify", END)

    return builder.compile(checkpointer=checkpointer)


# Compiled entrypoint referenced by gateway.create_app() and langgraph.json.
# Uses the real classifier + tool-free node defaults (the add flow activates when the agent
# layer is deployed with MCP-backed nodes). Compiling does NOT invoke the classifier.
graph = build_graph()
