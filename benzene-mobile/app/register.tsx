import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { signUp, resendVerification, isValidEmail, passwordLengthError } from '../src/api/authJourney';
import { ActionButton } from '../src/components/ActionButton';
import { Body, Screen, Wordmark } from '../src/components/Screen';
import { palette, type } from '../src/theme';

export default function RegisterScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    setError(''); setMessage('');
    if (!isValidEmail(email)) { setError('Enter a valid email address.'); return; }
    const passwordError = passwordLengthError(password);
    if (passwordError) { setError(passwordError); return; }
    setBusy(true);
    try {
      await signUp(email, password);
      setPending(true);
      setMessage('Check your inbox for a verification link. Open it in your browser, then return here.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Benzene could not create your account.');
    } finally { setBusy(false); }
  }

  async function resend() {
    setError(''); setMessage(''); setBusy(true);
    try {
      await resendVerification(email, password);
      setMessage('If this account is waiting for verification, a new message is on its way.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Benzene could not send a verification message.');
    } finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <Wordmark subtitle="Your personal storage, together." />
        <View style={styles.intro}>
          <Text style={styles.title}>{pending ? 'Check your email.' : 'Create your account.'}</Text>
          <Body style={styles.copy}>{pending ? `We sent a verification link to ${email.trim()}.` : 'Use an email address you can verify to protect your account.'}</Body>
        </View>
        {!pending ? <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Email address" />
          <Text style={styles.label}>Password</Text>
          <TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry textContentType="newPassword" value={password} onChangeText={setPassword} placeholder="At least 8 characters" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Password" onSubmitEditing={() => void submit()} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <ActionButton title="Create account" onPress={() => void submit()} busy={busy} disabled={!email.trim() || !password} />
          <Link href="/sign-in" style={styles.link}>Already have an account? Sign in</Link>
        </View> : <View style={styles.form}>
          <Body>{message || 'Open the email link in your browser. When it confirms verification, return here.'}</Body>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <ActionButton title="Send another verification email" onPress={() => void resend()} busy={busy} secondary />
          <ActionButton title="I’ve verified my email" onPress={() => router.replace('/sign-in')} secondary />
          <Link href="/sign-in" style={styles.link}>Back to sign in</Link>
        </View>}
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, intro: { marginTop: 42, gap: 9 }, title: { color: palette.ink, ...type.title }, copy: { color: palette.muted },
  form: { gap: 11, marginTop: 22 }, label: { color: palette.ink, fontSize: 13, fontWeight: '600', marginTop: 6 },
  input: { minHeight: 54, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 14, paddingHorizontal: 15, color: palette.ink, fontSize: 15 },
  error: { color: palette.danger, ...type.small, marginVertical: 4 }, link: { color: palette.ink, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline', textAlign: 'center', marginTop: 8 },
});
