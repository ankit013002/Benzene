import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../src/session/AuthContext';
import { palette } from '../src/theme';

export default function IndexRoute() {
  const { ready, tokens } = useAuth();
  if (!ready) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper }}><ActivityIndicator color={palette.ink} /></View>;
  return <Redirect href={tokens ? '/(app)' : '/sign-in'} />;
}
