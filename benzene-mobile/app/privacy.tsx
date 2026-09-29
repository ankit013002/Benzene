import { Link } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { privacyPolicyUrl } from '../src/config';
import { Body, Card, PageTitle, Screen } from '../src/components/Screen';
import { palette, type } from '../src/theme';

export default function PrivacyScreen() {
  const url = privacyPolicyUrl();
  return <Screen>
    <PageTitle title="Privacy" detail="Your files belong to you." />
    {url ? <>
      <Card><Body>Benzene&apos;s privacy policy is available at the link below.</Body></Card>
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)} style={styles.linkButton}><Text style={styles.link}>Open privacy policy</Text></Pressable>
    </> : <Card>
      <Text style={styles.heading}>Privacy policy not configured</Text>
      <Body>The service owner must publish a privacy policy and set EXPO_PUBLIC_PRIVACY_POLICY_URL before a store submission. This screen does not replace that policy.</Body>
    </Card>}
    <Link href="/(app)/settings" style={styles.back}>Back to Settings</Link>
  </Screen>;
}

const styles = StyleSheet.create({
  heading: { color: palette.ink, ...type.section },
  linkButton: { minHeight: 52, borderRadius: 15, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  link: { color: palette.card, fontSize: 15, fontWeight: '600' },
  back: { color: palette.ink, textDecorationLine: 'underline', fontSize: 14, fontWeight: '600' },
});
