/**
 * MovieCountLine (013 US2)
 *
 * Shows the collection's movie count beneath the list controls (FR-008/FR-009):
 *   - unfiltered → "<total> movies"
 *   - filtered   → "<filtered> of <total> movies"
 * The total/filtered/isFiltered view-model is computed by the count hook (use-movies).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import type { MovieCountLine as MovieCountLineModel } from '@/types/collection';

interface MovieCountLineProps {
  count: MovieCountLineModel;
}

function plural(n: number): string {
  return n === 1 ? 'movie' : 'movies';
}

export function MovieCountLine({ count }: MovieCountLineProps) {
  const theme = useTheme();
  const { filtered, total, isFiltered } = count;
  const text = isFiltered
    ? `${filtered} of ${total} ${plural(total)}`
    : `${total} ${plural(total)}`;

  return (
    <View style={[styles.container, { backgroundColor: theme.background?.val }]}>
      {/* Orange accent + slightly larger so the count stands out above the grid. */}
      <Text testID="movie-count-line" style={[styles.text, { color: theme.tertiary?.val }]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  text: {
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: '600',
  },
});
