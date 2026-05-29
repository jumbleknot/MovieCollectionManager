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
import { NoAutoFillInput } from '@/components/no-autofill-input';

interface MovieSearchBarProps {
  value: string;
  onSearch: (term: string) => void;
  placeholder?: string;
}

export function MovieSearchBar({ value, onSearch, placeholder = 'Search movies…' }: MovieSearchBarProps) {
  return (
    <View style={styles.container}>
      <NoAutoFillInput
        testID="movie-search-input"
        style={styles.input}
        value={value}
        onChangeText={onSearch}
        placeholder={placeholder}
        placeholderTextColor="#aaa"
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
          <Text style={styles.clearIcon}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    margin: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: '#111',
    padding: 0, // remove default Android padding
  },
  clearButton: {
    marginLeft: 8,
    padding: 4,
  },
  clearIcon: {
    fontSize: 18,
    color: '#888',
    lineHeight: 20,
  },
});
