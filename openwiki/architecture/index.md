# Files

- [AI Agents layer architecture (features 012/014/018/040)](agent-layer.md) - The call chain, token-custody model, and per-user config design for MCM's additive conversational assistant — how identity flows from mcm-app through the BFF and Agent Gateway to mc-service without the agent ever holding the user's session token.
- [mc-service domain data model](data-model.md) - The Domain-layer entities of mc-service — MovieCollection, Movie, ExternalIdentifier, DomainError — and the cross-field invariants and Specification-pattern rules that guard them before persistence.
- [System overview (MCM)](system-overview.md) - The whole-system map of MovieCollectionManager — core components (mcm-app, mc-service, mc-db, Keycloak), the additive AI Agents layer, and the RBAC/DAC access-control model — distilled from the canonical architecture document.
