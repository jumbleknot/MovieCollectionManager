/**
 * AssistantDock (T029) — app-wide overlay/dock for the conversational assistant.
 *
 * Reachable from any screen (clarify round 1). The toggle is always mounted; the chat
 * panel (which binds to the AG-UI agent via useAgent/useCopilotKit) mounts ONLY when the
 * dock is opened — so no agent run is triggered until the user opens the assistant, and
 * the closed dock has no backend dependency. Stable testIDs back the web E2E (Playwright).
 */
import React, { useCallback, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useAgent, useCopilotKit } from '@copilotkit/react-native';

import { NoAutoFillInput } from '@/components/no-autofill-input';
import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

type ChatMessage = { id?: string; role: string; content?: string };

export function AssistantDock() {
  const [open, setOpen] = useState(false);
  return (
    <View testID="assistant-dock" style={styles.dock} pointerEvents="box-none">
      <TouchableOpacity
        testID="assistant-dock-toggle"
        accessibilityRole="button"
        accessibilityLabel="Toggle movie assistant"
        onPress={() => setOpen((o) => !o)}
        style={styles.toggle}
      >
        <Text style={styles.toggleText}>{open ? 'Close assistant' : 'Assistant'}</Text>
      </TouchableOpacity>
      {open && <AssistantPanel />}
    </View>
  );
}

function AssistantPanel() {
  const [input, setInput] = useState('');
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });

  const messages = ((agent?.messages ?? []) as ChatMessage[]).filter(
    (m) => !!m.content && (m.role === 'user' || m.role === 'assistant'),
  );
  const isRunning = agent?.isRunning ?? false;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !agent || isRunning) return;
    setInput('');
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: text });
    await copilotkit.runAgent({ agent });
  }, [input, agent, isRunning, copilotkit]);

  return (
    <View testID="assistant-dock-panel" style={styles.panel}>
      <FlatList
        testID="assistant-dock-messages"
        data={messages}
        keyExtractor={(item, i) => item.id ?? String(i)}
        renderItem={({ item }) => (
          <View testID={`assistant-msg-${item.role}`} style={styles.message}>
            <Text>{item.content}</Text>
          </View>
        )}
      />
      <View style={styles.inputRow}>
        <NoAutoFillInput
          testID="assistant-dock-input"
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your movie collections…"
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

const styles = {
  // Bottom-LEFT, not bottom-right: every existing primary action in this app is a
  // bottom-right FAB (collection-screen-add-movie, etc.). A bottom-right dock toggle
  // overlapped that FAB and intercepted its clicks, breaking existing E2E flows
  // (SC-005 additive-only violation). Bottom-left is unoccupied app-wide. The container
  // is pointerEvents="box-none" so only the toggle/panel themselves capture events.
  dock: { position: 'absolute' as const, left: 16, bottom: 16, alignItems: 'flex-start' as const },
  toggle: { backgroundColor: '#4a6a88', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10 },
  toggleText: { color: '#fff', fontWeight: '600' as const },
  panel: { width: 320, height: 420, marginTop: 8, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#d0d7de', padding: 8 },
  message: { paddingVertical: 6, paddingHorizontal: 8 },
  inputRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#d0d7de', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  send: { backgroundColor: '#4a6a88', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  sendText: { color: '#fff', fontWeight: '600' as const },
};
