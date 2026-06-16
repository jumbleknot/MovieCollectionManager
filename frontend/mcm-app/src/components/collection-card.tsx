/**
 * CollectionCard component (feature 015 re-skin)
 *
 * Displays a single collection summary with name, description, movie count,
 * an optional "Default" badge, and an inline action menu (Open, Edit,
 * Set as Default, Delete).
 *
 * Re-skinned onto the MCM Cinema design system (Tamagui): the card surface,
 * typography (Outfit heading / Inter body), and actions use design-system
 * components + theme tokens. Structure, props, behaviour, and every testID are
 * unchanged (FR-002 / FR-018).
 */

import React from 'react';
import { Text, useTheme } from '@tamagui/core';
import { YStack, XStack } from '@tamagui/stacks';
import { Button } from '@mcm/design-system';
import type { CollectionSummary } from '@/types/collection';

interface CollectionCardProps {
  collection: CollectionSummary;
  onOpen: (collectionId: string) => void;
  onEdit: (collection: CollectionSummary) => void;
  onSetDefault: (collectionId: string) => void;
  onDelete: (collectionId: string) => void;
}

export function CollectionCard({
  collection,
  onOpen,
  onEdit,
  onSetDefault,
  onDelete,
}: CollectionCardProps): React.JSX.Element {
  const { collectionId, name, description, isDefault, movieCount } = collection;
  const theme = useTheme();

  return (
    <YStack
      testID="collection-card"
      accessibilityLabel={`Open collection ${name}`}
      onPress={() => onOpen(collectionId)}
      backgroundColor={theme.surface1?.val}
      borderRadius={12}
      padding={16}
      marginBottom={12}
      gap={6}
      cursor="pointer"
      pressStyle={{ opacity: 0.92, scale: 0.99 }}
      hoverStyle={{ backgroundColor: theme.surface2?.val }}
      shadowColor={theme.shadow?.val}
      shadowOffset={{ width: 0, height: 1 }}
      shadowOpacity={0.12}
      shadowRadius={2}
      elevation={1}
    >
      {/*
       * accessibilityRole="button" intentionally omitted on this outer wrapper.
       * The inner action buttons already carry role="button". Adding the role here
       * produces nested interactive elements on web. The wrapper remains pressable;
       * ARIA role is surfaced through the action buttons below.
       */}
      {/* Header row: name + default badge */}
      <XStack alignItems="center" gap={8}>
        <Text
          fontFamily="$heading"
          fontSize={17}
          fontWeight="700"
          color={theme.onSurface?.val}
          flex={1}
          numberOfLines={1}
        >
          {name}
        </Text>
        {isDefault && (
          <YStack
            testID="collection-card-default-badge"
            backgroundColor={theme.primary?.val}
            borderRadius={6}
            paddingHorizontal={8}
            paddingVertical={2}
          >
            <Text fontFamily="$body" color={theme.onPrimary?.val} fontSize={11} fontWeight="700">
              Default
            </Text>
          </YStack>
        )}
      </XStack>

      {/* Description */}
      {description != null && (
        <Text
          testID="collection-card-description"
          fontFamily="$body"
          fontSize={14}
          color={theme.onSurfaceVariant?.val}
          numberOfLines={2}
        >
          {description}
        </Text>
      )}

      {/* Movie count */}
      <Text fontFamily="$body" fontSize={14} color={theme.onSurfaceVariant?.val}>
        {movieCount} movies
      </Text>

      {/*
       * Action row.
       * Each action stops event propagation: the card wrapper above is itself
       * pressable (onOpen), and on web a Tamagui onPress maps to a DOM click that
       * bubbles from these nested buttons up to the wrapper. Without
       * stopPropagation, pressing e.g. "Set as Default" would also fire the card's
       * onOpen and navigate away (FR-002 — preserve the original RN behaviour where
       * the action and the card tap are distinct).
       */}
      <XStack flexWrap="wrap" gap={8} marginTop={4}>
        <Button
          variant="outlined"
          size="sm"
          label="Open"
          testID="collection-card-action-open"
          accessibilityLabel="Open collection"
          onPress={(e) => { e?.stopPropagation?.(); onOpen(collectionId); }}
        />
        <Button
          variant="outlined"
          size="sm"
          label="Edit"
          testID="collection-card-action-edit"
          accessibilityLabel="Edit collection"
          onPress={(e) => { e?.stopPropagation?.(); onEdit(collection); }}
        />
        {!isDefault && (
          <Button
            variant="outlined"
            size="sm"
            label="Set as Default"
            testID="collection-card-action-set-default"
            accessibilityLabel="Set as default collection"
            onPress={(e) => { e?.stopPropagation?.(); onSetDefault(collectionId); }}
          />
        )}
        <Button
          variant="outlined"
          size="sm"
          label="Delete"
          testID="collection-card-action-delete"
          accessibilityLabel="Delete collection"
          onPress={(e) => { e?.stopPropagation?.(); onDelete(collectionId); }}
        />
      </XStack>
    </YStack>
  );
}
