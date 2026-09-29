import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput } from 'react-native';
import { readAccountDeletionStatus, requestAccountDeletion, type DeletionStatus } from '../src/api/nativeSession';
import { ActionButton } from '../src/components/ActionButton';
import { Body, Card, PageTitle, Screen } from '../src/components/Screen';
import { useAuth } from '../src/session/AuthContext';
import { palette, type } from '../src/theme';

export default function AccountDeletionScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const { endSession } = useAuth();

  function getIdempotencyKey(): string {
    if (!idempotencyKey.current) {
      idempotencyKey.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2).padEnd(24, '0')}`;
    }
    return idempotencyKey.current;
  }

  async function submitRequest() {
    setBusy(true);
    setError('');
    try {
      const result = await requestAccountDeletion(email.trim(), password, getIdempotencyKey());
      setStatus(result);
      setPassword('');
      await endSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not request account deletion.');
    } finally {
      setBusy(false);
    }
  }

  function confirmRequest() {
    Alert.alert(
      'Record an account-deletion request?',
      'This revokes refresh credentials and records a request. An already-issued access token can remain valid for up to 15 minutes. It does not delete your Vault or associated files; cleanup is still pending.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Record request', style: 'destructive', onPress: () => void submitRequest() },
      ],
    );
  }

  async function checkStatus() {
    setBusy(true);
    setError('');
    try {
      setStatus(await readAccountDeletionStatus(email.trim(), password));
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check account-deletion status.');
    } finally {
      setBusy(false);
    }
  }

  return <Screen>
    <PageTitle title="Delete account" detail="You control the data in your Benzene account." />
    <Card>
      <Text style={styles.heading}>Request account deletion</Text>
      <Body>This verifies your password and revokes refresh credentials. An already-issued access token can remain valid for up to 15 minutes. It records a request for cleanup; it does not delete your account, Vault or files.</Body>
      <Text style={styles.label}>Account email</Text>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Account email" />
      <Text style={styles.label}>{status ? 'Password to check status' : 'Password'}</Text>
      <TextInput value={password} onChangeText={setPassword} autoCapitalize="none" autoComplete="current-password" secureTextEntry textContentType="password" placeholder={status ? 'Re-enter your password' : 'Your password'} placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel={status ? 'Password to check deletion status' : 'Password'} />
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <ActionButton title="Request account deletion" onPress={confirmRequest} busy={busy} disabled={!email.trim() || !password} />
      <ActionButton title="Check request status" onPress={() => void checkStatus()} secondary busy={busy} disabled={!email.trim() || !password} />
    </Card>
    {status ? <Card>
      <Text style={styles.heading}>{status.deletionComplete ? 'Service reports completion' : 'Request recorded · cleanup pending'}</Text>
      <Body>{status.message ?? `Current phase: ${status.currentPhase.replaceAll('_', ' ')}.`}</Body>
      {!status.deletionComplete ? <Body style={styles.warning}>Your account data has not been deleted. Cleanup {status.downstreamCleanupStarted ? 'has started' : 'has not started'}.</Body> : null}
      <Text selectable style={styles.requestId}>Request ID · {status.requestId}</Text>
    </Card> : null}
    <Link href="/(app)/settings" style={styles.back}>Back to Settings</Link>
  </Screen>;
}

const styles = StyleSheet.create({
  heading: { color: palette.ink, ...type.section },
  label: { color: palette.ink, fontSize: 13, fontWeight: '600', marginTop: 5 },
  input: { minHeight: 52, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 14, paddingHorizontal: 14, color: palette.ink, fontSize: 15 },
  error: { color: palette.danger, ...type.small },
  warning: { color: palette.danger },
  requestId: { color: palette.muted, ...type.small, marginTop: 4 },
  back: { color: palette.ink, textDecorationLine: 'underline', fontSize: 14, fontWeight: '600' },
});
