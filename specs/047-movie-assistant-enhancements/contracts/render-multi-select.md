# Contract: `render_multi_select` generative-UI tool

**Feature**: [047](../spec.md) · **Story**: US4 · **Satisfies**: FR-020a, FR-020b, FR-036

A new AG-UI generative-UI tool. The organizer emits it when it needs a *multi-valued* answer
(media formats, rip qualities); the client renders a toggle list with a confirm action. It is the
multi-select counterpart to the existing single-pick `render_selection`.

Follows the conventions in
[specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md](../../012-multi-agent-mvp/contracts/generative-ui-and-actions.md):
pure props, no token, no PII, render-only (no client-side write).

## Tool name

```text
render_multi_select
```

## Emitted args

```jsonc
{
  "prompt": "Which formats do you own it on?",
  "options": [
    { "label": "DVD",          "value": "DVD",          "selected": false },
    { "label": "Blu-Ray",      "value": "Blu-Ray",      "selected": false },
    { "label": "Blu-Ray 3D",   "value": "Blu-Ray 3D",   "selected": false },
    { "label": "UHD Blu-Ray",  "value": "UHD Blu-Ray",  "selected": false }
  ],
  "confirmLabel": "Done"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | The question. Also sent as the assistant's message text, so a client that does not render the tool still shows it. |
| `options` | array | yes | 1–12 options. Order is the order the member sees. |
| `options[].label` | string | yes | Button text. |
| `options[].value` | string | yes | Canonical value posted back on confirm. |
| `options[].selected` | boolean | no | Initial state; defaults `false`. Lets a re-ask show what was already chosen. |
| `confirmLabel` | string | no | Defaults to `"Done"`. |

The option values for the two Story 4 uses are the product's supported media formats, **fetched from
mc-service at question time** via the `get_movie_metadata` tool — see
[movie-metadata.md](./movie-metadata.md) and [RQ-4](../research.md#rq-4). This contract fixes the
shape, not the values; the emitter must never inline a literal list.

If the metadata fetch fails, the organizer **skips** this question rather than emitting a guessed
option set.

## What a confirm posts back

On confirm the client posts **one** message through the same send path the dock input and
`render_selection` use — no client-side state mutation reaches the agent, matching the 013 pattern:

```text
Selected: DVD, Blu-Ray
```

with the empty case posted as:

```text
Selected: none
```

The organizer resolves this in **pure code** against `add_multi_pending` (the options it offered),
matching each comma-separated part case- and whitespace-insensitively. This is deliberately the same
normalisation Story 2 adds to `resolve_option` — the two stories share the failure mode, and the
fix must not be applied to only one of them.

### Typed equivalence (FR-036)

A member who types `DVD and Blu-Ray`, `dvd, blu-ray`, or `none` must reach the same result as
tapping. No step of this flow may be reachable only by tapping.

## Client behaviour

- One React Native component rendering identically on web and Android (FR-020b) — no
  platform-forked implementation, no RSC, no `streamUI`.
- Toggling is local state; **nothing is sent until confirm**. Confirming zero selections is valid
  and posts `Selected: none` (FR-028).
- The current selection is visible before confirming (FR-020a).
- The component is disabled once confirmed, so the same question cannot be answered twice.
- Registered in `assistant-dock.tsx` alongside the other `useRenderTool` registrations.

## Accessibility

Each toggle exposes its selected state to assistive technology (an accessibility state, not colour
alone), and the confirm action carries a label naming what is being confirmed.

## Out of scope

- Re-ordering options.
- Free-text "other" values — the accepted set is fixed by mc-service.
- Reusing this tool for single-answer questions; those stay on `render_selection`.
