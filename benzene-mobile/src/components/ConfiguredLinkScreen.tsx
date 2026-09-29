import { Link } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { Body, Card, PageTitle, Screen } from './Screen';
import { palette, type } from '../theme';

export function ConfiguredLinkScreen({
  title,
  detail,
  label,
  url,
  missingMessage,
}: {
  title: string;
  detail: string;
  label: string;
  url: string | null;
  missingMessage: string;
}) {
  return <Screen>
    <PageTitle title={title} detail={detail} />
    {url ? <>
      <Card><Body>{title} is available at the link below.</Body></Card>
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)} style={styles.button}>
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    </> : <Card>
      <Text style={styles.heading}>{title} link not configured</Text>
      <Body>{missingMessage}</Body>
    </Card>}
    <Link href="/(app)/settings" style={styles.back}>Back to Settings</Link>
  </Screen>;
}

const styles = StyleSheet.create({
  heading: { color: palette.ink, ...type.section },
  button: { minHeight: 52, borderRadius: 15, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: palette.card, fontSize: 15, fontWeight: '600' },
  back: { color: palette.ink, textDecorationLine: 'underline', fontSize: 14, fontWeight: '600' },
});
