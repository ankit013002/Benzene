import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { getRandomBytesAsync } from 'expo-crypto';
import { isRecord } from '../../src/api/client';
import { isVaultSummary } from '../../src/api/models';
import { acknowledgeRecoveryKit, importVaultMasterKey, isRecoveryKitAcknowledged, loadVaultMasterKey } from '../../src/crypto/vaultKeys';
import { exportVaultRecoveryKit, importRecoveryKit } from '../../src/crypto/recoveryKitNative';
import { ActionButton } from '../../src/components/ActionButton';
import { Body, Card, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useAuth } from '../../src/session/AuthContext';
import { palette, type } from '../../src/theme';

export default function RecoveryScreen() {
  const { request } = useAuth();
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [keyDamaged, setKeyDamaged] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sharedKitReady, setSharedKitReady] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const pendingKitKey = useRef<Uint8Array | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshState(): Promise<void> {
    const payload: unknown = await request('/vaults/me');
    if (!isRecord(payload) || !isVaultSummary(payload.data)) throw new Error('Benzene did not return a valid Vault.');
    const currentVaultId = payload.data.id;
    setVaultId(currentVaultId);
    try {
      const [key, recoverySaved] = await Promise.all([loadVaultMasterKey(currentVaultId), isRecoveryKitAcknowledged(currentVaultId)]);
      setHasKey(key !== null);
      setAcknowledged(recoverySaved);
      setKeyDamaged(false);
    } catch (cause) {
      setHasKey(false);
      setAcknowledged(false);
      if (cause instanceof Error && cause.message.includes('key is damaged')) setKeyDamaged(true);
      throw cause;
    }
  }

  useEffect(() => {
    let active = true;
    void request('/vaults/me').then(async (payload: unknown) => {
      if (!isRecord(payload) || !isVaultSummary(payload.data)) throw new Error('Benzene did not return a valid Vault.');
      const currentVaultId = payload.data.id;
      if (!active) return;
      setVaultId(currentVaultId);
      try {
        const [key, recoverySaved] = await Promise.all([loadVaultMasterKey(currentVaultId), isRecoveryKitAcknowledged(currentVaultId)]);
        if (!active) return;
        setHasKey(key !== null);
        setAcknowledged(recoverySaved);
        setKeyDamaged(false);
      } catch (cause) {
        if (!active) return;
        setHasKey(false);
        setAcknowledged(false);
        if (cause instanceof Error && cause.message.includes('key is damaged')) setKeyDamaged(true);
        throw cause;
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load Vault key status.');
    });
    return () => { active = false; };
  }, [request]);

  useEffect(() => () => {
    pendingKitKey.current?.fill(0);
    pendingKitKey.current = null;
  }, []);

  async function createAndShareKit(): Promise<void> {
    if (!vaultId || busy) return;
    if (keyDamaged) {
      setError('The saved key was damaged. Import its recovery kit; creating a new key would make existing encrypted files unreadable.');
      return;
    }
    if (passphrase.length < 16 || passphrase.trim().length === 0) {
      setError('Use a unique recovery passphrase with at least 16 characters; six random words are recommended.');
      return;
    }
    if (passphrase !== confirmation) {
      setError('The recovery passphrases do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const existing = await loadVaultMasterKey(vaultId);
      const vmk = existing ?? await getRandomBytesAsync(32);
      try {
        const kit = await exportVaultRecoveryKit(vaultId, vmk, passphrase);
        if (!existing) await importVaultMasterKey(vaultId, vmk);
        if (!await Sharing.isAvailableAsync()) throw new Error('Recovery-kit export is supported in the iOS and Android apps only.');
        const staged = new File(Paths.cache, `benzene-vault-recovery-${Date.now()}.json`);
        try {
          staged.write(kit);
          await Sharing.shareAsync(staged.uri, { dialogTitle: 'Save your Benzene Vault recovery kit', mimeType: 'application/json' });
        } finally {
          try { if (staged.exists) staged.delete(); } catch {
            // The OS can remove a temporary cache file while the share sheet is open.
          }
        }
        pendingKitKey.current?.fill(0);
        pendingKitKey.current = vmk.slice();
        setSharedKitReady(true);
        setHasKey(true);
        setError('The share sheet closed. Confirm below only after you saved the recovery file somewhere safe.');
      } finally {
        vmk.fill(0);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export the recovery kit.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmSavedKit(): Promise<void> {
    if (!vaultId || !sharedKitReady || !pendingKitKey.current) return;
    setBusy(true);
    try {
      await acknowledgeRecoveryKit(vaultId, pendingKitKey.current);
      await refreshState();
      pendingKitKey.current.fill(0);
      pendingKitKey.current = null;
      setSharedKitReady(false);
      setError(null);
      setPassphrase('');
      setConfirmation('');
      Alert.alert('Recovery is ready', 'This device has a local Vault key and you confirmed that the encrypted recovery kit is saved. Keep its passphrase separate from the kit.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save recovery status.');
    } finally {
      setBusy(false);
    }
  }

  async function restoreKit(): Promise<void> {
    if (!vaultId || busy) return;
    setBusy(true);
    setError(null);
    let restored: Uint8Array | null = null;
    let current: Uint8Array | null = null;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain'], copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.[0]) return;
      const contents = await new File(picked.assets[0].uri).text();
      const restoredKey = await importRecoveryKit(contents, vaultId, passphrase);
      restored = restoredKey;
      current = keyDamaged ? null : await loadVaultMasterKey(vaultId);
      if (current && current.some((byte, index) => byte !== restoredKey[index])) {
        throw new Error('This kit contains a different Vault key than the one already on this device. It was not imported to avoid replacing an active key.');
      }
      await importVaultMasterKey(vaultId, restoredKey);
      await acknowledgeRecoveryKit(vaultId, restoredKey);
      setHasKey(true);
      setAcknowledged(true);
      setKeyDamaged(false);
      setSharedKitReady(false);
      pendingKitKey.current?.fill(0);
      pendingKitKey.current = null;
      setPassphrase('');
      setConfirmation('');
      Alert.alert('Recovery kit imported', 'This device can now decrypt files for this Vault.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not import the recovery kit.');
    } finally {
      restored?.fill(0);
      current?.fill(0);
      setBusy(false);
    }
  }

  return <Screen>
    <Wordmark />
    <PageTitle title="Encryption recovery" detail="Your Vault key stays on your devices. Benzene cannot recover it after a password reset." />
    {!vaultId && !error ? <StateMessage title="Loading Vault key status" busy /> : null}
    {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
    {vaultId ? <>
      <Card>
        <Text style={styles.heading}>{hasKey ? 'Vault key on this device' : 'No Vault key on this device'}</Text>
        <Body>{acknowledged
          ? 'A local key is stored and you confirmed saving its encrypted recovery kit.'
          : hasKey
            ? 'A key is stored locally, but recovery is not marked complete. Uploads stay disabled until you save and confirm a recovery kit.'
            : 'Create a key and save its encrypted recovery kit before adding files. Losing the kit and every device key means permanent data loss.'}</Body>
      </Card>
      <Card>
        <Text style={styles.heading}>Create or export a recovery kit</Text>
        <Body>Use a unique passphrase of at least 16 characters. A six-word phrase made from random words is easier to remember and harder to guess.</Body>
        <TextInput value={passphrase} onChangeText={setPassphrase} placeholder="Recovery passphrase" placeholderTextColor={palette.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="Recovery passphrase" />
        <TextInput value={confirmation} onChangeText={setConfirmation} placeholder="Confirm recovery passphrase" placeholderTextColor={palette.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="Confirm recovery passphrase" />
        <ActionButton title={busy ? 'Preparing recovery kit…' : keyDamaged ? 'Import recovery kit first' : 'Export encrypted recovery kit'} onPress={() => void createAndShareKit()} busy={busy} disabled={keyDamaged} />
        {sharedKitReady ? <>
          <Text style={styles.warning}>The key is stored locally, but uploads remain disabled until you confirm the kit is safely saved.</Text>
          <ActionButton title="I saved the recovery kit safely" onPress={() => void confirmSavedKit()} secondary disabled={busy} />
        </> : null}
      </Card>
      <Card>
        <Text style={styles.heading}>Restore from a recovery kit</Text>
        <Body>Select the JSON recovery file and enter its passphrase. Account password reset cannot replace this step.</Body>
        <ActionButton title="Choose recovery kit" onPress={() => void restoreKit()} secondary busy={busy} />
      </Card>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}><Text style={styles.backText}>Back to Settings</Text></Pressable>
    </> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  heading: { color: palette.ink, ...type.section },
  input: { minHeight: 50, borderWidth: 1, borderColor: palette.line, borderRadius: 13, paddingHorizontal: 14, color: palette.ink, backgroundColor: palette.paper },
  error: { color: palette.danger, ...type.body },
  warning: { color: palette.danger, ...type.small },
  back: { paddingVertical: 12, alignItems: 'center' },
  backText: { color: palette.muted, ...type.body },
});
