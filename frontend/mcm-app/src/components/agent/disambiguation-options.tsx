/**
 * DisambiguationOptions (013 US4) — client adapter for the `render_disambiguation` tool.
 *
 * When the curator offers ambiguous matches it emits a `render_disambiguation` AG-UI tool call
 * carrying the candidate options (generative_ui_tools.render_disambiguation). This renders one
 * selectable button per candidate (≤5, with an overflow control for the rest). Tapping a button
 * posts the SAME canonical disambiguator text the user could type ("<title> (<year>)"), which the
 * curator's pure-code resolve_option resolves — so no model decision changes and the assistant
 * text reply remains the fallback for clients that don't render the tool.
 *
 * Universal Generative UI: one React Native component, identical on web + Android.
 */
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@mcm/design-system';
import { useAgent, useCopilotKit, useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

/** AG-UI tool name — must match the curator's emitted tool call (generative_ui_tools.py). */
export const RENDER_DISAMBIGUATION_TOOL = 'render_disambiguation';

/** Max buttons shown before the overflow control (FR: ≤5 candidates surfaced upfront). */
export const DISAMBIG_VISIBLE_LIMIT = 5;

export type DisambiguationOption = {
  title: string;
  year: number | null;
  sourceId: string;
};

export type DisambiguationOptionsProps = {
  options: DisambiguationOption[];
};

/** The canonical disambiguator text a tap posts — identical to what the user could type. */
export function disambiguatorText(o: DisambiguationOption): string {
  return o.year != null ? `${o.title} (${o.year})` : o.title;
}

export function DisambiguationOptions({ options }: DisambiguationOptionsProps) {
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const [showAll, setShowAll] = useState(false);

  const isRunning = agent?.isRunning ?? false;
  const visible = showAll ? options : options.slice(0, DISAMBIG_VISIBLE_LIMIT);
  const hiddenCount = options.length - DISAMBIG_VISIBLE_LIMIT;

  const pick = useCallback(
    (o: DisambiguationOption) => {
      if (!agent || isRunning) return;
      // Same send path as the dock input — post the canonical text, then run the agent.
      agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: disambiguatorText(o) });
      void copilotkit.runAgent({ agent });
    },
    [agent, isRunning, copilotkit],
  );

  return (
    <View testID="disambiguation-options" style={styles.container}>
      {visible.map((o, i) => (
        <Button
          key={`${o.sourceId || 'opt'}-${i}`}
          testID={`disambig-option-${i}`}
          variant="outlined"
          label={disambiguatorText(o)}
          onPress={() => pick(o)}
          accessibilityLabel={`Choose ${disambiguatorText(o)}`}
          justifyContent="flex-start"
          multiline
        />
      ))}
      {!showAll && hiddenCount > 0 ? (
        <Button
          testID="disambig-more"
          variant="text"
          label={`Show ${hiddenCount} more…`}
          onPress={() => setShowAll(true)}
          accessibilityLabel={`Show ${hiddenCount} more matches`}
          justifyContent="flex-start"
        />
      ) : null}
    </View>
  );
}

/** Zod schema for the `render_disambiguation` tool args (mirrors generative_ui_tools output). */
export const renderDisambiguationParameters = z.object({
  options: z.array(
    z.object({
      title: z.string(),
      year: z.number().nullable(),
      sourceId: z.string(),
    }),
  ),
});

/**
 * Registers the `render_disambiguation` generative-UI tool with CopilotKit so the dock renders
 * the selectable option buttons inline when the curator offers ambiguous matches. Mount once
 * inside the dock (alongside the other render tools).
 */
export function useRenderDisambiguationTool(): void {
  useRenderTool<DisambiguationOptionsProps>({
    name: RENDER_DISAMBIGUATION_TOOL,
    description:
      'Display selectable buttons for the candidate movie matches when a look-up is ambiguous. Tapping one chooses that match.',
    parameters: renderDisambiguationParameters,
    render: ({ args }) => <DisambiguationOptions {...args} />,
  });
}

const styles = StyleSheet.create({
  // Full-width, stacked DS Buttons (outlined) — one shared button style across the dock.
  container: { gap: 6, paddingVertical: 4 },
});
