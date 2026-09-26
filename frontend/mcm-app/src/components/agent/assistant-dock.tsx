/**
 * The assistant dock's toggle — and the boundary the panel is deferred across (T029; feature 077).
 *
 * WHAT IS LEFT IN THIS FILE, AND WHY IT MATTERS. Only the toggle: a `TouchableOpacity`, an avatar,
 * and the state machine that fetches the panel. It imports nothing from `@copilotkit/*`, `@ag-ui/*`
 * or `@/hooks/use-assistant`, and that absence is the feature. Everything that used to sit here
 * moved to `@/components/agent/assistant-panel`, reachable only through the dynamic import in
 * `@/utils/assistant-runtime-loader` — 2.4 MB that no longer loads before a route can paint.
 *
 * Reachable from any screen (clarify round 1). The toggle is always mounted; the panel mounts only
 * when the dock is opened — so no agent run is triggered until the user opens the assistant, and the
 * closed dock has no backend dependency. Stable testIDs back the web E2E (Playwright).
 *
 * WHY THIS IS A STATE MACHINE AND NOT `React.lazy`. `React.lazy` is the idiomatic answer and it
 * cannot satisfy FR-006. Measured: `lazy` calls its factory exactly ONCE and caches a rejection on
 * the lazy object for the life of the page — a probe confirmed the factory is not re-invoked even on
 * a fresh mount after the error boundary resets. So a failed chunk fetch would disable the assistant
 * until a reload, no matter how retry-capable the loader beneath it is. Twelve lines of explicit
 * state buy a Retry that works.
 *
 * The prefetch is what keeps the deferral from costing the user anything: by the time they reach for
 * the toggle the chunk is usually already warm. See `@/hooks/use-assistant-runtime`.
 */
import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { AssistantAvatar } from '@mcm/design-system';

import { AssistantPanelError, AssistantPanelLoading } from '@/components/agent/assistant-panel-fallback';
import { useAssistantRuntimePrefetch } from '@/hooks/use-assistant-runtime';
import { loadAssistantRuntime, type AssistantRuntimeModule } from '@/utils/assistant-runtime-loader';

type PanelComponent = AssistantRuntimeModule['default'];

export function AssistantDock() {
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState<PanelComponent | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const theme = useTheme();
  const styles = makeStyles(theme);

  // Warm the chunk on idle, after this route is interactive. Never during render — see the hook.
  useAssistantRuntimePrefetch();

  const fetchPanel = useCallback(() => {
    setFailed(false);
    setLoading(true);
    loadAssistantRuntime()
      .then((mod) => {
        setPanel(() => mod.default);
        setLoading(false);
      })
      .catch(() => {
        // `loadAssistantRuntime` clears its own cache on rejection, so this is retryable.
        setFailed(true);
        setLoading(false);
      });
  }, []);

  const onToggle = useCallback(() => {
    setOpen((wasOpen) => {
      const nowOpen = !wasOpen;
      // Fetch on the transition to open, and only when we do not already hold the panel. `loading`
      // is checked so a flurry of presses mid-flight does not stack requests — the loader is
      // single-flight anyway, but not re-entering keeps the state transitions honest.
      if (nowOpen && !Panel && !loading) fetchPanel();
      return nowOpen;
    });
  }, [Panel, loading, fetchPanel]);

  return (
    <View testID="assistant-dock" style={styles.dock} pointerEvents="box-none">
      <TouchableOpacity
        testID="assistant-dock-toggle"
        accessibilityRole="button"
        accessibilityLabel="Toggle movie assistant"
        onPress={onToggle}
        style={styles.toggle}
      >
        {/* The Grumpy Robot avatar is the assistant's identity + one of the sanctioned
            orange (tertiary) accents (FR-006 of feature 012). */}
        <AssistantAvatar size="xs" />
        <Text style={styles.toggleText}>{open ? 'Close assistant' : 'Assistant'}</Text>
      </TouchableOpacity>
      {open && Panel ? <Panel /> : null}
      {open && !Panel && failed ? <AssistantPanelError onRetry={fetchPanel} /> : null}
      {open && !Panel && !failed ? <AssistantPanelLoading /> : null}
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => ({
  // Bottom-LEFT, not bottom-right: form action footers across the app (movie-form, etc.) pin
  // their primary action to the bottom-RIGHT (justifyContent: flex-end), and other primary
  // actions are bottom-right FABs. A bottom-right dock toggle overlaps those buttons and
  // intercepts their clicks, breaking existing E2E flows (SC-005 additive-only violation;
  // confirmed by a movies.spec.ts mass failure when the dock was moved right). Bottom-left is
  // unoccupied app-wide. The container is pointerEvents="box-none" so only the toggle/panel
  // themselves capture events.
  dock: { position: 'absolute' as const, left: 16, bottom: 16, alignItems: 'flex-start' as const },
  toggle: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, backgroundColor: theme.surface3?.val, borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: theme.outlineVariant?.val },
  toggleText: { color: theme.onSurface?.val, fontFamily: 'Inter', fontWeight: '600' as const },
});
