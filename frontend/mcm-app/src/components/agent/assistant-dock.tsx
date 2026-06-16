/**
 * AssistantDock (T029) — app-wide overlay/dock for the conversational assistant.
 *
 * Reachable from any screen (clarify round 1). The toggle is always mounted; the chat
 * panel (which binds to the AG-UI agent via useAgent/useCopilotKit) mounts ONLY when the
 * dock is opened — so no agent run is triggered until the user opens the assistant, and
 * the closed dock has no backend dependency. Stable testIDs back the web E2E (Playwright).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { AssistantAvatar, ChatBubble } from '@mcm/design-system';
import { useAgent, useCopilotKit, useRenderToolRegistry } from '@copilotkit/react-native';

import { NoAutoFillInput } from '@/components/no-autofill-input';
import { useRenderMovieCardTool } from '@/components/agent/render-movie-card';
import { useRenderCollectionSummaryTool } from '@/components/agent/render-collection-summary';
import { useRenderDisambiguationTool } from '@/components/agent/disambiguation-options';
import { useRenderSelectionTool } from '@/components/agent/selection-options';
import { useUiActionTools } from '@/components/agent/ui-action-tools';
import { useApprovalInterrupt } from '@/components/agent/approval-request';
import { useRequestImportFileTool } from '@/components/agent/request-import-file';
import { useRenderImportReportTool } from '@/components/agent/render-import-report';
import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';
import { useBumpAssistantData } from '@/hooks/use-assistant-data-sync';

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type ChatMessage = { id?: string; role: string; content?: string; toolCalls?: ToolCall[] };

// A flat, renderable view-model: text bubbles AND inline generative-UI tool cards, in order.
type DockItem =
  | { kind: 'text'; id: string; role: string; content: string }
  | { kind: 'tool'; id: string; element: React.ReactElement };

export function AssistantDock() {
  const [open, setOpen] = useState(false);
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View testID="assistant-dock" style={styles.dock} pointerEvents="box-none">
      <TouchableOpacity
        testID="assistant-dock-toggle"
        accessibilityRole="button"
        accessibilityLabel="Toggle movie assistant"
        onPress={() => setOpen((o) => !o)}
        style={styles.toggle}
      >
        {/* The Grumpy Robot avatar is the assistant's identity + one of the sanctioned
            orange (tertiary) accents (FR-006). */}
        <AssistantAvatar size="xs" />
        <Text style={styles.toggleText}>{open ? 'Close assistant' : 'Assistant'}</Text>
      </TouchableOpacity>
      {open && <AssistantPanel />}
    </View>
  );
}

/**
 * Flatten agent messages into ordered renderable items: text bubbles plus any inline
 * generative-UI tool calls whose tool name is registered (e.g. `render_movie_card`). Unknown
 * tool calls and unparseable args are skipped — never crash the chat.
 */
export function buildDockItems(
  messages: ChatMessage[],
  registry: ReadonlyMap<string, (props: { args: Record<string, unknown>; status: 'complete' }) => React.ReactElement | null>,
): DockItem[] {
  const items: DockItem[] = [];
  messages.forEach((m, i) => {
    // Prefix every item id with the message index so keys stay UNIQUE even when the agent
    // message list contains a repeated message / tool call after an approve→resume
    // continuation (the same `render_movie_card` tool-call id can appear twice). A duplicate
    // FlatList key throws a React "two children with the same key" error — a harmless
    // console.error on web, but a blocking LogBox RedBox on Android that overlays the dock.
    if (m.content && (m.role === 'user' || m.role === 'assistant')) {
      items.push({ kind: 'text', id: `${i}:${m.id ?? 'm'}`, role: m.role, content: m.content });
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        const renderFn = registry.get(tc.function.name);
        if (!renderFn) continue;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          continue;
        }
        const element = renderFn({ args, status: 'complete' });
        if (element) items.push({ kind: 'tool', id: `${i}:${tc.id}`, element });
      }
    }
  });
  return items;
}

/**
 * Auto-scroll the dock to the newest item (013 Inc5 enhancement 1). Re-fires `scrollToEnd`, deferred
 * a tick, whenever `revision` changes (a new message or card item appended). The deferral matters
 * for cards: a card's async content (poster image) can grow the list AFTER the initial layout, so
 * the FlatList's onContentSizeChange may not land the view at the bottom on its own.
 */
export function useScrollToEndOnChange(revision: number, scrollToEnd: () => void): void {
  useEffect(() => {
    const id = setTimeout(scrollToEnd, 120);
    return () => clearTimeout(id);
  }, [revision, scrollToEnd]);
}

function AssistantPanel() {
  const [input, setInput] = useState('');
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });

  // Register the generative-UI tools, then read the registry to render their tool calls inline.
  useRenderMovieCardTool();
  useRenderCollectionSummaryTool();
  // US4: ambiguous look-up matches render as selectable buttons (tap = post the canonical pick).
  useRenderDisambiguationTool();
  // US7: the unified search workflow's generalized selectable buttons (scope/collection/result/
  // control) — tap posts the canonical value back into the pure-code search state machine.
  useRenderSelectionTool();
  // US3/T059: the navigate_*/prefill UI-action tools — each renders an effect that authorizes
  // at the BFF then drives expo-router navigation (no domain write).
  useUiActionTools();
  // 014: the import "Choose file…/Cancel" affordance the import node emits when no file is staged
  // (an import is started by TYPING the request — there is no always-on upload button).
  useRequestImportFileTool();
  // 014 enhancement 3: the post-import "what wasn't imported" report card (skipped + failed rows).
  useRenderImportReportTool();
  const renderToolRegistry = useRenderToolRegistry();
  // T072: when an APPROVED write-apply run finishes, refresh any on-screen list. The approval
  // callback marks a pending write; the run-completion watcher below fires the bump once the
  // resumed run goes idle (a read/query turn never approves, so it never bumps).
  const bumpAssistantData = useBumpAssistantData();
  const pendingWriteRef = useRef(false);
  const approvalElement = useApprovalInterrupt(() => {
    pendingWriteRef.current = true;
  });

  const rawMessages = (agent?.messages ?? []) as ChatMessage[];
  const items = buildDockItems(rawMessages, renderToolRegistry);
  const isRunning = agent?.isRunning ?? false;

  // Bump the shared data revision when a run that applied an approved write transitions
  // running → idle, so the collection/movie/home lists re-fetch the now-changed server state.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning && pendingWriteRef.current) {
      pendingWriteRef.current = false;
      bumpAssistantData();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, bumpAssistantData]);

  // Keep the latest message in view as the conversation grows (e.g. the post-approval "Done"
  // confirmation after a multi-turn add) — the list does not auto-scroll otherwise, so on a
  // long thread the newest message lands below the fold on mobile.
  const listRef = useRef<FlatList<DockItem>>(null);
  const scrollToLatest = useCallback(() => listRef.current?.scrollToEnd({ animated: true }), []);
  // 013 Inc5 enhancement 1: keep the view pinned to the bottom when a new item — especially a card,
  // whose poster image lays out asynchronously — is appended (onContentSizeChange alone misses it).
  useScrollToEndOnChange(items.length, scrollToLatest);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !agent || isRunning) return;
    setInput('');
    // The current screen's ui_snapshot is already pushed to the BFF on focus (useReportUiState),
    // so it is cached before the turn — "add this" resolves it without a pre-run flush (a flush
    // here injected an await before runAgent that broke the CopilotKit run; US3/R15).
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: text });
    await copilotkit.runAgent({ agent });
  }, [input, agent, isRunning, copilotkit]);

  return (
    <View testID="assistant-dock-panel" style={styles.panel}>
      <FlatList
        ref={listRef}
        testID="assistant-dock-messages"
        data={items}
        keyExtractor={(item, i) => item.id ?? String(i)}
        onContentSizeChange={scrollToLatest}
        onLayout={scrollToLatest}
        renderItem={({ item }) =>
          item.kind === 'text' ? (
            // Wrapper keeps the stable assistant-msg-<role> testID; the DS ChatBubble
            // (Grumpy Robot avatar on assistant turns) renders the message visuals.
            <View testID={`assistant-msg-${item.role}`} style={styles.message}>
              <ChatBubble sender={item.role === 'user' ? 'user' : 'assistant'} message={item.content} />
            </View>
          ) : (
            <View testID={`assistant-tool-${item.id}`} style={styles.message}>
              {item.element}
            </View>
          )
        }
      />
      {approvalElement}
      <View style={styles.inputRow}>
        <NoAutoFillInput
          testID="assistant-dock-input"
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your movie collections…"
          placeholderTextColor={theme.onSurfaceVariant?.val}
          style={styles.input}
          onSubmitEditing={send}
        />
        <TouchableOpacity testID="assistant-dock-send" onPress={send} style={styles.send}>
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
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
  panel: { width: 320, height: 420, marginTop: 8, backgroundColor: theme.surface1?.val, borderRadius: 12, borderWidth: 1, borderColor: theme.outlineVariant?.val, padding: 8 },
  message: { paddingVertical: 6, paddingHorizontal: 2 },
  inputRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: theme.outline?.val, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: theme.onSurface?.val, backgroundColor: theme.surfaceVariant?.val, fontFamily: 'Inter' },
  send: { backgroundColor: theme.primary?.val, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  sendText: { color: theme.onPrimary?.val, fontFamily: 'Inter', fontWeight: '600' as const },
});
