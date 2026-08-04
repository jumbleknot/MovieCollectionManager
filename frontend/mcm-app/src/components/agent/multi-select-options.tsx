/**
 * MultiSelectOptions (047 US4) — client adapter for the `render_multi_select` tool.
 *
 * The multi-valued counterpart to `render_selection`. The organizer emits it when the answer is a
 * SET rather than one pick — which media formats a movie is owned on, at which qualities it is
 * ripped (agents/movie-assistant/src/nodes/organizer.py).
 *
 * Contract: specs/047-movie-assistant-enhancements/contracts/render-multi-select.md.
 *
 * Two rules shape the whole component:
 *
 *   1. **Toggling is local; nothing is sent until confirm.** No client-side state mutation ever
 *      reaches the agent (the 013 pattern). On confirm it posts ONE message —
 *      "Selected: DVD, Blu-Ray", or "Selected: none" — through the SAME send path as the dock
 *      input, which the organizer resolves in pure code. So a member who types the answer reaches
 *      exactly the same place as one who taps (FR-036).
 *   2. **Confirming zero selections is valid** (FR-028), not a no-op. "I own it, but not on any of
 *      these" is a real answer, so the confirm button is never disabled for an empty selection.
 *
 * The option VALUES are supplied by the agent, which fetched them from mc-service — this component
 * never contains a list of media formats, and must not gain one.
 *
 * Universal Generative UI: one React Native component, identical on web + Android (FR-020b).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@mcm/design-system';
import { useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

import { useAssistantRun } from '@/hooks/use-assistant';

/** AG-UI tool name — must match the organizer's emitted tool call (generative_ui_tools.py). */
export const RENDER_MULTI_SELECT_TOOL = 'render_multi_select';

/** The canonical prefix the confirm action posts back; the agent strips it before matching. */
export const MULTI_SELECT_REPLY_PREFIX = 'Selected:';

/** What an empty confirm posts — a real answer, distinct from not answering (FR-028). */
export const MULTI_SELECT_NONE_REPLY = `${MULTI_SELECT_REPLY_PREFIX} none`;

export type MultiSelectOption = {
  label: string;
  value: string;
  selected?: boolean;
};

export type MultiSelectOptionsProps = {
  prompt: string;
  options: MultiSelectOption[];
  confirmLabel?: string;
};

/** Build the single message a confirm posts. Exported so the test asserts the exact contract. */
export function buildMultiSelectReply(values: string[]): string {
  return values.length === 0
    ? MULTI_SELECT_NONE_REPLY
    : `${MULTI_SELECT_REPLY_PREFIX} ${values.join(', ')}`;
}

export function MultiSelectOptions({ prompt, options, confirmLabel }: MultiSelectOptionsProps) {
  // Same resilient send path as the dock input (use-assistant.tsx), so a confirm is queued rather
  // than dropped if the CopilotKit-RN agent registry is transiently empty.
  const { run } = useAssistantRun();

  // Initial state comes from the agent's `selected` flags, so a re-ask can show what was already
  // chosen. Keyed by VALUE, not index, so it survives a re-render with reordered props.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(options.filter((o) => o.selected).map((o) => o.value)),
  );
  const [confirmed, setConfirmed] = useState(false);

  const toggle = useCallback((value: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);

  // Confirm in the ORDER THE OPTIONS WERE OFFERED, not insertion order, so the posted message is
  // deterministic for a given selection regardless of the order the member tapped them.
  const selectedValues = useMemo(
    () => options.filter((o) => chosen.has(o.value)).map((o) => o.value),
    [options, chosen],
  );

  const confirm = useCallback(() => {
    if (confirmed) return;
    setConfirmed(true);
    run(buildMultiSelectReply(selectedValues));
  }, [confirmed, run, selectedValues]);

  const summary =
    selectedValues.length === 0
      ? 'Nothing selected'
      : `Selected: ${options.filter((o) => chosen.has(o.value)).map((o) => o.label).join(', ')}`;

  return (
    <View testID="multi-select-options" style={styles.container}>
      {options.map((o, i) => {
        const isOn = chosen.has(o.value);
        return (
          <Button
            key={`multi-${o.value || 'opt'}-${i}`}
            testID={`multi-select-option-${i}`}
            // Filled vs outlined is the visible affordance; `accessibilityState` below is what
            // assistive technology reads, so the selected state is never colour-alone.
            variant={isOn ? 'filled' : 'outlined'}
            label={o.label}
            onPress={() => toggle(o.value)}
            disabled={confirmed}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isOn, disabled: confirmed }}
            accessibilityLabel={`${o.label}${isOn ? ', selected' : ', not selected'}`}
            justifyContent="flex-start"
            multiline
          />
        );
      })}

      {/* The current selection is visible BEFORE confirming (FR-020a). */}
      <Text testID="multi-select-summary" style={styles.summary}>
        {summary}
      </Text>

      <Button
        testID="multi-select-confirm"
        variant="filled"
        // Never disabled on an empty selection — confirming zero is a valid answer (FR-028).
        // Disabled only AFTER confirming, so the same question cannot be answered twice.
        label={confirmLabel || 'Done'}
        onPress={confirm}
        disabled={confirmed}
        accessibilityState={{ disabled: confirmed }}
        accessibilityLabel={`${confirmLabel || 'Done'} — confirm ${
          selectedValues.length === 0 ? 'no selections' : summary.toLowerCase()
        } for: ${prompt}`}
      />
    </View>
  );
}

/** Zod schema for the `render_multi_select` tool args (mirrors generative_ui_tools output). */
export const renderMultiSelectParameters = z.object({
  prompt: z.string(),
  options: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      selected: z.boolean().optional(),
    }),
  ),
  confirmLabel: z.string().optional(),
});

/**
 * Registers the `render_multi_select` generative-UI tool with CopilotKit so the dock renders the
 * ownership toggle lists inline. Mount once inside the dock (alongside the other render tools).
 */
export function useRenderMultiSelectTool(): void {
  useRenderTool<MultiSelectOptionsProps>({
    name: RENDER_MULTI_SELECT_TOOL,
    description:
      'Display a multi-select toggle list with a confirm action — e.g. which media formats a movie is owned on, or at which qualities it is ripped. Several options can be turned on before confirming.',
    parameters: renderMultiSelectParameters,
    render: ({ args }) => <MultiSelectOptions {...args} />,
  });
}

const styles = StyleSheet.create({
  container: { gap: 6, paddingVertical: 4 },
  summary: { opacity: 0.8, paddingTop: 2 },
});
