import { Link, router, type Href } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { passwordLengthError, resetPassword } from '../src/api/authJourney';
import { ActionButton } from '../src/components/ActionButton';
import { Body, Screen, Wordmark } from '../src/components/Screen';
import { palette, type } from '../src/theme';

export default function ResetPasswordScreen() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setError('');
    if (!token.trim()) { setError('Paste the token from your reset link.'); return; }
    const lengthError = passwordLengthError(password);
    if (lengthError) { setError(lengthError); return; }
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setBusy(true);
    try { await resetPassword(token, password); setComplete(true); setToken(''); setPassword(''); setConfirmation(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Benzene could not reset your password.'); }
    finally { setBusy(false); }
  }
  return <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Screen><Wordmark subtitle="Account recovery" />
      <View style={styles.intro}><Text style={styles.title}>{complete ? 'Password updated.' : 'Choose a new password.'}</Text><Body style={styles.copy}>{complete ? 'You can now sign in with your new password.' : 'Open the reset email in your browser, copy the token value from its URL, and paste it below.'}</Body></View>
      {!complete ? <View style={styles.form}><Text style={styles.label}>Reset token</Text><TextInput autoCapitalize="none" autoCorrect={false} value={token} onChangeText={setToken} placeholder="Paste reset token" placeholderTextColor={palette.muted} style={[styles.input, styles.token]} accessibilityLabel="Reset token" />
        <Text style={styles.label}>New password</Text><TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry textContentType="newPassword" value={password} onChangeText={setPassword} placeholder="At least 8 characters" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="New password" />
        <Text style={styles.label}>Confirm new password</Text><TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry textContentType="newPassword" value={confirmation} onChangeText={setConfirmation} placeholder="Enter it again" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Confirm new password" onSubmitEditing={() => void submit()} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}<ActionButton title="Reset password" onPress={() => void submit()} busy={busy} disabled={!token || !password || !confirmation} />
      </View> : <View style={styles.form}><ActionButton title="Go to sign in" onPress={() => router.replace('/sign-in')} /></View>}
      <Link href={'/forgot-password' as Href} style={styles.link}>Request another reset email</Link>
    </Screen>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, intro: { marginTop: 42, gap: 9 }, title: { color: palette.ink, ...type.title }, copy: { color: palette.muted }, form: { gap: 12, marginTop: 22 }, label: { color: palette.ink, fontSize: 13, fontWeight: '600', marginTop: 4 }, input: { minHeight: 54, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 14, paddingHorizontal: 15, color: palette.ink, fontSize: 15 }, token: { fontFamily: 'monospace' }, error: { color: palette.danger, ...type.small }, link: { color: palette.ink, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline', textAlign: 'center', marginTop: 10 } });
