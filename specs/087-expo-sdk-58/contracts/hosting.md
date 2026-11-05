# Contract: Hosting (PR A)

## The URL a route receives

`server.js` is the only code that touches the adapter. For any request reaching the catch-all:

| `TRUSTED_PROXY` | `Host` | `X-Forwarded-Proto` | `X-Forwarded-Host` | URL a route receives |
|---|---|---|---|---|
| `true` | `mcm.example.test` | `https` | absent | `https://mcm.example.test/...` |
| `true` | `mcm.example.test` | absent | absent | `http://mcm.example.test/...` |
| `true` | `mcm.example.test` | `https` | `attacker.test` | `https://mcm.example.test/...` |
| unset | `mcm.example.test` | `https` | absent | `http://mcm.example.test/...` |

The path and query string arrive intact. A malformed percent-encoded path is still answered 400 before the handler, as
`bff-server-adapter.test.ts` pins today.

**Proof**: `bff-server-trust-proxy.test.ts`, through the real `expo-server` adapter, with no stub on this path. Removing
the fix must turn the first and third rows red.

## Fixture build

`tests/unit/fixtures/real-adapter-build/` is a minimal `dist/server`:

- `_expo/routes.json`, with `htmlRoutes: []`, `notFoundRoutes: []` and one API route.
- One function file for that route, returning `Response.json({ url: request.url })`.

It holds no app code. If an SDK changes the manifest shape, this test fails, which is the intended prompt.

## Runtime image

- `expo-server` is a direct dependency and a prune root, and `@expo/server` appears in no manifest, prune root or stub.
- A missing root fails the image build.
- `pnpm nx docker-build mcm-app` succeeds with `--check-bundle` clean, and the built image serves the web E2E suite.

## Healthcheck

Each BFF service in `compose.yaml` (two) and `compose.prod.yaml` (one) probes both surfaces:

| Pages | API routes | Result |
|---|---|---|
| 200 | 200 | healthy |
| **404** | **200** | **unhealthy** |
| 200 | failing | unhealthy |

**Guard**: `bff-healthcheck-pages.guard.test.mjs` parses both compose files, finds every service running the BFF image, and
requires a page path and a `/bff-api/` path in its test. It fails if it finds no such services, so it cannot pass by
reading the wrong file.

**Runtime proof, once**: a copy of `dist` with `htmlRoutes` emptied, run in the real image. Quoted in `tasks.md`.
