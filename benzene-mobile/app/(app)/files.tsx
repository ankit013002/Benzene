import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Alert, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { isRecord } from '../../src/api/client';
import { formatBytes, isVaultFile, isVaultSummary } from '../../src/api/models';
import { allowsInsecureLanTransfers } from '../../src/config';
import { decryptObject, encryptObject } from '../../src/crypto/encryptedObject';
import { isRecoveryKitAcknowledged, loadVaultMasterKey } from '../../src/crypto/vaultKeys';
import { MAX_ENCRYPTED_FILE_BYTES, downloadEncryptedCurrentFile, uploadEncryptedFile } from '../../src/files/encryptedTransfers';
import { sharePlaintextFile } from '../../src/files/nativeFileExport';
import { Card, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useRemote } from '../../src/components/useRemote';
import { useAuth } from '../../src/session/AuthContext';
import { palette, type } from '../../src/theme';

export default function FilesScreen() {
  const { request } = useAuth();
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const select = useCallback((payload: unknown) => {
    if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.files)) return null;
    if (!payload.data.files.every(isVaultFile)) return null;
    return payload.data.files;
  }, []);
  const { data, loading, error, reload } = useRemote('/files?path=', select);

  async function addEncryptedFile(): Promise<void> {
    if (busyFile) return;
    setBusyFile('Preparing file picker…');
    try {
      const vaultPayload: unknown = await request('/vaults/me');
      if (!isRecord(vaultPayload) || !isVaultSummary(vaultPayload.data)) throw new Error('Benzene did not return a valid Vault.');
      const vaultId = vaultPayload.data.id;
      const vmk = await loadVaultMasterKey(vaultId);
      if (!vmk) {
        Alert.alert('Vault key is missing', 'Create a recovery kit or import one before uploading encrypted files.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Set up recovery', onPress: () => router.push('./recovery') },
        ]);
        return;
      }
      try {
        if (!await isRecoveryKitAcknowledged(vaultId)) {
          Alert.alert('Recovery is incomplete', 'Save and confirm this Vault’s recovery kit before uploading. A password reset cannot restore the encryption key.', [
            { text: 'Not now', style: 'cancel' },
            { text: 'Set up recovery', onPress: () => router.push('./recovery') },
          ]);
          return;
        }
        const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
        if (picked.canceled || !picked.assets?.[0]) return;
        const asset = picked.assets[0];
        if (typeof asset.size === 'number' && asset.size > MAX_ENCRYPTED_FILE_BYTES) {
          throw new Error(`Files larger than ${formatBytes(MAX_ENCRYPTED_FILE_BYTES)} are not supported on mobile yet. Use a connected computer.`);
        }
        const source = new File(asset.uri);
        const actualSize = asset.size ?? source.info().size;
        if (typeof actualSize !== 'number' || !Number.isSafeInteger(actualSize) || actualSize > MAX_ENCRYPTED_FILE_BYTES) {
          throw new Error(`This file exceeds the ${formatBytes(MAX_ENCRYPTED_FILE_BYTES)} mobile limit or its size could not be verified.`);
        }
        setBusyFile(`Encrypting ${asset.name}…`);
        const plaintext = await source.bytes();
        try {
          if (plaintext.byteLength !== actualSize) throw new Error('The selected file changed while it was being read. Choose it again.');
          const result = await uploadEncryptedFile({
            name: asset.name,
            path: '',
            contentType: asset.mimeType || 'application/octet-stream',
            plaintext,
            vaultId,
            encrypt: (bytes, id) => encryptObject(bytes, vmk, id),
          }, {
            request: (path, init) => request<unknown>(path, init),
            directFetch: (url, init) => fetch(url, init),
            allowInsecureLanTransfers: allowsInsecureLanTransfers(),
          });
          await reload();
          if (result.warnings.length > 0) {
            Alert.alert('File saved with reduced protection', result.warnings.join('\n\n'));
          } else {
            Alert.alert('Encrypted file saved', 'The file was encrypted on this device and stored directly on your devices.');
          }
        } finally {
          plaintext.fill(0);
        }
      } finally {
        vmk.fill(0);
      }
    } catch (cause) {
      Alert.alert('Upload could not finish', cause instanceof Error ? cause.message : 'Could not upload this file.');
    } finally {
      setBusyFile(null);
    }
  }

  async function downloadEncryptedFile(file: NonNullable<typeof data>[number]): Promise<void> {
    if (busyFile) return;
    setBusyFile(`Preparing ${file.name}…`);
    try {
      const vaultPayload: unknown = await request('/vaults/me');
      if (!isRecord(vaultPayload) || !isVaultSummary(vaultPayload.data)) throw new Error('Benzene did not return a valid Vault.');
      const vaultId = vaultPayload.data.id;
      const vmk = await loadVaultMasterKey(vaultId);
      if (!vmk) throw new Error('No Vault key is available on this device. Import the Vault recovery kit before downloading encrypted files.');
      try {
        await downloadEncryptedCurrentFile({
          nodeId: file.id,
          filename: file.name,
          contentType: file.contentType || 'application/octet-stream',
          availability: file.protection?.availability,
          vaultId,
          vmk,
          decrypt: decryptObject,
          exportPlaintext: sharePlaintextFile,
        }, {
          request: (path, init) => request<unknown>(path, init),
          directFetch: (url, init) => fetch(url, init),
          allowInsecureLanTransfers: allowsInsecureLanTransfers(),
        });
      } finally {
        vmk.fill(0);
      }
    } catch (cause) {
      Alert.alert('Download could not finish', cause instanceof Error ? cause.message : 'Could not download this file.');
    } finally {
      setBusyFile(null);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void reload()} tintColor={palette.ink} />}>
      <Wordmark />
      <PageTitle title="Files" detail="Files in the root of your Vault." />
      <View style={styles.addBlock}>
        <Pressable accessibilityRole="button" onPress={() => void addEncryptedFile()} disabled={busyFile !== null || Platform.OS === 'web'} style={({ pressed }) => [styles.addButton, (pressed || busyFile !== null || Platform.OS === 'web') && styles.pressed]}>
          <Text style={styles.addText}>{busyFile ?? 'Add encrypted file'}</Text>
        </Pressable>
        <Text style={styles.limit}>{Platform.OS === 'web' ? 'Encrypted upload and export are supported in the native iOS and Android apps only.' : `Encrypted mobile uploads currently support files up to ${formatBytes(MAX_ENCRYPTED_FILE_BYTES)}.`}</Text>
      </View>
      {loading && !data ? <StateMessage title="Loading your files" busy /> : null}
      {error ? <StateMessage title="Files could not load" detail={error} /> : null}
      {data?.length === 0 ? <StateMessage title="Your Vault is empty" detail="Add encrypted files from an iOS or Android app, or add files from a connected computer." /> : null}
      {data?.map((file) => <Card key={file.id}>
        <View style={styles.row}><View style={styles.copy}><Text numberOfLines={1} style={styles.name}>{file.name}</Text><Text numberOfLines={1} style={styles.path}>{file.path || 'Vault'}</Text></View><Text style={styles.size}>{formatBytes(file.bytes)}</Text></View>
        {!file.hasContent ? <Text style={styles.pending}>Upload still in progress</Text> : null}
        {file.hasContent ? <>
          <Text style={file.protection?.availability === 'unavailable' ? styles.warning : styles.path}>
            {availabilityLabel(file.protection?.availability)}
          </Text>
          {reducedProtectionLabel(file.protection) ? <Text style={styles.warning}>{reducedProtectionLabel(file.protection)}</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => void downloadEncryptedFile(file)} disabled={busyFile !== null || Platform.OS === 'web'} style={({ pressed }) => [styles.downloadButton, (pressed || Platform.OS === 'web') && styles.pressed]}>
            <Text style={styles.downloadText}>{Platform.OS === 'web' ? 'Open in iOS or Android to decrypt' : busyFile?.includes(file.name) ? busyFile : 'Decrypt and save a copy'}</Text>
          </Pressable>
        </> : null}
      </Card>)}
    </Screen>
  );
}

function availabilityLabel(value: string | undefined): string {
  switch (value) {
    case 'available': return 'Available';
    case 'waiting_for_device': return 'Waiting for a device';
    case 'restoring_protection': return 'Restoring protection';
    case 'unavailable': return 'Unavailable';
    default: return 'Availability not reported';
  }
}

function reducedProtectionLabel(protection: import('../../src/api/models').VaultFile['protection']): string | null {
  const reduced = typeof protection?.healthyReplicas === 'number'
    && typeof protection.desiredReplicas === 'number'
    && protection.healthyReplicas < protection.desiredReplicas;
  if (protection?.state === 'at_risk') return 'At risk';
  if (reduced) return `Reduced protection · ${protection.healthyReplicas} of ${protection.desiredReplicas} copies`;
  return null;
}

const styles = StyleSheet.create({
  addBlock: { gap: 7 },
  addButton: { minHeight: 52, borderRadius: 15, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  addText: { color: palette.card, fontSize: 15, fontWeight: '600' },
  limit: { color: palette.muted, ...type.small, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  copy: { flex: 1, gap: 4 },
  name: { color: palette.ink, ...type.section },
  path: { color: palette.muted, ...type.small },
  size: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  pending: { color: palette.muted, fontSize: 12, marginTop: 5 },
  warning: { color: palette.danger, ...type.small },
  downloadButton: { minHeight: 44, borderWidth: 1, borderColor: palette.line, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  downloadText: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.55 },
});
