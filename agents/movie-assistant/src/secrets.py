"""Runtime secret injection via HashiCorp Vault, with an environment fallback (T030a).

`resolve_secret(name, env)` returns the LLM/MCP credential from Vault when the gateway/MCP
container is configured for it (`VAULT_ADDR` + `VAULT_TOKEN`), else from the environment
(`.env.local` in local dev). Secrets MUST NOT appear in agent context, prompts, logs, or source
(constitution §Agent Security): this module never logs a value and never raises on a Vault
error — it falls back to the environment so a Vault outage degrades to env config, never a crash.

The KV v2 secret lives at `secret/movie-assistant` (mount `secret`); each credential is a key.
`vault_read` is the seam (a `path -> {key: value}` reader): the default closes over an `hvac`
client; tests pass a stub.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping

logger = logging.getLogger(__name__)

VaultReader = Callable[[str], dict[str, str]]

# KV v2 path (mount `secret`) holding the agent's credentials in a deployed environment.
VAULT_SECRET_PATH = "movie-assistant"
VAULT_MOUNT_POINT = "secret"


def vault_configured(env: Mapping[str, str]) -> bool:
    """Whether Vault runtime injection is configured (both address + token present)."""
    return bool((env.get("VAULT_ADDR") or "").strip() and (env.get("VAULT_TOKEN") or "").strip())


def _default_vault_reader(env: Mapping[str, str]) -> VaultReader | None:
    """Build the live `hvac`-backed KV-v2 reader, or None when Vault is not configured."""
    if not vault_configured(env):
        return None

    def read(path: str) -> dict[str, str]:
        import hvac  # type: ignore[import-untyped]  # local import — only when Vault-configured

        client = hvac.Client(url=env["VAULT_ADDR"], token=env["VAULT_TOKEN"])
        resp = client.secrets.kv.v2.read_secret_version(
            path=path, mount_point=VAULT_MOUNT_POINT, raise_on_deleted_version=False
        )
        data = resp["data"]["data"]
        return {str(k): str(v) for k, v in data.items()}

    return read


def resolve_secret(
    name: str, env: Mapping[str, str], *, vault_read: VaultReader | None = None
) -> str | None:
    """Resolve a credential from Vault (preferred) else the environment; None if absent.

    A Vault error or a missing key falls through to `env[name]` (fail-open to env, never crash).
    Never logs the secret value (SC-004).
    """
    reader = vault_read if vault_read is not None else _default_vault_reader(env)
    if reader is not None:
        try:
            secrets = reader(VAULT_SECRET_PATH)
            if name in secrets and secrets[name]:
                return secrets[name]
        except Exception:  # noqa: BLE001 — any Vault failure degrades to env config, never crashes
            logger.warning("vault read failed; falling back to env", extra={"secret_name": name})
    value = env.get(name)
    return value if value else None
