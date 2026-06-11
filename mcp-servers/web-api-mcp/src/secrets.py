"""Runtime secret injection via HashiCorp Vault, with an environment fallback (T030a).

web-api-mcp authenticates to TMDB with its own v3 API key. In deployed environments that key is
injected from Vault (KV v2 at `secret/web-api-mcp`); local dev falls back to the environment
(`.env.local`). Mirrors `agents/movie-assistant/src/secrets.py`: never logs a value, never
crashes on a Vault error (fail-open to env). The key is NEVER logged or placed in agent context.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable

logger = logging.getLogger(__name__)

VaultReader = Callable[[str], dict[str, str]]

VAULT_SECRET_PATH = "web-api-mcp"
VAULT_MOUNT_POINT = "secret"


def vault_configured() -> bool:
    """Whether Vault runtime injection is configured (both address + token present)."""
    return bool((os.environ.get("VAULT_ADDR") or "").strip()
                and (os.environ.get("VAULT_TOKEN") or "").strip())


def _default_vault_reader() -> VaultReader | None:
    if not vault_configured():
        return None

    def read(path: str) -> dict[str, str]:
        import hvac  # type: ignore[import-untyped]  # only needed when Vault-configured

        client = hvac.Client(url=os.environ["VAULT_ADDR"], token=os.environ["VAULT_TOKEN"])
        resp = client.secrets.kv.v2.read_secret_version(
            path=path, mount_point=VAULT_MOUNT_POINT, raise_on_deleted_version=False
        )
        data = resp["data"]["data"]
        return {str(k): str(v) for k, v in data.items()}

    return read


def resolve_secret(name: str, *, vault_read: VaultReader | None = None) -> str:
    """Resolve a credential from Vault (preferred) else the environment; "" if absent.

    A Vault error or a missing key falls through to `os.environ[name]` (never crashes). Never
    logs the secret value (SC-004).
    """
    reader = vault_read if vault_read is not None else _default_vault_reader()
    if reader is not None:
        try:
            secrets = reader(VAULT_SECRET_PATH)
            if name in secrets and secrets[name]:
                return secrets[name]
        except Exception:  # noqa: BLE001 — any Vault failure degrades to env config, never crashes
            logger.warning("vault read failed; falling back to env", extra={"secret_name": name})
    return os.environ.get(name, "")
