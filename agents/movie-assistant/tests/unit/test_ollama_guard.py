"""Address guard for the gateway's outbound Ollama connection (item #542).

The BFF has its own guard on the same URL, and this is NOT a duplicate of it for the sake of
symmetry. The per-user ``ollamaBaseUrl`` travels from the BFF into this process as
``OLLAMA_BASE_URL`` (see ``models.runtime_env``) and is handed to ``ChatOllama``, which connects
from HERE. A check that ran only in the BFF would be a check of a different process at a different
time, and the answer for a name can change in between -- which is precisely the rebinding case.

The resolver is injected throughout so these run offline and deterministically.
"""

import pytest

from src.ollama_guard import OllamaAddressNotAllowed, assert_ollama_url_allowed


def resolves_to(*addresses: str):
    """A stub resolver: every name answers with the given addresses."""

    def _lookup(_host: str) -> list[str]:
        return list(addresses)

    return _lookup


class TestLiteralAddresses:
    def test_allows_private_lan(self) -> None:
        for url in (
            "http://10.0.0.5:11434",
            "http://192.168.1.20:11434",
            "http://172.16.4.4:11434",
        ):
            assert_ollama_url_allowed(url, lookup=resolves_to())

    def test_blocks_cloud_metadata(self) -> None:
        with pytest.raises(OllamaAddressNotAllowed):
            assert_ollama_url_allowed("http://169.254.169.254/", lookup=resolves_to())

    def test_blocks_link_local_v4_and_v6(self) -> None:
        for url in ("http://169.254.1.1/", "http://[fe80::1]:11434/", "http://[fd00:ec2::254]/"):
            with pytest.raises(OllamaAddressNotAllowed):
                assert_ollama_url_allowed(url, lookup=resolves_to())

    def test_allows_ipv6_unique_local_which_is_an_ordinary_lan(self) -> None:
        assert_ollama_url_allowed("http://[fd12:3456::5]:11434/", lookup=resolves_to())

    def test_rejects_a_non_http_scheme(self) -> None:
        for url in ("file:///etc/passwd", "ftp://host/", "not a url"):
            with pytest.raises(OllamaAddressNotAllowed):
                assert_ollama_url_allowed(url, lookup=resolves_to())


class TestLoopbackIsNarrowedToTheOllamaPort:
    def test_allows_loopback_on_the_ollama_port(self) -> None:
        assert_ollama_url_allowed("http://127.0.0.1:11434", lookup=resolves_to())
        assert_ollama_url_allowed("http://[::1]:11434", lookup=resolves_to())

    def test_denies_loopback_on_any_other_port(self) -> None:
        # Loopback in this container is the GATEWAY, not the user's machine.
        for url in ("http://127.0.0.1:8081/", "http://127.0.0.1:27017/", "http://localhost/"):
            with pytest.raises(OllamaAddressNotAllowed):
                assert_ollama_url_allowed(url, lookup=resolves_to("127.0.0.1"))

    def test_honours_a_configured_port_list(self) -> None:
        assert_ollama_url_allowed(
            "http://127.0.0.1:11435", lookup=resolves_to(), loopback_ports=(11434, 11435)
        )
        with pytest.raises(OllamaAddressNotAllowed):
            assert_ollama_url_allowed(
                "http://127.0.0.1:11434", lookup=resolves_to(), loopback_ports=()
            )


class TestResolution:
    def test_blocks_a_name_resolving_to_cloud_metadata(self) -> None:
        with pytest.raises(OllamaAddressNotAllowed):
            assert_ollama_url_allowed(
                "http://ollama.evil.test:11434", lookup=resolves_to("169.254.169.254")
            )

    def test_allows_a_name_resolving_to_an_ordinary_lan_address(self) -> None:
        assert_ollama_url_allowed(
            "http://nas.home.arpa:11434", lookup=resolves_to("192.168.1.50")
        )

    def test_checks_every_answer_not_just_the_first(self) -> None:
        # One public and one blocked answer is the shape that defeats a guard reading answers[0].
        with pytest.raises(OllamaAddressNotAllowed):
            assert_ollama_url_allowed(
                "http://split.test:11434", lookup=resolves_to("203.0.113.9", "169.254.169.254")
            )

    def test_an_unresolvable_name_is_not_safe(self) -> None:
        def boom(_host: str) -> list[str]:
            raise OSError("queryA ENOTFOUND ollama.internal.corp via 10.0.0.53")

        with pytest.raises(OllamaAddressNotAllowed) as caught:
            assert_ollama_url_allowed("http://nope.test:11434", lookup=boom)
        # The resolver's message can name internal DNS servers; it must not reach the raised error.
        assert "10.0.0.53" not in str(caught.value)

        with pytest.raises(OllamaAddressNotAllowed):
            assert_ollama_url_allowed("http://empty.test:11434", lookup=resolves_to())


class TestRebinding:
    def test_a_host_permitted_at_save_and_denied_at_use_is_caught_here(self) -> None:
        """The gateway is the LAST check before the socket, so it sees the answer of the moment."""
        calls = {"n": 0}

        def rebinding(_host: str) -> list[str]:
            calls["n"] += 1
            # First answer is what the BFF would have seen at save time.
            return ["192.168.1.50"] if calls["n"] == 1 else ["169.254.169.254"]

        assert_ollama_url_allowed("http://rebind.test:11434", lookup=rebinding)
        with pytest.raises(OllamaAddressNotAllowed):
            assert_ollama_url_allowed("http://rebind.test:11434", lookup=rebinding)


class TestBuildChatModelIsGuarded:
    """The guard must be wired in, not merely available. This is the wiring test."""

    def test_build_chat_model_refuses_a_blocked_ollama_base_url(self, monkeypatch) -> None:
        from src.models import ModelSpec, _build_real_chat_model

        monkeypatch.setattr(
            "src.ollama_guard._default_lookup", lambda _host: ["169.254.169.254"]
        )
        spec = ModelSpec(provider="ollama", model_id="qwen2.5", temperature=0.0)
        with pytest.raises(OllamaAddressNotAllowed):
            _build_real_chat_model(spec, {"OLLAMA_BASE_URL": "http://ollama.evil.test:11434"})

    def test_build_chat_model_allows_an_ordinary_lan_ollama(self, monkeypatch) -> None:
        from src.models import ModelSpec, _build_real_chat_model

        monkeypatch.setattr("src.ollama_guard._default_lookup", lambda _host: ["192.168.1.50"])
        spec = ModelSpec(provider="ollama", model_id="qwen2.5", temperature=0.0)
        # Constructs offline; ChatOllama does not connect at construction time.
        assert _build_real_chat_model(spec, {"OLLAMA_BASE_URL": "http://nas.home.arpa:11434"})
