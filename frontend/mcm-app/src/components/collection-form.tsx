/**
 * CollectionForm component (T058)
 *
 * Shared form for creating and editing a collection.
 * In "create" mode: renders blank inputs.
 * In "edit" mode: pre-fills inputs from initialValues.
 *
 * Validation:
 *   - name required (non-empty after trim)
 *   - name max 50 characters
 * Description is optional; empty string is sent as null.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
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

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Collection Name *</Text>
      <TextInput
        style={[styles.input, nameError ? styles.inputError : null]}
        value={name}
        onChangeText={text => {
          setName(text);
          if (nameError) setNameError(null);
        }}
        placeholder="Enter collection name"
        maxLength={60}
        returnKeyType="done"
        testID="collection-form-name-input"
        accessibilityLabel="Collection name"
      />
      {nameError && (
        <Text style={styles.errorText} testID="collection-form-name-error">
          {nameError}
        </Text>
      )}

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        value={description}
        onChangeText={setDescription}
        placeholder="Enter description"
        multiline
        numberOfLines={3}
        testID="collection-form-description-input"
        accessibilityLabel="Collection description"
      />

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={onCancel}
          testID="collection-form-cancel-button"
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          disabled={isLoading}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.submitButton, isLoading ? styles.submitDisabled : null]}
          onPress={handleSubmit}
          testID="collection-form-submit-button"
          accessibilityRole="button"
          accessibilityLabel={mode === 'create' ? 'Create collection' : 'Save changes'}
          accessibilityState={{ disabled: isLoading }}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.submitText}>
              {mode === 'create' ? 'Create' : 'Save'}
            </Text>
          )}
        </TouchableOpacity>
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
    color: '#2d3748',
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1a202c',
    backgroundColor: '#f7fafc',
  },
  inputError: {
    borderColor: '#fc8181',
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  errorText: {
    color: '#c53030',
    fontSize: 13,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 24,
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e0',
  },
  cancelText: {
    color: '#2d3748',
    fontSize: 15,
    fontWeight: '600',
  },
  submitButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#3182ce',
    minWidth: 80,
    alignItems: 'center',
  },
  submitDisabled: {
    backgroundColor: '#90cdf4',
  },
  submitText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
