/**
 * UI-action tools (T059, US3) — client dispatch for the agent's `navigate_*` / `prefill_*`
 * tool calls.
 *
 * `@copilotkit/react-native` exposes only `useRenderTool` (render-only; no handler hook), so a
 * UI action rides on the render callback: the registered tool renders a tiny effect component
 * that, on mount, (1) asks the BFF `ui-action-authorizer` to authorize the structural target
 * (default-deny; an unauthorized action is discarded at the boundary — FR-011/FR-012, SC-003),
 * then (2) performs the expo-router navigation. `prefill_add_movie` is HITL-surfaced: it opens
 * the add-movie form PRE-FILLED but never submits — the user still confirms.
 *
 * Because `buildDockItems` re-creates the element whenever the dock panel re-mounts, dispatch
 * is de-duplicated by a module-level set keyed on `uiActionKey(...)`. That key includes the
 * agent's per-emission `nonce` (its message-count at emit time) so a dock re-mount of the SAME
 * tool-call message is deduped, while a genuine SECOND navigation to the same target in a later
 * turn (a higher nonce) is a fresh key that DOES navigate (013 Inc5 nav bug — keying on the
 * target alone swallowed the repeat). The render callback only receives `{ args, status }` — no
 * tool-call/message id — so the discriminator must ride in `args.nonce`.
 *
 * Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md.
 */
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

import { BFF_BASE_URL } from '@/config/bff-url';

export const NAVIGATE_TO_COLLECTION_TOOL = 'navigate_to_collection';
export const NAVIGATE_TO_MOVIE_TOOL = 'navigate_to_movie';
export const PREFILL_ADD_MOVIE_TOOL = 'prefill_add_movie';
export const DOWNLOAD_EXPORT_TOOL = 'download_export';

type UiActionType = 'navigate' | 'prefill';

// Dispatched action keys (module-lived) so a re-mounted dock panel never re-fires a navigation.
const dispatched = new Set<string>();

/**
 * The dedup key for a UI-action tool call: target ids + the agent's per-emission `nonce`. Two
 * navigations to the same target in different turns carry different nonces (the agent's message
 * count at emit time) → different keys → both navigate; a dock re-mount of one message replays
 * the same nonce → same key → deduped. Pure + exported for unit testing.
 */
export function uiActionKey(name: string, args: Record<string, unknown>): string {
  const nonce = typeof args.nonce === 'string' ? args.nonce : '';
  if (name === NAVIGATE_TO_MOVIE_TOOL) {
    return `navmov:${args.collectionId}:${args.movieId}:${nonce}`;
  }
  if (name === PREFILL_ADD_MOVIE_TOOL) {
    return `prefill:${args.collectionId}:${nonce}`;
  }
  if (name === DOWNLOAD_EXPORT_TOOL) {
    return `export:${args.handle}:${nonce}`;
  }
  return `navcol:${args.collectionId}:${nonce}`;
}

/** Ask the BFF to authorize the structural target (default-deny). Returns true on 204. */
async function authorize(type: UiActionType, target: string): Promise<boolean> {
  try {
    const res = await fetch(`${BFF_BASE_URL}/bff-api/agent/ui-action`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, target }),
    });
    return res.status === 204;
  } catch {
    return false; // network error → discard (never navigate on an unconfirmed action)
  }
}

interface UiActionEffectProps {
  actionKey: string;
  type: UiActionType;
  target: string;
  label: string;
  perform: () => void;
}

/**
 * Invisible-ish effect: authorize once, then navigate. Renders a short status line (with a
 * stable testID) so web/mobile E2E can assert the action fired. Exported for unit testing.
 */
export function UiActionEffect({
  actionKey,
  type,
  target,
  label,
  perform,
}: UiActionEffectProps): React.JSX.Element {
  // Lazy initial state avoids a synchronous setState in the effect: an already-dispatched key
  // (dock re-opened) starts 'done' so the effect just returns without re-navigating.
  const [status, setStatus] = useState<'pending' | 'done' | 'denied'>(() =>
    dispatched.has(actionKey) ? 'done' : 'pending',
  );
  useEffect(() => {
    if (dispatched.has(actionKey)) return;
    dispatched.add(actionKey);
    let cancelled = false;
    void authorize(type, target).then((ok) => {
      if (cancelled) return;
      if (ok) {
        setStatus('done');
        perform();
      } else {
        setStatus('denied');
      }
    });
    return () => {
      cancelled = true;
    };
    // actionKey identifies this specific action; perform/type/target are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionKey]);

  return (
    <Text testID={`assistant-ui-action-${type}`}>
      {status === 'denied' ? "I can't open that for you." : label}
    </Text>
  );
}

/**
 * Trigger a same-origin authenticated download of the built export workbook. The BFF GET route is
 * itself auth-gated (cookie session), so no `/ui-action` authorization step is needed — unlike a
 * navigate/prefill, a download performs no in-app navigation to a possibly-unauthorized target.
 * Web-only (the import/export flow is a documented web-first parity exception).
 */
function triggerExportDownload(handle: string, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = `${BFF_BASE_URL}/bff-api/agent/export-download?handle=${encodeURIComponent(handle)}`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'movie-collections-export.xlsx';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Download effect: fire the browser download exactly once per emission (deduped on the
 * handle+nonce key so a dock re-mount doesn't re-download). Exported for unit testing.
 */
export function DownloadExportEffect({
  actionKey,
  handle,
  filename,
}: {
  actionKey: string;
  handle: string;
  filename: string;
}): React.JSX.Element {
  // No local state — the download is a one-shot side effect (deduped by `actionKey`); the status
  // line is static, avoiding a synchronous setState in the effect (cascading-render lint rule).
  useEffect(() => {
    if (dispatched.has(actionKey)) return;
    dispatched.add(actionKey);
    triggerExportDownload(handle, filename);
    // actionKey identifies this specific emission; handle/filename are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionKey]);

  return <Text testID="assistant-ui-action-download">Your export is downloading…</Text>;
}

// `nonce` (the agent's per-emission discriminator) is optional so older messages without it still
// validate; absent ⇒ the key falls back to target-only (the prior behaviour).
const navigateToCollectionParameters = z.object({
  collectionId: z.string(),
  nonce: z.string().optional(),
});
const navigateToMovieParameters = z.object({
  collectionId: z.string(),
  movieId: z.string(),
  nonce: z.string().optional(),
});
const prefillAddMovieParameters = z.object({
  collectionId: z.string(),
  movie: z.unknown().optional(),
  nonce: z.string().optional(),
});
const downloadExportParameters = z.object({
  handle: z.string(),
  filename: z.string().optional(),
  nonce: z.string().optional(),
});

type RoutePush = Parameters<typeof router.push>[0];

function prefillPath(collectionId: string, movie: unknown): string {
  const draft = (movie && typeof movie === 'object' ? movie : {}) as {
    title?: unknown;
    year?: unknown;
  };
  const params = new URLSearchParams();
  if (typeof draft.title === 'string' && draft.title) params.set('title', draft.title);
  if (typeof draft.year === 'number') params.set('year', String(draft.year));
  const qs = params.toString();
  return `/collections/${collectionId}/add-movie${qs ? `?${qs}` : ''}`;
}

/**
 * Register the three allowlisted UI-action tools with CopilotKit. Mount once inside the dock
 * (alongside the generative-UI render tools).
 */
export function useUiActionTools(): void {
  useRenderTool<{ collectionId: string }>({
    name: NAVIGATE_TO_COLLECTION_TOOL,
    description: 'Navigate the user to one of their collection screens.',
    parameters: navigateToCollectionParameters,
    render: ({ args }) => (
      <UiActionEffect
        actionKey={uiActionKey(NAVIGATE_TO_COLLECTION_TOOL, args)}
        type="navigate"
        target="collection"
        label="Opening that collection…"
        perform={() => router.push(`/collections/${args.collectionId}` as RoutePush)}
      />
    ),
  });

  useRenderTool<{ collectionId: string; movieId: string }>({
    name: NAVIGATE_TO_MOVIE_TOOL,
    description: "Navigate the user to a movie's detail screen.",
    parameters: navigateToMovieParameters,
    render: ({ args }) => (
      <UiActionEffect
        actionKey={uiActionKey(NAVIGATE_TO_MOVIE_TOOL, args)}
        type="navigate"
        target="movie-detail"
        label="Opening that movie…"
        perform={() =>
          router.push(
            `/collections/${args.collectionId}/movies/${args.movieId}` as RoutePush,
          )
        }
      />
    ),
  });

  useRenderTool<{ collectionId: string; movie?: unknown }>({
    name: PREFILL_ADD_MOVIE_TOOL,
    description: 'Open the add-movie form on a collection, pre-filled (the user still confirms).',
    parameters: prefillAddMovieParameters,
    render: ({ args }) => (
      <UiActionEffect
        actionKey={uiActionKey(PREFILL_ADD_MOVIE_TOOL, args)}
        type="prefill"
        target="add-movie"
        label="Opening the add-movie form…"
        perform={() => router.push(prefillPath(args.collectionId, args.movie) as RoutePush)}
      />
    ),
  });

  useRenderTool<{ handle: string; filename?: string }>({
    name: DOWNLOAD_EXPORT_TOOL,
    description: "Download the user's exported collections spreadsheet.",
    parameters: downloadExportParameters,
    render: ({ args }) => (
      <DownloadExportEffect
        actionKey={uiActionKey(DOWNLOAD_EXPORT_TOOL, args)}
        handle={String(args.handle)}
        filename={typeof args.filename === 'string' ? args.filename : ''}
      />
    ),
  });
}
