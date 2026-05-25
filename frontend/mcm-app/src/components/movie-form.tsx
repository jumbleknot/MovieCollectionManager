/**
 * MovieForm component (T100)
 *
 * Shared form for adding and editing a movie.
 * In "create" mode: renders blank inputs with defaults.
 * In "edit" mode: pre-fills all inputs from initialValues (Movie).
 *
 * Required fields: title, year, contentType, language, owned, ripped, childrens
 * Conditional fields:
 *   - ownedMedia: shown only when owned=true
 *   - ripQuality: shown only when ripped=true
 *
 * Validation:
 *   - title required
 *   - year required (numeric, 4-digit reasonable)
 *   - language required
 *   - contentType must be 'Movie' | 'Series' | 'Concert'
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Switch,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import type { Movie, CreateMovieRequest, ContentType, MediaFormat, RipQuality } from '@/types/collection';

type MovieFormMode = 'create' | 'edit';

interface MovieFormProps {
  mode: MovieFormMode;
  initialValues?: Movie;
  onSubmit: (values: CreateMovieRequest) => Promise<void>;
  onCancel: () => void;
  isLoading?: boolean;
}

const CONTENT_TYPES: ContentType[] = ['Movie', 'Series', 'Concert'];
const MEDIA_FORMATS: MediaFormat[] = ['Blu-Ray', '4K-UHD', 'DVD', 'VHS', 'Digital', 'Laserdisc'];
const RIP_QUALITIES: RipQuality[] = ['4K', '1080p', '720p', '480p', 'SD'];

export function MovieForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isLoading = false,
}: MovieFormProps): React.JSX.Element {
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [year, setYear] = useState(initialValues?.year?.toString() ?? '');
  const [contentType, setContentType] = useState<ContentType>(
    initialValues?.contentType ?? 'Movie',
  );
  const [language, setLanguage] = useState(initialValues?.language ?? '');
  const [owned, setOwned] = useState(initialValues?.owned ?? false);
  const [ripped, setRipped] = useState(initialValues?.ripped ?? false);
  const [childrens, setChildrens] = useState(initialValues?.childrens ?? false);
  const [ownedMedia, setOwnedMedia] = useState<MediaFormat[]>(
    initialValues?.ownedMedia ?? [],
  );
  const [ripQuality, setRipQuality] = useState<RipQuality[]>(
    initialValues?.ripQuality ?? [],
  );

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!title.trim()) {
      newErrors.title = 'Title is required.';
    }
    if (!year.trim()) {
      newErrors.year = 'Year is required.';
    } else if (!/^\d{4}$/.test(year.trim())) {
      newErrors.year = 'Year must be a 4-digit number.';
    }
    if (!language.trim()) {
      newErrors.language = 'Language is required.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    const payload: CreateMovieRequest = {
      title: title.trim(),
      year: parseInt(year.trim(), 10),
      contentType,
      language: language.trim(),
      owned,
      ripped,
      childrens,
      ownedMedia: owned ? ownedMedia : [],
      ripQuality: ripped ? ripQuality : [],
      genres: [],
      directors: [],
      actors: [],
      tags: [],
      externalIds: [],
    };

    await onSubmit(payload);
  };

  const handleOwnedChange = (value: boolean) => {
    setOwned(value);
    if (!value) setOwnedMedia([]);
  };

  const handleRippedChange = (value: boolean) => {
    setRipped(value);
    if (!value) setRipQuality([]);
  };

  const toggleMediaFormat = (fmt: MediaFormat) => {
    setOwnedMedia(prev =>
      prev.includes(fmt) ? prev.filter(f => f !== fmt) : [...prev, fmt],
    );
  };

  const toggleRipQuality = (q: RipQuality) => {
    setRipQuality(prev =>
      prev.includes(q) ? prev.filter(r => r !== q) : [...prev, q],
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Title */}
      <Text style={styles.label}>Title *</Text>
      <TextInput
        style={[styles.input, errors.title ? styles.inputError : null]}
        value={title}
        onChangeText={text => { setTitle(text); setErrors(e => ({ ...e, title: '' })); }}
        placeholder="Movie title"
        testID="movie-form-title-input"
        accessibilityLabel="Movie title"
      />
      {!!errors.title && (
        <Text style={styles.errorText} testID="movie-form-title-error">
          {errors.title}
        </Text>
      )}

      {/* Year */}
      <Text style={styles.label}>Year *</Text>
      <TextInput
        style={[styles.input, errors.year ? styles.inputError : null]}
        value={year}
        onChangeText={text => { setYear(text); setErrors(e => ({ ...e, year: '' })); }}
        placeholder="e.g. 1999"
        keyboardType="numeric"
        maxLength={4}
        testID="movie-form-year-input"
        accessibilityLabel="Release year"
      />
      {!!errors.year && (
        <Text style={styles.errorText} testID="movie-form-year-error">
          {errors.year}
        </Text>
      )}

      {/* Content Type — radio-style buttons avoid @react-native-picker/picker native module issues on Android */}
      <Text style={styles.label}>Content Type *</Text>
      <View style={styles.radioGroup} testID="movie-form-content-type-picker">
        {CONTENT_TYPES.map(ct => (
          <TouchableOpacity
            key={ct}
            style={[styles.radioButton, contentType === ct && styles.radioButtonSelected]}
            onPress={() => setContentType(ct)}
            testID={`movie-form-content-type-${ct.toLowerCase()}`}
            accessibilityRole="radio"
            accessibilityLabel={ct}
            accessibilityState={{ selected: contentType === ct }}
          >
            <Text style={[styles.radioText, contentType === ct && styles.radioTextSelected]}>
              {ct}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Language */}
      <Text style={styles.label}>Language *</Text>
      <TextInput
        style={[styles.input, errors.language ? styles.inputError : null]}
        value={language}
        onChangeText={text => { setLanguage(text); setErrors(e => ({ ...e, language: '' })); }}
        placeholder="e.g. English"
        testID="movie-form-language-input"
        accessibilityLabel="Language"
      />
      {!!errors.language && (
        <Text style={styles.errorText} testID="movie-form-language-error">
          {errors.language}
        </Text>
      )}

      {/* Owned */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Owned</Text>
        <Switch
          value={owned}
          onValueChange={handleOwnedChange}
          testID="movie-form-owned-toggle"
          accessibilityLabel="Owned"
        />
      </View>

      {/* Owned Media (conditional) */}
      {owned && (
        <View testID="movie-form-owned-media-picker">
          <Text style={styles.label}>Owned Media</Text>
          {MEDIA_FORMATS.map(fmt => (
            <TouchableOpacity
              key={fmt}
              style={[styles.chip, ownedMedia.includes(fmt) ? styles.chipSelected : null]}
              onPress={() => toggleMediaFormat(fmt)}
              testID={`movie-form-owned-media-${fmt.toLowerCase().replace(/ /g, '-')}`}
              accessibilityRole="checkbox"
              accessibilityLabel={fmt}
            >
              <Text style={ownedMedia.includes(fmt) ? styles.chipTextSelected : styles.chipText}>
                {fmt}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Ripped */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Ripped</Text>
        <Switch
          value={ripped}
          onValueChange={handleRippedChange}
          testID="movie-form-ripped-toggle"
          accessibilityLabel="Ripped"
        />
      </View>

      {/* Rip Quality (conditional) */}
      {ripped && (
        <View testID="movie-form-rip-quality-picker">
          <Text style={styles.label}>Rip Quality</Text>
          {RIP_QUALITIES.map(q => (
            <TouchableOpacity
              key={q}
              style={[styles.chip, ripQuality.includes(q) ? styles.chipSelected : null]}
              onPress={() => toggleRipQuality(q)}
              testID={`movie-form-rip-quality-${q.toLowerCase()}`}
              accessibilityRole="checkbox"
              accessibilityLabel={q}
            >
              <Text style={ripQuality.includes(q) ? styles.chipTextSelected : styles.chipText}>
                {q}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Children's Content */}
      <View style={styles.toggleRow}>
        <Text style={styles.label}>Children's</Text>
        <Switch
          value={childrens}
          onValueChange={setChildrens}
          testID="movie-form-childrens-toggle"
          accessibilityLabel="Children's content"
        />
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={onCancel}
          testID="movie-form-cancel-button"
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          disabled={isLoading}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.submitButton, isLoading ? styles.submitDisabled : null]}
          onPress={handleSubmit}
          testID="movie-form-submit-button"
          accessibilityRole="button"
          accessibilityLabel={mode === 'create' ? 'Add movie' : 'Save changes'}
          accessibilityState={{ disabled: isLoading }}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.submitText}>{mode === 'create' ? 'Add Movie' : 'Save'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
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
  inputError: { borderColor: '#fc8181' },
  pickerWrapper: {
    borderWidth: 1,
    borderColor: '#cbd5e0',
    borderRadius: 8,
    backgroundColor: '#f7fafc',
    overflow: 'hidden',
  },
  radioGroup: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 4,
  },
  radioButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e0',
    backgroundColor: '#f7fafc',
  },
  radioButtonSelected: {
    borderColor: '#3182ce',
    backgroundColor: '#ebf8ff',
  },
  radioText: { color: '#2d3748', fontSize: 14, fontWeight: '500' },
  radioTextSelected: { color: '#3182ce', fontWeight: '700' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#cbd5e0',
    marginVertical: 4,
    alignSelf: 'flex-start',
  },
  chipSelected: {
    backgroundColor: '#3182ce',
    borderColor: '#3182ce',
  },
  chipText: { color: '#2d3748', fontSize: 14 },
  chipTextSelected: { color: '#fff', fontSize: 14 },
  errorText: { color: '#c53030', fontSize: 13, marginTop: 4 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 24,
    marginBottom: 16,
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e0',
  },
  cancelText: { color: '#2d3748', fontSize: 15, fontWeight: '600' },
  submitButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#3182ce',
    minWidth: 80,
    alignItems: 'center',
  },
  submitDisabled: { backgroundColor: '#90cdf4' },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
