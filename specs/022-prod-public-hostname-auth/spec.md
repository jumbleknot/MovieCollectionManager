# Feature Specification: Production Public-Hostname Authentication

**Feature Branch**: `022-prod-public-hostname-auth`

**Created**: 2026-06-22

**Status**: Draft

**Input**: User description: "Production Keycloak & BFF configuration for the public hostname so external (off-network) mobile and web login works over mcm.${BASE_DOMAIN} / auth.${BASE_DOMAIN}. Scope is defined by docs/proposals/homelab-setup/Phase-11-Work-Order.md (Parts A–D); use PRD-CI.md, Server-Setup-Runbook.md, and keycloak-prod.compose.yaml for additional context."

## Overview

Today the app's authentication works only against local/dev hostnames (`localhost:8099`, emulator `10.0.2.2`). A user away from the home network cannot log in: the mobile app's baked backend URL, the identity provider's token issuer, and the allowed redirect targets all point at non-public addresses, so the OAuth round-trip fails. This feature produces the **production configuration** — as committed config-as-code — that lets a real user on a phone or browser, **off the home network**, sign in over the public hostnames `mcm.${BASE_DOMAIN}` (application) and `auth.${BASE_DOMAIN}` (identity). It deliberately does not change application behavior or business logic; it changes only how the production deployment is addressed, secured, and wired for the public origin.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Production identity provider on the public auth hostname (Priority: P1)

A person responsible for the deployment stands up the identity provider in production posture so that, on the public `auth.` hostname, it issues tokens whose issuer matches what clients see, while its administrative surface stays off the public internet. This slice is independently deployable today (it depends only on an upstream image, not on the application build pipeline).

**Why this priority**: Every other part of login depends on the identity provider answering correctly on the public hostname with a consistent token issuer. Without it, no client — web or mobile — can complete sign-in. It is also the only slice that can ship before the application image pipeline exists, so it unblocks everything else.

**Independent Test**: Deploy the production identity provider, then from a public network request its OpenID discovery document at the public `auth.` hostname and confirm the advertised issuer is the public `auth.` origin (not an internal/loopback host); confirm the realm, its application client, and the application roles are present; confirm the admin console is reachable only over the private admin network and returns nothing on the public hostname.

**Acceptance Scenarios**:

1. **Given** the production identity provider is deployed, **When** a client fetches the OpenID discovery document over the public `auth.` hostname, **Then** the advertised issuer equals the public `auth.` origin and the signing keys are served.
2. **Given** the production identity provider is running, **When** an operator opens the admin console URL on the public `auth.` hostname, **Then** the admin console is not served there; it is reachable only over the private admin (tailnet) address.
3. **Given** the realm is imported, **When** the realm is inspected, **Then** the application client, the `mc-admin`/`mc-user` roles, and brute-force protection are present, and no real client secrets or mail-server credentials are stored in the committed realm file.
4. **Given** repeated failed login attempts for a user, **When** the threshold is exceeded, **Then** the account is temporarily locked (brute-force protection is active).

---

### User Story 2 - Off-network end-to-end login (web and mobile) (Priority: P2)

An end user away from the home network opens the app (web browser or installed mobile app) and signs in. The browser is redirected to the public `auth.` hostname, the user authenticates, is redirected back to the public `mcm.` hostname, and an authenticated session is established — over mobile data, with no VPN and no home-network access.

**Why this priority**: This is the headline user value. It depends on US1 being in place and on the application's backend being reachable on the public `mcm.` origin with correctly scoped session cookies, allowed redirect targets, and a mobile build that targets the public hostname.

**Independent Test**: On a device with no access to the home LAN (e.g., cellular only), install the production mobile build and complete the full sign-in round-trip; separately, in a public-network browser, complete the same round-trip on the public `mcm.` origin. Both establish an authenticated session and can reach a protected screen.

**Acceptance Scenarios**:

1. **Given** the production app reachable at the public `mcm.` origin and US1 in place, **When** a user signs in from a public-network browser, **Then** the OAuth redirect to `auth.` and back to `mcm.` completes and a protected screen loads.
2. **Given** the production mobile build whose backend URL is the public `mcm.` origin, **When** a user on cellular completes sign-in, **Then** the browser callback returns to the app and a session is established.
3. **Given** the application client's allowed redirect targets, **When** the web origin and the mobile callback are both registered, **Then** neither client loops or errors after the identity-provider redirect.
4. **Given** an established production session, **When** the session cookie is inspected, **Then** it is marked secure and HTTP-only and scoped to the public app domain, and cross-origin requests from origins other than the app origin are rejected.
5. **Given** a user whose access token expires mid-session, **When** a subsequent request is made, **Then** the session is refreshed against the public `auth.` origin without forcing re-login.

---

### User Story 3 - Production config is secret-safe and gate-compliant (Priority: P3)

A maintainer adds the production configuration to the repository with zero clear-text credentials, following the established secrets model, so that the existing automated guardrails pass and a fresh checkout fails loudly (never silently with a baked-in default) when a required secret is absent.

**Why this priority**: It protects the project's "no clear-text secrets in git — ever" guarantee as the production surface grows. It cross-cuts US1 and US2 (both introduce new config files) but is independently verifiable by running the guardrails and a missing-secret start.

**Independent Test**: Run the repository's secret-detection and inline-secret guardrails against the new production files and confirm they pass; remove a required secret value and confirm the production configuration refuses to start with a message naming the missing variable rather than starting with a fallback.

**Acceptance Scenarios**:

1. **Given** the new production configuration files, **When** the inline-secret and whole-tree secret-scan guardrails run, **Then** both pass with no findings.
2. **Given** a required production secret is unset or blank, **When** the production configuration is started, **Then** startup aborts and the message names the missing variable.
3. **Given** the committed templates, **When** they are inspected, **Then** they contain placeholders only (no real values, no `:-literal` / `?? 'literal'` fallback defaults).
4. **Given** the production identity provider's first start, **When** the bootstrap administrator is used, **Then** a named administrator with two-factor authentication can be created and the bootstrap credential retired.

---

### Edge Cases

- **TLS terminates at the edge, traffic to containers is plain HTTP.** The identity provider must treat forwarded protocol/host headers as authoritative so issued URLs are `https://` public URLs, not the internal `http://` address.
- **Issuer vs. back-channel host mismatch.** The browser reaches the identity provider at the public `auth.` origin while the backend reaches it over the internal network for the refresh-token grant; the token issuer must stay fixed at the public origin or the refresh grant is rejected (observed previously as "invalid token issuer").
- **Missing mobile redirect target.** If only the web redirect is registered, on-device login fails after the browser callback.
- **Mail not configured in production.** With the mail server stubbed, registration/verification/password-reset emails will not send; any flow that depends on them must be treated as unavailable until a real provider is wired.
- **Stale volume / rotated credential.** If a database volume from a prior credential generation is reused, the stored password may not match the freshly generated one; first-boot must use a clean volume or a known-matching credential.
- **Only two hostnames public.** Any service other than `mcm.` and `auth.` (admin UIs, databases, agent layer, the build environment) must not be reachable from the public internet.

## Requirements *(mandatory)*

### Functional Requirements

#### Identity provider — production posture (US1)

- **FR-001**: The production identity provider MUST run in production mode (not development mode).
- **FR-002**: The identity provider MUST advertise the public `auth.` origin as its token issuer for clients, regardless of which internal or external host a request arrives on.
- **FR-003**: The identity provider MUST honor edge-terminated TLS by trusting forwarded protocol/host headers, so generated URLs use the public `https://` origin.
- **FR-004**: The identity provider MUST keep a fixed public issuer while allowing the backend to reach it over the internal network for the refresh-token grant.
- **FR-005**: The administrative console MUST NOT be reachable on the public `auth.` hostname; it MUST be reachable only over the private admin (tailnet) address.
- **FR-006**: Brute-force protection MUST be enabled in the production realm.
- **FR-007**: The production realm (realm, application client, `mc-admin`/`mc-user` roles, registration intent) MUST be provisioned from a committed, sanitized realm export that is imported on start.
- **FR-008**: The committed realm export MUST NOT contain real client secrets, mail-server credentials, or dev-only redirect targets.
- **FR-009**: The production realm export MUST be kept separate from the throwaway CI realm export used by the build pipeline.
- **FR-010**: The production identity provider MUST NOT publish its database port; the database MUST remain internal to the Docker networks.
- **FR-011**: The development-only mail capture service MUST be absent from the production identity provider; the realm mail server MUST be left stubbed/empty until a real provider is wired (documented prerequisite before opening registration).

#### Public-origin client wiring (US2)

- **FR-012**: The application's production backend MUST present its issuer/root URL as the public `auth.` origin.
- **FR-013**: Production session cookies MUST be marked secure and HTTP-only and scoped to the public app domain.
- **FR-014**: Cross-origin access MUST be restricted to the public app origin only.
- **FR-015**: A session store MUST be wired for the production backend (the backend returns an auth error without it).
- **FR-016**: The production backend MUST be reachable by the public-ingress component on the shared external ingress network by service name, with no public port mapping of its own.
- **FR-017**: The application client's allowed redirect targets MUST include both the public web origin and the mobile callback (app link / custom-scheme deep link).
- **FR-018**: The allowed web origins (for cross-origin) MUST include the public app origin.
- **FR-019**: The production mobile build MUST bake the public `mcm.` origin (HTTPS) as its backend URL — not an IP address and not a development port — sourced from a build-time variable, not hard-coded.

#### Secrets, hardening & guardrails (US3)

- **FR-020**: Every credential referenced by production configuration files MUST be a fail-fast reference that aborts startup (naming the variable) when unset — no inline literal and no fallback default.
- **FR-021**: Production secret templates MUST be committed with placeholders only; real values MUST live outside git (operator-managed secret store) and be injected at deploy.
- **FR-022**: Build-time file-based secrets (e.g., the identity-provider database password) MUST continue to use the file-secret pattern, with the file value matching the corresponding variable.
- **FR-023**: The repository's inline-secret and whole-tree secret-scan guardrails MUST pass for all files this feature adds.
- **FR-024**: Any newly introduced Docker network name MUST satisfy the resource-naming convention (and the gate's approved-network list) before the production files enter the gated path.
- **FR-025**: The production identity provider MUST support a first-run bootstrap administrator that can be used once to create a named administrator with two-factor authentication, after which the bootstrap credential is retired.

#### Verification (cross-cutting)

- **FR-026**: It MUST be possible to verify, from a public network, that the discovery document at the public `auth.` origin reports the public issuer.
- **FR-027**: It MUST be possible to verify that only `mcm.` and `auth.` are reachable from the public internet and all other services are not.
- **FR-028**: It MUST be possible to verify a full off-network device login round-trip end to end.

### Key Entities *(include if feature involves data)*

- **Production realm export**: The sanitized identity-provider configuration (realm, application client, roles, redirect targets, brute-force setting) imported at production start; carries no real secrets.
- **Production identity-provider deployment config**: The production deployment definition for the identity provider and its database (production mode, public issuer, proxy-header handling, admin-on-private-network, no public DB port).
- **Production backend deployment config**: The production deployment definition for the application backend (public issuer/root URL, cookie domain and flags, cross-origin allow-list, session store, ingress-network attachment).
- **Production secret templates**: Committed placeholder templates plus build-time file-secrets; real values are operator-managed and injected at deploy.
- **Production mobile build artifact**: The mobile application build whose backend URL is baked to the public `mcm.` origin.
- **OAuth application client**: The identity-provider client used by web and mobile, whose allowed redirect targets and web origins gate where login can complete.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user on a network with no access to the home LAN can complete the full sign-in round-trip (web and mobile) and reach a protected screen on the first attempt.
- **SC-002**: The discovery document fetched over the public `auth.` hostname reports an issuer equal to the public `auth.` origin in 100% of checks.
- **SC-003**: Exactly two hostnames (`mcm.`, `auth.`) respond from the public internet; every other service (admin consoles, databases, agent layer, build environment) is unreachable publicly.
- **SC-004**: The administrative console of the identity provider returns no response on the public `auth.` hostname and is reachable only over the private admin address.
- **SC-005**: Both repository secret guardrails (inline-secret and whole-tree scan) pass with zero findings for the files this feature introduces.
- **SC-006**: Starting any production configuration with a required secret unset aborts with a message naming the missing variable, in 100% of cases (no silent fallback).
- **SC-007**: An expired access token mid-session is transparently refreshed against the public `auth.` origin without forcing the user to log in again.
- **SC-008**: After exceeding the failed-login threshold, the affected account is temporarily locked (brute-force protection demonstrably active).

## Assumptions

- **Ingress model is direct edge-TLS.** Cloudflare terminates TLS at the edge and the tunnel dials the containers over plain HTTP on the shared external `edge-network`; an internal reverse proxy (Caddy) is an optional alternative, not assumed here (per the reconciled runbook/work-order model).
- **Email is stubbed in production for now.** Registration, email verification, and password reset are out of scope until a real mail provider is wired; the feature targets login for users who already exist in the realm. Opening self-registration is a documented prerequisite, not a deliverable.
- **The mobile OAuth callback value** (app link vs. custom scheme) is whatever the existing mobile app configuration already uses; identifying the exact value is a planning/implementation detail, not a scope change.
- **The CI/CD pipeline already exists and 022 deploys through it.** Feature 023 BUILT the self-hosted Forgejo Actions pipeline (`.forgejo/workflows/`: `guardrails.yml`, `app-ci.yml`, `cd-deploy.yml`); the pipeline ships first and 022's prod config deploys through it (co-delivery). The identity-provider slice (US1) can be authored and deployed independently now from an upstream image; the backend/app slices (US2) are authored now and deploy through 023's `cd-deploy.yml`, which builds, scans, and publishes the backend image and the prod APK by digest.
- **Deploy orchestration is pipeline-driven; only three steps remain manual.** Image build → scan → publish-by-digest → Komodo redeploy → health probe → rollback, and the prod-APK build, are automated by feature 023's `cd-deploy.yml` (no longer manual). The only remaining manual operator steps, documented in the companion runbook (not code deliverables of this feature), are: (i) publishing the two public Cloudflare tunnel/DNS routes (`mcm.`/`auth.`); (ii) seeding real secrets into the operator secret store (Komodo/Vault) plus the matching Forgejo CI secrets/variables; and (iii) the on-device off-network APK test.
- **The off-network device login test is a manual verification** performed on a real device on a non-home network.
- **Existing application behavior is unchanged.** This feature only configures the production deployment for the public origin; it does not alter domain logic, screens, or APIs.
- **Resource and secret conventions from prior features apply.** Naming (one role id per resource, `*-network` networks) and secrets (fail-fast references, generated per-environment values, no committed literals) follow the established repository model and its CI gates.
