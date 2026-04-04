<!-- 
SYNC IMPACT REPORT - Constitution v1.0.2 (Comprehensive Review & Validation)
=============================================================================

VERSION HISTORY:
- v1.0.0: Initial Comprehensive Ratification (2026-03-08)
- v1.0.1: Comprehensive Review & Validation (2026-03-29)
- v1.0.2: Comprehensive Review & Validation (2026-04-04) [CURRENT]

VERSION BUMP RATIONALE: PATCH (1.0.1 → 1.0.2)
- Reason: Comprehensive review confirming alignment across all dependent 
  templates, validator adherence, and ongoing correctness of principles
- No new principles added
- No principle removals or redefinitions
- No governance procedure changes
- All existing technology stacks validated and current
- Status: All sections mature and validated

COMPREHENSIVE REVIEW RESULTS (2026-04-04):
========================================

✅ PRIMARY CONSTITUTIONAL PRINCIPLES:
  • AI Assistant Constraints (NON-NEGOTIABLE) - Validated
  • Security, Authentication & Authorization (NON-NEGOTIABLE) - Validated
  • Test-Driven Development (NON-NEGOTIABLE) - Validated  
  • Common Technology Stack and Standards - Validated

✅ BACKEND SERVICES PRINCIPLES (All Validated):
  • Bounded Contexts
  • Decoupling via APIs/Messaging
  • Enforce Isolation
  • Stateless Processes
  • Independent Deployment
  • API-First Design (REST/GraphQL/gRPC/WebSocket/Webhook)
  • Docker-Native Operations
  • Clean Architecture (Domain, Application, Adapters, API layers)
  • Rust Safety First
  • Technology Stack: Rust, Axum, Tokio, Tower, Serde, SQLx, PostgreSQL, Docker
  • Quality Standards: 70% coverage, clippy, fmt, cargo audit

✅ FRONTEND APP PRINCIPLES (All Validated):
  • Differentiated Experiences
  • Universal Frontend Apps (shared codebases)
  • No Domain Logic
  • Frontend Separation of Concerns (6 Layers: App, BFF, Components, Screens, Utils, Hooks)
  • Technology Stack: React Native, Expo, Hermes, Keycloak, Axios, Node.js
  • Quality Standards: 70% coverage, ESLint, Prettier, expo-doctor

✅ SHARED PACKAGES & MONOREPO PRINCIPLES (All Validated):
  • Monorepo organization at /packages/{{package-name}}/
  • Complete directory hierarchy defined and verified
  • Backend structure verified: /backend/{{service-name}}/src/{{domain|application|adapters|api}}/
  • Frontend structure verified: /frontend/{{app-name}}/src/{{app|bff-api|bff-server|components|screens|utils|hooks}}/

✅ GOVERNANCE & COMPLIANCE:
  • Amendment procedure documented: Proposal → Review → Version bump → Migration
  • Compliance enforcement verified in PR/review process
  • Development guidance maintained in docs/development.md
  • No remaining placeholder tokens
  • All sections complete and coherent

DEPENDENT TEMPLATES VALIDATION (2026-04-04):
==========================================
✅ .specify/templates/plan-template.md
   - "Constitution Check" gate section verified
   - Technical context alignment confirmed
   - No updates needed

✅ .specify/templates/spec-template.md
   - Generic user story/requirement structure compatible with all principles
   - No constitution-specific placeholders found
   - No updates needed

✅ .specify/templates/tasks-template.md
   - Task organization compatible with all principles
   - Phase structure (Setup, Foundational, User Stories) aligns with governance
   - No updates needed

✅ .specify/templates/checklist-template.md
   - Generic structure, no constitutional dependencies
   - No updates needed

✅ .specify/templates/agent-file-template.md
   - Designed for development guidance generation
   - Compatible with current constitution
   - No updates needed

RUNTIME DOCUMENTATION VALIDATION (2026-04-04):
============================================
✅ README.md
   - Purpose and roadmap documented
   - All prerequisite technologies listed and current
   - No outdated references
   - Aligns with constitution technology choices
   - Validated prerequisites match stack: Rust, Axum, React Native, Expo, Node.js, Docker
   - Keycloak IAM requirements documented
   - No updates needed

NO REMAINING PLACEHOLDER TOKENS: ✅
ALL SECTIONS VALIDATED & COMPLETE: ✅
TEMPLATE ALIGNMENT VERIFIED: ✅
GOVERNANCE PROCEDURES CONFIRMED: ✅
TECHNOLOGY STACK VERIFIED: ✅

FOLLOW-UP ACTIONS: None required
DEFERRED ITEMS: None
MIGRATION NEEDED: No (backward compatible PATCH bump)
-->

# Constitution for Full Stack Development in this Monorepo

This document outlines the core, immutable principles for developing Frontend Apps and Backend Services with an AI Assistant in this software ecosystem in a secure, consistent, extensible, scalable and maintainable way.

## Core Principles

The following Core Principles always apply to Backend Services development, Frontend Apps development, and cross-cutting concerns.

### AI Assistant Constraints (NON-NEGOTIABLE)

- **Adherence:** The AI Assistant must strictly adhere to the principles outlined in this constitution and the project's technical plan.
- **Clarification:** The AI Assistant should request clarification from the developer if a task or specification appears to violate the constitution or is underspecified.
- **Documentation:** All generated code should include clear documentation comments, and relevant documentation (e.g., OpenAPI specs, READMEs) must be updated as part of the implementation process.
- **Technology Agnosticism in Specification:** The spec.md and plan.md files must maintain a strict separation of concerns:
  - spec.md: Focuses on WHAT and WHY (user stories, requirements, domain terms), and must be technology-agnostic.
  - plan.md: Focuses on HOW (tech stack, specific libraries, implementation details).
- **No Vibe Coding:** The AI Assistant must always refer to the current plan.md and spec.md before writing code. Deviations require explicit documentation and approval.
- **Code Quality:** The AI Assistant must always adhere to standard conventions for the chosen language/framework (e.g., Idiomatic Rust, React Native best practices). Code complexity must be justified and documented.

### Security, Authentication & Authorization (NON-NEGOTIABLE)

- **Deny By Default:** Except for public resources, access must be denied by default.
- **Authentication:** All API endpoints must require JWT token authentication via OAuth2/OIDC.
- **Authorization:** Role-Based Access Control (RBAC) must be implemented.
- **Least Privilege:** All services must implement authentication and authorization mechanisms appropriate to their data sensitivity, adhering to the principle of least privilege.
- **Declarative Access Controls:** Use well-established toolkits or patterns that provide simple, declarative access controls.
- **Security Best Practices:**
  - Authentication must always use Authorization Code Flow with PKCE. Never allow Implicit Flow.
  - Authentication must always validate ID token signatures, `iss` (issuer), `aud` (audience), and `exp` (expiration).
  - Never store sensitive information like client secrets and private cookie keys in source code, config files, or version controls systems (e.g., git) - instead use environment variables or specialized secret management tools.
  - Always enforce TLS 1.3 for all communication.
  - Alwyas encrypt sensitive data at rest.
  - Always store session data in a server-side store (e.g., BFF as OAuth2 client), storing only an opaque session ID in the client's cookie or JWT.
  - Always place access control logic in a centralized middleware or wrapper function that intercepts all API requests to ensure that every request, regardless of its source within the app, is evaluated against the same security policies.
  - Always disable web server directory listing and ensure file metadata (e.g., .git) and backup files are not present within web root.
  - Always log access control failures and alert admins when appropriate (e.g., repeated failures).
  - Always implement rate limits on API and controller access to minimize the harm from automated attack tooling.
  - Always invalidate stateful session identifiers on the server after logout. Stateless JWT tokens should be short-lived to minimize the window of opportunity for an attacker. For longer-lived JWTs, consider using refresh tokens and following OAuth2 standards to revoke access.
  - Always treat all user input as untrusted and malicious by default, adopting a "never trust, always verify" mindset. Implement server-side, whitelist-based validation early in the data lifecycle, enforcing strict type, length, and format checks to prevent injection attacks.

### Test-Driven Development (NON-NEGOTIABLE)

TDD is mandatory: Test cases written → User approval → Tests fail → Implementation → Tests pass → Refactor. Unit tests exercise individual functions/methods. Integration tests verify service-to-service and service-to-database contracts. Code changes without corresponding test coverage are not permitted.

### Common Technology Stack and Standards

- **Git Management:** Always use a single root-level `.gitignore` file for the monorepo (e.g., /.gitignore).
- **Monorepo Build Tool:** Nx must be used to manage polyglot builds across the monorepo.
- **Environment & Secret Files:**
  - Create a root `.env` and `.env.local` for shared configuration, but use individual `.env` and `.env.local` files in each project (e.g., /backend/{{service-name}}/.env, /frontend/{{app-name}}/.env) for project specific configuration.
  - Each secret required at build time should be in it's own `{{secret_name}}.txt` file located in the root `secrets/` directory (e.g., /secrets/db_password.txt) that can be referenced in the monorepo docker compose file.
  - Always add `*.env` and `*.env.*` and `secrets/` to the root `.gitignore` to prevent committing sensitive secrets.

## Backend Services Development Principles

The software's backend is organized and divided into Backend Service projects that represent the various problem spaces, or Domains, the software is designed to solve. The following Principles always apply to Backend Services development.

- **Bounded Contexts:** Each Backend Service must focus on a single Domain within a clearly defined bounded context.
- **Decoupling:** Backend Services must be loosely coupled, communicating via well-defined APIs or asynchronous messaging, avoiding direct database access across service boundaries.
- **Enforce Isolation:** Never create dependencies between a Backend Service and internal components of a different Backend Service.  Never import code from a different Backend Service, except for shared contracts.
- **Stateless Processes:** Backend Services' processes should be stateless to facilitate scalability and resilience.  Ask before making a Backend Service stateful and document the specific requirement for state along with a strategy to make the stateful part scalable.
- **Independent Deployment:** Always use independent deployment pipelines, API versioning, and contract testing to ensure that changes in one Backend Service do not necessitate a full redeployment of unrelated Backend Services.

### API-First Design

Every feature must expose its functionality in Backend Services through well-defined APIs. Backend Services expose endpoints that clients (web, mobile, CLI) consume.

- **Allowed API Architecture Styles:** Always use REST, GraphQL, gRPC, WebSocket, or Webhook API architecture styles.  Never use SOAP APIs.
- **Specification-First:** All API changes must start by updating the API Specification files in the /api-specs directory.
- **API Contracts:** API contracts must be explicitly defined and treated as a single source of truth.
- **REST Guidelines:**
  - **API Specification:** Always document APIs with OpenAPI 3.0.3 YAML format.
  - **RESTful Design:** APIs must adhere to standard RESTful conventions (e.g., use of HTTP verbs, status codes).
  - **Versioning:** APIs must use URL path versioning (e.g., /api/v1/resource).
  - **Data Format:** All API requests and responses must use JSON as the data interchange format.
  - **Validation:** All endpoints must have defined request/response schemas.
  - **Naming:** Always use kebab-case for URL paths and camelCase for JSON properties.
  - **Standard Responses:** Always use standard HTTP status codes (200, 201, 400, 401, 404, 500).
  - **Error Handling:** Error responses must follow the Problem Details for HTTP APIs standard specified in RFC 9457.

### Docker-Native Operations

All Backend Services MUST run in Docker containers. Backend Services are stateless and horizontally scalable when possible. Configuration via environment variables. Health checks and graceful shutdown always implemented. Compose files always provided for local multi-service development.

### Clean Architecture

Backend Service code is always orgnized into layers that promotes separation of concerns. A Backend Service's core logic and domain models MUST be independent of external agencies such as clients, repositories, other services, and frameworks. Data access layers are always abstracted via traits/interfaces. Tests use in-memory or mock implementations. Database choice (SQL, NoSQL, etc.) is an implementation detail, not a constraint on the core Backend Service logic. Each Backend Service code must be broken down into 4 layers: Domain-Layer, Application-Layer, Adapters-Layer, API-Layer.

- **Domain-Layer:** Must encapsulate the Backend Service's Domain Objects.
  - The Domain-Layer is independent - changes to any other layer or external agencies never affects the Domain-Layer.
  - Domain Objects represent real-world objects or concepts and their attributes and behaviors with data structures, relationships, rules, and methods.
  - Domain Objects include entities, value objects, aggregates, and domain services.
  - The Domain-Layer encapsulates domain-specific validation rules with the Specification Pattern by defining a generic specification interface, a  base class that implements the generic specification interface, and one or more domain-specific validation rule specifications that implements the base class with the domain-specific validation rules.
    - The Specification Pattern should never be used for query logic - only for validation logic.
  - The Domain-Layer defines domain-specific rules and domain-specific errors where rule violations are represented using a Typed Result Pattern to explicitly handle success or failure states.
- **Application-Layer:** Must encapsulate and implement all of the Backend Service's use cases.
  - The Application-Layer is dependent on the Domain-Layer - changes to the Domain-Layer could affect the Application-Layer.
  - The Application-Layer is independent of all other layers - changes to external agencies or any layer other than Domain-Layer never affects the Application-Layer.
  - The Application-Layer achieves the goals of the Backend Service's use cases by performing application-specific logic and validation, interacting with Adapter Interfaces, and orchestrating interactions with Domain Objects including updating their state as needed.
  - The Application-Layer always leverages the CQRS Pattern to implement separate command and query handlers.
  - The Application-Layer operates solely on Domain Objects and Data Transfer Objects (DTOs) and never operates on Data Access Objects (DAOs).
  - The Application-Layer defines use case specific Request DTOs and Response DTOs for communicating with the API-Layer, decoupling the Domain Objects from external systems including API clients and messaging systems.
    - The Application-Layer command and query handlers consume Request DTOs as arguments passed to it from the API-Layer, performs any necessary validation on the inputs, and maps them to Domain Objects, calling Domain Object methods.
    - The Application-Layer maps Domain Objects to Response DTOs to return use case responses to the requesting API-Layer methods.
  - The Application-Layer always leverages Dependency Inversion to interact with External Providers (e.g., a database, a message broker, an external API, or third party libraries) - commands and queries for External Providers are always defined as Adapter Interfaces in the Application-Layer (implemented in the Adapters-Layer) that specify the contract for data operations (e.g., `GetById(id)` , `Save(entity)` ) passing Domain Objects as arguments and return types.
  - The Application-Layer handles a Backend Service's application specific concerns like logging, applying least privilege controls (e.g., authorization, role based access control), and transaction management.
  - The Application-Layer must validate its own command and query objects.
  - The Application-Layer receives the generalized errors from the outer layers (via Adapter Interfaces) and decides the appropriate application response - this can include logic to make decisions based on the error type, for example, logging the error or determining if a different action is needed.
- **Adapters-Layer:** Must encapsulate the Backend Service's adapters to External Providers (e.g., a database, a message broker, an external API, or third party libraries).
  - The Adapters-Layer is dependent on the Domain-Layer and the Application-Layer - changes to the Domain-Layer or the Application-Layer could affect the Adapters-Layer.
  - The Adapters-Layer is independent of the API-Layer - changes to the API-Layer never affects the Adapters-Layer.
  - The Adapters-Layer is dependent on External Providers - changes to External Providers can affect the Adapters-Layer.
  - The Adapters-Layer prevents tight coupling of your Backend Service to your External Providers.
  - The Adapters-Layer always leverages the Repository Pattern for the communication with External Providers - converting data from the format most convenient for the Domain-Layer and Application-Layer, to the format most convenient for External Providers.
    - The Adapters-Layer must define Data Access Objects (DAOs) which are structs specifically mapped to an External Provider data format.
    - The Adapters-Layer always leverages the CQRS Pattern to implement separate command and query Adapter Interfaces (defined in Application-Layer) that accept and return Domain Objects, map Domain Objects to DAOs, and fetch or persist data from the External Provider using a data access library (e.g., SQLx for Rust access to relational databases) or direct driver (e.g., mongodb crate for Rust access to MongoDB).
    - To ensure transparency and performance, the Adapters-Layer never leverages an Object Relational Mapper (ORM) and never leverages the Specification Pattern for command or query logic.
  - The Adapters-Layer always includes configuration management, initialization and logging for External Providers.
  - The Adapters-Layer deals with low-level errors from external systems (databases, APIs, network failures) - it should catch specific, technology-dependent exceptions (e.g., `SqlException` or `IOException`) and translate them into a generic, domain-agnostic error model or custom domain exception (e.g., `StorageUnavailableException` or `NetworkError`).
- **API-Layer:** Must encapsulate the Backend Service's API definition and is the entry point of your Backend Service.
  - The API-Layer is dependent on the Domain-Layer and the Application-Layer - changes to the Domain-Layer or the Application-Layer could affect the API-Layer.
  - The API-Layer is independent of the Adapters-Layer - changes to the Adapters-Layer never affects the API-Layer.
  - The API-Layer allows clients or other Backend Services to communicate with this Backend Service via defined interfaces and protocols (e.g., HTTP, gRPC, message queues).
  - The API-Layer is the entry point of your Backend Service, using a web application framework (e.g. Axum) to receive and parse incoming request data, route requests to handlers (call into the Application-Layer's use cases), and return properly formatted responses over the selected protocol.
  - The API-Layer must encapsulate endpoint definitions, controllers, serialization and deserialization of the data, validation and error handling.
  - The API-Layer is the OAuth2 Resource Server and must obtain and cache the public key from the Central Authentication Service and validate the incoming JWT.
  - The API-Layer always leverages the CQRS Pattern to define separate command and query endpoints.
  - The API-Layer must uses Request DTOs and Response DTOs defined in the Application-Layer to communicate with the Application-Layer.
  - The API-Layer API controller receives the raw request via an API endpoint, deserializes it, maps the data to a Request DTO, performs any necessary basic validation, and uses a mediator to dynamically route the command or query to its specific Application-Layer handler passing the Request DTO as an argument.
  - The Application-Layer handler returns a Response DTO to the API-Layer API controller via the mediator, and the API controller formats the appropriate response to return to the requestor.
  - The API-Layer must catch unhandled exceptions, logging them, and returning a consistent, non-sensitive error response to the requestor - it never contains the logic for how to handle the error.
  - The API-Layer must contain a health check endpoint to determine the status of the Backend Service.
- **Error Handling in Clean Architecture:**
  - Errors are produced in the outer layers (API-Layer, Adapters-Layer) and are caught, translated, and handled as they are passed inward to the Application-Layer and finally returned by the API-Layer to the requestor.
  - Typed Result Pattern: Always make the possibility of failure explicit in a method's signature and force the caller to handle both success and failure cases using a `Result<T, E>` enum which represents either success or failure.
  - Exception Propagation: Errors can be thrown and allowed to bubble up to a layer with enough context to handle them appropriately - the key is to wrap low-level exceptions in custom, higher-level exceptions as they cross layer boundaries to prevent dependency leaks.

### Rust Safety First

Leverage Rust's type system, ownership rules, and borrowing semantics to eliminate entire categories of bugs (memory safety, data races). Use idiomatic Rust patterns; avoid unsafe blocks unless absolutely justified with documentation. Dependencies kept minimal and vetted for security and maintenance status.

### Backend Service Technology Stack Requirements

The following technologies MUST be used unless explicitly amended:

- **Language**: Rust
- **Package Manager:** Cargo workspaces
- **Docker Image:** Multi-stage build starting with `rust:alpine3.23 AS build` for first stage and `alpine:3.23 AS runtime` for second stage
- **Monorepo Build Tool Integration:** @monodon/rust plugin for Nx
- **Web Framework**: Axum with Tokio async runtime
- **Networking Library:** Tower
- **Serialize and Deserialize:** Serde
- **Session Management:** tower-sessions
- **CSRF Protection:** axum-tower-sessions-csrf
- **Session Store:** Redis
- **Authentication Library:** axum-oidc
- **Authorization Protocol:** oauth2 crate
- **Central Authentication Service:** Keycloak provides the public key for verifying JWT signature
- **Authorization Management:** axum-gate crate must be used for authorization middleware and implementation of RBAC by using the claims on the validated JWT to make authorization decisions
- **Backend HTTP Client:** reqwest crate must be used as Backend Service HTTP Client (e.g., for making Backend Service API calls to Keycloak)
- **Mediator Library:** medi-rs must be used for dynamically routing commands, queries, and events from the API-Layer controller to the Application-Layer handler
- **Relational Database Access:** SQLx is the only approved data access library for relational databases
- **Document Database Access:** mongodb crate is the only approved data access library for document databases
- **In-memory Database:** Redis is the standard in-memory database for in-memory data store and cache (Docker image `redis:8.6.2-alpine3.23`)
- **Relational Database:** PostgreSQL is the standard relational database for persistent storage (Docker image `postgres:18.3-alpine3.23`)
- **Document Database:** mongodb is the standard document database for persistent storage (Docker image `mongodb/mongodb-community-server:8.2.6-ubuntu2204-slim`)
- **Configuration:** All configuration (credentials, feature flags, etc.) must be stored in the environment (environment variables), not in the codebase
- **Logging & Monitoring:** Standardized logging formats (e.g., JSON) and tracing headers must be used to ensure seamless integration with the centralized monitoring system (Prometheus/Grafana)
- **Testing Standards:** cargo test; unit tests are mandatory for all new features and bug fixes, aiming for high code coverage, and integration tests must be added to validate API contracts
- **Containerization**: Project specific Dockerfiles and monorepo root Docker Compose file (use new Docker Compose standard of compose.yaml)
- **Build**: Cargo with semantic versioning (MAJOR.MINOR.PATCH)
- **Directory and File Naming:** Use kebab-case for all directory and file names
- **Monorepo for Multiple Backend Services Approach:** Each Backend Service project in the monorepo must have its own directory located at /backend/{{service-name}}/
  - **Project File:** Each Backend Service in the monorepo must have its own project file located at /backend/{{service-name}}/src/main.rs
  - **Domain-Layer:** All Domain-Layer code for each Backend Service in the monorepo must be placed in the directory /backend/{{service-name}}/src/domain/
  - **Application-Layer:** All Application-Layer code for each Backend Service in the monorepo must be placed in the directory /backend/{{service-name}}/src/application/
  - **Adapters-Layer:** All Adapters-Layer code for each Backend Service in the monorepo must be placed in the directory /backend/{{service-name}}/src/adapters/
  - **API-Layer:** All API-Layer code for each Backend Service in the monorepo must be placed in the directory /backend/{{service-name}}/src/api/
  - **Unit Tests:**  Unit tests must be placed in each file with the code that they’re testing encapsulated within an annotated tests block
  - **Integration Tests:** Each Backend Service in the monorepo must have its own directory for integration tests located at /backend/{{service-name}}/tests/
  - **Dockerfile:** Each Backend Service in the monorepo must have its own dedicated Dockerfile located at /backend/{{service-name}}/Dockerfile
  - **Docker Build:** When building an image for a specific Backend Service, the build command must be run from the repository root with the build context set to the entire repository and specifying the specific Backend Service's Dockerfile using the `-f` flag

Deviations from this stack require constitution amendment with documented justification.

### Backend Service Quality Standards

- **Code Coverage**: Minimum 70% for new features (measured via coverage tools)
- **Linting**: All code must pass `cargo clippy` with no warnings
- **Formatting**: `cargo fmt` enforced in CI/CD
- **Documentation**: README updated for user-facing changes
- **Dependencies**: Regular audits via `cargo audit`; security patches applied promptly

## Frontend App Development Principles

The software's multi-experience frontend is organized and divided into separate Frontend App projects that provide differentiated user experiences for user types with different objectives (e.g., consumer website and mobile app vs administrator website).  The following Principles always apply to Frontend App development.

- **Differentiated Experiences:** When different user types have non-overlapping objectives, each differentiated experience must be developed in separate Frontend App projects with separate codebases.
- **Universal Frontend Apps:** When the same experience is needed in multiple channels (e.g. website and mobile app), this must leverage a shared codebase in a single Frontend App project - allowing the same codebase and routing to work across web, Android, and iOS.
- **No Domain Logic:** Frontend Apps never contain any domain logic. Frontend Apps must accomplish all domain tasks by communicating with Backend Services over their defined APIs.

### Frontend UI & UX

Defines enforced rules for UI/UX consistency, accessibility, usability and performance.

- **Accessibility First:** All interactive elements must meet WCAG 2.2 Level AA compliance. ARIA labels are required for all non-text elements, and focus states must be visible.
- **Performance Budgeting:** No page shall exceed a 2-second time-to-interactive on simulated 3G networks. Images must be automatically optimized to WebP format, and JavaScript bundles must be lazy-loaded.
- **Responsive & Adaptive Design:** Layouts must follow a mobile-first approach, using fluid grids. Components must adapt seamlessly between mobile, tablet, and desktop breakpoints.
- **Consistency & Feedback:** Use consistent spacing (base-8 system) and color palettes. All actions must provide immediate, clear feedback (e.g., loading spinners, success toast messages).
- **User-Centric Naming:**  "Component and property names must reflect user actions (e.g., `SubmitButton` rather than `GenericButton`) to aid in readability and AI comprehension.

### Frontend Separation of Concerns

Each Frontend App code must be structured into 6 distinct layers: App-Layer, BFF-Layer, Components-Layer, Screens-Layer, Utils-Layer, and Hooks-Layer.

- **App-Layer:** Must encapsulate core Frontend App code that defines the navigation and routes.
  - **File-based Routing:** Frontend App navigation always utilizes file-based routing system.
  - **Routes Return Screen Components:** Routes never define screen components - every route simply returns a screen component from the Screens-Layer.
- **BFF-Layer:** A thin, secure layer that must encapsulate server-side API routes using the Backend for Frontend (BFF) pattern.
  - **Loose Coupling:**  Prevents tight coupling of your Frontend App to your Backend Services.
  - **Data Aggregation and Transformation:** Aggregates data from multiple Backend Services and formats it precisely for the Frontend App requirements, reducing over-fetching and the number of client-side requests.
  - **Server-Side Execution:** Must run server-side and never be included client-side.
  - **Secure Credential Handling:** Must protect and securely store Frontend App senstive information like API keys and refresh token. Prevents Frontend App sensitive information from being stored client-side.
  - **Authentication Flow Management:** The BFF-Layer is the OAuth2 client.  It must authenticate each client request against the Central Authentication Service before forwarding it to the appropriate Backend Service.  It manages HTTP-only cookies and token translation, which the client-side cannot access.
  - **Identity Propagation:** Must propagate user identity to Backend Services by including it in the request's `Authorization` header.
  - **Manages Session State:** Must manage login-based authentication session state.
- **Components-Layer:** Must encapsulate reusable UI components (e.g., buttons, sliders, cards).
  - **One Named Export:** Each component will generally have one named export.
  - **File Name:** The filename is always the a kebab-case version of the component name followed by file extension (e.g., `my-component.tsx`, `my-component.android.tsx`).
  - **Platform Specific Code:** Separate components for web and native targets must be placed in separate files with platform-specific file extensions (e.g., `.web`, `.native`, `.ios`, `.android`).  When referencing the component, the code must import without the platform-specific file extension.  The props for the component must be identical for all platform-specific files.  A default version of the component without a platform-specific extension is required - the default must be for web.
  - **Style objects:** Style objects must be placed at the bottom of the component files.
- **Screens-Layer:** Must encapsulate screen components that are composed from UI components in the Components-Layer.  Screen components are leveraged in the App-Layer.
- **Utils-Layer:** Must encapsulate small standalone utilities such as date formatters, currency converters, data transformers, etc.
- **Hooks-Layer:** Must encapsulate code for custom hooks that contain and reuse stateful logic or side effects across multiple components.
  - **Reusable Logic:** When the same logic is needed in more than one compoent, this logic must be encapsulated in a custom hook and reused across components.
  - **State Management Logic:** Code that manages complex state logic must be placed in custom hooks for use in different parts of the Frontend App.
  - **API Calls/Data Fetching:** Logic for fetching data from an API, managing loading/error states, and handling the results must be placed in custom hooks.
  - **Event Listeners:** Logic for subscribing to events (like keyboard status, network status, or screen orientation) and managing their cleanup must be wrapped in a custom hook.
  - **Utility/Helper Function Wrappers:** While simple utility functions go in a Utils-Layer, if a utility requires access to React state or lifecycle methods, it becomes a custom hook.
  - **Theming/Styling Logic:** Logic that manages the Frontend App's theme or styling preferences and are useful for consistency across the Frontend App must be encapsulted in a custom hook.
  - **Single Responsibility:** Each custom hook should ideally be focused on one specific piece of logic to make it easier to test, reuse, and understand.
  - **No UI:** Custom hooks never return any UI components.
- **Unit Tests:** Unit tests must be collocated in the same directory and with same file name as the code it is testing with a file extension of `.test.ts` (e.g., `format-date.ts` would be tested by `format-date.test.ts`).

### Frontend App Technology Stack Requirements

The following technologies MUST be used unless explicitly amended:

- **Framework:** React Native + Expo
  - **JavaScript Runtime:** Node.js Latest LTS (v24.14.1)
  - **React Native JS Engine:** Hermes
  - **React Native Architecture:** JavaScript Interface (JSI)
  - **Package Manager:** pnpm
  - **Expo SDK:** Expo SDK 55 (must use `pnpm create expo-app --template default@sdk-55` to create an SDK 55 project)
  - **Dev Expo Build:** `eas build --local`
  - **Prod Expo Build:** `eas build`
- **Monorepo Build Tool Integration:** @nx/expo plugin for Nx
- **Backend-for-Frontend:** Expo Router API Routes implement BFF and deployed server-side (`app.json` web output set to server `"output": "server"`)
  - **BFF API:** Expo Router API Routes deployed in a Node.js Docker container with same version of Node as used by React Native and Expo (`node:24.14.1-alpine3.23`, and install glibc compatibility `RUN apk add --no-cache gcompat`)
  - **BFF Cache:** Session state cached in separate Redis in-memory database Docker container (Docker image `redis:8.6.2-alpine3.23`)
- **Protected Screens:** Expo Router must be used with protected routes to prevent access of screens that require authentication and authorization
- **Authentication Library:** Expo AuthSessssion (expo-auth-session) must be used for implementing authentication
- **Central Authentication Service:** Keycloak is responsible for authenticating the user and issuing signed, short-lived JWTs to the Frontend App
- **Secure Storage:** Expo SecureStore (expo-secure-store) must be used to encrypt and securely store sensitive key-value pairs on client device
- **JWT as Bearer Token:** The Frontend App must include the JWT Access Token in the `Authorization: Bearer` header for all API requests to Backend Services
- **HTTP Client:** Axios must be used for API calls
- **Monorepo for Multiple Frontend Apps Approach:** Each Frontend App project in the monorepo must have its own directory located at /frontend/{{app-name}}/
  - **Project File:** Each Frontend App in the monorepo must have its own project file located at /frontend/{{app-name}}/package.json
  - **Config File:** Each Frontend App in the monorepo must have its own config file located at /frontend/{{app-name}}/app.json
  - **Build File:** Each Frontend App in the monorepo must have its own build file located at /frontend/{{app-name}}/eas.json
  - **App-Layer:** All App-Layer code for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/app/
  - **BFF-Layer API Routes:** All BFF-Layer API routes for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/app/bff-api/
  - **BFF-Layer API Utilities:** All BFF-Layer utilities for the BFF-Layer API routes for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/bff-server/
  - **Components-Layer:** All Components-Layer code for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/components/
  - **Screens-Layer:** All Screens-Layer code for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/screens/
  - **Utils-Layer:** All Utils-Layer code for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/utils/
  - **Hooks-Layer:** All Hooks-Layer code for each Frontend App in the monorepo must be placed in the directory /frontend/{{app-name}}/src/hooks/

Deviations from this stack require constitution amendment with documented justification.

### Frontend App Quality Standards

- **Code Coverage**: Minimum 70% for new features (measured via coverage tools)
- **Linting**: All code must pass ESLint with no warnings
- **Formatting**: Prettier enforced in CI/CD
- **Documentation**: README updated for user-facing changes
- **Dependencies**: Regular audits via `npx expo-doctor`; security patches applied promptly

## Shared Packages and Libraries Principles

- **Monorepo for Shared Packages Approach:** Each Shared Package in the monorepo must have its own directory located at /packages/{{package-name}}/

## Monorepo Directory Structure

```tree
/
├── .gitignore
├── .dockerignore
├── .env
├── .env.local
├── compose.yaml  # References Dockerfile from each project
├── package.json  # Used by Bun/npm/Yarn to set up workspaces for the monorepo
├── README.md
├── docs/
│   └── ...  # Human-readable documentation, such as user guides, tutorials, and general project information
├── specs/
│   └── ...  # Detailed, structured documentation and artifacts for specific project features or work units - directed by the Human, generated by the AI Assistant, and used as single source of truth for the AI Assistant
├── api-specs/
│   └── ...  # OpenAPI specification (OAS) files, AsyncAPI specification files, and JSON schemas
├── scripts/
│   └── ...  # Script files
├── secrets/
│   └── ...  # Secret files
├── backend/
│   ├── service-1/
│   │   ├── .env
│   │   ├── .env.local
│   │   ├── src/
│   │   │   ├── domain/
│   │   │   │   └── ...  # Domain Objects
│   │   │   ├── application/
│   │   │   │   └── ...  # Use Cases and DTOs
│   │   │   ├── adapters/
│   │   │   │   └── ...  # Adapters, DAOs, and data access libraries for interacting with External Providers
│   │   │   ├── api/
│   │   │   │   └── ...  # Web Application Framework libraries, API Endpoints, and API Controllers
│   │   │   └── main.rs
│   │   ├── tests/
│   │   └── Dockerfile
│   ├── service-2/
│   │   ├── .env
│   │   ├── .env.local
│   │   ├── src/
│   │   │   ├── domain/
│   │   │   │   └── ...  # Domain Objects
│   │   │   ├── application/
│   │   │   │   └── ...  # Use Cases and DTOs
│   │   │   ├── adapters/
│   │   │   │   └── ...  # Adapters, DAOs, and data access libraries for interacting with External Providers
│   │   │   ├── api/
│   │   │   │   └── ...  # Web Application Framework libraries, API Endpoints, and API Controllers
│   │   │   └── main.rs
│   │   ├── tests/
│   │   └── Dockerfile
├── frontend/
│   ├── app-1/
│   │   ├── .env
│   │   ├── .env.local
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── bff-api/
│   │   │   │   │   └── ...  # BFF API routes to be run on server
│   │   │   │   └── ...  # Expo app code and defines navigation and routes
│   │   │   ├── bff-server/
│   │   │   │   └── ...  # Utilities for the BFF API routes to be run on server
│   │   │   ├── components/
│   │   │   │   └── ...  # Contains reusable UI components (e.g., buttons, sliders, cards)
│   │   │   ├── screens/
│   │   │   │   └── ...  # Definition of app screens
│   │   │   ├── utils/
│   │   │   │   └── ...  # Small standalone utilities such as date formatters, currency converters, data transformers, etc.
│   │   │   ├── hooks/
│   │   │   │   └── ...  # Definition of custom hooks that encapsulate and reuse stateful logic or side effects across multiple components
│   │   ├── app.json
│   │   ├── eas.json  # EAS config file defines how target platform apps are built
│   │   └── package.json
│   ├── app-2
│   │   ├── .env
│   │   ├── .env.local
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── bff-api/
│   │   │   │   │   └── ...  # BFF API routes to be run on server
│   │   │   │   └── ...  # Expo app code and defines navigation and routes
│   │   │   ├── bff-server/
│   │   │   │   └── ...  # Utilities for the BFF API routes to be run on server
│   │   │   ├── components/
│   │   │   │   └── ...  # Contains reusable UI components (e.g., buttons, sliders, cards)
│   │   │   ├── screens/
│   │   │   │   └── ...  # Definition of app screens
│   │   │   ├── utils/
│   │   │   │   └── ...  # Small standalone utilities such as date formatters, currency converters, data transformers, etc.
│   │   │   ├── hooks/
│   │   │   │   └── ...  # Definition of custom hooks that encapsulate and reuse stateful logic or side effects across multiple components
│   │   ├── app.json
│   │   ├── eas.json  # EAS config file defines how target platform apps are built
│   │   └── package.json
├── packages/
├── infrastructure-as-code/
│   │   ├── docker/
│   │   └── terraform/
└── migrations/
```

## Architecture Diagrams

Important architecture diagrams to guide an AI Assistant when developing Frontend Apps and Backend Services in this software ecosystem.

### C4 Container Diagram

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
    app1_user["**App 1 User**<br/>Accesses App 1 via web browser and mobile device"]
    app2_user["**App 2 User**<br/>Accesses App 2 via web browser"]
    
    subgraph software_ecosystem["**Software Ecosystem**"]
        subgraph frontend["**Frontend Apps**"]
            subgraph app1["**App 1**"]
                subgraph app1_client["**App 1 Client**"]
                    app1_web["**Web App**<br/>*React Native Expo Client - Web*<br/>Handles web-based UI rendering and interactions"]
                    app1_mobile["**Mobile App**<br/>*React Native Expo Client - Mobile*<br/>Handles mobile UI rendering and interactions"]
                end
                subgraph app1_bff["**App 1 BFF**"]
                    app1_bff_api["**App 1 BFF API**<br/>*React Native Expo Router API Routes in Node.js Docker Container*<br/>A thin, secure layer that must encapsulate server-side API routes using the Backend for Frontend pattern"]
                    app1_bff_cache[("**App 1 BFF Cache**<br/>*Redis in-memory database in Docker Container*<br/>Caches session state for App 1 BFF")]
                end
            end
            subgraph app2["**App 2**"]
                subgraph app2_client["**App 2 Client**"]
                    app2_web["**Web App**<br/>*React Native Expo Client - Web*<br/>Handles web-based UI rendering and interactions"]
                end
                subgraph app2_bff["**App 2 BFF**"]
                    app2_bff_api["**App 2 BFF API**<br/>*React Native Expo Router API Routes in Node.js Docker Container*<br/>A thin, secure layer that must encapsulate server-side API routes using the Backend for Frontend pattern"]
                    app2_bff_cache[("**App 2 BFF Cache**<br/>*Redis in-memory database in Docker Container*<br/>Caches session state for App 2 BFF")]
                end
            end
        end
        
        subgraph backend["**Backend Services**"]
            subgraph service1["**Service 1**"]
                service1_api["**Service 1 API**<br/>*Rust + Axum Microservice in Docker Container*<br/>Handles Service 1 use cases and logic"]
                service1_db[("**Service 1 Database**<br/>*PostgreSQL Database in Docker Container*<br/>Stores Service 1 data")]
            end
            subgraph service2["**Service 2**"]
                service2_api["**Service 2 API**<br/>*Rust + Axum Microservice in Docker Container*<br/>Handles Service 2 use cases and logic"]
                service2_db[("**Service 2 Database**<br/>*MongoDB Database in Docker Container*<br/>Stores Service 2 data")]
            end
        end
    end
    
    keycloak["**Identity and Access Management (IAM)**<br/>*Keycloak*<br/>Manages user identities, authentication, SSO, and permissions"]
    
    app1_user -->|Uses| app1_web
    app1_user -->|Uses| app1_mobile
    app2_user -->|Uses| app2_web
    
    app1_web -->|Calls REST| app1_bff_api
    app1_mobile -->|Calls REST| app1_bff_api
    app2_web -->|Calls REST| app2_bff_api
    
    app1_bff_api -->|Reads/Writes NoSQL| app1_bff_cache
    app2_bff_api -->|Reads/Writes NoSQL| app2_bff_cache
    
    app1_bff_api -->|Routes to REST/GraphQL| service1_api
    app1_bff_api -->|Routes to REST/GraphQL| service2_api
    app2_bff_api -->|Routes to REST/GraphQL| service1_api
    app2_bff_api -->|Routes to REST/GraphQL| service2_api
    
    service1_api -->|Reads/Writes SQL| service1_db
    service2_api -->|Reads/Writes NoSQL| service2_db
    
    app1_bff_api -->|Authenticates REST| keycloak
    app2_bff_api -->|Authenticates REST| keycloak
    service1_api -->|Validates token REST| keycloak
    service2_api -->|Validates token REST| keycloak
  end

  class c4_container_diagram style_background;
  class software_ecosystem style_sub1;
  class frontend,backend style_sub2;
  class app1,app2,service1,service2 style_sub3;
  class app1_client,app2_client,app1_bff,app2_bff style_sub4;
```

### Diagram for Auth Flow - Login

```mermaid
---
config:
  theme: redux-dark-color
  look: neo
---
sequenceDiagram
  actor User
  participant ReactNativeUI as React Native UI
  participant Browser as Browser<br/>(Login Screen)
  participant BFF as BFF<br/>(Backend for Frontend)
  participant IAM as IAM Service

  User->>ReactNativeUI: 1. user clicks signin button
  ReactNativeUI->>BFF: 2. client fetches URL to start authentication code flow request<br/>from BFF and tells Browser to go to that URL
  Browser->>IAM: 3. browser opens IAM service's authorization endpoint
  IAM-->>Browser: 4. IAM service redirects the browser to the login page
  Browser->>IAM: 5. browser opens login page
  User->>Browser: 6. user enters credentials
  Browser->>IAM: 7. browser posts user's credentials to IAM service
  IAM-->>Browser: 8. IAM service verifies user's credentials<br/>and redirects browser to revist authorization endpoint
  Browser->>IAM: 9. browser revists authorization endpoint
  IAM-->>Browser: 10. IAM service redirects browser to callback URL
  Browser->>BFF: 11. browser calls callback URL with additional<br/>query parameters including one-time authorization 'code'
  activate BFF
  BFF->>IAM: 12. BFF requests IAM service's token endpoint, supplying client credentials and authorization 'code'
  IAM-->>BFF: 13. IAM service validates client credentials and authorization 'code'<br/>and returns ID token, access token, and refresh token
  BFF->>BFF: 14. BFF stores tokens in session cache
  BFF-->>Browser: 15. BFF redirects browser to home
  deactivate BFF
  Browser->>BFF: 16. browser gets home page, setting the session cookie
  Browser->>ReactNativeUI: 17. browser loads React Native UI
```

### Diagram for Auth Flow - Access Backend Service Resources

```mermaid
---
config:
  theme: redux-dark-color
  look: neo
---
sequenceDiagram
  actor User
  participant ReactNativeUI as React Native UI
  participant BFF as BFF<br/>(Backend for Frontend)
  participant Backend as Backend Service<br/>(OAuth2 Resource Server)
  participant IAM as IAM Service

  Backend->>IAM: 1. on startup, backend service fetches<br/>public key for JWT signature verification from IAM service
  IAM-->>Backend: 2. IAM service returns public key
  ReactNativeUI->>BFF: 3. client makes HTTP GET request to BFF which includes session cookie
  BFF->>BFF: 4. BFF extracts access token from session
  BFF->>Backend: 5. BFF includes access token in request to backend service
  activate Backend
  Backend->>Backend: 6. backend service validates requests's JWT<br/>using the public key obtained from IAM service
  Backend->>Backend: 7. backend service reads JWT's identity and<br/>authorization claims and uses them for permission checks
  Backend-->>BFF: 8. backend service returns a response to BFF
  deactivate Backend
  BFF-->>ReactNativeUI: 9. BFF returns the response to the client
```

## Governance

This constitution supersedes all other practices and conventions. Amendments require:

1. **Proposal**: Document rationale, impact on existing code, and migration plan
2. **Review**: Community discussion and formal approval
3. **Version Bump**: MAJOR for principle changes, MINOR for guidance additions, PATCH for clarifications
4. **Migration**: Existing code aligned with new principles within one release cycle

All pull requests and code reviews MUST verify compliance with active principles. Violations flagged in review require justification or code modification before merge. Complexity decisions justified in code comments when they challenge constitutional principles.

Development guidance and implementation examples are maintained in [docs/development.md](docs/development.md) (separate from constitution).

**Version**: 1.0.1 | **Ratified**: 2026-03-08 | **Last Amended**: 2026-03-29
