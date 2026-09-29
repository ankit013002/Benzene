import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { revokeNativeSession } from '../../src/api/nativeSession';
import { Card, PageTitle, Screen, Wordmark } from '../../src/components/Screen';
import { useAuth } from '../../src/session/AuthContext';
import { palette, type } from '../../src/theme';

function SettingRow({ title, detail, onPress, destructive = false }: { title: string; detail: string; onPress: () => void; destructive?: boolean }) {
  return <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
    <View style={styles.copy}><Text style={[styles.rowTitle, destructive && styles.danger]}>{title}</Text><Text style={styles.detail}>{detail}</Text></View><Text style={styles.chevron}>›</Text>
  </Pressable>;
}

export default function SettingsScreen() {
  const { tokens, endSession } = useAuth();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    let revoked = false;
    try {
      if (tokens) await revokeNativeSession(tokens);
      revoked = true;
    } catch {
      // Local credentials are cleared even if the service cannot be reached.
    } finally {
      await endSession();
      setBusy(false);
      router.replace('/sign-in');
    }
    if (!revoked) Alert.alert('Signed out on this device', 'The server could not confirm revocation. The remote session may remain valid until it expires.');
  }

  return <Screen>
    <Wordmark />
    <PageTitle title="Settings" detail="Your account and privacy choices." />
    <Card style={styles.group}>
      <SettingRow title="Privacy" detail="Read how Benzene handles your information." onPress={() => router.push('/privacy')} />
      <View style={styles.divider} />
      <SettingRow title="Terms" detail="Review the terms for this Benzene service." onPress={() => router.push('/terms')} />
      <View style={styles.divider} />
      <SettingRow title="Support" detail="Get help from the Benzene service owner." onPress={() => router.push('/support')} />
      <View style={styles.divider} />
      <SettingRow title="Delete account" detail="See account deletion options and availability." destructive onPress={() => router.push('/account-deletion')} />
    </Card>
    <Pressable onPress={() => void signOut()} disabled={busy} style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}>
      <Text style={styles.signOutText}>{busy ? 'Signing out…' : 'Sign out'}</Text>
    </Pressable>
  </Screen>;
}

const styles = StyleSheet.create({
  group: { paddingVertical: 0, paddingHorizontal: 17 },
  row: { minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 16 },
  copy: { flex: 1, gap: 4 },
  rowTitle: { color: palette.ink, fontSize: 15, fontWeight: '600' },
  detail: { color: palette.muted, ...type.small },
  danger: { color: palette.danger },
  chevron: { color: palette.muted, fontSize: 25, lineHeight: 28 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  signOut: { minHeight: 52, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  signOutText: { color: palette.ink, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.65 },
});
