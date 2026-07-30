---
type: Gotcha
title: Directory-based collection routing in Expo Router
description: collections/[collectionId]/ must be an Expo Router directory route, not a [collectionId].tsx file route, so that movies/[movieId].tsx nested underneath inherits the collectionId param. Using the file-route form breaks collectionId availability in nested movie routes.
tags: [expo-router, react-native, routing, frontend]
timestamp: 2026-07-30T12:34:09-04:00
---

# Directory-based collection routing in Expo Router

This is a relocated Non-Obvious Design Decision. It has no resource citation because it is
authoritative in its own right — the rule and its rationale live here, not in a linked document.

## Gotcha

**Directory-based collection routing**: `collections/[collectionId]/` is a directory (not a file
route) so that `movies/[movieId].tsx` nested under it inherits the `collectionId` route param. Use
`index.tsx` inside the directory for the collection screen. Never use `[collectionId].tsx` (file
route) — it breaks `collectionId` availability in nested movie routes.

See the [Expo/React Native app](/openwiki/projects/expo-app.md) for the broader `app/(app)/`
file-based routing structure this convention sits in, and
[Expo Router server export and agent-transport traps](expo-router-and-transport-traps.md) for other
Expo Router gotchas in the same codebase.
