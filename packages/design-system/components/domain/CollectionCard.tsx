/**
 * MCM Design System — Collection Card
 *
 * Displays a movie collection on the home / collections list screen.
 *
 * Visual treatment:
 *   - Shows up to 3 poster thumbnails in a film-strip mosaic
 *   - Collection name, movie count, owner badge (if shared)
 *   - Permission role indicator (owner / contributor / viewer)
 *
 * Variants:
 *   grid  — square/wide card for grid layout
 *   row   — horizontal row for list layout
 */

import React from 'react'
import { Image } from 'react-native'
import { Stack, Text, useTheme } from '@tamagui/core'
import { XStack, YStack } from '@tamagui/stacks'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CollectionRole    = 'owner' | 'contributor' | 'viewer'
export type CollectionVariant = 'grid' | 'row'

export interface Collection {
  id:            string
  name:          string
  description?:  string
  movieCount:    number
  posterUrls?:   string[]   // first 3 shown in mosaic
  isDefault?:    boolean
  role?:         CollectionRole
  ownerName?:    string     // shown for shared collections
  updatedAt?:    Date
}

export interface CollectionCardProps {
  collection:  Collection
  variant?:    CollectionVariant
  onPress?:    () => void
  onManage?:   () => void
  /** Forwarded to the pressable root (FR-018 stable selectors). */
  testID?:             string
  accessibilityLabel?: string
}

// ─── Poster Mosaic (3-up film strip) ─────────────────────────────────────────

function PosterMosaic({ urls, size }: { urls: string[]; size: number }) {
  const theme     = useTheme()
  const slotW     = Math.floor(size / 3)
  const slotH     = size

  return (
    <XStack width={size} height={slotH} overflow="hidden" borderRadius={8}>
      {[0, 1, 2].map(i => (
        <Stack
          key={i}
          width={slotW}
          height={slotH}
          backgroundColor={i % 2 === 0 ? theme.surfaceVariant?.val : theme.surface2?.val}
          borderRightWidth={i < 2 ? 1 : 0}
          borderRightColor={theme.background?.val}
          alignItems="center"
          justifyContent="center"
          overflow="hidden"
        >
          {urls[i] ? (
            <Image
              source={{ uri: urls[i] }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          ) : (
            <Text fontSize={slotW * 0.4} lineHeight={slotW * 0.4}>🎬</Text>
          )}
        </Stack>
      ))}
    </XStack>
  )
}

// ─── Role chip ────────────────────────────────────────────────────────────────

function RoleChip({ role }: { role: CollectionRole }) {
  const theme = useTheme()

  const config = {
    owner:       { label: 'Owner',       bg: theme.primaryContainer?.val,   fg: theme.onPrimaryContainer?.val },
    contributor: { label: 'Contributor', bg: theme.secondaryContainer?.val, fg: theme.onSecondaryContainer?.val },
    viewer:      { label: 'Viewer',      bg: theme.surfaceVariant?.val,     fg: theme.onSurfaceVariant?.val },
  }

  const c = config[role]

  return (
    <Stack
      backgroundColor={c.bg}
      borderRadius={4}
      paddingHorizontal={8}
      paddingVertical={2}
    >
      <Text
        fontFamily="$body"
        fontSize={11}
        fontWeight="500"
        letterSpacing={0.5}
        color={c.fg}
      >
        {c.label}
      </Text>
    </Stack>
  )
}

// ─── Grid Card ────────────────────────────────────────────────────────────────

function GridCard({ collection, onPress, onManage, testID, accessibilityLabel }: CollectionCardProps) {
  const theme = useTheme()

  return (
    <YStack
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      width="100%"
      backgroundColor={theme.surface1?.val}
      borderRadius={16}
      overflow="hidden"
      cursor="pointer"
      animation="quick"
      onPress={onPress}
      pressStyle={{ opacity: 0.9, scale: 0.98 }}
      hoverStyle={{ opacity: 0.95 }}
      shadowColor={theme.shadow?.val}
      shadowOffset={{ width: 0, height: 1 }}
      shadowOpacity={0.12}
      shadowRadius={2}
      elevation={1}
    >
      {/* Mosaic */}
      <PosterMosaic urls={collection.posterUrls ?? []} size={300} />

      {/* Info */}
      <YStack padding={16} gap={8}>
        <XStack alignItems="center" justifyContent="space-between">
          <Text
            fontFamily="$heading"
            fontSize={18}
            fontWeight="500"
            color={theme.onSurface?.val}
            numberOfLines={1}
            flex={1}
          >
            {collection.name}
            {collection.isDefault && (
              <Text
                fontFamily="$body"
                fontSize={12}
                color={theme.primary?.val}
              > ★ Default</Text>
            )}
          </Text>

          {collection.role && <RoleChip role={collection.role} />}
        </XStack>

        <XStack alignItems="center" gap={8}>
          <Text
            fontFamily="$body"
            fontSize={14}
            letterSpacing={0.25}
            color={theme.onSurfaceVariant?.val}
          >
            {collection.movieCount} {collection.movieCount === 1 ? 'movie' : 'movies'}
          </Text>

          {collection.ownerName && collection.role !== 'owner' && (
            <>
              <Text color={theme.outlineVariant?.val} fontSize={14}>·</Text>
              <Text
                fontFamily="$body"
                fontSize={14}
                color={theme.onSurfaceVariant?.val}
              >
                by {collection.ownerName}
              </Text>
            </>
          )}
        </XStack>

        {collection.description && (
          <Text
            fontFamily="$body"
            fontSize={13}
            letterSpacing={0.4}
            color={theme.onSurfaceVariant?.val}
            numberOfLines={2}
          >
            {collection.description}
          </Text>
        )}
      </YStack>
    </YStack>
  )
}

// ─── Row Card ─────────────────────────────────────────────────────────────────

function RowCard({ collection, onPress, onManage, testID, accessibilityLabel }: CollectionCardProps) {
  const theme = useTheme()

  return (
    <XStack
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      backgroundColor="transparent"
      borderRadius={8}
      overflow="hidden"
      cursor="pointer"
      animation="quick"
      onPress={onPress}
      pressStyle={{ backgroundColor: theme.surfaceVariant?.val }}
      hoverStyle={{ backgroundColor: theme.surface1?.val }}
      paddingVertical={12}
      paddingHorizontal={16}
      alignItems="center"
      gap={16}
      minHeight={80}
    >
      {/* Mini mosaic */}
      <PosterMosaic urls={collection.posterUrls ?? []} size={72} />

      {/* Info */}
      <YStack flex={1} gap={2}>
        <Text
          fontFamily="$heading"
          fontSize={16}
          fontWeight="500"
          color={theme.onSurface?.val}
          numberOfLines={1}
        >
          {collection.name}
        </Text>
        <Text
          fontFamily="$body"
          fontSize={13}
          color={theme.onSurfaceVariant?.val}
        >
          {collection.movieCount} movies
          {collection.ownerName && collection.role !== 'owner'
            ? ` · ${collection.ownerName}`
            : ''}
        </Text>
        {collection.role && <RoleChip role={collection.role} />}
      </YStack>

      {/* Arrow */}
      <Text fontSize={20} color={theme.onSurfaceVariant?.val} lineHeight={20}>›</Text>
    </XStack>
  )
}

// ─── Main CollectionCard ──────────────────────────────────────────────────────

export const CollectionCard = React.memo<CollectionCardProps>(function CollectionCard({
  variant = 'grid',
  ...props
}) {
  return variant === 'row' ? <RowCard {...props} /> : <GridCard {...props} />
})

CollectionCard.displayName = 'MCM.CollectionCard'
