/**
 * MCM Design System — Movie Card
 *
 * The primary domain object card for displaying a movie in a collection.
 *
 * Layout variants:
 *   poster  — vertical poster card (default); shows poster image prominently
 *   compact — horizontal row; good for lists (search results, wishlists)
 *   detail  — full-width hero card (collection detail screen)
 *
 * Data:
 *   - Movie poster image (or placeholder)
 *   - Title, year, runtime
 *   - Media format badges (4K, Blu-ray, DVD, Digital, etc.)
 *   - Personal rating (0–10 stars displayed as 0–5)
 *   - "In collection" / "Wishlist" indicator
 *   - Quick-action: add to collection (FAB), wishlist toggle
 */

import React from 'react'
import { Image } from 'react-native'
import { Stack, XStack, YStack, Text, useTheme } from 'tamagui'
import { Chip } from '../primitives/Chip'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MediaFormat = '4K UHD' | 'Blu-ray' | 'DVD' | 'Digital' | 'VHS' | '4K Digital'
export type CardLayout  = 'poster' | 'compact' | 'detail'

export interface Movie {
  id:           string
  title:        string
  year?:        number
  posterUrl?:   string
  runtime?:     number           // minutes
  formats?:     MediaFormat[]
  rating?:      number           // 0–10
  inWishlist?:  boolean
  genres?:      string[]
  director?:    string
}

export interface MovieCardProps {
  movie:          Movie
  layout?:        CardLayout
  onPress?:       () => void
  onWishlistToggle?: () => void
  onAddToCollection?: () => void
  selected?:      boolean        // multi-select mode
  disabled?:      boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  // Convert 0–10 to 0–5 half-stars
  const stars = rating / 2
  const full  = Math.floor(stars)
  const half  = stars - full >= 0.5
  const empty = 5 - full - (half ? 1 : 0)

  const theme = useTheme()
  const color = theme.tertiary?.val  // orange accent for rating stars

  return (
    <XStack gap={1} alignItems="center">
      {Array(full).fill(0).map((_, i) => (
        <Text key={`f${i}`} fontSize={12} color={color}>★</Text>
      ))}
      {half && <Text fontSize={12} color={color}>⯨</Text>}
      {Array(empty).fill(0).map((_, i) => (
        <Text key={`e${i}`} fontSize={12} color={theme.outlineVariant?.val}>☆</Text>
      ))}
    </XStack>
  )
}

function FormatBadge({ format }: { format: MediaFormat }) {
  const theme = useTheme()

  // 4K formats get the tertiary accent colour
  const is4K    = format.startsWith('4K')
  const bg      = is4K ? theme.tertiaryContainer?.val : theme.secondaryContainer?.val
  const fg      = is4K ? theme.onTertiaryContainer?.val : theme.onSecondaryContainer?.val

  const shortLabel: Record<MediaFormat, string> = {
    '4K UHD':     '4K',
    'Blu-ray':    'BD',
    'DVD':        'DVD',
    'Digital':    'DIG',
    'VHS':        'VHS',
    '4K Digital': '4KD',
  }

  return (
    <Stack
      backgroundColor={bg}
      borderRadius={4}
      paddingHorizontal={5}
      paddingVertical={2}
    >
      <Text
        fontFamily="$body"
        fontSize={10}
        fontWeight="700"
        letterSpacing={0.5}
        color={fg}
      >
        {shortLabel[format]}
      </Text>
    </Stack>
  )
}

// ─── Poster Card (vertical) ───────────────────────────────────────────────────

function PosterCard({ movie, onPress, onWishlistToggle, selected }: MovieCardProps) {
  const theme = useTheme()

  return (
    <YStack
      width={160}
      backgroundColor={selected ? theme.secondaryContainer?.val : theme.surface1?.val}
      borderRadius={12}
      overflow="hidden"
      cursor="pointer"
      animation="quick"
      onPress={onPress}
      pressStyle={{ opacity: 0.9, scale: 0.98 }}
      hoverStyle={{ opacity: 0.95 }}
      borderWidth={selected ? 2 : 0}
      borderColor={selected ? theme.primary?.val : undefined}
      // MD3 elevation 1
      shadowColor={theme.shadow?.val}
      shadowOffset={{ width: 0, height: 1 }}
      shadowOpacity={0.12}
      shadowRadius={2}
      elevation={1}
    >
      {/* Poster image — 2:3 aspect ratio */}
      <Stack width={160} height={240} backgroundColor={theme.surfaceVariant?.val}>
        {movie.posterUrl ? (
          <Image
            source={{ uri: movie.posterUrl }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
            accessibilityLabel={`${movie.title} poster`}
          />
        ) : (
          // Placeholder
          <Stack flex={1} alignItems="center" justifyContent="center">
            <Text fontSize={48} lineHeight={48}>🎬</Text>
          </Stack>
        )}

        {/* Wishlist badge */}
        {movie.inWishlist && (
          <Stack
            position="absolute"
            top={8}
            right={8}
            backgroundColor={theme.tertiaryContainer?.val}
            borderRadius={12}
            width={24}
            height={24}
            alignItems="center"
            justifyContent="center"
          >
            <Text fontSize={12} lineHeight={12}>♥</Text>
          </Stack>
        )}
      </Stack>

      {/* Info */}
      <YStack padding={10} gap={4}>
        <Text
          fontFamily="$heading"
          fontSize={14}
          fontWeight="500"
          color={theme.onSurface?.val}
          numberOfLines={2}
          lineHeight={18}
        >
          {movie.title}
        </Text>

        {movie.year && (
          <Text
            fontFamily="$body"
            fontSize={12}
            letterSpacing={0.4}
            color={theme.onSurfaceVariant?.val}
          >
            {movie.year}
            {movie.runtime ? ` · ${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m` : ''}
          </Text>
        )}

        {movie.rating !== undefined && (
          <Stack marginTop={2}>
            <StarRating rating={movie.rating} />
          </Stack>
        )}

        {/* Format badges */}
        {movie.formats && movie.formats.length > 0 && (
          <XStack gap={4} flexWrap="wrap" marginTop={4}>
            {movie.formats.map(fmt => (
              <FormatBadge key={fmt} format={fmt} />
            ))}
          </XStack>
        )}
      </YStack>
    </YStack>
  )
}

// ─── Compact Card (horizontal row) ───────────────────────────────────────────

function CompactCard({ movie, onPress, onWishlistToggle, selected }: MovieCardProps) {
  const theme = useTheme()

  return (
    <XStack
      backgroundColor={selected ? theme.secondaryContainer?.val : 'transparent'}
      borderRadius={8}
      overflow="hidden"
      cursor="pointer"
      animation="quick"
      onPress={onPress}
      pressStyle={{ backgroundColor: theme.surfaceVariant?.val }}
      hoverStyle={{ backgroundColor: theme.surface1?.val }}
      paddingVertical={8}
      paddingHorizontal={16}
      alignItems="center"
      gap={16}
      minHeight={72}
    >
      {/* Thumbnail — 40x60 (2:3) */}
      <Stack
        width={40}
        height={60}
        borderRadius={4}
        overflow="hidden"
        backgroundColor={theme.surfaceVariant?.val}
        flexShrink={0}
      >
        {movie.posterUrl ? (
          <Image
            source={{ uri: movie.posterUrl }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        ) : (
          <Stack flex={1} alignItems="center" justifyContent="center">
            <Text fontSize={20}>🎬</Text>
          </Stack>
        )}
      </Stack>

      {/* Info */}
      <YStack flex={1} gap={2}>
        <Text
          fontFamily="$heading"
          fontSize={16}
          fontWeight="500"
          color={theme.onSurface?.val}
          numberOfLines={1}
        >
          {movie.title}
        </Text>

        <Text
          fontFamily="$body"
          fontSize={12}
          letterSpacing={0.4}
          color={theme.onSurfaceVariant?.val}
        >
          {[movie.year, movie.director].filter(Boolean).join(' · ')}
        </Text>

        <XStack gap={4} marginTop={2} alignItems="center">
          {movie.rating !== undefined && <StarRating rating={movie.rating} />}
          {movie.formats?.slice(0, 2).map(fmt => (
            <FormatBadge key={fmt} format={fmt} />
          ))}
        </XStack>
      </YStack>

      {/* Wishlist toggle */}
      {onWishlistToggle && (
        <Stack
          width={40}
          height={40}
          alignItems="center"
          justifyContent="center"
          onPress={(e) => { e.stopPropagation?.(); onWishlistToggle() }}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Text
            fontSize={20}
            color={movie.inWishlist ? theme.tertiary?.val : theme.outlineVariant?.val}
          >
            {movie.inWishlist ? '♥' : '♡'}
          </Text>
        </Stack>
      )}
    </XStack>
  )
}

// ─── Main MovieCard ───────────────────────────────────────────────────────────

export const MovieCard = React.memo<MovieCardProps>(function MovieCard({
  layout = 'poster',
  ...props
}) {
  switch (layout) {
    case 'compact': return <CompactCard {...props} />
    case 'poster':
    default:        return <PosterCard  {...props} />
  }
})

MovieCard.displayName = 'MCM.MovieCard'
export { StarRating, FormatBadge }
