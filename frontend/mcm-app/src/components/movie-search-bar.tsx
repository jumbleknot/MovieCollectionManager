/**
 * MovieSearchBar component (T131)
 *
 * Controlled text input for movie search. Debouncing is handled in
 * the parent hook (use-movies); this component is purely presentational.
 *
 * Props:
 *   value    — current search term (controlled)
 *   onSearch — called immediately on every change (debounce lives in use-movies)
 *
 * testIDs:
 *   movie-search-input — the TextInput
 *   movie-search-clear — the clear button (only shown when value is non-empty)
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { NoAutoFillInput } from '@/components/no-autofill-input';

interface MovieSearchBarProps {
  value: string;
  onSearch: (term: string) => void;
  placeholder?: string;
}

// Re-skinned (feature 015): MD3 docked search-bar look — a surfaceVariant pill with a
// leading magnifier. NoAutoFillInput + both testIDs (movie-search-input/-clear) preserved.
export function MovieSearchBar({ value, onSearch, placeholder = 'Search movies…' }: MovieSearchBarProps) {
  const theme = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.surfaceVariant?.val }]}>
      <Text style={styles.searchIcon}>🔍</Text>
      <NoAutoFillInput
        testID="movie-search-input"
        style={[styles.input, { color: theme.onSurface?.val }]}
        value={value}
        onChangeText={onSearch}
        placeholder={placeholder}
        placeholderTextColor={theme.onSurfaceVariant?.val}
        clearButtonMode="never" // handled manually via clear button
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {value.length > 0 && (
        <Pressable
          testID="movie-search-clear"
          style={styles.clearButton}
          onPress={() => onSearch('')}
          accessibilityLabel="Clear search"
          accessibilityRole="button"
        >
          <Text style={[styles.clearIcon, { color: theme.onSurfaceVariant?.val }]}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 10,
    margin: 8,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter',
    padding: 0, // remove default Android padding
  },
  clearButton: {
    marginLeft: 8,
    padding: 4,
  },
  clearIcon: {
    fontSize: 18,
    lineHeight: 20,
  },
});
