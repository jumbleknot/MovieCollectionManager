/**
 * ToolCallPending (066 / item #265) — the shared "this card is still arriving" state.
 *
 * CopilotKit 1.70 streams a tool call's arguments: a `render` is invoked while the model is still
 * writing the JSON, so `args` can be missing required fields. Every generative-UI render site gates
 * on its own parameter schema and shows THIS while the args do not yet validate, rather than
 * spreading absent fields into a component that promises them.
 *
 * It deliberately does NOT branch on the props union's `status`. Measured 2026-09-06 against
 * @copilotkit/react-native@1.70.1: `status` is `inProgress` even for complete arguments, because the
 * library derives `Complete` from a matching `toolMessage` and `Executing` from `executingToolCallIds`
 * — and MCM's generative-UI tools are all render-only (no handler) against a gateway that emits
 * `AIMessage(tool_calls=…)` and never a `ToolMessage`. Branching on `status` would make every card a
 * permanent skeleton. See specs/066-copilotkit-170-migration/spec.md.
 *
 * Universal Generative UI (constitution): one React Native component, identical on web and Android.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';

export type ToolCallPendingProps = {
  /** Short, human phrasing of what is arriving — e.g. "Loading the movie…". */
  label: string;
};

export function ToolCallPending({ label }: ToolCallPendingProps) {
  const styles = makeStyles(useTheme());
  return (
    <View testID="tool-call-pending" style={styles.card}>
      <Text testID="tool-call-pending-label" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  card: {
    padding: 8,
    marginVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.outlineVariant?.val,
    backgroundColor: theme.surface2?.val,
  },
  label: { fontFamily: 'Inter', fontSize: 12, color: theme.onSurfaceVariant?.val },
});
