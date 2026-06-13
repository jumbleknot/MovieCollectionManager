/**
 * RenderMovieCard (T040) — client adapter for the `render_movie_card` generative-UI tool.
 *
 * Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md. The curator node
 * emits a `render_movie_card` AG-UI tool call carrying read-only TMDB/mc-service metadata (no
 * token, no write). CopilotKit's `useRenderTool` (see `useRenderMovieCardTool` below) maps the
 * tool-call args to this presentational component, rendered inline in the assistant dock.
 *
 * Universal Generative UI (constitution): one React Native component renders identically on web
 * (react-native-web) and Android — no React Server Components / streamUI.
 */
import React, { useCallback } from 'react';
import { Image, Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAgent, useCopilotKit, useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

/** AG-UI tool name — must match the curator's emitted tool call (generative_ui_tools.py). */
export const RENDER_MOVIE_CARD_TOOL = 'render_movie_card';

/**
 * Props mirror the `render_movie_card` contract shape (camelCase wire props). A `type` alias
 * (not an interface) so it satisfies `useRenderTool`'s `Record<string, unknown>` constraint.
 *
 * 013 US10: a web (`source="tmdb"`) preview card may carry `url` (the themoviedb.org link) and
 * `addable` (surface an "add to collection" affordance). Both optional so existing curator/query
 * cards that omit them still validate.
 *
 * 013 Inc5 Bug 1: a web preview card surfaced from a collection-scoped search carries
 * `addCollectionName` (the collection the user searched) so "Add to collection" targets THAT
 * collection rather than the user's default. Absent ⇒ the add falls back to default/create.
 */
export type RenderMovieCardProps = {
  movieId: string | null;
  collectionId: string | null;
  title: string;
  year: number | null;
  posterUrl: string | null;
  genres: string[];
  overview: string;
  source: 'tmdb' | 'mc-service';
  proposalItemId: string | null;
  url?: string | null;
  addable?: boolean;
  addCollectionId?: string | null;
  addCollectionName?: string | null;
};

/** Open an external URL: new tab on web, system browser on native (movie-detail `openUrl`). */
function openUrl(url: string) {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    void Linking.openURL(url);
  }
}

/**
 * The canonical "add" message a tap posts into the approval-gated add flow (FR-031). When a
 * collection name is given (013 Inc5 Bug 1 — the collection the search was scoped to), the message
 * targets it explicitly ("… to <Name>") so the organizer adds there instead of the default.
 */
export function addMovieText(
  title: string,
  year: number | null,
  collectionName?: string | null,
): string {
  const base = year != null ? `add ${title} (${year})` : `add ${title}`;
  return collectionName ? `${base} to ${collectionName}` : base;
}

const SOURCE_LABELS: Record<RenderMovieCardProps['source'], string> = {
  tmdb: 'TMDB',
  'mc-service': 'Library',
};

export function RenderMovieCard({
  movieId,
  collectionId,
  title,
  year,
  posterUrl,
  genres,
  overview,
  source,
  url = null,
  addable = false,
  addCollectionName = null,
}: RenderMovieCardProps) {
  const router = useRouter();
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  // 013 US3: an in-collection card (both ids present) deep-links to the movie's detail screen;
  // a look-up-only TMDB preview (ids null) renders as a plain, non-interactive card.
  const canNavigate = Boolean(movieId && collectionId);

  // 013 US10: tapping "Add to collection" posts the canonical add message into the same dock
  // send path → the existing approval-gated add flow (never auto-adds).
  const addToCollection = useCallback(() => {
    if (!agent || (agent.isRunning ?? false)) return;
    agent.addMessage({
      id: `u-${Date.now()}`,
      role: 'user',
      content: addMovieText(title, year, addCollectionName),
    });
    void copilotkit.runAgent({ agent });
  }, [agent, copilotkit, title, year, addCollectionName]);

  const body = (
    <>
      {posterUrl ? (
        <Image
          testID="render-movie-card-poster"
          source={{ uri: posterUrl }}
          style={styles.poster}
          resizeMode="cover"
        />
      ) : null}
      <View style={styles.body}>
        <View style={styles.headerRow}>
          <Text testID="render-movie-card-title" style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {year !== null ? (
            <Text testID="render-movie-card-year" style={styles.year}>
              {year}
            </Text>
          ) : null}
        </View>
        {genres.length > 0 ? (
          <Text testID="render-movie-card-genres" style={styles.genres} numberOfLines={1}>
            {genres.join(', ')}
          </Text>
        ) : null}
        {overview ? (
          <Text testID="render-movie-card-overview" style={styles.overview} numberOfLines={4}>
            {overview}
          </Text>
        ) : null}
        <Text testID="render-movie-card-source" style={styles.source}>
          {SOURCE_LABELS[source]}
        </Text>
        {url ? (
          <Text
            testID="render-movie-card-url"
            style={styles.link}
            accessibilityRole="link"
            onPress={() => openUrl(url)}
          >
            View on TMDB
          </Text>
        ) : null}
        {addable ? (
          <TouchableOpacity
            testID="render-movie-card-add"
            style={styles.addButton}
            onPress={addToCollection}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Add ${title} to a collection`}
          >
            <Text style={styles.addText}>Add to collection</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );

  if (canNavigate) {
    return (
      <TouchableOpacity
        testID="render-movie-card"
        style={styles.card}
        onPress={() =>
          router.push(
            `/collections/${collectionId}/movies/${movieId}` as Parameters<typeof router.push>[0],
          )
        }
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Open ${title} details`}
      >
        {body}
      </TouchableOpacity>
    );
  }

  return (
    <View testID="render-movie-card" style={styles.card}>
      {body}
    </View>
  );
}

/**
 * Zod schema for the `render_movie_card` tool args (mirrors the contract props). Zod v4 is a
 * StandardSchema, which is what `useRenderTool` accepts.
 */
export const renderMovieCardParameters = z.object({
  movieId: z.string().nullable(),
  collectionId: z.string().nullable(),
  title: z.string(),
  year: z.number().nullable(),
  posterUrl: z.string().nullable(),
  genres: z.array(z.string()),
  overview: z.string(),
  source: z.enum(['tmdb', 'mc-service']),
  proposalItemId: z.string().nullable(),
  url: z.string().nullable().optional(),
  addable: z.boolean().optional(),
  addCollectionId: z.string().nullable().optional(),
  addCollectionName: z.string().nullable().optional(),
});

/**
 * Registers the `render_movie_card` generative-UI tool with CopilotKit so that, when the agent
 * emits the tool call, the dock renders RenderMovieCard inline. Render-only (no `handler`): the
 * card is a preview; the write is gated behind the approval flow. Mount once inside the dock.
 */
export function useRenderMovieCardTool(): void {
  useRenderTool<RenderMovieCardProps>({
    name: RENDER_MOVIE_CARD_TOOL,
    description:
      'Display a read-only movie metadata preview card (title, year, poster, genres, overview). Does not add or modify anything.',
    parameters: renderMovieCardParameters,
    render: ({ args }) => <RenderMovieCard {...args} />,
  });
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: 10,
    padding: 8,
    backgroundColor: '#f6f8fa',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d0d7de',
    marginVertical: 4,
  },
  poster: { width: 60, height: 90, borderRadius: 6, backgroundColor: '#e0e0e0' },
  body: { flex: 1, gap: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: '#111' },
  year: { fontSize: 13, color: '#57606a' },
  genres: { fontSize: 12, color: '#444' },
  overview: { fontSize: 12, color: '#333' },
  source: { fontSize: 10, color: '#57606a', textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  link: { fontSize: 12, color: '#0969da', fontWeight: '600', marginTop: 2 },
  addButton: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1f6feb',
    borderRadius: 8,
  },
  addText: { fontSize: 13, color: '#fff', fontWeight: '600' },
});
