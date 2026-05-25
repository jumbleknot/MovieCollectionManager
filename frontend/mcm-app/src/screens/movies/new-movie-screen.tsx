/**
 * NewMovieScreen (T107 support)
 *
 * Renders a form for creating a new movie within a collection.
 * On successful creation, navigates to the movie detail screen.
 * On cancel, navigates back to the collection screen.
 *
 * Note: Uses inline form instead of MovieForm to avoid @react-native-picker/picker
 * rendering issues on Android in development mode. The Picker component can cause
 * navigation delays when the module is lazily loaded.
 *
 * Route params: collectionId (from useLocalSearchParams)
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMovies } from '@/hooks/use-movies';
import type { CreateMovieRequest } from '@/types/collection';

export function NewMovieScreen(): React.JSX.Element {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();
  const router = useRouter();
  const { createMovie, movie, error } = useMovies(collectionId);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [language, setLanguage] = useState('');
  const [titleError, setTitleError] = useState('');
  const [yearError, setYearError] = useState('');
  const [languageError, setLanguageError] = useState('');

  const handleSubmit = async () => {
    let valid = true;
    if (!title.trim()) { setTitleError('Title is required.'); valid = false; } else { setTitleError(''); }
    if (!year.trim()) { setYearError('Year is required.'); valid = false; } else if (!/^\d{4}$/.test(year.trim())) { setYearError('Year must be 4 digits.'); valid = false; } else { setYearError(''); }
    if (!language.trim()) { setLanguageError('Language is required.'); valid = false; } else { setLanguageError(''); }
    if (!valid) return;

    setIsSubmitting(true);
    try {
      const payload: CreateMovieRequest = {
        title: title.trim(),
        year: parseInt(year.trim(), 10),
        contentType: 'Movie',
        language: language.trim(),
        owned: false,
        ripped: false,
        childrens: false,
        ownedMedia: [],
        ripQuality: [],
        genres: [],
        directors: [],
        actors: [],
        tags: [],
        externalIds: [],
      };
      await createMovie(payload);
    } finally {
      setIsSubmitting(false);
    }
  };

  // After creation, navigate to the movie detail route (same path pattern as
  // the working movie-browse navigation: /collections/:id/movies/:movieId).
  React.useEffect(() => {
    if (movie?.movieId) {
      router.replace(
        `/collections/${collectionId}/movies/${movie.movieId}` as Parameters<typeof router.replace>[0],
      );
    }
  }, [movie?.movieId, collectionId, router]);

  const handleCancel = () => {
    router.back();
  };

  return (
    <View style={styles.container} testID="new-movie-screen">
      {error ? (
        <Text style={styles.errorBanner} testID="new-movie-screen-error">{error}</Text>
      ) : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.label}>Title *</Text>
        <TextInput
          style={[styles.input, titleError ? styles.inputError : null]}
          value={title}
          onChangeText={setTitle}
          placeholder="Movie title"
          testID="movie-form-title-input"
          accessibilityLabel="Movie title"
        />
        {!!titleError && <Text style={styles.errorText} testID="movie-form-title-error">{titleError}</Text>}

        <Text style={styles.label}>Year *</Text>
        <TextInput
          style={[styles.input, yearError ? styles.inputError : null]}
          value={year}
          onChangeText={setYear}
          placeholder="e.g. 1999"
          keyboardType="numeric"
          maxLength={4}
          testID="movie-form-year-input"
          accessibilityLabel="Release year"
        />
        {!!yearError && <Text style={styles.errorText} testID="movie-form-year-error">{yearError}</Text>}

        <Text style={styles.label}>Language *</Text>
        <TextInput
          style={[styles.input, languageError ? styles.inputError : null]}
          value={language}
          onChangeText={setLanguage}
          placeholder="e.g. English"
          testID="movie-form-language-input"
          accessibilityLabel="Language"
        />
        {!!languageError && <Text style={styles.errorText} testID="movie-form-language-error">{languageError}</Text>}

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={handleCancel}
            testID="movie-form-cancel-button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.submitButton, isSubmitting ? styles.buttonDisabled : null]}
            onPress={() => { void handleSubmit(); }}
            disabled={isSubmitting}
            testID="movie-form-submit-button"
            accessibilityLabel="Save movie"
          >
            {isSubmitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText}>Save</Text>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  label: { fontSize: 14, fontWeight: '600', color: '#2d3748', marginBottom: 4, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    color: '#1a202c',
    backgroundColor: '#f7fafc',
  },
  inputError: { borderColor: '#c53030' },
  errorText: { color: '#c53030', fontSize: 12, marginTop: 2 },
  errorBanner: {
    backgroundColor: '#fff5f5',
    color: '#c53030',
    padding: 12,
    margin: 12,
    borderRadius: 8,
    fontSize: 14,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 32,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  submitButton: {
    backgroundColor: '#1a56db',
  },
  buttonDisabled: { opacity: 0.6 },
  cancelText: { color: '#2d3748', fontWeight: '600', fontSize: 15 },
  submitText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
