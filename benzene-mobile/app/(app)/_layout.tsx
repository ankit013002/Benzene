import { Redirect, Tabs } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../../src/session/AuthContext';
import { palette } from '../../src/theme';

export default function AppLayout() {
  const { ready, tokens } = useAuth();
  if (!ready) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper }}><ActivityIndicator color={palette.ink} /></View>;
  if (!tokens) return <Redirect href="/sign-in" />;

  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: palette.ink,
      tabBarInactiveTintColor: palette.muted,
      tabBarStyle: { backgroundColor: palette.card, borderTopColor: palette.line, height: 62, paddingTop: 7, paddingBottom: 7 },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Vault' }} />
      <Tabs.Screen name="files" options={{ title: 'Files' }} />
      <Tabs.Screen name="devices" options={{ title: 'Devices' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      <Tabs.Screen name="recovery" options={{ href: null }} />
    </Tabs>
  );
}
