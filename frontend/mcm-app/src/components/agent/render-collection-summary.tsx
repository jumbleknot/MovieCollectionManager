/**
 * RenderCollectionSummary (T052) — client adapter for the `render_collection_summary`
 * generative-UI tool (US2).
 *
 * Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md. The organizer
 * emits a `render_collection_summary` AG-UI tool call carrying read-only collection metadata
 * (name, movie count, the caller's role — no token, no write). CopilotKit's `useRenderTool`
 * maps the args to this presentational component, rendered inline in the assistant dock. A
 * "wishlist" renders here too — it is just a user-named collection (no distinct entity).
 *
 * Universal Generative UI (constitution): one React Native component renders identically on web
 * (react-native-web) and Android.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

/** AG-UI tool name — must match the organizer's emitted tool call (generative_ui_tools.py). */
export const RENDER_COLLECTION_SUMMARY_TOOL = 'render_collection_summary';

export type RenderCollectionSummaryProps = {
  collectionId: string;
  name: string;
  movieCount: number;
  role: 'owner' | 'contributor' | 'viewer';
};

const ROLE_LABELS: Record<RenderCollectionSummaryProps['role'], string> = {
  owner: 'Owner',
  contributor: 'Contributor',
  viewer: 'Viewer',
};

export function RenderCollectionSummary({
  name,
  movieCount,
  role,
}: RenderCollectionSummaryProps) {
  const styles = makeStyles(useTheme());
  return (
    <View testID="render-collection-summary" style={styles.card}>
      <Text testID="render-collection-summary-name" style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      <View style={styles.metaRow}>
        <Text testID="render-collection-summary-count" style={styles.count}>
          {movieCount} {movieCount === 1 ? 'movie' : 'movies'}
        </Text>
        <Text testID="render-collection-summary-role" style={styles.role}>
          {ROLE_LABELS[role] ?? role}
        </Text>
      </View>
    </View>
  );
}

/** Zod schema for the `render_collection_summary` tool args (mirrors the contract props). */
export const renderCollectionSummaryParameters = z.object({
  collectionId: z.string(),
  name: z.string(),
  movieCount: z.number(),
  role: z.enum(['owner', 'contributor', 'viewer']),
});

/**
 * Registers the `render_collection_summary` generative-UI tool with CopilotKit so the dock
 * renders RenderCollectionSummary inline when the organizer emits the tool call. Render-only
 * (no `handler`): a read-only summary; any change is gated behind the approval flow. Mount once
 * inside the dock.
 */
export function useRenderCollectionSummaryTool(): void {
  useRenderTool<RenderCollectionSummaryProps>({
    name: RENDER_COLLECTION_SUMMARY_TOOL,
    description:
      'Display a read-only summary of a movie collection (name, movie count, your role). Does not modify anything.',
    parameters: renderCollectionSummaryParameters,
    render: ({ args }) => <RenderCollectionSummary {...args} />,
  });
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  card: {
    padding: 10,
    backgroundColor: theme.surface2?.val,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.outlineVariant?.val,
    marginVertical: 4,
    gap: 4,
  },
  name: { fontFamily: 'Outfit', fontSize: 16, fontWeight: '600', color: theme.onSurface?.val },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { fontFamily: 'Inter', fontSize: 14, color: theme.onSurfaceVariant?.val },
  role: { fontFamily: 'Inter', fontSize: 11, color: theme.onSurfaceVariant?.val, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
});
