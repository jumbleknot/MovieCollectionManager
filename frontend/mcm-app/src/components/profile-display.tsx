/**
 * ProfileDisplay component (T-083)
 * Displays user profile information and logout button (T-101).
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { LogoutConfirmationDialog } from '@/components/logout-confirmation-dialog';
import type { UserProfile } from '@/types/auth';

interface ProfileDisplayProps {
  user: UserProfile;
  onLogout: () => Promise<void>;
}

export function ProfileDisplay({ user, onLogout }: ProfileDisplayProps): React.JSX.Element {
  const [showDialog, setShowDialog] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleConfirmLogout() {
    setShowDialog(false);
    setIsLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <View style={styles.container} testID="profile-display">
      <Text style={styles.heading}>Your Profile</Text>

      <ProfileRow label="First Name" value={user.firstName} />
      <ProfileRow label="Last Name" value={user.lastName} />
      <ProfileRow label="Username" value={user.username} />
      <ProfileRow label="Email" value={user.email} />
      <ProfileRow
        label="Email Verified"
        value={user.emailVerified ? 'Yes' : 'No'}
        testID="profile-email-verified"
      />
      <ProfileRow
        label="Roles"
        value={(user.roles ?? []).join(', ')}
        testID="profile-roles"
      />
      <ProfileRow
        label="Account Status"
        value="Active"
        testID="profile-status"
      />

      <TouchableOpacity
        style={[styles.logoutButton, isLoggingOut && styles.buttonDisabled]}
        onPress={() => setShowDialog(true)}
        disabled={isLoggingOut}
        testID="btn-logout"
        accessibilityRole="button"
        accessibilityLabel="Logout"
      >
        {isLoggingOut ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.logoutButtonText}>Logout</Text>
        )}
      </TouchableOpacity>

      <LogoutConfirmationDialog
        visible={showDialog}
        onConfirm={handleConfirmLogout}
        onCancel={() => setShowDialog(false)}
      />
    </View>
  );
}

function ProfileRow({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.row} testID={testID ?? `profile-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: '#fff',
  },
  heading: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  rowLabel: {
    fontSize: 14,
    color: '#718096',
    fontWeight: '600',
  },
  rowValue: {
    fontSize: 14,
    color: '#1a202c',
    fontWeight: '500',
    textAlign: 'right',
    flex: 1,
    marginLeft: 16,
  },
  logoutButton: {
    backgroundColor: '#e53e3e',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 32,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  logoutButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
