/**
 * The assistant's conversation panel — AND THE DEFERRED CHUNK'S ROOT (feature 077; item #558).
 *
 * WHY THIS FILE EXISTS AS A FILE. Everything below used to live in `assistant-dock.tsx` alongside
 * the toggle. Measured on the web bundle, that one file's import list was 57% of everything the
 * browser downloaded before ANY route could paint: `zod` (640 KB), `graphql` (246 KB),
 * `@copilotkit/*` (234 KB), `@ag-ui/*` (144 KB), `rxjs` (113 KB) — plus 659 KB of React Native
 * polyfills (`text-encoding`, `web-streams-polyfill`) that cannot even execute on web and are
 * unavoidable because `@copilotkit/react-native/dist/headless.mjs` opens with
 * `import "./polyfills.mjs"`, a side effect of the package's own entry point.
 *
 * None of it is needed to paint a screen. This module is therefore the ONLY place in the app from
 * which those packages are reachable, and it is reached exclusively through the dynamic import in
 * `@/utils/assistant-runtime-loader`. That is the entire mechanism:
 *
 *   A STATIC IMPORT OF THIS MODULE FROM ANYWHERE IN THE EAGER GRAPH UNDOES THE WHOLE FEATURE.
 *
 * It would not fail anything obviously — the app would work, and the bundle would quietly be 2.4 MB
 * bigger. `scripts/check-web-bundle-budget.mjs` is the guard: it asserts those packages contribute
 * zero modules to the entry chunk, so a stray static import fails CI naming the package rather than
 * showing up as an unexplained size regression.
 *
 * `AssistantProvider` is mounted HERE rather than in `(app)/_layout.tsx`, which is where it used to
 * live. That move is load-bearing, not tidying: the provider imports `CopilotKitProvider` from
 * `@copilotkit/react-native`, so leaving it in the layout would keep the entire graph above in the
 * entry chunk and defer nothing at all.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button, ChatBubble } from '@mcm/design-system';
import { useAgent, useRenderToolCall, type ToolCall } from '@copilotkit/react-native';

import { NoAutoFillInput } from '@/components/no-autofill-input';
import { ImportProgress } from '@/components/agent/import-progress';
import { useRenderMovieCardTool } from '@/components/agent/render-movie-card';
import { useRenderCollectionSummaryTool } from '@/components/agent/render-collection-summary';
import { useRenderDisambiguationTool } from '@/components/agent/disambiguation-options';
import { useRenderSelectionTool } from '@/components/agent/selection-options';
import { useRenderMultiSelectTool } from '@/components/agent/multi-select-options';
import { useUiActionTools } from '@/components/agent/ui-action-tools';
import { useApprovalInterrupt } from '@/components/agent/approval-request';
import { useRequestImportFileTool } from '@/components/agent/request-import-file';
import { useRenderImportReportTool } from '@/components/agent/render-import-report';
import { ASSISTANT_AGENT_ID, AssistantProvider, useAssistantRun } from '@/hooks/use-assistant';
import { useBumpAssistantData } from '@/hooks/use-assistant-data-sync';

// `ToolCall` is CopilotKit's own (re-exported from @ag-ui/client). It was a local structural copy
// until 066/#265: `useRenderToolCall` takes the real type, whose `type` is the literal 'function',
// and a local alias widening that to `string` is what would otherwise force a cast here.
type ChatMessage = { id?: string; role: string; content?: string; toolCalls?: ToolCall[] };

// A flat, renderable view-model: text bubbles AND inline generative-UI tool cards, in order.
type DockItem =
  | { kind: 'text'; id: string; role: string; content: string }
  | { kind: 'tool'; id: string; element: React.ReactElement };
/**
 * Renders one tool call through CopilotKit's registered renderers, or null when no renderer is
 * registered for its name. This is `useRenderToolCall()`'s return value.
 *
 * 066/#265: 1.70 removed `useRenderToolRegistry` — the React Native package no longer keeps a
 * registry of its own; renderers register into react-core's canonical `copilotkit.renderToolCalls`
 * and are read back through this function. It owns the argument parsing (partial-JSON tolerant,
 * because arguments STREAM) and the props union that used to be built here by hand.
 */
type RenderToolCall = ReturnType<typeof useRenderToolCall>;

/**
 * Flatten agent messages into ordered renderable items: text bubbles plus any inline
 * generative-UI tool calls whose tool name is registered (e.g. `render_movie_card`). Unknown
 * tool calls render nothing and are skipped — never crash the chat.
 *
 * 066/#265: this no longer parses `tc.function.arguments` itself, and no longer asserts
 * `status: 'complete'`. Both were the old registry's contract; `renderToolCall` does the parsing
 * (tolerating a half-written JSON body mid-stream) and each registered renderer decides for itself
 * whether the arguments are complete enough to draw — see `tool-call-pending.tsx` for why that
 * decision cannot be made from `status`.
 */
export function buildDockItems(
  messages: ChatMessage[],
  renderToolCall: RenderToolCall,
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
        const element = renderToolCall({ toolCall: tc });
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
  // 047 US3 / FR-014a: the in-place import progress line needs re-renders on AGENT STATE, which
  // the DEFAULT subscription already provides — `useAgent` resolves `updates ?? ALL_UPDATES`, and
  // ALL_UPDATES is [OnMessagesChanged, OnStateChanged, OnRunStatusChanged].
  //
  // Do NOT pass `updates: ['OnStateChanged']` "to be explicit": the option REPLACES the default
  // rather than adding to it, so that silently unsubscribes the dock from message and run-status
  // updates — which is how a tool call (navigate_to_movie, the render_* cards) reaches the client.
  // Measured: it made three navigation E2E specs time out waiting for a URL that never changed,
  // while the unit tests stayed green because they assert on what is REQUESTED, not on what is
  // still delivered.
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const agentState = (agent?.state ?? {}) as { import_applied?: number; import_total?: number };
  // Resilient send path (queues if the agent registry is transiently empty) — shared with the
  // generative-UI selection buttons so a typed send and a pick-tap behave identically.
  const { run } = useAssistantRun();

  // Register the generative-UI tools, then read the registry to render their tool calls inline.
  useRenderMovieCardTool();
  useRenderCollectionSummaryTool();
  // US4: ambiguous look-up matches render as selectable buttons (tap = post the canonical pick).
  useRenderDisambiguationTool();
  // US7: the unified search workflow's generalized selectable buttons (scope/collection/result/
  // control) — tap posts the canonical value back into the pure-code search state machine.
  useRenderSelectionTool();
  // 047 US4: the ownership toggle lists (which media formats, which rip qualities). Multi-valued,
  // so it is its own tool rather than a mode of render_selection — nothing is sent until confirm,
  // and confirming zero selections is a valid answer.
  useRenderMultiSelectTool();
  // US3/T059: the navigate_*/prefill UI-action tools — each renders an effect that authorizes
  // at the BFF then drives expo-router navigation (no domain write).
  useUiActionTools();
  // 014: the import "Choose file…/Cancel" affordance the import node emits when no file is staged
  // (an import is started by TYPING the request — there is no always-on upload button).
  useRequestImportFileTool();
  // 014 enhancement 3: the post-import "what wasn't imported" report card (skipped + failed rows).
  useRenderImportReportTool();
  const renderToolCall = useRenderToolCall();
  // T072: when an APPROVED write-apply run finishes, refresh any on-screen list. The approval
  // callback marks a pending write; the run-completion watcher below fires the bump once the
  // resumed run goes idle (a read/query turn never approves, so it never bumps).
  const bumpAssistantData = useBumpAssistantData();
  const pendingWriteRef = useRef(false);
  const approvalElement = useApprovalInterrupt(() => {
    pendingWriteRef.current = true;
  });

  const rawMessages = (agent?.messages ?? []) as ChatMessage[];
  const items = buildDockItems(rawMessages, renderToolCall);
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

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    // The current screen's ui_snapshot is already pushed to the BFF on focus (useReportUiState),
    // so it is cached before the turn — "add this" resolves it without a pre-run flush (a flush
    // here injected an await before runAgent that broke the CopilotKit run; US3/R15).
    // run() resolves the agent from the live registry and queues if it is transiently empty.
    run(text);
  }, [input, run]);

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
      {/* FR-014a: ONE surface that updates in place. It renders nothing once the gateway clears
          the counters at the end of the run, so the report replaces it (FR-014b). */}
      <ImportProgress
        applied={Number(agentState.import_applied ?? 0)}
        total={Number(agentState.import_total ?? 0)}
      />
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
        <Button
          variant="filled"
          size="sm"
          label="Send"
          onPress={send}
          testID="assistant-dock-send"
          accessibilityLabel="Send message"
        />
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
});

/**
 * The deferred chunk's entry point: the panel, already inside its CopilotKit provider.
 *
 * A default export because `@/utils/assistant-runtime-loader` resolves `.default` — keeping the
 * dynamic import's shape trivial, and keeping the dock ignorant of what the provider is.
 */
export default function AssistantRuntime(): React.JSX.Element {
  return (
    <AssistantProvider>
      <AssistantPanel />
    </AssistantProvider>
  );
}

// Named export too: `assistant-dock-tools.test.tsx` renders the panel directly to exercise
// generative-UI tool rendering, which is this module's job rather than the toggle's.
export { AssistantPanel };
