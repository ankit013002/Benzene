import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../src/session/AuthContext';
import { palette } from '../src/theme';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ contentStyle: { backgroundColor: palette.paper }, headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="(app)" />
        <Stack.Screen name="privacy" options={{ headerShown: true, title: 'Privacy', headerBackTitle: 'Settings' }} />
        <Stack.Screen name="terms" options={{ headerShown: true, title: 'Terms', headerBackTitle: 'Settings' }} />
        <Stack.Screen name="support" options={{ headerShown: true, title: 'Support', headerBackTitle: 'Settings' }} />
        <Stack.Screen name="account-deletion" options={{ headerShown: true, title: 'Delete account', headerBackTitle: 'Settings' }} />
      </Stack>
    </AuthProvider>
  );
}
