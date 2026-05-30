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
    primaryTextColor: '#000'
    primaryBorderColor: '#4a6a88'
    lineColor: '#0000ff'
    secondaryColor: '#85e2e2'
  look: neo
  htmlLabels: false
---
graph LR
  classDef style_background fill:#ECEFF1,stroke:#28282B,stroke-width:4px;
  classDef style_sub1 fill:#C9F1F2,stroke:#28282B,stroke-width:4px;
  classDef style_sub2 fill:#64B5C1,stroke:#28282B,stroke-width:4px;
  classDef style_sub3 fill:#F29F5A,stroke:#28282B,stroke-width:4px;
  classDef style_sub4 fill:#E2D7B0,stroke:#28282B,stroke-width:4px;

  subgraph c4_container_diagram["**Container Diagram**"]
    mcm_user["**MCM User**<br/>Accesses MCM via web browser and mobile device"]
    
    subgraph software_ecosystem["**Software Ecosystem**"]
        subgraph frontend["**Frontend Apps**"]
            subgraph mcm_app["**MCM App**"]
                subgraph mcm_client["**MCM Client**"]
                    mcm_web["**Web App**<br/>*React Native Expo Client - Web*<br/>Handles web-based UI rendering and interactions"]
                    mcm_mobile["**Mobile App**<br/>*React Native Expo Client - Mobile*<br/>Handles mobile UI rendering and interactions"]
                end
                subgraph mcm_bff["**MCM BFF**"]
                    mcm_bff_api["**MCM BFF API**<br/>*React Native Expo Router API Routes in Node.js Docker Container*<br/>A thin, secure layer that must encapsulate server-side API routes using the Backend for Frontend pattern"]
                    mcm_bff_cache[("**MCM BFF Cache**<br/>*Redis in-memory database in Docker Container*<br/>Caches session state for MCM BFF")]
                end
            end
        end
        
        subgraph backend["**Backend Services**"]
            subgraph mc_service["**Movie Collection Service**"]
                mc_service_api["**Movie Collection Service API**<br/>*Rust + Axum Microservice in Docker Container*<br/>Handles Movie Collection Service use cases and logic"]
                mc_service_db[("**Movie Collection Service Database**<br/>*MongoDB Database in Docker Container*<br/>Stores Movie Collection Service data")]
            end
        end
    end
    
    keycloak["**Identity and Access Management (IAM)**<br/>*Keycloak*<br/>Manages user identities, authentication, SSO, and permissions"]
    
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
- **ownerId denormalization**: `movie_collections` stores both `ownerId` (fast ownership filter) and `acl: [{ userId, role }]` (future sharing). The ACL is seeded with `{ userId: ownerId, role: "owner" }` on creation.

### MongoDB Collections

| Collection | Purpose |
|------------|---------|
| `movie_collections` | Stores collection metadata: `ownerId`, `name`, `description`, `isDefault`, `acl`, timestamps |
| `movies` | Stores movie records: `collectionId`, `ownerId` (denormalized), full movie metadata |

Indexes enforce uniqueness via collation (`strength: 2` for case-insensitive matching without extra fields).

### Docker Infrastructure

mc-service and mc-db are defined in `infrastructure-as-code/docker/mc-service/compose.yaml`.

```bash
# Start mc-service + mc-db (MongoDB)
pnpm nx deploy mc-service
# or directly:
docker compose -f infrastructure-as-code/docker/mc-service/compose.yaml up -d

# mc-service: http://localhost:3001
# MongoDB:    mongodb://localhost:27017/mc_db
```

**mc-service requires Keycloak running** — it fetches the JWKS endpoint on startup to cache the public key for JWT validation. Start Keycloak first (`infrastructure-as-code/docker/keycloak/compose.yaml`).

---

## Local Development Testing

### Local IAM Testing

Local testing of IAM with this solution can be done leveraging the local Keycloak instance and local mailpit instance running in Docker.  The BFF requires a Redis instance for its cache.

#### Start Infrastructure

```bash
# Start Keycloak (port 8099) from repo root
cd infrastructure-as-code/docker/keycloak
docker compose -f compose.yaml up -d

# Verify Keycloak is healthy
curl -f http://localhost:8099/realms/master || echo "Keycloak not ready yet"

# Start Redis (port 6379) for BFF cache
docker run -d --name mcm-redis -p 6379:6379 redis:8.6.2-alpine3.23
```

#### Access IAM

- Keycloak will be accessible from the host on `http://localhost:8099`.  
- For the admin console and API access, port 8099 is exposed externally, but containers running on the same docker network should use port 8080.
- The test mail client for use with keycloak will be accessible from the host on `http://localhost:8025/`.
- Other compose files that have services running on the same docker network (`backend-network`) can connect to this keycloak container by referencing `keycloak-service:8080`.

#### Cleaning Up

To remove the containers and clean up:

```bash
# Stop and remove containers
docker compose down
```
