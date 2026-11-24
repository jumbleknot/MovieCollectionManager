# Contract: `.forgejo/version-pin-exclusions.json`

A JSON array. Each entry excuses one named pin in one file from needing a Renovate manager.

```json
[
  {
    "file": ".devcontainer/toolchain.Dockerfile",
    "name": "SPECKIT_VERSION",
    "reason": "Spec Kit upgrades are a reviewed procedure (docs/runbooks/spec-kit.md): the overrides must be re-checked against the new templates, so a bot bump would be wrong."
  }
]
```

| field | rule | violation |
| --- | --- | --- |
| `file` | exact repository-relative path, forward slashes | missing, or containing `*` or `?`, makes the entry invalid |
| `name` | exact pin name as the check reports it | missing, or containing `*` or `?`, makes the entry invalid |
| `reason` | at least 20 characters after trimming; says why a manager is wrong for this pin | missing or short makes the entry invalid |

These rules come from the spec:
- An entry must match at least one current pin. Otherwise it is **stale** (FR-006).
- An entry whose matched pins are all managed is **redundant** (FR-006).
- Duplicate `{file, name}` entries are invalid.

**What is a legitimate reason** (renovate runbook, FR-012): the version is held by something else that
upgrades it (an SDK, a toolchain wrapper), or upgrading it is a deliberate, reviewed procedure that a bot
bump would bypass. "Not worth a manager" is not a reason.
