import { Link, type Href } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { isValidEmail, requestPasswordReset } from '../src/api/authJourney';
import { ActionButton } from '../src/components/ActionButton';
import { Body, Screen, Wordmark } from '../src/components/Screen';
import { palette, type } from '../src/theme';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setError('');
    if (!isValidEmail(email)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    try { await requestPasswordReset(email); setSubmitted(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Benzene could not process this request.'); }
    finally { setBusy(false); }
  }
  return <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Screen><Wordmark subtitle="Account recovery" />
      <View style={styles.intro}><Text style={styles.title}>Reset your password.</Text><Body style={styles.copy}>{submitted ? 'If an account matches that email, a reset link has been sent. Check your inbox and open the link in your browser.' : 'Enter your account email and we’ll send a reset link if an account matches.'}</Body></View>
      {!submitted ? <View style={styles.form}><Text style={styles.label}>Email</Text><TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Email address" onSubmitEditing={() => void submit()} />{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}<ActionButton title="Send reset link" onPress={() => void submit()} busy={busy} disabled={!email.trim()} /></View> : <View style={styles.form}><Body>To finish in the app, copy the token value from the reset URL and paste it on the reset screen.</Body><Link href={'/reset-password' as Href} style={styles.link}>Enter reset token</Link></View>}
      <Link href="/sign-in" style={styles.link}>Back to sign in</Link>
    </Screen>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, intro: { marginTop: 42, gap: 9 }, title: { color: palette.ink, ...type.title }, copy: { color: palette.muted }, form: { gap: 12, marginTop: 22 }, label: { color: palette.ink, fontSize: 13, fontWeight: '600' }, input: { minHeight: 54, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 14, paddingHorizontal: 15, color: palette.ink, fontSize: 15 }, error: { color: palette.danger, ...type.small }, link: { color: palette.ink, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline', textAlign: 'center', marginTop: 10 } });
