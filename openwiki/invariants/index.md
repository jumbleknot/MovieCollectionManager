# Files

- [Authentication and authorization chain](auth-chain.md) - The end-to-end auth chain from client login through the BFF, mc-service, and the agent gateway's token-exchange path — where each layer enforces what, and where the chain is easy to break.
- [Logging and audit conventions](logging-and-audit.md) - The structured-logging and security-audit-event requirements shared across the BFF, mc-service, and Agent Gateway, including the never-log list and each layer's redaction mechanism.
- [Model-provider environment scoping](model-provider-scoping.md) - Why the agent gateway's LLM provider is env-scoped rather than a single global choice — Ollama for dev/test, Claude for the golden test surface and prod, with escalation always pinned to Claude regardless of the base provider.
- [Nx as the universal task runner](nx-task-runner.md) - Why every build/test/lint/deploy command across the polyglot monorepo goes through Nx rather than the underlying tool directly, and the executors that bridge Nx to cargo, pytest, and Docker Compose.
- [Published-port reservation convention](published-port-reservation.md) - The reserved 19000-19099 host-port range for production admin/UI ports, and the shared-host collision it exists to prevent between the homelab's prod stacks and its CI runner.
- [Secrets management posture](secrets-management.md) - The no-clear-text-secrets-in-git rule, why Komodo Variables (not Vault) is the sanctioned production secrets mechanism, and how CI gates enforce both.
- [Testing tiers and what gates a merge](testing-tiers.md) - The unit / integration / golden / E2E test tiers used across mc-service, mcm-app, and the agent gateway, and which of them actually block a merge in CI versus which are informational.
