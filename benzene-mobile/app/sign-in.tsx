import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { ActionButton } from '../src/components/ActionButton';
import { Body, Screen, Wordmark } from '../src/components/Screen';
import { signIn } from '../src/api/client';
import { useAuth } from '../src/session/AuthContext';
import { palette, type } from '../src/theme';

export default function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { startSession } = useAuth();

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const result = await signIn(email.trim(), password);
      await startSession(result.tokens);
      router.replace('/(app)');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Benzene could not sign you in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <Wordmark subtitle="Your personal storage, together." />
        <View style={styles.intro}>
          <Text style={styles.title}>Welcome back.</Text>
          <Body style={styles.copy}>Sign in to see your Vault, files and connected devices.</Body>
        </View>
        <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Email address" />
          <Text style={styles.label}>Password</Text>
          <TextInput autoCapitalize="none" autoComplete="current-password" secureTextEntry textContentType="password" value={password} onChangeText={setPassword} placeholder="Your password" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Password" onSubmitEditing={() => void submit()} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <ActionButton title="Sign in" onPress={() => void submit()} busy={busy} disabled={!email.trim() || !password} />
        </View>
        <View style={styles.footer}>
          <Text style={styles.footerText}>New to Benzene? Account creation is managed by your Benzene service.</Text>
          <View style={styles.links}>
            <Link href="/account-deletion" style={styles.link}>Delete account / check status</Link>
            <Link href="/privacy" style={styles.link}>Privacy</Link>
            <Link href="/terms" style={styles.link}>Terms</Link>
            <Link href="/support" style={styles.link}>Support</Link>
          </View>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  intro: { marginTop: 48, gap: 9 },
  title: { color: palette.ink, ...type.title },
  copy: { color: palette.muted, maxWidth: 320 },
  form: { gap: 11, marginTop: 25 },
  label: { color: palette.ink, fontSize: 13, fontWeight: '600', marginTop: 6 },
  input: { minHeight: 54, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 14, paddingHorizontal: 15, color: palette.ink, fontSize: 15 },
  error: { color: palette.danger, ...type.small, marginVertical: 4 },
  footer: { marginTop: 'auto', gap: 12, paddingTop: 40 },
  footerText: { color: palette.muted, ...type.small },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  link: { color: palette.ink, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
});
