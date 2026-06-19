/**
 * Movie Assistant configuration form (feature 018, T027 / US2+US3).
 *
 * Lets a user opt in to the assistant and bring their own credentials: enable toggle, provider
 * picker (Ollama / Anthropic), the provider's credential field(s), a TMDB key, and an optional
 * personal cost limit. Save runs validate-on-save (per-field 422 surfaced); Test re-probes the
 * already-stored credentials (US3). Secret fields are WRITE-ONLY — when a credential is already
 * on file we show a "Configured" indicator and an empty field means "keep the stored value"
 * (FR-014). No secret value is ever sent to or rendered in the client (FR-018).
 *
 * Authored against @mcm/design-system to satisfy the R1–R7 compliance scan (T023): themed
 * StyleSheet tokens only, DS Button/Chip/Banner, NoAutoFillInput for every field.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Switch } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Banner, Button, Chip } from '@mcm/design-system';

import { NoAutoFillInput } from '@/components/no-autofill-input';
import { useAssistantConfig } from '@/hooks/use-assistant-config';
import type { AgentConfigUpdate, AgentProvider, ProbeField, ProbeStatus } from '@/types/agent-config';

const PROVIDERS: { value: AgentProvider; label: string }[] = [
  { value: 'ollama', label: 'Ollama (self-hosted)' },
  { value: 'anthropic', label: 'Anthropic Claude' },
];

type FieldErrors = Partial<Record<ProbeField, string>>;

// Map a failed save to a user-facing banner. A 400/422 carries per-field reasons (shown inline);
// a 401 (session expired) and a 5xx carry none, so distinguish them rather than show the same
// opaque "could not save" for every failure (review M2).
function saveErrorMessage(outcome: { status: number; errors: { field: ProbeField; reason: string }[] }): string {
  if (outcome.status === 401) return 'Your session has expired — please sign in again.';
  if (outcome.status >= 500) return 'The server had a problem saving your settings. Please try again.';
  if (outcome.errors.length > 0) return 'Some settings could not be validated — see the messages below.';
  return 'Could not save your settings. Please try again.';
}

export function MovieAssistantConfig(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { config, loading, save, test } = useAssistantConfig();

  // Non-secret form state — hydrated from the loaded config (secrets are never hydrated).
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<AgentProvider>('ollama');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('');
  const [costLimit, setCostLimit] = useState('');
  // Write-only secret inputs — empty means "keep the stored value".
  const [anthropicKey, setAnthropicKey] = useState('');
  const [tmdbKey, setTmdbKey] = useState('');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProbeStatus> | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Hydrate the non-secret fields from the server view on initial load and after each save
  // (React's "adjust state during render" pattern — keyed on updatedAt so user keystrokes, which
  // don't change the server view, are never clobbered). Typed secret inputs are never touched.
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const viewKey = `${config.updatedAt ?? 'none'}`;
  if (viewKey !== hydratedKey) {
    setHydratedKey(viewKey);
    setEnabled(config.enabled);
    setProvider(config.provider);
    setOllamaBaseUrl(config.ollamaBaseUrl ?? '');
    setCostLimit(config.costLimitUsd != null ? String(config.costLimitUsd) : '');
  }

  const showEscalationNote = provider === 'ollama' && !config.hasAnthropicKey;

  const buildUpdate = (): AgentConfigUpdate => {
    const update: AgentConfigUpdate = { enabled, provider };
    if (provider === 'ollama') update.ollamaBaseUrl = ollamaBaseUrl.trim() || null;
    update.costLimitUsd = costLimit.trim() === '' ? null : Number(costLimit);
    if (anthropicKey.trim() !== '') update.anthropicKey = anthropicKey.trim();
    if (tmdbKey.trim() !== '') update.tmdbKey = tmdbKey.trim();
    return update;
  };

  async function handleSave() {
    setErrors({});
    setBanner(null);
    setTestResults(null);

    // Validate the optional cost limit locally before saving. Number('abc') is NaN, which
    // JSON.stringify serializes to null — so without this guard a malformed entry would
    // silently wipe the saved limit to "use default" with no field error (review M1).
    const trimmedCost = costLimit.trim();
    if (trimmedCost !== '') {
      const n = Number(trimmedCost);
      if (!Number.isFinite(n) || n <= 0) {
        setErrors({ costLimitUsd: 'Must be a positive number (or leave blank to use the default)' });
        return;
      }
    }

    setSaving(true);
    try {
      const outcome = await save(buildUpdate());
      if (outcome.ok) {
        setAnthropicKey('');
        setTmdbKey('');
        setBanner({ tone: 'success', text: 'Assistant settings saved.' });
      } else {
        const fieldErrors: FieldErrors = {};
        for (const e of outcome.errors) fieldErrors[e.field] = e.reason;
        setErrors(fieldErrors);
        setBanner({ tone: 'error', text: saveErrorMessage(outcome) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setBanner(null);
    setTestResults(null);
    setTesting(true);
    try {
      const outcome = await test();
      if (outcome.ok) setTestResults(outcome.results);
      else setBanner({ tone: 'error', text: outcome.message });
    } finally {
      setTesting(false);
    }
  }

  const credentialChips = useMemo(
    () =>
      PROVIDERS.map((p) => (
        <Chip
          key={p.value}
          type="choice"
          selectedScheme="primary"
          selected={provider === p.value}
          label={p.label}
          onPress={() => setProvider(p.value)}
          testID={`assistant-config-provider-${p.value}`}
          accessibilityLabel={p.label}
        />
      )),
    [provider],
  );

  if (loading) {
    return (
      <View style={styles.container} testID="assistant-config">
        <Text style={styles.heading}>Movie Assistant</Text>
        <Text style={styles.helper} testID="assistant-config-loading">
          Loading…
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="assistant-config">
      <Text style={styles.heading}>Movie Assistant</Text>
      <Text style={styles.helper}>
        The assistant is off until you enable it and supply your own credentials. Nothing is shared.
      </Text>

      {banner && (
        <Banner tone={banner.tone} marginTop={12} marginBottom={4} testID="assistant-config-banner">
          {banner.text}
        </Banner>
      )}

      {/* Enable */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Enable the assistant</Text>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          testID="assistant-config-enabled-toggle"
          accessibilityLabel="Enable the assistant"
        />
      </View>

      {/* Provider */}
      <Text style={styles.label}>Model provider</Text>
      <View style={styles.chipRow}>{credentialChips}</View>
      {!!errors.provider && (
        <Text style={styles.errorText} testID="assistant-config-provider-error">
          {errors.provider}
        </Text>
      )}

      {/* Provider credentials */}
      {provider === 'ollama' ? (
        <>
          <Text style={styles.label}>Ollama base URL</Text>
          <NoAutoFillInput
            style={[styles.input, errors.ollamaBaseUrl ? styles.inputError : null]}
            value={ollamaBaseUrl}
            onChangeText={setOllamaBaseUrl}
            placeholder="http://localhost:11434"
            autoCapitalize="none"
            testID="assistant-config-ollama-url-input"
            accessibilityLabel="Ollama base URL"
          />
          {!!errors.ollamaBaseUrl && (
            <Text style={styles.errorText} testID="assistant-config-ollama-url-error">
              {errors.ollamaBaseUrl}
            </Text>
          )}
        </>
      ) : (
        <>
          <Text style={styles.label}>
            Anthropic API key{config.hasAnthropicKey ? ' (configured)' : ''}
          </Text>
          <NoAutoFillInput
            style={[styles.input, errors.anthropicKey ? styles.inputError : null]}
            value={anthropicKey}
            onChangeText={setAnthropicKey}
            placeholder={config.hasAnthropicKey ? 'Leave blank to keep the saved key' : 'sk-ant-…'}
            secureTextEntry
            autoCapitalize="none"
            testID="assistant-config-anthropic-key-input"
            accessibilityLabel="Anthropic API key"
          />
          {!!errors.anthropicKey && (
            <Text style={styles.errorText} testID="assistant-config-anthropic-key-error">
              {errors.anthropicKey}
            </Text>
          )}
        </>
      )}

      {/* TMDB key (always required) */}
      <Text style={styles.label}>TMDB API key{config.hasTmdbKey ? ' (configured)' : ''}</Text>
      <NoAutoFillInput
        style={[styles.input, errors.tmdbKey ? styles.inputError : null]}
        value={tmdbKey}
        onChangeText={setTmdbKey}
        placeholder={config.hasTmdbKey ? 'Leave blank to keep the saved key' : 'Your TMDB v3 API key'}
        secureTextEntry
        autoCapitalize="none"
        testID="assistant-config-tmdb-key-input"
        accessibilityLabel="TMDB API key"
      />
      {!!errors.tmdbKey && (
        <Text style={styles.errorText} testID="assistant-config-tmdb-key-error">
          {errors.tmdbKey}
        </Text>
      )}

      {/* Optional personal cost limit */}
      <Text style={styles.label}>Personal cost limit (USD, optional)</Text>
      <NoAutoFillInput
        style={[styles.input, errors.costLimitUsd ? styles.inputError : null]}
        value={costLimit}
        onChangeText={setCostLimit}
        placeholder="Leave blank to use the default"
        keyboardType="decimal-pad"
        testID="assistant-config-cost-limit-input"
        accessibilityLabel="Personal cost limit in US dollars"
      />
      {!!errors.costLimitUsd && (
        <Text style={styles.errorText} testID="assistant-config-cost-limit-error">
          {errors.costLimitUsd}
        </Text>
      )}

      {showEscalationNote && (
        <Text style={styles.note} testID="assistant-config-escalation-note">
          Escalation to the most capable model needs an Anthropic key — add one to enable it.
        </Text>
      )}

      {/* Per-credential test results (US3) */}
      {testResults && (
        <View style={styles.results} testID="assistant-config-test-results">
          {Object.entries(testResults).map(([field, status]) => (
            <View key={field} style={styles.resultRow} testID={`assistant-config-test-${field}`}>
              <Text style={styles.resultLabel}>{field}</Text>
              <Text style={status === 'ok' ? styles.resultOk : styles.resultBad}>
                {status === 'ok' ? 'OK' : status.reason}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <Button
          variant="filled"
          label="Save"
          onPress={handleSave}
          loading={saving}
          disabled={saving || testing}
          testID="assistant-config-save"
          accessibilityLabel="Save assistant settings"
        />
        <Button
          variant="outlined"
          label="Test connection"
          onPress={handleTest}
          loading={testing}
          disabled={saving || testing}
          testID="assistant-test-connection"
          accessibilityLabel="Test the saved credentials"
          marginLeft={12}
        />
      </View>
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      padding: 24,
      borderTopWidth: 1,
      borderTopColor: theme.outlineVariant?.val,
    },
    heading: {
      fontFamily: 'Outfit-Bold',
      fontSize: 18,
      fontWeight: '700',
      color: theme.onSurface?.val,
      marginBottom: 4,
    },
    helper: {
      fontFamily: 'Inter',
      fontSize: 12,
      color: theme.onSurfaceVariant?.val,
      marginBottom: 8,
    },
    label: {
      fontFamily: 'Inter',
      fontSize: 14,
      fontWeight: '600',
      color: theme.onSurfaceVariant?.val,
      marginTop: 16,
      marginBottom: 6,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.outline?.val,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontFamily: 'Inter',
      fontSize: 14,
      color: theme.onSurface?.val,
      backgroundColor: theme.surface1?.val,
    },
    inputError: {
      borderColor: theme.error?.val,
    },
    errorText: {
      fontFamily: 'Inter',
      fontSize: 12,
      color: theme.error?.val,
      marginTop: 4,
    },
    note: {
      fontFamily: 'Inter',
      fontSize: 12,
      color: theme.onSurfaceVariant?.val,
      marginTop: 12,
    },
    toggleRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 16,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    results: {
      marginTop: 16,
    },
    resultRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 6,
    },
    resultLabel: {
      fontFamily: 'Inter',
      fontSize: 12,
      color: theme.onSurfaceVariant?.val,
    },
    resultOk: {
      fontFamily: 'Inter',
      fontSize: 12,
      fontWeight: '600',
      color: theme.success?.val,
    },
    resultBad: {
      fontFamily: 'Inter',
      fontSize: 12,
      color: theme.error?.val,
    },
    actions: {
      flexDirection: 'row',
      // Right-aligned so the bottom-LEFT floating assistant dock never intercepts the Save/Test
      // clicks when a configured user (dock present) edits their config (design-system convention,
      // feature 015): action buttons live bottom-right, the dock stays bottom-left.
      justifyContent: 'flex-end',
      marginTop: 28,
    },
  });
