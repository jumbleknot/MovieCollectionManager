# Contract — authenticated HTTP authorization at the mc-service boundary

**Feature**: 046 · **Status**: this contract **already holds in production**. This feature does not
introduce it; it makes it executable. Nothing in `backend/mc-service/src/` changes.

Base path: `/api/v1`. Every route below sits behind `KeycloakAuthLayer<Role>` (outermost) and
`require_app_role` (inner) — see
[role-enforcement-is-a-layer](../../../openwiki/gotchas/role-enforcement-is-a-layer.md).

---

## 1. Request contract

| Element | Value |
|---|---|
| Credential | `Authorization: Bearer <access token>` |
| Audience | the token's `aud` must contain the service's `KEYCLOAK_CLIENT_ID` (`movie-collection-manager`) |
| Role | `resource_access.movie-collection-manager.roles` must contain `mc-user` **or** `mc-admin` |
| Acting subject | the token's `sub` claim — every handler reads `token.subject` and passes it as `owner_id` |

The acting subject is **never** taken from the request body, path or a header. A client cannot name
the owner it wants to act as; this is the reason the foreign-owner fixture must be seeded through the
repository rather than over HTTP.

---

## 2. Response contract — the assertions this feature adds

### 2.1 Own data (US2)

| Request | Expected |
|---|---|
| `POST /collections` with a valid credential | `201 Created`; body `ownerId` **equals the token's `sub`** |
| `GET /collections/{id}` for a collection the subject owns | `200 OK`; body `collectionId` equals the created id |
| any protected route with a valid credential | **never `401`**, and never `403` for an `mc-user` |

`ownerId` equal to `sub` is the control for everything else: without it a `404` below could equally
mean "the credential was rejected".

### 2.2 Another subject's data (US1) — the security-critical rows

Let `C` be a collection whose stored `ownerId` is some subject other than the caller's.

| Request | Expected | Explicitly **not** |
|---|---|---|
| `GET /collections/{C}` | `404 Not Found` | `403` |
| `PATCH /collections/{C}` | `404 Not Found` | `403` |
| `DELETE /collections/{C}` | `404 Not Found` | `403` |
| `GET /collections/{C}/movies/{M}` | `404 Not Found` | `403` |

`403` is called out as a failure, not merely "not expected". A `403` confirms the resource exists and
is the existence leak this design exists to prevent — see the file header of
`tests/integration/movies/dac_authorization_test.rs`, which states the rule at the domain layer.

Side-effect requirement: a refused `PATCH`/`DELETE` must leave the stored document **present and
unmodified**.

### 2.3 Error body shape (US3)

Every refusal above is an RFC 9457 Problem Details response produced by
`api::middleware::error_handler::problem_response` — see
[rfc-9457-problem-details](../../../openwiki/gotchas/rfc-9457-problem-details.md).

```text
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{
  "type":   "https://mc-service.example/errors/COLLECTION_NOT_FOUND",
  "title":  "Collection not found",
  "status": 404,
  "detail": "The requested collection does not exist or you do not have access to it."
}
```

Asserted:

- `content-type` is `application/problem+json`;
- `type`, `title` and `status` are present, and `status` equals the HTTP status line;
- `type` ends in `COLLECTION_NOT_FOUND` for the cross-tenant cases;
- the body contains **no** stack trace, no `panicked`, no source path, and no database-driver error
  text.

The `.example` host in `type` is deliberate — a stable, non-resolvable RFC 2606 namespace, not the
deployment domain. An assertion must not "fix" it to a real host.

---

## 3. Not covered by this contract

| Case | Why |
|---|---|
| `403` from `require_app_role` (valid credential, neither `mc-user` nor `mc-admin`) | Deferred — needs a role-less identity and the realm is runtime-managed with no committed source. Recorded in spec § Out of Scope with its prerequisite. |
| `403` from `DomainError::AccessDenied` | Unreachable: `grep` across `src/` shows no production producer; it appears only in mocked unit tests. |
| Seeded ACL levels (contributor / viewer) | Enforcement is verified at the application layer in `movies/dac_authorization_test.rs`; no HTTP path reaches a distinct refusal for them today. |
| `401` without a credential | Already covered by feature 045's unauthenticated suite, which this feature leaves untouched. |
