# Spec 093: A collection named with a trailing "collection" still resolves

**Status**: Complete | **Date**: 2026-11-07 | **Input**: cd-deploy's live-model gate failed on the
deploy of `858792ec` (#951)

## Problem

For "move Inception from my Sci-Fi collection to my Favorites collection", the live gate's Claude returned
the source collection as `Sci-Fi collection` instead of `Sci-Fi`. The other 50 pairs passed, and this pair
passed on the previous deploy, so the model's wording varies from run to run.

The organizer resolves a named collection by exact name, ignoring case. `Sci-Fi collection` matches
nothing:

- as the **source**, the organizer asks "Which collection should I organize?" instead of moving the movie;
- as a **destination**, it offers to create a new collection named `Favorites collection`.

Nothing is written without approval, but a plain request fails. The gate caught a real defect.

## Requirements

- **FR-001**: When a named collection matches no collection exactly, `_resolve_target` MUST retry with one
  trailing word `collection` removed, ignoring case. This covers the source, the destination, and the
  add target, which all use `_resolve_target`.
- **FR-002**: An exact match MUST still win. A real collection named `Movie Collection` resolves to itself.
- **FR-003**: If the retry also matches nothing, behaviour is unchanged: create-if-missing, with the name
  as the user's request gave it.
- **FR-004**: The golden comparison MUST treat an actual collection or move destination of `X collection` as
  equal to an expected `X`, because the app now treats them the same. Only in that direction: an expected
  `Movie Collection` is still NOT matched by an actual `Movie`.

## Success criteria

- **SC-001**: `_resolve_target("Sci-Fi collection", …)` resolves to the existing `Sci-Fi` collection.
- **SC-002**: The golden comparison passes on the exact failing output, and still fails on a wrong collection.
- **SC-003**: The model's prompt is unchanged, so no recorded model responses need re-recording.

## Out of scope

- Changing the organizer's prompt. The operator chose this on 2026-11-07, because a prompt change
  invalidates all 7 recorded plan responses and needs a live re-record.
- Other wording, such as `my Sci-Fi`.
