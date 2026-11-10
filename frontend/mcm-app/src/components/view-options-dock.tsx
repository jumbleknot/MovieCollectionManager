/**
 * Docked view options for the collection screen (098 US1, contracts/ui-contract.md).
 *
 * The column selector, sort control and filter panel used to sit inline above the movie list and,
 * on a phone, filled most of the first screen. They now live behind ONE compact bar:
 *
 *   ViewOptionsDock   — the bar (`view-options-toggle`), in NORMAL LAYOUT FLOW between the search
 *                       bar and the count row. Shows the active-filter count (`view-options-active-count`).
 *   ViewOptionsPanel  — the drop-down (`view-options-panel`), mounted by the screen INSIDE the
 *                       container that holds the count row and the list, absolutely positioned at its
 *                       top so it overlays them: the list never re-lays-out or re-scrolls (FR-005a).
 *                       Renders its children (the three existing controls, unchanged) only while open.
 *
 * Two exports rather than one because the overlay has to sit in a later layout container than the
 * bar it drops from. They share state through the OpenPanel context, which also makes opening the
 * assistant re-dock the view options (FR-015).
 *
 * WHY the bar is in flow: RN Fabric on Android does not dispatch Maestro's ACTION_CLICK to
 * absolutely-positioned views (see collection-screen.tsx). The panel's chips are inside an
 * absolutely-positioned view; the edited Maestro flows (T013) are what prove taps reach them.
 *
 * Close paths: the close button, the bar again, Android Back (BackHandler, native only, registered
 * only while open), web Escape, and leaving the screen — the panel is docked on every visit (FR-004).
 * Focus moves to the panel heading on open and back to the bar on close (FR-016).
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { BackHandler, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useFocusEffect } from 'expo-router';
import { Badge, Button, elevation } from '@mcm/design-system';

import { useOpenPanel } from '@/hooks/use-open-panel';
import { moveFocus } from '@/utils/move-focus';

const PANEL = 'view-options' as const;

function dockLabel(count: number): string {
  if (count <= 0) return 'View options';
  return `View options, ${count} ${count === 1 ? 'filter' : 'filters'} active`;
}

interface ViewOptionsDockProps {
  /** Number of filters currently applied — the badge and the accessibility label (FR-008). */
  activeFilterCount: number;
}

export function ViewOptionsDock({ activeFilterCount }: ViewOptionsDockProps): React.JSX.Element {
  const theme = useTheme();
  const { openPanel, toggle, close } = useOpenPanel();
  const open = openPanel === PANEL;
  const toggleRef = useRef<React.ComponentRef<typeof View>>(null);

  // Leaving the screen re-docks the panel, so the next visit starts docked (FR-004).
  useFocusEffect(useCallback(() => () => close(PANEL), [close]));

  // Return focus to the bar when the panel closes — but not when the assistant took over, which
  // manages its own focus.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && openPanel === null) moveFocus(toggleRef);
    wasOpen.current = open;
  }, [open, openPanel]);

  return (
    <Pressable
      ref={toggleRef}
      testID="view-options-toggle"
      accessibilityRole="button"
      accessibilityLabel={dockLabel(activeFilterCount)}
      accessibilityState={{ expanded: open }}
      onPress={() => toggle(PANEL)}
      style={[
        styles.bar,
        {
          backgroundColor: theme.surface2?.val,
          borderColor: theme.outlineVariant?.val,
        },
      ]}
    >
      <Text style={[styles.barLabel, { color: theme.onSurface?.val }]}>View options</Text>
      {activeFilterCount > 0 ? (
        <Badge
          testID="view-options-active-count"
          inline
          colorScheme="primary"
          count={activeFilterCount}
        />
      ) : null}
      <View style={styles.spacer} />
      <Text style={[styles.chevron, { color: theme.onSurfaceVariant?.val }]}>
        {open ? '▲' : '▼'}
      </Text>
    </Pressable>
  );
}

interface ViewOptionsPanelProps {
  children: React.ReactNode;
}

export function ViewOptionsPanel({ children }: ViewOptionsPanelProps): React.JSX.Element | null {
  const { openPanel } = useOpenPanel();
  if (openPanel !== PANEL) return null;
  return <OpenViewOptionsPanel>{children}</OpenViewOptionsPanel>;
}

function OpenViewOptionsPanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  const headingRef = useRef<React.ComponentRef<typeof Text>>(null);
  // `close` is a stable callback from the provider, so this is stable too and the listeners below
  // register once per open.
  const { close } = useOpenPanel();
  const onClose = useCallback(() => close(PANEL), [close]);

  // Focus into the panel on open (FR-016).
  useEffect(() => {
    moveFocus(headingRef);
  }, []);

  // Back (native) / Escape (web) re-dock without navigating (FR-007). Registered only while open.
  useEffect(() => {
    if (Platform.OS === 'web') {
      const doc = (globalThis as { document?: Document }).document;
      if (!doc) return undefined;
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') onClose();
      };
      doc.addEventListener('keydown', onKey);
      return () => doc.removeEventListener('keydown', onKey);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true; // handled — the router must not pop the collection screen
    });
    return () => sub.remove();
  }, [onClose]);

  const level = elevation[3];
  // RN-Web makes a heading programmatically focusable (but not tabbable) with tabIndex -1.
  const headingFocusProps = Platform.OS === 'web' ? ({ tabIndex: -1 } as object) : {};

  return (
    <View
      testID="view-options-panel"
      style={[
        styles.panel,
        {
          backgroundColor: theme[level.surfaceToneKey]?.val,
          borderColor: theme.outlineVariant?.val,
          shadowColor: level.shadowColor,
          shadowOffset: level.shadowOffset,
          shadowOpacity: level.shadowOpacity,
          shadowRadius: level.shadowRadius,
          elevation: level.elevation,
        },
      ]}
    >
      <View style={styles.header}>
        <Text
          ref={headingRef}
          accessibilityRole="header"
          style={[styles.heading, { color: theme.onSurface?.val }]}
          {...headingFocusProps}
        >
          View options
        </Text>
        <Button
          testID="view-options-close"
          variant="text"
          size="sm"
          label="Close"
          accessibilityLabel="Close view options"
          onPress={onClose}
        />
      </View>
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

const styles = {
  bar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    minHeight: 44, // WCAG 2.2 AA touch target (FR-016)
    marginHorizontal: 16,
    marginVertical: 4,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  barLabel: { fontFamily: 'Inter', fontWeight: '600' as const, fontSize: 14 },
  spacer: { flex: 1 },
  chevron: { fontSize: 12 },
  panel: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    maxHeight: '100%' as const,
    zIndex: 10,
    borderBottomWidth: 1,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    paddingBottom: 8,
  },
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingLeft: 16,
    paddingRight: 8,
  },
  heading: { fontFamily: 'Inter', fontWeight: '600' as const, fontSize: 16 },
  body: { flexShrink: 1 },
};
