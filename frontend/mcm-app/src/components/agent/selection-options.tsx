/**
 * SelectionOptions (013 US7) — client adapter for the `render_selection` tool.
 *
 * The unified search workflow (agents/movie-assistant/src/nodes/search.py) emits a generalized
 * `render_selection` AG-UI tool call carrying `options: [{ label, value, kind }]` — scope buttons
 * ("Search a collection" / "Search the web"), collection-name buttons, movie/web result buttons,
 * and control buttons ("Search another collection" / "Exit search"). Tapping a button posts the
 * option's canonical `value` through the SAME send path as the dock input, which re-enters the
 * pure-code search state machine — so no model decision changes and the assistant text reply
 * remains the fallback for clients that don't render the tool.
 *
 * The "pickable" results (kind `movie` | `collection`) are capped at 5 with a "view more" overflow
 * (reuses the US4 disambiguation cap); the workflow `scope` | `control` buttons are always shown so
 * the user can never lose the way out (e.g. "Exit search") behind the overflow.
 *
 * Universal Generative UI: one React Native component, identical on web + Android.
 */
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useAgent, useCopilotKit, useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

/** AG-UI tool name — must match the search node's emitted tool call (generative_ui_tools.py). */
export const RENDER_SELECTION_TOOL = 'render_selection';

/** Max result buttons shown before the overflow control (≤5, mirrors US4). */
export const SELECTION_VISIBLE_LIMIT = 5;

export type SelectionKind = 'movie' | 'collection' | 'scope' | 'control';

export type SelectionOption = {
  label: string;
  value: string;
  kind: SelectionKind;
};

export type SelectionOptionsProps = {
  options: SelectionOption[];
};

/** Result picks are capped + overflowed; workflow controls (scope/control) are always shown. */
const isPickable = (o: SelectionOption) => o.kind === 'movie' || o.kind === 'collection';

export function SelectionOptions({ options }: SelectionOptionsProps) {
  const styles = makeStyles(useTheme());
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const [showAll, setShowAll] = useState(false);

  const isRunning = agent?.isRunning ?? false;
  const picks = options.filter(isPickable);
  const controls = options.filter((o) => !isPickable(o));
  const visiblePicks = showAll ? picks : picks.slice(0, SELECTION_VISIBLE_LIMIT);
  const hiddenCount = picks.length - SELECTION_VISIBLE_LIMIT;

  const choose = useCallback(
    (o: SelectionOption) => {
      if (!agent || isRunning || !o.value) return;
      // Same send path as the dock input — post the canonical value, then run the agent.
      agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: o.value });
      void copilotkit.runAgent({ agent });
    },
    [agent, isRunning, copilotkit],
  );

  const renderButton = (o: SelectionOption, i: number, group: string) => (
    <TouchableOpacity
      key={`${group}-${o.value || 'opt'}-${i}`}
      testID={`selection-option-${group}-${i}`}
      style={[styles.option, o.kind === 'control' || o.kind === 'scope' ? styles.control : null]}
      onPress={() => choose(o)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Choose ${o.label}`}
    >
      <Text style={styles.optionText}>{o.label}</Text>
    </TouchableOpacity>
  );

  return (
    <View testID="selection-options" style={styles.container}>
      {visiblePicks.map((o, i) => renderButton(o, i, 'pick'))}
      {!showAll && hiddenCount > 0 ? (
        <TouchableOpacity
          testID="selection-more"
          style={styles.more}
          onPress={() => setShowAll(true)}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Show ${hiddenCount} more matches`}
        >
          <Text style={styles.moreText}>Show {hiddenCount} more…</Text>
        </TouchableOpacity>
      ) : null}
      {controls.map((o, i) => renderButton(o, i, 'control'))}
    </View>
  );
}

/** Zod schema for the `render_selection` tool args (mirrors generative_ui_tools output). */
export const renderSelectionParameters = z.object({
  options: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      kind: z.enum(['movie', 'collection', 'scope', 'control']),
    }),
  ),
});

/**
 * Registers the `render_selection` generative-UI tool with CopilotKit so the dock renders the
 * search workflow's selectable buttons inline. Mount once inside the dock (alongside the other
 * render tools).
 */
export function useRenderSelectionTool(): void {
  useRenderTool<SelectionOptionsProps>({
    name: RENDER_SELECTION_TOOL,
    description:
      'Display selectable buttons for the movie-search workflow — search scope, collections, results, or controls. Tapping one advances the search.',
    parameters: renderSelectionParameters,
    render: ({ args }) => <SelectionOptions {...args} />,
  });
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: { gap: 6, paddingVertical: 4 },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: theme.surfaceVariant?.val,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.outlineVariant?.val,
  },
  control: { backgroundColor: theme.surface1?.val, borderStyle: 'dashed' },
  optionText: { fontFamily: 'Inter', fontSize: 14, color: theme.onSurface?.val, fontWeight: '500' },
  more: { paddingHorizontal: 12, paddingVertical: 6 },
  moreText: { fontFamily: 'Inter', fontSize: 13, color: theme.primary?.val, fontWeight: '600' },
});
