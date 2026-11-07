# Plan 093: A collection named with a trailing "collection" still resolves

**Spec**: [spec.md](./spec.md)

## Approach

- `agents/movie-assistant/src/nodes/organizer.py`, `_resolve_target`: after the exact loop finds nothing,
  strip one trailing ` collection` (ignoring case) and look again. Only a non-empty, non-generic remainder
  is tried, so `my collection` keeps its generic meaning.
- `agents/movie-assistant/tests/golden/compare.py`: a plan's `collection`, and a move's `to`, compare
  equal when they are equal ignoring case, or when the actual is the expected plus ` collection`. This
  mirrors FR-001 rather than loosening the gate: the gate still fails on any other collection. This is the
  guard updated at its cause, because the behaviour it protects changed.

No prompt change, so the recorded plan responses stay valid (SC-003).

## Tests

- `tests/unit/test_resolvers_adversarial.py`: the suffix resolves (source and destination names), an exact
  `Movie Collection` wins, an unknown name with the suffix still creates with its full name, and
  `my collection` stays generic.
- `tests/unit/test_golden_compare.py`: the exact failing output passes, a suffix on the destination passes,
  a wrong collection fails, and the reverse direction fails.

## Rollback

Revert the merge. No data or schema change.
