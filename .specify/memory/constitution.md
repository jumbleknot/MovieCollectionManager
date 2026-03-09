<!-- 
SYNC IMPACT REPORT - Constitution v1.0.0 (Comprehensive Edition)
================================================================
Version: 1.0.0 (Initial Comprehensive Ratification)
Ratification Date: 2026-03-08
Last Amendment Date: 2026-03-08

CORE PRINCIPLES ESTABLISHED:
✅ AI Assistant Constraints (NON-NEGOTIABLE)
✅ Security, Authentication & Authorization (NON-NEGOTIABLE)
✅ Test-Driven Development (NON-NEGOTIABLE)
✅ Common Technology Stack and Standards

BACKEND SERVICES PRINCIPLES:
✅ Bounded Contexts
✅ Decoupling via APIs/Messaging
✅ Enforce Isolation
✅ Stateless Processes
✅ Independent Deployment
✅ API-First Design (REST/GraphQL/gRPC/WebSocket/Webhook)
✅ Docker-Native Operations
✅ Clean Architecture (4 Layers: Domain, Application, Adapters, API)
✅ Rust Safety First
✅ Technology Stack: Rust, Axum, Tokio, Tower, Serde, SQLx, PostgreSQL, Docker
✅ Quality Standards: 70% coverage, clippy, fmt, cargo audit

FRONTEND APP PRINCIPLES:
✅ Differentiated Experiences
✅ Universal Frontend Apps (shared codebases)
✅ No Domain Logic
✅ Frontend Separation of Concerns (5 Layers: App, Components, Screens, Utils, Hooks)
✅ Technology Stack: React Native, Expo, Hermes, Keycloak, Axios
✅ Quality Standards: 70% coverage, ESLint, Prettier, expo-doctor

SHARED PACKAGES PRINCIPLES:
✅ Monorepo organization at /packages/{{package-name}}/

MONOREPO STRUCTURE:
✅ Complete detailed folder hierarchy defined
✅ Backend: /backend/{{service-name}}/src/{{domain|application|adapters|api}}/
✅ Frontend: /frontend/{{app-name}}/src/{{app|components|screens|utils|hooks}}/
✅ API Specs: /api-specs/
✅ Documentation: /docs/, /specs/
✅ Scripts: /scripts/

GOVERNED BY:
✅ Amendment procedure: Proposal → Review → Version bump → Migration
✅ Compliance enforcement: All PRs/reviews verify adherence
✅ Development guidance: Maintained in docs/development.md

NO REMAINING PLACEHOLDER TOKENS: ✅
ALL SECTIONS COMPLETE: ✅

DEPENDENT TEMPLATES STATUS:
✅ plan-template.md - "Constitution Check" section ready
✅ spec-template.md - Generic structure compatible
✅ tasks-template.md - Task organization aligned
✅ checklist-template.md - No constitution dependencies
✅ agent-file-template.md - Development guidance section ready
-->

# MovieCollectionManager Constitution

This document outlines the core, immutable principles for developing Frontend Apps and Backend Services within this software ecosystem.

## Core Principles

The following Core Principles apply to Backend Services development, Frontend Apps development, and cross-cutting concerns

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

- **Deny By Default:** Except for public resources, deny access by default.
- **Authentication:** All API endpoints require JWT token authentication via OAuth2/OIDC.
- **Authorization:** Role-Based Access Control (RBAC) must be implemented.
- **Least Privilege:** All services must implement authentication and authorization mechanisms appropriate to their data sensitivity, adhering to the principle of least privilege.
- **Declarative Access Controls:** Use well-established toolkits or patterns that provide simple, declarative access controls.
- **Security Best Practices:**
  - Always use Authorization Code Flow with PKCE for security. Avoid Implicit Flow.
  - Validate ID token signatures, `iss` (issuer), `aud` (audience), and `exp` (expiration).
  - Store sensitive information like client secrets and private cookie keys in environment variables.
  - Enforce TLS 1.3 for all communication.
  - Encrypt data at rest.
  - Use a server-side store (database, Redis) for session data, storing only an opaque session ID in the client's cookie or JWT.
  - Implement access control mechanisms once and reuse them throughout the application, including minimizing Cross-Origin Resource Sharing (CORS) usage.
  - Disable web server directory listing and ensure file metadata (e.g., .git) and backup files are not present within web roots.
  - Log access control failures, alert admins when appropriate (e.g., repeated failures).
  - Implement rate limits on API and controller access to minimize the harm from automated attack tooling.
  - Stateful session identifiers should be invalidated on the server after logout. Stateless JWT tokens should be short-lived to minimize the window of opportunity for an attacker. For longer-lived JWTs, consider using refresh tokens and following OAuth standards to revoke access.
  - Treat all user input as untrusted and malicious by default, adopting a "never trust, always verify" mindset. Implement server-side, whitelist-based validation early in the data lifecycle, enforcing strict type, length, and format checks to prevent injection attacks.

### Test-Driven Development (NON-NEGOTIABLE)

TDD is mandatory: Test cases written → User approval → Tests fail → Implementation → Tests pass → Refactor. Unit tests exercise individual functions/methods. Integration tests verify service-to-service and service-to-database contracts. Code changes without corresponding test coverage are not permitted.

### Common Technology Stack and Standards

- **Git Management:** Use a single root-level `.gitignore` file for the monorepo (e.g., /.gitignore).
- **Environment Files:**
  - Create a root `.env` and `.env.local` for shared configuration, but use individual `.env` and `.env.local` files in each project (e.g., /backend/{{service-name}}/.env, /frontend/{{app-name}}/.env) for project specific configuration.
  - Always add `*.env` and `*.env.*` to the root `.gitignore` to prevent committing sensitive secrets.

## Backend Services Development Principles

The software's backend is organized and divided into Backend Service projects that represent the various problem spaces, or Domains, the software is designed to solve. The following Principles apply to Backend Services development.

- **Bounded Contexts:** Each Backend Service must focus on a single Domain within a clearly defined bounded context.
- **Decoupling:** Backend Services should be loosely coupled, communicating via well-defined APIs or asynchronous messaging, avoiding direct database access across service boundaries.
- **Enforce Isolation:** A Backend Service should not have direct dependencies on internal components of a different Backend Service and should not directly import each other's code, except for shared contracts.
- **Stateless Processes:** Backend Services' processes should be stateless where possible to facilitate scalability and resilience.
- **Independent Deployment:** Ensure that changes in one Backend Service do not necessitate a full redeployment of unrelated Backend Services.

### API-First Design

Every feature must expose its functionality in Backend Services through well-defined APIs. Backend Services expose endpoints that clients (web, mobile, CLI) consume.

- **Allowed API Architecture Styles:** REST, GraphQL, gRPC, WebSocket, and Webhook are the only allowed API architecture styles.  SOAP APIs are not allowed.
- **Specification-First:** All API changes must start by updating the API Specification files in the /api-specs directory.
- **API Contracts:** API contracts must be explicitly defined and treated as a single source of truth.
- **REST Guidelines:**
  - **API Specification:** Document APIs with OpenAPI 3.0.3 YAML format.
  - **RESTful Design:** APIs must adhere to standard RESTful conventions (e.g., use of HTTP verbs, status codes).
  - **Versioning:** APIs must use URL path versioning (e.g., /api/v1/resource).
  - **Data Format:** JSON is the mandatory data interchange format for all API requests and responses.
  - **Validation:** All endpoints must have defined request/response schemas.
  - **Naming:** Use kebab-case for URL paths and camelCase for JSON properties.
  - **Standard Responses:** Use standard HTTP status codes (200, 201, 400, 401, 404, 500).
  - **Error Handling:** Error responses must follow the Problem Details for HTTP APIs standard specified in RFC 9457.

### Docker-Native Operations

All Backend Services MUST run in Docker containers. Backend Services are stateless and horizontally scalable when possible. Configuration via environment variables. Health checks and graceful shutdown implemented. Compose files provided for local multi-service development.

### Clean Architecture

Backend Service code is orgnized into layers that promotes separation of concerns. A Backend Service's core logic and domain models MUST be independent of external agencies such as clients, repositories, other services, and frameworks. Data access layers are abstracted via traits/interfaces. Tests use in-memory or mock implementations. Database choice (SQL, NoSQL, etc.) is an implementation detail, not a constraint on the core Backend Service logic. Each Backend Service code is broken down into 4 layers: Domain Layer, Application Layer, Adapters Layer, API Layer.

- **Domain Layer:** Contains the Backend Service's Domain Objects.
  - The Domain Layer is independent - no change to any other layer or external agencies should affect the Domain Layer.
  - Domain Objects represent real-world objects or concepts and their attributes and behaviors with data structures, relationships, rules, and methods.
  - Domain Objects include entities, value objects, aggregates, and domain services.
  - The Domain Layer encapsulates domain-specific validation rules with the Specification Pattern by defining a generic specification interface, a  base class that implements the generic specification interface, and one or more domain-specific validation rule specifications that implements the base class with the domain-specific validation rules.
    - The Specification Pattern should only be used for validation logic and should not be used for query logic.
  - The Domain Layer defines domain-specific rules and domain-specific errors where rule violations are represented using a Typed Result Pattern to explicitly handle success or failure states.
- **Application Layer:** Encapsulate and implements all of the Backend Service's use cases.
  - The Application Layer is dependent on the Domain Layer - changes to the Domain Layer could affect the Application Layer.
  - The Application Layer is independent of all other layers - no change to any other layer or external agencies should affect the Application Layer.
  - The Application Layer achieves the goals of the Backend Service's use cases by performing application-specific logic and validation, interacting with Adapter Interfaces, and orchestrating interactions with Domain Objects including updating their state as needed.
  - The Application Layer leverages the CQRS Pattern to implement separate command and query handlers.
  - The Application Layer operates solely on Domain Objects and Data Transfer Objects (DTOs) and does not operate on Data Access Objects (DAOs).
  - The Application Layer defines use case specific Request DTOs and Response DTOs for communicating with the API Layer, decoupling the Domain Objects from external systems including API clients and messaging systems.
    - The Application Layer command and query handlers consume Request DTOs as arguments passed to it from the API Layer, performs any necessary validation on the inputs, and maps them to Domain Objects, calling Domain Object methods.
    - The Application Layer maps Domain Objects to Response DTOs to return use case responses to the requesting API Layer methods.
  - The Application Layer leverages Dependency Inversion to interact with External Providers (e.g., a database, a message broker, an external API, or third party libraries) - commands and queries for External Providers are defined as Adapter Interfaces in the Application Layer (implemented in the Adapters Layer) that specify the contract for data operations (e.g., `GetById(id)` , `Save(entity)` ) passing Domain Objects as arguments and return types.
  - The Application Layer handles a Backend Service's application specific concerns like logging, applying least privilege controls (e.g., authorization, role based access control), and transaction management.
  - The Application Layer is responsible for validating its own command and query objects.
  - The Application Layer receives the generalized errors from the outer layers (via Adapter Interfaces) and decides the appropriate application response - this can include logic to make decisions based on the error type, for example, logging the error or determining if a different action is needed.
- **Adapters Layer:** Contains the Backend Service's adapters to External Providers (e.g., a database, a message broker, an external API, or third party libraries).
  - The Adapters Layer is dependent on the Domain Layer and the Application Layer - changes to the Domain Layer or the Application Layer could affect the Adapters Layer.
  - The Adapters Layer is independent of the API Layer - changes to the API Layer should not affect the Adapters Layer.
  - The Adapters Layer is dependent on External Providers - changes to External Providers can affect the Adapters Layer.
  - The Adapters Layer prevents tight coupling of your Backend Service to your External Providers.
  - The Adapters Layer leverages the Repository Pattern for the communication with External Providers - converting data from the format most convenient for the Domain Layer and Application Layer, to the format most convenient for External Providers.
    - The Adapters Layer defines Data Access Objects (DAOs) which are structs specifically mapped to an External Provider data format.
    - The Adapters Layer leverages the CQRS Pattern to implement separate command and query Adapter Interfaces (defined in Application Layer) that accept and return Domain Objects, map Domain Objects to DAOs, and fetch or persist data from the External Provider using a data access library (e.g., SQLx for Rust access to relational databases) or direct driver (e.g., mongodb crate for Rust access to MongoDB).
    - To ensure transparency and performance, the Adapters Layer should not leverage an Object Relational Mapper (ORM) and should not leverage the Specification Pattern for command or query logic.
  - The Adapters Layer includes configuration management, initialization and logging for External Providers.
  - The Adapters Layer deals with low-level errors from external systems (databases, APIs, network failures) - it should catch specific, technology-dependent exceptions (e.g., `SqlException` or `IOException`) and translate them into a generic, domain-agnostic error model or custom domain exception (e.g., `StorageUnavailableException` or `NetworkError`).
- **API Layer:** Is the entry point of your Backend Service that contains the Backend Service's API definition.
  - The API Layer is dependent on the Domain Layer and the Application Layer - changes to the Domain Layer or the Application Layer could affect the API Layer.
  - The API Layer is independent of the Adapters Layer - changes to the Adapters Layer should not affect the API Layer.
  - The API Layer allows clients or other Backend Services to communicate with this Backend Service via defined interfaces and protocols (e.g., HTTP, gRPC, message queues).
  - The API Layer is the entry point of your Backend Service, using a web application framework (e.g. Axum) to receive and parse incoming request data, route requests to handlers (call into the Application Layer's use cases), and return properly formatted responses over the selected protocol.
  - The API Layer encapsulates endpoint definitions, controllers, serialization and deserialization of the data, validation and error handling.
  - The API Layer leverages the CQRS Pattern to define separate command and query endpoints.
  - The API Layer uses Request DTOs and Response DTOs defined in the Application Layer to communicate with the Application Layer.
  - The API Layer API controller receives the raw request via an API endpoint, deserializes it, maps the data to a Request DTO, performs any necessary basic validation, and uses a mediator to dynamically route the command or query to its specific Application Layer handler passing the Request DTO as an argument.
  - The Application Layer handler returns a Response DTO to the API Layer API controller via the mediator, and the API controller formats the appropriate response to return to the requestor.
  - The API Layer is responsible for catching unhandled exceptions, logging them, and returning a consistent, non-sensitive error response to the requestor - it should not contain the logic for how to handle the error.
  - The API Layer should contain a health check endpoint to determine the status of the Backend Service.
- **Error Handling in Clean Architecture:**
  - Errors are produced in the outer layers (API Layer, Adapters Layer) and are caught, translated, and handled as they are passed inward to the Application Layer and finally returned by the API Layer to the requestor.
  - Typed Result Pattern: make the possibility of failure explicit in a method's signature and force the caller to handle both success and failure cases using a `Result<T, E>` enum which represents either success or failure.
  - Exception Propagation: Errors can be thrown and allowed to bubble up to a layer with enough context to handle them appropriately - the key is to wrap low-level exceptions in custom, higher-level exceptions as they cross layer boundaries to prevent dependency leaks.

### Rust Safety First

Leverage Rust's type system, ownership rules, and borrowing semantics to eliminate entire categories of bugs (memory safety, data races). Use idiomatic Rust patterns; avoid unsafe blocks unless absolutely justified with documentation. Dependencies kept minimal and vetted for security and maintenance status.

### Backend Service Technology Stack Requirements

The following technologies MUST be used unless explicitly amended:

- **Language**: Rust
- **Web Framework**: Axum with Tokio async runtime
- **Networking Library:** Tower
- **Serialize and Deserialize:** Serde
- **Session Management:** tower-sessions
- **CSRF Protection:** axum-tower-sessions-csrf
- **Authentication Library:** axum-oidc
- **Authorization Protocol:** oauth2 crate
- **Identity Validation:** Each Backend Service validates the incoming JWT by calling Keycloak central authentication service to confirm the user's identity
- **Authorization Management:** axum-gate crate must be used for authorization middleware and implementation of RBAC by using the claims on the validated JWT to make authorization decisions
- **Backend HTTP Client:** reqwest crate must be used as Backend Service HTTP Client (e.g., for making Backend Service API calls to Keycloak)
- **Mediator Library:** medi-rs must be used for dynamically routing commands, queries, and events from the API Layer controller to the Application Layer handler
- **Relational Database Access:** SQLx is the only approved data access library for relational databases
- **Document Database Access:** mongodb crate is the only approved data access library for document databases
- **Relational Database:** PostgreSQL is the standard relational database for persistent storage
- **Document Database:** mongodb is the standard document database for persistent storage
- **Configuration:** All configuration (credentials, feature flags, etc.) must be stored in the environment (environment variables), not in the codebase
- **Logging & Monitoring:** Standardized logging formats (e.g., JSON) and tracing headers must be used to ensure seamless integration with the centralized monitoring system (Prometheus/Grafana)
- **Testing Standards:** cargo test; unit tests are mandatory for all new features and bug fixes, aiming for high code coverage, and integration tests must be added to validate API contracts
- **Containerization**: Docker and Docker Compose
- **Build**: Cargo with semantic versioning (MAJOR.MINOR.PATCH)
- **Folder and File Naming:** Use kebab-case for all folder and file names
- **Monorepo for Multiple Backend Services Approach:** Each Backend Service project in the monorepo should have its own folder located at /backend/{{service-name}}/
  - **Project File:** Each Backend Service in the monorepo should have its own project file located at /backend/{{service-name}}/src/main.rs
  - **Domain Layer:** All Domain Layer code for each Backend Service in the monorepo should be placed in the folder /backend/{{service-name}}/src/domain/
  - **Application Layer:** All Application Layer code for each Backend Service in the monorepo should be placed in the folder /backend/{{service-name}}/src/application/
  - **Adapters Layer:** All Adapters Layer code for each Backend Service in the monorepo should be placed in the folder /backend/{{service-name}}/src/adapters/
  - **API Layer:** All API Layer code for each Backend Service in the monorepo should be placed in the folder /backend/{{service-name}}/src/api/
  - **Unit Tests:**  Unit tests are placed in each file with the code that they’re testing encapsulated within an annotated tests block
  - **Integration Tests:** Each Backend Service in the monorepo should have its own folder for integration tests located at /backend/{{service-name}}/tests/
  - **Dockerfile:** Each Backend Service in the monorepo should have its own dedicated Dockerfile located at /backend/{{service-name}}/Dockerfile
  - **Docker Build:** When building an image for a specific Backend Service, the build command is run from the repository root with the build context set to the entire repository and specifying the specific Backend Service's Dockerfile using the `-f` flag

Deviations from this stack require constitution amendment with documented justification.

### Backend Service Quality Standards

- **Code Coverage**: Minimum 70% for new features (measured via coverage tools)
- **Linting**: All code must pass `cargo clippy` with no warnings
- **Formatting**: `cargo fmt` enforced in CI/CD
- **Documentation**: README updated for user-facing changes
- **Dependencies**: Regular audits via `cargo audit`; security patches applied promptly

## Frontend App Development Principles

The software's multi-experience frontend is organized and divided into separate Frontend App projects that provide differentiated user experiences for user types with different objectives (e.g., consumer website and mobile app vs administrator website).  The following Principles apply to Frontend App development.

- **Differentiated Experiences:** When different user types have non-overlapping objectives, each differentiated experience should be developed in separate Frontend App projects with separate codebases.
- **Universal Frontend Apps:** When the same experience is needed in multiple channels (e.g. website and mobile app), this should leverage a shared codebase in a single Frontend App project - allowing the same codebase and routing to work across web, Android, and iOS.
- **No Domain Logic:** Frontend Apps should not contain any domain logic. Frontend Apps should accomplish all domain tasks by communicating with Backend Services over their defined APIs.

### Frontend Separation of Concerns

Each Frontend App code should be structured into 5 distinct layers: App Layer, Components Layer, Screens Layer, Utils Layer, and Hooks Layer.

- **App Layer:** Core Frontend App code that defines the navigation and routes.
  - **File-based Routing:** Frontend App navigation utilizes file-based routing system.
  - **Routes Return Screen Components:** Routes don't define screen components - every route simply returns a screen component from the Screen Layer.
- **Components Layer:** Contains reusable UI components (e.g., buttons, sliders, cards).
  - **One Named Export:** Each component will generally have one named export.
  - **File Name:** The filename is the a kebab-case version of the component name followed by file extension (e.g., `my-component.tsx`, `my-component.android.tsx`).
  - **Platform Specific Code:** Separate components for web and native targets are placed in separate files with platform-specific file extensions (e.g., `.web`, `.native`, `.ios`, `.android`).  When referencing the component, the code should import without the platform-specific file extension.  The props for the component should be identical for all platform-specific files.  A default version of the component without a platform-specific extension is required - the default should be for web.
  - **Style objects:** Style objects should be placed at the bottom of the component files.
- **Screens Layer:** Defines screen components that are composed from UI components in the Components Layer.  Screen components are leveraged in the App Layer.
- **Utils Layer:** Place for small standalone utilities such as date formatters, currency converters, data transformers, etc.
- **Hooks Layer:** Place code for custom hooks that encapsulate and reuse stateful logic or side effects across multiple components.
  - **Reusable Logic:** When the same logic is needed in more than one compoent, this logic should be encapsulated in a custom hook and reused across components.
  - **State Management Logic:** Code that manages complex state logic should be placed in custom hooks for use in different parts of the Frontend App.
  - **API Calls/Data Fetching:** Logic for fetching data from an API, managing loading/error states, and handling the results should be placed in custom hooks.
  - **Event Listeners:** Logic for subscribing to events (like keyboard status, network status, or screen orientation) and managing their cleanup should be wrapped in a custom hook.
  - **Utility/Helper Function Wrappers:** While simple utility functions go in a Utils Layer, if a utility requires access to React state or lifecycle methods, it becomes a custom hook.
  - **Theming/Styling Logic:** Logic that manages the Frontend App's theme or styling preferences and are useful for consistency across the Frontend App should be encapsulted in a custom hook.
  - **Single Responsibility:** Each custom hook should ideally be focused on one specific piece of logic to make it easier to test, reuse, and understand.
  - **No UI:** Custom hooks should contain logic and not return any UI components.
- **Unit Tests:** Unit tests should be collocated in the same folder and with same file name as the code it is testing with a file extension of `.test.ts` (e.g., `format-date.ts` would be tested by `format-date.test.ts`).

### Frontend App Technology Stack Requirements

The following technologies MUST be used unless explicitly amended:

- **Framework:** React Native + Expo
  - **React Native JS Engine:** Hermes
  - **React Native Architecture:** JavaScript Interface (JSI)
- **Protected Screens:** Use Expo Router with protected routes to prevent access of screens that require authentication and authorization
- **Authentication Library:** Use Expo AuthSessssion (expo-auth-session) for implementing authentication
- **Identity Provider:** Keycloak central authentication service is responsible for authenticating the user and issuing signed, short-lived JWTs to the Frontend App
- **Secure Storage:** Expo SecureStore (expo-secure-store) must be used to encrypt and securely store sensitive key-value pairs on client device
- **JWT as Bearer Token:** The Frontend App includes the JWT Access Token in the ' Authorization: Bearer ' header for all API requests to Backend Services
- **HTTP Client:** Axios must be used for API calls
- **Monorepo for Multiple Frontend Apps Approach:** Each Frontend App project in the monorepo should have its own folder located at /frontend/{{app-name}}/
  - **Project File:** Each Frontend App in the monorepo should have its own project file located at /frontend/{{app-name}}/package.json
  - **Config File:** Each Frontend App in the monorepo should have its own config file located at /frontend/{{app-name}}/app.json
  - **Build File:** Each Frontend App in the monorepo should have its own build file located at /frontend/{{app-name}}/eas.json
  - **App Layer:** All App Layer code for each Frontend App in the monorepo should be placed in the folder /frontend/{{app-name}}/src/app
  - **Components Layer:** All Components Layer code for each Frontend App in the monorepo should be placed in the folder /frontend/{{app-name}}/src/components
  - **Screens Layer:** All Screens Layer code for each Frontend App in the monorepo should be placed in the folder /frontend/{{app-name}}/src/screens
  - **Utils Layer:** All Utils Layer code for each Frontend App in the monorepo should be placed in the folder /frontend/{{app-name}}/src/utils
  - **Hooks Layer:** All Hooks Layer code for each Frontend App in the monorepo should be placed in the folder /frontend/{{app-name}}/src/hooks

Deviations from this stack require constitution amendment with documented justification.

### Frontend App Quality Standards

- **Code Coverage**: Minimum 70% for new features (measured via coverage tools)
- **Linting**: All code must pass ESLint with no warnings
- **Formatting**: Prettier enforced in CI/CD
- **Documentation**: README updated for user-facing changes
- **Dependencies**: Regular audits via `npx expo-doctor`; security patches applied promptly

## Shared Packages and Libraries Principles

- **Monorepo for Shared Packages Approach:** Each Shared Package in the monorepo should have its own folder located at /packages/{{package-name}}/

## Monorepo Folder Structure

/
├── .gitignore
├── .env
├── .env.local
├── README.md
├── package.json  # Used by Bun/npm/Yarn to set up workspaces for the monorepo
├── docs/
│   └── ...  # Human-readable documentation, such as user guides, tutorials, and general project information
├── specs/
│   └── ...  # Detailed, structured documentation and artifacts for specific project features or work units - directed by the Human, generated by the AI Assistant, and used as single source of truth for the AI Assistant
├── scripts/
│   └── ...  # Script files
├── api-specs/
│   └── ...  # OpenAPI specification (OAS) files, AsyncAPI specification files, and JSON schemas
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
│   │   │   │   └── ...  # Expo app code and defines navigation and routes
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
│   │   │   │   └── ...  # Expo app code and defines navigation and routes
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
└── migrations/

## Governance

This constitution supersedes all other practices and conventions. Amendments require:

1. **Proposal**: Document rationale, impact on existing code, and migration plan
2. **Review**: Community discussion and formal approval
3. **Version Bump**: MAJOR for principle changes, MINOR for guidance additions, PATCH for clarifications
4. **Migration**: Existing code aligned with new principles within one release cycle

All pull requests and code reviews MUST verify compliance with active principles. Violations flagged in review require justification or code modification before merge. Complexity decisions justified in code comments when they challenge constitutional principles.

Development guidance and implementation examples are maintained in [docs/development.md](docs/development.md) (separate from constitution).

**Version**: 1.0.0 | **Ratified**: 2026-03-08 | **Last Amended**: 2026-03-08
