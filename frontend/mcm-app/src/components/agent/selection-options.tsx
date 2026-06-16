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
import { StyleSheet, View } from 'react-native';
import { Button } from '@mcm/design-system';
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

  // All buttons share the SAME DS Button (outlined, full-width) — the previous bespoke styles
  // (esp. the dashed low-contrast scope/control variant) were hard to see; one button style now.
  const renderButton = (o: SelectionOption, i: number, group: string) => (
    <Button
      key={`${group}-${o.value || 'opt'}-${i}`}
      testID={`selection-option-${group}-${i}`}
      variant="outlined"
      label={o.label}
      onPress={() => choose(o)}
      accessibilityLabel={`Choose ${o.label}`}
      justifyContent="flex-start"
    />
  );

  return (
    <View testID="selection-options" style={styles.container}>
      {visiblePicks.map((o, i) => renderButton(o, i, 'pick'))}
      {!showAll && hiddenCount > 0 ? (
        <Button
          testID="selection-more"
          variant="text"
          label={`Show ${hiddenCount} more…`}
          onPress={() => setShowAll(true)}
          accessibilityLabel={`Show ${hiddenCount} more matches`}
          justifyContent="flex-start"
        />
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

const styles = StyleSheet.create({
  container: { gap: 6, paddingVertical: 4 },
});
