/**
 * CollectionForm component (T058; feature 015 re-skin)
 *
 * Shared form for creating and editing a collection.
 * In "create" mode: renders blank inputs.
 * In "edit" mode: pre-fills inputs from initialValues.
 *
 * Validation:
 *   - name required (non-empty after trim)
 *   - name max 50 characters
 * Description is optional; empty string is sent as null.
 *
 * Re-skinned onto the MCM Cinema design system: theme-token inputs + labels and
 * DS `Button` actions. NoAutoFillInput is kept (password-manager suppression is a
 * project-wide design decision for all non-register fields) and restyled in
 * place. Structure, props, behaviour, and every testID are unchanged
 * (FR-002 / FR-018).
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';
import { NoAutoFillInput } from '@/components/no-autofill-input';
import type { CreateCollectionRequest } from '@/types/collection';

type CollectionFormMode = 'create' | 'edit';

interface CollectionFormProps {
  mode: CollectionFormMode;
  initialValues?: {
    name: string;
    description?: string | null;
  };
  onSubmit: (values: CreateCollectionRequest) => Promise<void>;
  onCancel: () => void;
  isLoading?: boolean;
}

export function CollectionForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isLoading = false,
}: CollectionFormProps): React.JSX.Element {
  const theme = useTheme();
  const [name, setName] = useState(initialValues?.name ?? '');
  const [description, setDescription] = useState(
    initialValues?.description ?? ''
  );
  const [nameError, setNameError] = useState<string | null>(null);

  const validate = (): boolean => {
    if (!name.trim()) {
      setNameError('Name is required.');
      return false;
    }
    if (name.trim().length > 50) {
      setNameError('Name must be 50 characters or fewer.');
      return false;
    }
    setNameError(null);
    return true;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    await onSubmit({
      name: name.trim(),
      description: description.trim() || null,
    });
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: theme.outline?.val,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: 'Inter',
    color: theme.onSurface?.val,
    backgroundColor: theme.surfaceVariant?.val,
  } as const;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.onSurfaceVariant?.val }]}>Collection Name *</Text>
      <NoAutoFillInput
        style={[inputStyle, nameError ? { borderColor: theme.error?.val } : null]}
        value={name}
        onChangeText={text => {
          setName(text);
          if (nameError) setNameError(null);
        }}
        placeholder="Enter collection title"
        placeholderTextColor={theme.onSurfaceVariant?.val}
        maxLength={60}
        returnKeyType="done"
        testID="collection-form-name-input"
        accessibilityLabel="Collection title"
        webName="collection-name-entry"
      />
      {nameError && (
        <Text style={[styles.errorText, { color: theme.error?.val }]} testID="collection-form-name-error">
          {nameError}
        </Text>
      )}

      <Text style={[styles.label, { color: theme.onSurfaceVariant?.val }]}>Description (optional)</Text>
      <NoAutoFillInput
        style={[inputStyle, styles.textArea]}
        value={description}
        onChangeText={setDescription}
        placeholder="Enter description"
        placeholderTextColor={theme.onSurfaceVariant?.val}
        multiline
        numberOfLines={3}
        testID="collection-form-description-input"
        accessibilityLabel="Collection description"
      />

      <View style={styles.actions}>
        <Button
          variant="outlined"
          label="Cancel"
          onPress={onCancel}
          testID="collection-form-cancel-button"
          accessibilityLabel="Cancel"
          disabled={isLoading}
        />
        <Button
          variant="filled"
          label={mode === 'create' ? 'Create' : 'Save'}
          onPress={handleSubmit}
          loading={isLoading}
          disabled={isLoading}
          testID="collection-form-submit-button"
          accessibilityLabel={mode === 'create' ? 'Create collection' : 'Save changes'}
          accessibilityState={{ disabled: isLoading }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 12,
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  errorText: {
    fontSize: 14,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 24,
  },
});
