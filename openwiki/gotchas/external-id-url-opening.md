---
type: Gotcha
title: External ID links open via a scheme-guarded openUrl helper — web vs native, and a second unguarded copy
description: movie-detail.tsx's openUrl helper opens an external-identifier link with window.open(url, '_blank', 'noopener,noreferrer') on web and Linking.openURL on native, but only after isSafeHttpUrl() rejects non-http(s) schemes — a duplicate openUrl in render-movie-card.tsx skips that guard.
resource: frontend/mcm-app/src/components/movie-detail.tsx
tags: [frontend, security, expo-router, external-links, xss]
timestamp: 2026-07-30T12:49:54-04:00
---

# External ID links open via a scheme-guarded openUrl helper — web vs native, and a second unguarded copy

`MovieDetail` renders each movie's external identifiers (e.g. IMDb, TMDB) as tappable links when a
`url` is present. Tapping one calls the module-local `openUrl(url)` in `movie-detail.tsx`, which opens
`window.open(url, '_blank', 'noopener,noreferrer')` on web (`Platform.OS === 'web'`) and
`Linking.openURL(url)` on native.

## Gotchas

- **The scheme check happens before either branch, not inside them.** `openUrl()` first calls
  `isSafeHttpUrl(url)` (`utils/http-url.ts`) and returns early if it's false — refusing
  `javascript:`, `data:`, `file:`, and any other non-`http(s)` scheme. This exists because external
  identifiers are attacker-controlled, persisted strings (009 finding #1, FR-003): without the guard,
  a stored `javascript:` URL would execute on tap. The same `HttpUrlSpec` rule is enforced
  server-side in mc-service on create/update (`domain/specifications/http_url.rs`,
  FR-001/FR-002) — the client guard is defense-in-depth, not the only check.
- **`noopener,noreferrer` on `window.open` is load-bearing, not boilerplate.** Omitting it lets the
  opened page's `window.opener` reach back into the MCM tab (reverse tabnabbing) on browsers that
  don't default this behavior.
- **A second, unguarded `openUrl` exists in `render-movie-card.tsx`.** The generative-UI movie card
  (rendered from the curator agent's `render_movie_card` tool call, carrying a TMDB `url`) defines its
  own `openUrl(url)` with the identical `window.open(..., '_blank', 'noopener,noreferrer')` /
  `Linking.openURL(url)` branching — but it does **not** call `isSafeHttpUrl()` first. Its comment
  explicitly cross-references "movie-detail `openUrl`" as the pattern it mirrors. If you harden one
  copy, check whether the other needs the same fix; they are not shared code.
- **Native has no equivalent scheme allowlist inside `Linking.openURL` itself** — the `isSafeHttpUrl()`
  check in `movie-detail.tsx` is what stands between a malicious `system:uniqueId` URL and
  `Linking.openURL` actually launching it. Do not remove the guard under the assumption that
  `Linking.openURL` is safe by default.

See [Directory-based collection routing in Expo Router](expo-router-collection-routing.md) and
[Expo Router server export and agent-transport traps](expo-router-and-transport-traps.md) for other
gotchas in the same Expo/React Native surface, and
[mc-service errors are RFC 9457 Problem Details](rfc-9457-problem-details.md) for how the server-side
`HttpUrlSpec` failure is reported back to the client.
