"""Address guard for the gateway's outbound Ollama connection (item #542).

WHY THIS EXISTS SEPARATELY FROM THE BFF GUARD. The per-user ``ollamaBaseUrl`` is not a gateway
setting: it travels from the BFF into this process as ``OLLAMA_BASE_URL`` (``models.runtime_env``)
and is handed straight to ``ChatOllama``, which opens the connection from HERE. Before this module
that outbound request had no address validation of any kind. A check performed only in the BFF is a
check of a different process at an earlier time, and the answer for a name can change in between --
which is exactly the DNS-rebinding case. This is the last check before the socket.

THE POLICY IS THE OLLAMA ONE, NOT THE BACKUP ONE. A model server is *expected* to be on the LAN, so
private and unique-local addresses are ALLOWED. What is refused is the unambiguously dangerous:
link-local (169.254/16 and fe80::/10, which is where the cloud-metadata service lives), the AWS
IMDS-over-IPv6 address, multicast/reserved space, and the unspecified address.

LOOPBACK IS NARROWED, NOT ALLOWED. Inside this container loopback is the GATEWAY itself, not the
user's machine, so an unrestricted allowance would let a user-supplied URL address whatever else is
listening locally. It is permitted only on the ports Ollama itself uses
(``AGENT_OLLAMA_LOOPBACK_PORTS``, default 11434), which mirrors the BFF guard exactly.

KNOWN RESIDUAL RISK -- read before assuming this is airtight. This module RESOLVES and VALIDATES;
it does not PIN the connection the way the BFF's ``createPinnedAgent`` does. ``ChatOllama`` builds
its own HTTP client, so the resolver is consulted a second time when the socket is opened, leaving
a sub-second TOCTOU window in which an answer could change. That window is much smaller than the
save-to-use gap this closes -- which could be days -- but it is not zero, and pinning the httpx
transport inside ``langchain-ollama`` is the remaining work if it ever needs to be zero.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from collections.abc import Callable, Iterable, Mapping
from urllib.parse import urlsplit

__all__ = ["OllamaAddressNotAllowed", "assert_ollama_url_allowed", "loopback_ports_from_env"]

DEFAULT_LOOPBACK_PORTS: tuple[int, ...] = (11434,)

#: The AWS IMDS-over-IPv6 address. It sits inside fc00::/7, which is otherwise ordinary LAN space.
_METADATA_V6 = ipaddress.ip_address("fd00:ec2::254")


class OllamaAddressNotAllowed(Exception):
    """The configured Ollama endpoint may not be connected to.

    Carries a SAFE reason only. The resolver's own message can name internal DNS servers and
    search domains, so it is never forwarded into this.
    """


Lookup = Callable[[str], list[str]]


def _default_lookup(host: str) -> list[str]:
    """Every address the name resolves to, both families."""
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    # `str(...)` because a sockaddr's first element is typed `str | int` (IPv4 gives a 2-tuple,
    # IPv6 a 4-tuple); it is always the address. dict.fromkeys preserves resolution order while
    # dropping the duplicates getaddrinfo returns for a host with several socket types.
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def loopback_ports_from_env(env: Mapping[str, str] | None = None) -> tuple[int, ...]:
    """Parse ``AGENT_OLLAMA_LOOPBACK_PORTS``; an empty value denies loopback outright."""
    env = os.environ if env is None else env
    raw = env.get("AGENT_OLLAMA_LOOPBACK_PORTS")
    if raw is None:
        return DEFAULT_LOOPBACK_PORTS
    ports: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            port = int(part)
        except ValueError:
            continue
        if 0 < port <= 65535:
            ports.append(port)
    return tuple(ports)


def _is_blocked(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True for the ranges refused regardless of configuration."""
    # An IPv4-mapped IPv6 literal is re-checked as the IPv4 it carries. Without this,
    # ``::ffff:169.254.169.254`` reaches cloud metadata past an IPv4-only range check.
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        return _is_blocked(mapped)
    # Loopback is decided by the PORT rule in the caller, not here, so it must be taken out of the
    # way first. MEASURED: `ipaddress.IPv6Address("::1").is_reserved` is True -- IPv6 loopback sits
    # inside a reserved block -- so a `is_reserved` check placed above this one silently blocks
    # every `::1` URL, including the default `http://localhost:11434` once `localhost` resolves to
    # `::1` first. That is not a hypothetical: it broke two tests before this line existed.
    if address.is_loopback:
        return False
    if address.is_link_local:  # 169.254/16 and fe80::/10 -- where the metadata service lives
        return True
    if address == _METADATA_V6:
        return True
    if address.is_multicast or address.is_reserved:
        return True
    if address.is_unspecified:
        return True
    if isinstance(address, ipaddress.IPv4Address) and address in ipaddress.ip_network("0.0.0.0/8"):
        return True
    # Private, unique-local and public addresses all reach here and are ALLOWED -- that is the
    # bring-your-own-Ollama policy, and the deliberate difference from the backup guard.
    return False


def assert_ollama_url_allowed(
    url: str,
    *,
    lookup: Lookup | None = None,
    loopback_ports: Iterable[int] | None = None,
) -> list[str]:
    """Validate an Ollama base URL, returning every address that passed.

    Raises :class:`OllamaAddressNotAllowed` with a safe reason. Call this at USE, every time --
    a result cached from an earlier call would reintroduce the gap this closes.
    """
    if lookup is None:
        # Read through the module attribute rather than binding it at import time, so a test that
        # patches `_default_lookup` actually affects this call.
        lookup = _default_lookup
    ports = DEFAULT_LOOPBACK_PORTS if loopback_ports is None else tuple(loopback_ports)

    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise OllamaAddressNotAllowed("The Ollama base URL must be an http(s) URL")
    try:
        hostname = parts.hostname
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:  # a malformed port
        raise OllamaAddressNotAllowed("The Ollama base URL must be an http(s) URL") from exc
    if not hostname:
        raise OllamaAddressNotAllowed("The Ollama base URL must be an http(s) URL")

    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None

    if literal is not None:
        answers = [hostname]
    else:
        try:
            answers = lookup(hostname)
        except Exception:  # noqa: BLE001 - any resolver failure is "not safe"
            # `from None` on purpose: chaining would attach the resolver's message, which can name
            # internal DNS servers and search domains, to an error that may be surfaced.
            raise OllamaAddressNotAllowed(
                "The Ollama host could not be resolved to an address"
            ) from None
        if not answers:
            # A name with no answers is unresolvable, NOT safe. Treating an empty result as
            # "nothing blocked was found" is how a guard ends up defaulting to allow.
            raise OllamaAddressNotAllowed("The Ollama host could not be resolved to an address")

    # EVERY answer, not the first. A record returning one public and one blocked address is the
    # shape that defeats a guard checking answers[0], and whoever controls the name can arrange it.
    for answer in answers:
        try:
            address = ipaddress.ip_address(answer)
        except ValueError:
            raise OllamaAddressNotAllowed(
                "The Ollama host resolved to an unusable address"
            ) from None
        if _is_blocked(address):
            raise OllamaAddressNotAllowed(
                "That address is not allowed (link-local / cloud-metadata range)"
            )
        if address.is_loopback and port not in ports:
            raise OllamaAddressNotAllowed(
                "That address is not allowed: a loopback address is this server, not your "
                "machine. Only the configured Ollama port may be reached over loopback."
            )
    return list(answers)
