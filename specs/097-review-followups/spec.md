# Spec 097: Review follow-ups — test/config lint, no broken watchman, agent-layer hardening residuals

**Status**: In progress | **Date**: 2026-11-08 | **Input**: implementation review, 2026-11-08 (PR #965),
items #962, #963, #964

## Problem

The 2026-11-08 implementation review merged as PR #965 with three findings filed for later and two spec
tasks left open:

- Specs 094 and 095 each end with "Open the PR and get green CI. **Quote** the run numbers." PR #965 was
  green on its head `2e81645b`, but nobody recorded the runs.
- **Item #962.** `mcm-app`'s `lint` target runs `eslint src`, so `tests/`, `scripts/` and the root config
  files are never linted. `eslint .` reports 18 errors there, mostly `expo/no-dynamic-env-var`, an
  app-bundle rule that does not fit test code.
- **Item #963.** The dev-container image bakes a prebuilt `watchman v2024.01.22.00` that links
  `libcrypto.so.1.1`. Bookworm ships only OpenSSL 3, so every call fails, and a bare `npx jest <file>`
  exits 1 printing only the loader error.
- **Item #964.** Three agent-layer residuals, each below the review's reporting bar:
  1. the gateway hands the user's Ollama base URL to `ChatOllama`, and redirects were unverified;
  2. `agent/stop` names its thread in `params.threadId`, which the ownership check never reads;
  3. the backup destination guard does not deny NAT64 or IPv4-compatible IPv6 forms.

## Findings that shaped the requirements

- **Ollama redirects ARE followed, in the gateway only.** `ollama-python` 0.6.3 (`ollama/_client.py`,
  `BaseClient.__init__`) builds its httpx clients with `follow_redirects=True`, documented as its override
  of httpx's default. `langchain-ollama` 1.1.0 passes `client_kwargs` through to both the sync and async
  clients. Measured: a vetted loopback server answering `307` sent both `invoke` and `ainvoke` on to the
  redirect target (`POST /api/chat`). The BFF probe uses `http.request`, which never follows.
- **No watchman prebuilt fits bookworm.** Every upstream release with a `linux.zip` was checked:
  through `v2024.04.15.00` they link `libcrypto.so.1.1` (GLIBC ≤ 2.29). From `v2025.03.03.00` they link
  `libcrypto.so.3` but need `GLIBC_2.38` and `GLIBCXX_3.4.32`. Bookworm has glibc 2.36, and no Linux zip
  was published in between. Nothing in the repository needs watchman: no config sets it, jest falls back
  to its Node crawler when the binary is absent, and so does Metro (`metro-file-map` `#shouldUseWatchman`
  returns `false` on any failed capability check).
- **`agent/stop` envelope.** `copilotRuntimeNextJSAppRouterEndpoint` is single-route
  (`createCopilotEndpointSingleRoute`). A stop arrives as
  `{ method: "agent/stop", params: { agentId, threadId }, body: { runId? } }`, and `handleStopAgent` acts on
  `params.threadId`. `extractThreadId` reads only `body.threadId`, so for a stop it returned `undefined`
  and `enforceAgentThreadOwnership` treated that as "nothing to bind".

## Requirements

- **FR-001**: Spec 094 T003 and spec 095 T005 MUST quote PR #965's run ids and required-context verdict.
- **FR-002** (#962): `mcm-app` `lint` MUST cover `tests/`, `scripts/` and the root TypeScript config
  files, keep its `prettier --check`, and have cache `inputs` covering those paths.
- **FR-003** (#962): A test-files override MUST turn off `expo/no-dynamic-env-var`.
  `@typescript-eslint/no-unused-vars` MUST be an error for `tests/`. Every rule turned off for a path MUST
  carry its reason in the config.
- **FR-004** (#962): Real errors MUST be fixed rather than suppressed; a `rules-of-hooks` suppression needs
  a confirmed false positive.
- **FR-005** (#963): The image MUST NOT carry a watchman that cannot run. It is removed, and the runbook
  says Metro and jest use their Node crawler.
- **FR-006** (#963): `npx jest <file>` MUST work from `frontend/mcm-app` without `--no-watchman`.
- **FR-007** (#964.1): The gateway's Ollama client MUST NOT follow redirects, sync or async. The BFF
  probe's not-following MUST be pinned by a test. Both are recorded in the SSRF gotcha.
- **FR-008** (#964.2): `agent/stop` MUST be refused (403, before the runtime) for a thread another user
  owns. The thread id comes from the same `extractThreadId` → `enforceAgentThreadOwnership` path that
  `run` and `resume` use, with no second check.
- **FR-009** (#964.3): The backup destination guard MUST deny IPv4-compatible `::/96`, NAT64
  `64:ff9b::/96` and local-use NAT64 `64:ff9b:1::/48`, in the canonical form `new URL()` and the resolver
  produce. IPv4-mapped `::ffff:0:0/96` keeps its de-map-and-check.

## Decisions recorded

- **NAT64 is denied outright, not de-mapped.** A NAT64 address to a public IPv4 is legitimate on an
  IPv6-only network with DNS64. But the guard denies by default and admits by allow-list, and an operator
  on such a network names the host in `BACKUP_ALLOWED_DESTINATION_HOSTS`. De-mapping would trust the
  NAT64 gateway to translate only the embedded address, which the guard cannot verify.
- **The thread-owner claim outliving its TTL is ACCEPTED, not fixed.** The claim
  (`agent-thread-owner:<threadId>`, Redis `SET NX EX`) lasts the session's absolute window (24 h default),
  and the gateway checkpoint (`MemorySaver`, in-process, `gateway.py:157`) lasts until the gateway
  restarts. After the claim expires, the next user to present that thread id claims it. Reasons:
  - the id is a client-generated uuid v4 (`@copilotkit/shared` `randomUUID` → `uuid.v4`, 122 random
    bits), never shown to another user;
  - cross-user writes are already impossible: the subject token is minted from the requester's session,
    so mc-service DAC answers 404 for another user's collections;
  - what a takeover could show is a checkpointed proposal preview (collection and movie names);
  - a claim that never expires would grow Redis by one key per conversation for good, to protect against
    a guess with 2⁻¹²² odds.

  Revisit if checkpoints move to a durable store with a retention longer than the session (the Postgres
  checkpointer the comments anticipate), or if thread ids ever become visible to another user.
- **The gateway stays validate-without-pin.** Disabling redirects meets item #964's criterion (1). The
  sub-second DNS TOCTOU between `assert_ollama_url_allowed` and httpx's own resolution is unchanged and
  still recorded in the gotcha.

## Success criteria

- **SC-001**: `pnpm nx lint mcm-app` exits 0 with the widened scope.
- **SC-002**: Each behaviour change has a test seen failing before the change and passing after.
- **SC-003**: `npx jest <file>` passes in this container with watchman off `PATH`. A freshly built image
  is confirmed by the operator; this VM cannot build the full toolchain image.

## Out of scope

- Pinning the gateway's Ollama connection (the TOCTOU above).
- Wiring the BFF's session-end notification to the gateway's proposal sweep (`session_expiry.py`, T062).
