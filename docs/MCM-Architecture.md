# MovieCollectionManager (MCM)

Browse and manage your movie collection from a web browser or mobile app

## Purpose

- MCM is a multi-user application where each user can own multiple movie collections
- Manage information about your movie collections
- Add movies to a collection and specify details about the movie such as media formats, movie metadata, personal rating, and links to movie databases such as IMDB and TMDB for additional information
- View and search your collections
- Maintain a wishlist of movies you would like to upgrade or add to a collection

## Future Roadmap

- Web search for where to buy movies on wish list
- Update NFO files
- Scrape media format metadata from digital movie files (via ffprobe or ffmpeg)
- Scrape movie metadata from TMDB to create NFO files

## Architecture Description

### Core Components

- `mcm-app` is the core Frontend App where users view and manage movie collections they have access to
- `mc-service` is the core Backend Service that implements all movie collection domain models and executes core movie collection logic
- `mc-service` stores movie collection data on a mongodb server named `mc-db` in a single mongodb database named `mc_db` with shared collections across all users
  - The `movie_collections` shared collection stores identifiers along with Access Control Lists (ACLs) for all movie collections
  - The `movies` shared collection stores data about the movies in the collections
- This software is dependent on Keycloak, an external IAM service
  - This software expects Keycloak to be set up with a client named `movie-collection-manager` in a realm named `jumbleknot`
  - This software expects Keycloak to have the following client roles: `mc-admin`, `mc-user`
  - Users are able to register themselves with Keycloak and are defaulted to `mc-user` client role in Keycloak

#### AI Agents Layer Components (AG-UI-Native)

The AI Agents layer is added per the constitution's *AI Agents Development Principles* using the AG-UI-native approach. It is additive — `mc-service` and the existing `mcm-app` screens are unchanged.

- `mcm-agent` is the Python LangGraph orchestration project (supervisor + specialist agents) that helps users manage collections conversationally (e.g., find and add movies, organise collections, build wishlists, enrich metadata).
- `movie-mcp` is an MCP Tool Server that wraps the existing `mc-service` REST API; it carries the user's JWT so `mc-service` applies its existing RBAC and DAC unchanged.
- `web-api-mcp` is an MCP Tool Server for outbound movie-metadata lookups (e.g., TMDB/IMDB); outbound-only, no internal network access.
- `agent-db` is a dedicated PostgreSQL instance holding LangGraph checkpoints (conversation threads), logically isolated from `mc-db`.
- `mcm-bff` is extended to act as a **secure proxy** for the AG-UI stream — it does not translate event shapes. The Agent Gateway emits AG-UI natively; the client consumes it via CopilotKit.
- `mcm-app` adds CopilotKit (`@copilotkit/react-native`) so the same universal Expo codebase renders the conversational UI, generative UI, and agent-driven UI actions on both web and mobile.

**Monorepo locations** (per the constitution's directory layout): `mcm-agent` → `/agents/mcm-agent/` (one LangGraph orchestration project); `movie-mcp` → `/mcp-servers/movie-mcp/`; `web-api-mcp` → `/mcp-servers/web-api-mcp/`. `agent-db` and the agent infra services are added to the repo-root `compose.yaml` under a new agents profile (the existing `app`/`keycloak`/`bff` profiles are unchanged).

### Data Classification

The data in this application is classified as internal.

### Access Control

#### Role-Based Access Control (RBAC)

- The `mcm-app` protected screens must require JWT token authentication and validate membership in one of the following client roles: `mc-admin`, `mc-user`
The `mc-service` API endpoints must require JWT token authentication and validate membership in one of the following client roles: `mc-admin`, `mc-user`
- `mc-admin` allows full administrator access to all capabilities in `mcm-app` and `mc-service`
- `mc-user` allows normal user access to `mcm-app` and `mc-service` including: create movie collection, view owned movie collection, update owned movie collection, delete owned movie collection

#### Discretionary Access Control (DAC)

Each movie collection has an owner (defaulted to the user who created the movie collection) and can have 0 or more contributors, and 0 or more viewers.  The owner of a movie collection decides who can access it and what permissions they have by granting or revoking either contributor or viewer rights.  The security logic must be implemented in `mc-service` based on the ACLs in the `movie_collections` mongodb shared collection.

- `mc-owner`: the movie collection owner has full rights to the owned movie collection including view, update, delete, grant permissions to another user, and revoke permissions from another user
- `mc-contributor`: a movie collection contributor has been granted rights by the owner and is able to view and update the movie collection
- `mc-viewer`: a movie collection viewer has been granted rights by the owner and is able to view the movie collection

### Architecture Diagram

```mermaid
---
config:
  layout: elk
  theme: base
  themeVariables:
    primaryColor: '#cfe2f3'
    primaryTextColor: '#000000'
    primaryBorderColor: '#4a6a88'
    lineColor: '#0000ff'
    secondaryColor: '#85e2e2'
    edgeLabelBackground: '#ffffff'
    tertiaryTextColor: '#000000'
  look: neo
  htmlLabels: false
---
graph LR
  classDef style_background fill:#ECEFF1,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub1 fill:#C9F1F2,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub2 fill:#64B5C1,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub3 fill:#F29F5A,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub4 fill:#E2D7B0,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_node fill:#cfe2f3,stroke:#4a6a88,stroke-width:2px,color:#000000;

  subgraph c4_container_diagram["`**MCM Container Diagram - No Agentic Layer**`"]
    mcm_user["`**MCM User**<br/>Accesses MCM via web browser and mobile device`"]
    
    subgraph software_ecosystem["`**Software Ecosystem**`"]
        subgraph frontend["`**Frontend Apps**`"]
            subgraph mcm_app["`**MCM App**`"]
                subgraph mcm_client["`**MCM Client**`"]
                    mcm_web["`**Web App**<br/>*React Native Expo Client - Web*<br/>Handles web-based UI rendering and interactions`"]
                    mcm_mobile["`**Mobile App**<br/>*React Native Expo Client - Mobile*<br/>Handles mobile UI rendering and interactions`"]
                end
                subgraph mcm_bff["`**MCM BFF**`"]
                    mcm_bff_api["`**MCM BFF API**<br/>*React Native Expo Router API Routes in Node.js Docker Container*<br/>A thin, secure layer that must encapsulate server-side API routes using the Backend for Frontend pattern`"]
                    mcm_bff_cache[("`**MCM BFF Cache**<br/>*Redis in-memory database in Docker Container*<br/>Caches session state for MCM BFF`")]
                end
            end
        end
        
        subgraph backend["`**Backend Services**`"]
            subgraph mc_service["`**Movie Collection Service**`"]
                mc_service_api["`**Movie Collection Service API**<br/>*Rust + Axum Microservice in Docker Container*<br/>Handles Movie Collection Service use cases and logic`"]
                mc_service_db[("`**Movie Collection Service Database**<br/>*MongoDB Database in Docker Container*<br/>Stores Movie Collection Service data`")]
            end
        end
    end
    
    keycloak["`**Identity and Access Management (IAM)**<br/>*Keycloak*<br/>Manages user identities, authentication, SSO, and permissions`"]
    
    mcm_user -->|Uses| mcm_web
    mcm_user -->|Uses| mcm_mobile
    
    mcm_web -->|Calls REST| mcm_bff_api
    mcm_mobile -->|Calls REST| mcm_bff_api
    
    mcm_bff_api -->|Reads/Writes NoSQL| mcm_bff_cache
    
    mcm_bff_api -->|Routes to REST| mc_service_api
    
    mc_service_api -->|Reads/Writes NoSQL| mc_service_db
    
    mcm_bff_api -->|Authenticates REST| keycloak
    mc_service_api -->|Validates token REST| keycloak
  end

  class c4_container_diagram style_background;
  class software_ecosystem style_sub1;
  class frontend,backend style_sub2;
  class mcm_app,mc_service style_sub3;
  class mcm_client,mcm_bff style_sub4;
  class mcm_user,mcm_web,mcm_mobile,mcm_bff_api,mcm_bff_cache,mc_service_api,mc_service_db,keycloak style_node;

  linkStyle default stroke:blue,color:black;
```

## AI Agents Layer (AG-UI-Native)

The agent layer follows the constitution's *AI Agents Development Principles*. The defining choice is **AG-UI-native interaction**: the LangGraph orchestration runtime emits AG-UI events natively, the CopilotKit client consumes them on web and mobile, and `mcm-bff` is a thin **secure proxy** rather than an event-translation chokepoint. Python is the language for `mcm-agent` and the MCP servers; `mc-service` remains Rust.

### Call Chain and Security Boundary

The user's identity flows end to end and the BFF stays the only OAuth2 client:

```
mcm-app (CopilotKit) → mcm-bff (secure proxy; supplies an ephemeral subject token per run/resume)
  → agent-gateway → supervisor → specialist agent (curator/organizer) → shared MCP client
  → [RFC 8693 token exchange → downscoped, aud=mc-service, short-TTL JWT]
  → movie-mcp → mc-service (validates JWT, applies RBAC + DAC) → mc-db
```

- The **specialist agents are the tool callers** — they reason and decide. They run as in-process nodes inside the Agent Gateway (`langgraph-api`) and invoke MCP tools through the gateway's single **shared, in-process MCP client** (with per-agent allowlists). There is no network call *back* to the gateway, and agents do not each open their own MCP transports; the shared client owns the connections to the MCP server containers. The `supervisor` only routes (it calls no domain tools).
- Agents never call `mc-service` directly — only through MCP tools carrying a **downscoped, audience-bound user token obtained by OAuth2 Token Exchange** (see *Token Custody & Propagation* below), so the existing `mc-owner`/`mc-contributor`/`mc-viewer` DAC and `mc-admin`/`mc-user` RBAC are enforced unchanged.
- The Agent Gateway and `agent-db` are private-network only; the client never reaches them.
- `mcm-bff` keeps token custody (opaque `HttpOnly` cookie), supplies the per-run subject token, sanitises readable UI state, authorises agent-driven UI actions against the user's roles, and maps `userId → threadId`.

### Token Custody & Propagation for Agent Runs

Identity is propagated by **OAuth2 Token Exchange (RFC 8693)** — the agent never receives or forwards the user's full session token to a backend. This preserves least-privilege and **decouples token lifetime from how long a run (or HITL pause) lasts**.

- **The BFF stays the sole token custodian.** On each run **invocation and each HITL resume** — both of which originate from an authenticated BFF request — the BFF supplies the Agent Gateway a **short-lived subject token** representing the user, passed as an **ephemeral, non-checkpointed run value**. Raw tokens (subject *or* exchanged) are **never** written to checkpointed agent state (`agent-db`), traces, or logs.
- **Exchange happens at tool-call time.** When a specialist agent calls a tool, the gateway's shared MCP client exchanges the subject token at Keycloak for a **downscoped, audience-bound (`aud=mc-service`), short-TTL** access token, attached as `Authorization: Bearer` to the MCP server, which forwards it unchanged to the backend. OPA authorises the exchange ("may this agent act for this user against this audience?").
- **Robust across long HITL pauses (the reason for this design).** A paused run holds **no token** — only the checkpointed graph state plus the non-sensitive `userId`/`threadId`. A token need only remain valid for an **active run segment** (the initial turn, or a single resume), never the pause. Because every resume is an authenticated BFF request, the BFF always supplies a fresh subject token on resume — so pause length is irrelevant. If the user's session has lapsed by approval time, they re-authenticate at the BFF first.
- **Keycloak / gateway configuration.** The Agent Gateway is a confidential OAuth2 client permitted to perform token exchange in the `jumbleknot` realm; exchanged tokens are short-TTL and audience-scoped; no token is persisted to disk, and any in-memory cache is keyed by `(user, audience)` and bounded by the token's TTL.
- **Subject token = a dedicated run-scoped delegation token, not the user's session token.** At handoff the BFF performs its own token exchange to mint a **run-scoped, audience-narrowed** delegation token (short TTL, carrying an agent-origin marker) and hands *that* to the gateway — never the user's full session access token. This keeps the most-exposed component (the model-driven gateway) holding only a minimized credential, decouples the handoff token's lifetime from the user's session, and gives `mc-service`/OPA a distinct "agent-originated" signal for the HITL-write policy. The gateway still re-exchanges per tool call to bind each token to a single backend audience (`aud=mc-service`). *(Rationale: Keycloak 26.5 standard token exchange downscopes via the `audience` filter, requires confidential requester clients, and has no impersonation — which is why downscoping, not impersonation, is the mechanism.)*
- **TTL guidance.** A "run segment" (handoff → completion or HITL pause) is bounded by model + tool latency, **not** by the run's wall-clock. Size the **subject-token TTL** to the p99 *active segment* with a hard ceiling (≈2–5 min) — a segment exceeding it fails closed and the BFF re-supplies a fresh token on resume; never lengthen it to span a pause. Keep the **exchanged-token TTL** as short as practical (≤60 s), set on the `mc-service` audience client (Keycloak governs exchanged-token lifespan via client/realm settings, not a per-request parameter); the in-memory `(user, audience)` cache may reuse it within a single segment's burst of calls, bounded by that TTL. Exact second-values are deployment config, finalized in the agent feature's plan.

### Three Agent-UI Capabilities (MCM examples)

| Capability | Mechanism (AG-UI) | MCM example |
|---|---|---|
| Agent controls UI | Frontend action (allowlisted) | "Open the add-movie form for *Dune*" → pre-fills the add-movie form on the current collection |
| Agent reads/shares UI state | Sanitised structural snapshot | Knows the user is viewing collection `X` so "add this to my wishlist" resolves the target without asking |
| Agent renders generative UI | `useRenderTool` → RN component | `render_movie_card`, `render_collection_summary`, `render_wishlist` rendered inline in chat |

Generative-UI components are ordinary `mcm-app` Components-Layer components reused inline in the conversation. No React Server Components or `streamUI` are used, so rendering is identical on web and mobile.

### Orchestration (LangGraph Supervisor)

| Node | Role |
|------|------|
| `supervisor` | Classifies intent and routes to a specialist, a UI/generative tool, or the HITL gate |
| `curator` | Finds and enriches movie metadata via `web-api-mcp`; proposes additions |
| `organizer` | Reorganises collections / wishlists via `movie-mcp` (writes are HITL-gated) |
| `approval_gate` | HITL checkpoint for any write/delete to a collection |

Tools fall into three categories with fixed naming so the BFF routes results without inspecting orchestration internals: MCP tools (`get_collection`, `add_movie`, …), generative-UI tools (`render_*`), and UI-action tools (`navigate_*`, `prefill_*`). Any write to `mc-service` (add/update/delete movie or collection) routes through `approval_gate` and is recorded in the audit log; write tool calls carry an idempotency key.

### MCP Servers

| MCP Server | Wraps / Purpose | Identity |
|------------|-----------------|----------|
| `movie-mcp` | Thin wrapper over `mc-service` REST API (`/api/v1/...`) | Propagates the user's JWT |
| `web-api-mcp` | Outbound movie-metadata lookups (TMDB/IMDB), HTTP fetch | Outbound only; no internal network access |

### Container Diagram (with AI Agents Layer)

The Agent Gateway is a **single container/process**: the supervisor graph (supervisor + specialist agents + HITL gate) and the shared MCP client are components **inside** it. The specialist agents decide and call tools; the boundary-crossing MCP calls to the `movie-mcp` / `web-api-mcp` containers are carried by the gateway's shared MCP client (writes pass through the HITL gate first). Showing *which* agent calls *which* tool is strictly a C4 component-level detail, included here for clarity within the gateway boundary.

```mermaid
---
config:
  layout: elk
  theme: base
  themeVariables:
    primaryColor: '#cfe2f3'
    primaryTextColor: '#000000'
    primaryBorderColor: '#4a6a88'
    lineColor: '#0000ff'
    secondaryColor: '#85e2e2'
    edgeLabelBackground: '#ffffff'
    tertiaryTextColor: '#000000'
  look: neo
  htmlLabels: false
---
graph LR
  classDef style_background fill:#ECEFF1,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub1 fill:#C9F1F2,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub2 fill:#64B5C1,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub3 fill:#F29F5A,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_sub4 fill:#E2D7B0,stroke:#28282B,stroke-width:4px,color:#000000;
  classDef style_node fill:#cfe2f3,stroke:#4a6a88,stroke-width:2px,color:#000000;

  subgraph c4_container_diagram["`**MCM Container Diagram - With Agentic Layer**`"]
    mcm_user["`**MCM User**<br/>Accesses MCM via web browser and mobile device`"]
    
    subgraph software_ecosystem["`**Software Ecosystem**`"]
        subgraph frontend["`**Frontend Apps**`"]
            subgraph mcm_app["`**MCM App**`"]
                subgraph mcm_client["`**MCM Client**`"]
                    mcm_web["`**Web App**<br/>*React Native Expo Client - Web*<br/>CopilotKit (@copilotkit/react-native):<br/>AG-UI client, generative UI,<br/>frontend actions, readable UI state`"]
                    mcm_mobile["`**Mobile App**<br/>*React Native Expo Client - Mobile*<br/>CopilotKit (@copilotkit/react-native):<br/>AG-UI client, generative UI,<br/>frontend actions, readable UI state`"]
                end
                subgraph mcm_bff["`**MCM BFF**`"]
                    mcm_bff_api["`**MCM BFF API**<br/>*React Native Expo Router API Routes in Node.js Docker Container*<br/>Sole OAuth2 client; proxies AG-UI;<br/>JWT propagation; UI-state sanitisation;<br/>UI-action authz; thread mapping`"]
                    mcm_bff_cache[("`**MCM BFF Cache**<br/>*Redis in-memory database in Docker Container*<br/>Session + userId→threadId`")]
                end
            end
        end

      subgraph agents["`**AI Agents Layer** *(Python)*`"]
        subgraph gateway["`**Agent Gateway** *(langgraph-api — Python Docker)*<br/>One container/process hosting the graph`"]
          gw_runtime["`**Runtime / API**<br/>Runs the graph; emits AG-UI natively;<br/>NeMo Guardrails; OPA; checkpointer`"]
          subgraph lg_graph["`**LangGraph Supervisor Graph**`"]
            supervisor["`**Supervisor**<br/>routes only`"]
            curator["`**Curator Agent**`"]
            organizer["`**Organizer Agent**`"]
            hitl["`**HITL Approval Gate**`"]
          end
          mcp_client["`**Shared MCP client**<br/>per-agent tool allowlists`"]
        end
        agent_db[("`**Agent State DB**<br/>*PostgreSQL*<br/>Checkpoints`")]
        subgraph mcp["`**MCP Tool Servers** *(separate Python Docker containers)*`"]
          movie_mcp["`**movie-mcp**<br/>Wraps mc-service API`"]
          web_mcp["`**web-api-mcp**<br/>TMDB/IMDB lookups`"]
        end
      end

      subgraph backend["`**Backend Services**`"]
            subgraph mc_service["`**Movie Collection Service**`"]
                mc_service_api["`**Movie Collection Service API**<br/>*Rust + Axum Microservice in Docker Container*<br/>Handles Movie Collection Service use cases and logic`"]
                mc_service_db[("`**Movie Collection Service Database**<br/>*MongoDB Database in Docker Container*<br/>Stores Movie Collection Service data`")]
            end
        end

      subgraph control_tower["`**Control Tower**`"]
        observ["`**LangFuse + Grafana stack**`"]
        audit["`**OpenSearch**<br/>Immutable audit log`"]
        policy["`**OPA + Unleash**`"]
      end
    end

    keycloak["`**IAM**<br/>*Keycloak*`"]
    vault["`**Vault**<br/>*Secrets*`"]

    mcm_user -->|Uses| mcm_web
    mcm_user -->|Uses| mcm_mobile
    mcm_web -->|"WebSocket/SSE (AG-UI)"| mcm_bff_api
    mcm_mobile -->|"WebSocket/SSE (AG-UI)"| mcm_bff_api

    mcm_bff_api -->|Reads/Writes| mcm_bff_cache
    mcm_bff_api -->|"REST + AG-UI stream (server-side only)"| gw_runtime
    mcm_bff_api -->|Routes to REST| mc_service_api

    gw_runtime -->|Runs graph| supervisor
    supervisor --> curator
    supervisor --> organizer
    curator -->|"Reads / metadata"| mcp_client
    organizer -->|"Write proposal"| hitl
    hitl -->|"Approved write"| mcp_client
    mcp_client -->|"RFC 8693 token exchange (subject → downscoped JWT)"| keycloak
    mcp_client -->|"MCP: movie tools (downscoped JWT)"| movie_mcp
    mcp_client -->|"MCP: web lookups"| web_mcp
    gw_runtime -->|Checkpoints| agent_db
    movie_mcp -->|JWT REST| mc_service_api
    mc_service_api -->|Reads/Writes NoSQL| mc_service_db

    mcm_bff -->|Authenticates| keycloak
    mc_service_api -->|Validates token| keycloak
    gw_runtime -->|Traces| observ
    gw_runtime -->|Audit events| audit
    gw_runtime -->|Policy + kill switch| policy
    gw_runtime -->|Secrets| vault
  end

  class c4_container_diagram style_background;
  class software_ecosystem style_sub1;
  class frontend,backend,agents,control_tower style_sub2;
  class mcm_app,mc_service,mcp,gateway style_sub3;
  class mcm_client,mcm_bff,lg_graph style_sub4;
  class mcm_user,mcm_web,mcm_mobile,mcm_bff_api,mcm_bff_cache,mc_service_api,mc_service_db,gw_runtime,supervisor,curator,organizer,mcp_client,agent_db,movie_mcp,web_mcp,observ,audit,policy,vault,hitl,keycloak style_node;

  linkStyle default stroke:blue,color:black;
```

## mc-service Architecture

`mc-service` is a Rust/Axum microservice that implements all movie collection domain logic. It follows **Clean Architecture** with strict 4-layer separation — outer layers may import from inner layers; inner layers must never import from outer layers.

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| **Domain** | `backend/mc-service/src/domain/` | Entities (`Collection`, `Movie`), value objects, domain errors, `Specification<T>` pattern for business rule validation |
| **Application** | `backend/mc-service/src/application/` | CQRS commands/queries via `medi-rs`, DTOs, repository trait interfaces (ports) |
| **Adapters** | `backend/mc-service/src/adapters/mongodb/` | MongoDB implementations of repository traits, BSON ↔ domain mapping (DAOs) |
| **API** | `backend/mc-service/src/api/` | Axum handlers, middleware (auth, logging, error), router assembly, `AppState` |

### Key Design Decisions

- **CQRS via `medi-rs`**: State-changing operations are `Command` types dispatched through the mediator; reads are `Query` types. Handlers live in `application/commands/` and `application/queries/`.
- **Repository pattern**: `application/ports/` defines trait interfaces (`CollectionRepository`, `MovieRepository`). `adapters/mongodb/` provides the implementations. Handlers depend only on the trait, never on the concrete adapter — enabling unit testing with `mockall`.
- **Specification pattern**: `domain/specifications/spec.rs` defines a generic `Specification<T>` trait (`is_satisfied_by(&T) -> bool`) with `AndSpec`, `OrSpec`, `NotSpec` combinators. Domain validation uses composed specifications, not ad-hoc `if` chains.
- **Centralized auth via layer**: `KeycloakAuthLayer<Role>` is applied as a tower layer on the `protected` sub-router. All `/api/v1/` routes are automatically protected — individual handlers never perform auth checks.
- **JWT validation**: `axum-keycloak-auth` fetches Keycloak's JWKS once on startup and caches the public key. JWT validation is entirely local — no per-request Keycloak round-trip.
- **Cursor-based pagination**: Movie list uses keyset pagination (`{ _id: { $gt: lastSeenId } }`), not offset/skip. The `cursor` query param is a base64-encoded MongoDB ObjectId. Batch size: 50.
- **RFC 9457 Problem Details**: All error responses use `application/problem+json`. The catch-all error handler in `src/api/middleware/error_handler.rs` maps domain errors to Problem Details.
- **MongoDB collation uniqueness**: Collection name uniqueness (per owner) and movie uniqueness (per collection) are enforced at the index level with `{ locale: "en", strength: 2 }` collation — case-insensitive without a derived lowercase field.
- **ownerId denormalization + DAC enforcement**: `movie_collections` stores both `ownerId` (fast ownership filter) and `acl: [{ userId, role }]`. **Per-collection DAC is enforced** (feature 011): every movie operation authorizes against the parent collection's ACL via a shared `authorize_collection_access` check in the Application-Layer handlers, using the role hierarchy `owner ⊇ contributor ⊇ viewer` (writes require contributor, reads require viewer); an unauthorized or missing collection returns `404` (no existence leak), and `movie.ownerId` is always stamped as the collection owner. What remains future is **granting/revoking** contributor/viewer entries (UI + endpoints): today the ACL is seeded only with `{ userId: ownerId, role: "owner" }`, so the seam is exercised but non-owner roles are added only in tests until the grant/revoke feature lands.
- **Atomic cascade delete**: `collection_repository.rs::delete()` removes a collection and all its movies inside a single MongoDB multi-document transaction. Ownership is verified first (`delete_one` filtered by `{ _id, ownerId }`); a zero match aborts before any movie is touched. This requires a **replica-set-enabled MongoDB** (a single-member replica set suffices).
- **Observability endpoints**: The router exposes unauthenticated `/health` (liveness probe) and `/metrics` (Prometheus scrape endpoint via `metrics-exporter-prometheus`) outside the `protected` sub-router.

### MongoDB Collections

| Collection | Purpose |
|------------|---------|
| `movie_collections` | Stores collection metadata: `ownerId`, `name`, `description`, `isDefault`, `acl`, timestamps |
| `movies` | Stores movie records: `collectionId`, `ownerId` (denormalized), full movie metadata |

Indexes enforce uniqueness via collation (`strength: 2` for case-insensitive matching without extra fields).

mc-db runs as a **single-member replica set** (`mongod --replSet rs0`) so that the cascade-delete transaction works; the `rs-init` service initialises the set automatically on first start. mc-service connects with `directConnection=true` to bypass replica-set member discovery.

### Docker Infrastructure

All local dev/test infrastructure is orchestrated from the repo-root **`compose.yaml`**, which uses Docker Compose `include:` to incorporate each service's individual compose file and `profiles` to select which services start:

| Profile flag | Services started |
| --- | --- |
| *(none — default)* | `mc-db` (MongoDB replica set) + `rs-init` + `mcm-redis` |
| `--profile app` | + `mc-service` |
| `--profile keycloak` | + `keycloak-db` + `keycloak-service` + `keycloak-mailpit` |
| `--profile bff` | + `mcm-bff` (Docker-deployed BFF; local dev normally uses Metro instead) |
| `--profile app --profile keycloak` | full backend stack |

```bash
# Full backend stack — correct ordering (mc-service waits for Keycloak healthy)
docker compose --profile app --profile keycloak up -d
# or via Nx:
pnpm nx up-all infrastructure-as-code

# mc-service:        http://localhost:3001   (/health liveness, /metrics Prometheus)
# MongoDB:           mongodb://localhost:27017/mc_db
# Keycloak Admin UI: http://localhost:8099
# Mailpit:           http://localhost:8025
```

> `--profile` flags must come **before** `up`/`down` with Docker Compose v2.

**mc-service requires Keycloak running** — it fetches the JWKS endpoint on startup to cache the public key for JWT validation, and `depends_on: keycloak-service: condition: service_healthy` enforces the ordering. Starting `--profile app` alone (without `--profile keycloak`) will hang waiting for Keycloak.

### Agent Layer Infrastructure

| Component | Image / Runtime | Purpose |
|-----------|-----------------|---------|
| `agent-gateway` | `langchain/langgraph-api` (Python) | LangGraph API server; emits AG-UI natively |
| `agent-db` | `postgres:18.3-alpine3.23` | LangGraph checkpoints (isolated from `mc-db`) |
| `movie-mcp` | Custom Python Docker image | MCP wrapper over `mc-service` REST API |
| `web-api-mcp` | Custom Python Docker image | TMDB/IMDB lookups + HTTP fetch |
| `langfuse` + Grafana stack | Official images | LLM traces, metrics, logs |
| `opensearch` | `opensearchproject/opensearch` | Immutable audit log |
| `opa` + `unleash` | Official images | Policy enforcement + kill switch |
| `vault` | `hashicorp/vault` | Secrets (LLM/MCP credentials) |

The Agent Gateway also requires Keycloak indirectly: `movie-mcp` calls `mc-service` with the user's JWT, so the full chain (Keycloak → mc-service → movie-mcp → agent-gateway → mcm-bff) must be running for end-to-end agent flows.

---

## Local Development Testing

### First-Time Setup

Run once per machine before the first `docker compose up` (the external networks and volumes are referenced by the included compose files):

```bash
docker network create backend-network
docker network create keycloak-network
docker volume create mc-service_mc-db-data
docker volume create localdev-auth_keycloak-db-data
docker volume create mcm-redis-data
# Copy infrastructure-as-code/docker/keycloak/.env.local.example → .env.local and fill in secrets.
```

### Local IAM Testing

Local testing of IAM leverages the local Keycloak instance and local Mailpit instance running in Docker. The BFF requires a Redis instance for its session store and cache.

#### Start Infrastructure

```bash
# Test infra only (MongoDB replica set + Redis)
docker compose up -d

# Add Keycloak stack (Keycloak + its Postgres + Mailpit)
docker compose --profile keycloak up -d

# Verify Keycloak is healthy
curl -f http://localhost:8099/realms/master || echo "Keycloak not ready yet"
```

#### Access IAM

- Keycloak is accessible from the host on `http://localhost:8099` (admin console / API).
- Containers on the shared docker network (`keycloak-network`) reach Keycloak via `keycloak-service:8080` — port 8099 is the externally-exposed mapping.
- The Mailpit test mail client is accessible from the host on `http://localhost:8025/`.

#### Cleaning Up

```bash
# Stop containers, keep all persistent volumes
docker compose --profile app --profile keycloak down

# Stop + wipe transient volumes only (persistent external volumes are untouched)
docker compose --profile app --profile keycloak down --volumes
```
