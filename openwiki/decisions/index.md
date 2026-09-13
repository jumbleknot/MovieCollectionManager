# Files

- [ADR-0001: Production secrets-management standard](adr-0001-prod-secrets-management.md) - The ratified decision record selecting Komodo Variables (not HashiCorp Vault) as the sanctioned production secrets mechanism for all core stacks, with Vault kept dormant and agent-layer-scoped only.
- [ADR-0002: Stateful major upgrades — OpenSearch 3 then Langfuse 4](adr-0002-stateful-major-upgrades.md) - Ratifies upgrading OpenSearch 2→3 before Langfuse 3→4, in separate specs, driven by a security clock on four allowlisted CVEs whose only upstream remediation is a major version bump.
