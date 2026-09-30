import { Link } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput } from 'react-native';
import { readAccountDeletionStatus, readAccountDeletionStatusByReceipt, requestAccountDeletion, type DeletionStatus } from '../src/api/nativeSession';
import { ActionButton } from '../src/components/ActionButton';
import { Body, Card, PageTitle, Screen } from '../src/components/Screen';
import { clearAccountDeletionReceipt, readAccountDeletionReceipt, saveAccountDeletionReceipt, type AccountDeletionReceipt } from '../src/session/accountDeletionReceiptStore';
import { useAuth } from '../src/session/AuthContext';
import { palette, type } from '../src/theme';

export default function AccountDeletionScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedReceipt, setSavedReceipt] = useState<AccountDeletionReceipt | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const { endSession } = useAuth();

  const refreshWithReceipt = useCallback(async (receipt: AccountDeletionReceipt) => {
    const result = await readAccountDeletionStatusByReceipt(receipt.requestId, receipt.receipt);
    setError('');
    setStatus(result);
    if (result.deletionComplete) {
      await clearAccountDeletionReceipt();
      setSavedReceipt(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void readAccountDeletionReceipt()
      .then((receipt) => { if (active) setSavedReceipt(receipt); })
      .catch(() => { if (active) setError('Could not read the saved deletion receipt.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!savedReceipt || status?.deletionComplete) return;
    let active = true;
    const poll = async () => {
      try {
        if (active) await refreshWithReceipt(savedReceipt);
      } catch {
        // Keep the receipt so a temporary network failure can be retried.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [refreshWithReceipt, savedReceipt, status?.deletionComplete]);

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
      let receiptSaved = false;
      if (result.receipt) {
        const receipt = { requestId: result.requestId, receipt: result.receipt };
        // Keep polling for this app session even if the OS keystore is
        // temporarily unavailable. Persistence still fails visibly below.
        setSavedReceipt(receipt);
        try {
          await saveAccountDeletionReceipt(receipt);
          receiptSaved = true;
        } catch {
          setError('The deletion request was recorded, but this device could not securely save its status receipt. You can re-enter your credentials to check progress.');
        }
      }
      if (receiptSaved) setPassword('');
      await endSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not request account deletion.');
    } finally {
      setBusy(false);
    }
  }

  function confirmRequest() {
    Alert.alert(
      'Request account deletion?',
      'This revokes refresh credentials and starts the cleanup process. An already-issued access token can remain valid for up to 15 minutes. Cleanup can take time while devices acknowledge removal; this screen will check progress automatically.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start cleanup', style: 'destructive', onPress: () => void submitRequest() },
      ],
    );
  }

  async function checkStatus() {
    setBusy(true);
    setError('');
    try {
      if (savedReceipt) {
        await refreshWithReceipt(savedReceipt);
      } else {
        setStatus(await readAccountDeletionStatus(email.trim(), password));
        setPassword('');
      }
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
      <Body>Confirm with your password to revoke refresh credentials and start account cleanup. An already-issued access token can remain valid for up to 15 minutes. Cleanup may take time while connected devices acknowledge removal.</Body>
      <Text style={styles.label}>Account email</Text>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" placeholder="you@example.com" placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel="Account email" />
      {!savedReceipt ? <>
        <Text style={styles.label}>{status ? 'Password to check status' : 'Password'}</Text>
        <TextInput value={password} onChangeText={setPassword} autoCapitalize="none" autoComplete="current-password" secureTextEntry textContentType="password" placeholder={status ? 'Re-enter your password' : 'Your password'} placeholderTextColor={palette.muted} style={styles.input} accessibilityLabel={status ? 'Password to check deletion status' : 'Password'} />
      </> : <Body>A private status receipt is saved on this device. Benzene checks cleanup progress without retaining your password.</Body>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!status?.deletionComplete ? <ActionButton title="Request account deletion" onPress={confirmRequest} busy={busy} disabled={!email.trim() || !password || !!savedReceipt} /> : null}
      <ActionButton title="Check cleanup status" onPress={() => void checkStatus()} secondary busy={busy} disabled={savedReceipt ? false : !email.trim() || !password} />
    </Card>
    {status ? <Card>
      <Text style={styles.heading}>{status.deletionComplete ? 'Service reports completion' : 'Request recorded · cleanup pending'}</Text>
      <Body>{status.message ?? `Current phase: ${status.currentPhase.replaceAll('_', ' ')}.`}</Body>
      {!status.deletionComplete ? <Body style={styles.warning}>Cleanup {status.downstreamCleanupStarted ? 'has started' : 'is queued'} and is not complete yet.</Body> : null}
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
