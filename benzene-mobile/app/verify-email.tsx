import { Link, type Href, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Body, Screen, Wordmark } from '../src/components/Screen';
import { palette, type } from '../src/theme';

export default function VerifyEmailScreen() {
  const { status: paramStatus } = useLocalSearchParams<{ status?: string | string[] }>();
  const verified = paramStatus === 'success';

  return <Screen><Wordmark subtitle="Email verification" />
    <View style={styles.intro}>
      <Text style={styles.title}>{verified ? 'Email verified.' : 'Check your email in the browser.'}</Text>
      <Body style={styles.copy}>{verified
        ? 'Your email address is confirmed. You can now sign in to Benzene.'
        : 'Open the secure verification link from your email in a browser. After it confirms your address, choose Open Benzene to return here.'}</Body>
    </View>
    <Link href={'/sign-in' as Href} style={styles.link}>Continue to sign in</Link>
  </Screen>;
}

const styles = StyleSheet.create({
  intro: { marginTop: 42, gap: 9 },
  title: { color: palette.ink, ...type.title },
  copy: { color: palette.muted },
  link: { color: palette.ink, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline', textAlign: 'center', marginTop: 24 },
});
