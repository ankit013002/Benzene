import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { isRecord } from '../../src/api/client';
import { requestRelayReadFallback } from '../../src/api/relayRead';
import { formatBytes, isVaultSummary } from '../../src/api/models';
import { allowsInsecureLanTransfers } from '../../src/config';
import { decryptObject, encryptObject } from '../../src/crypto/encryptedObject';
import { isRecoveryKitAcknowledged, loadVaultMasterKey } from '../../src/crypto/vaultKeys';
import { MAX_ENCRYPTED_FILE_BYTES, downloadEncryptedCurrentFile, uploadEncryptedFile } from '../../src/files/encryptedTransfers';
import { createFolderRequestBody, filesRequestPath, normalizeVaultPath, parentVaultPath, parseVaultDirectory, vaultBreadcrumbs } from '../../src/files/folders';
import { sharePlaintextFile } from '../../src/files/nativeFileExport';
import { Card, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useRemote } from '../../src/components/useRemote';
import { useAuth } from '../../src/session/AuthContext';
import { palette, type } from '../../src/theme';

export default function FilesScreen() {
  const { request } = useAuth();
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [showFolderInput, setShowFolderInput] = useState(false);
  const select = useCallback((payload: unknown) => {
    return parseVaultDirectory(payload, currentPath);
  }, [currentPath]);
  const { data, loading, error, reload } = useRemote(filesRequestPath(currentPath), select);
  const directory = data?.path === currentPath ? data : null;
  const breadcrumbs = vaultBreadcrumbs(currentPath) ?? [];

  async function createFolder(): Promise<void> {
    if (busyFile) return;
    let body: { paths: string[] };
    try {
      body = createFolderRequestBody(folderName, currentPath);
    } catch (cause) {
      Alert.alert('Folder name not valid', cause instanceof Error ? cause.message : 'Choose another folder name.');
      return;
    }
    setBusyFile('Creating folder…');
    try {
      const payload: unknown = await request('/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!isRecord(payload) || !isRecord(payload.data) || typeof payload.data.created !== 'number'
        || !Number.isSafeInteger(payload.data.created) || payload.data.created < 0) {
        throw new Error('Benzene returned an invalid folder creation response.');
      }
      setFolderName('');
      setShowFolderInput(false);
      await reload();
    } catch (cause) {
      Alert.alert('Folder could not be created', cause instanceof Error ? cause.message : 'Could not create this folder.');
    } finally {
      setBusyFile(null);
    }
  }

  function openFolder(path: string): void {
    const normalized = normalizeVaultPath(path);
    if (normalized !== null) setCurrentPath(normalized);
  }

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
            path: currentPath,
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

  async function downloadEncryptedFile(file: NonNullable<typeof directory>['files'][number]): Promise<void> {
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
          relayFallback: (expected) => requestRelayReadFallback(
            (path, init) => request<unknown>(path, init),
            { ...expected, nodeId: file.id, requestId: Crypto.randomUUID() },
          ),
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
      <PageTitle title="Files" detail={currentPath || 'Files in your Vault.'} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.breadcrumbs} accessibilityLabel="Folder breadcrumbs">
        {breadcrumbs.map((crumb, index) => <View key={crumb.path || 'vault'} style={styles.crumbWrap}>
          {index > 0 ? <Text style={styles.crumbSeparator}>›</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${crumb.label}`} onPress={() => openFolder(crumb.path)} disabled={currentPath === crumb.path}>
            <Text style={[styles.crumb, currentPath === crumb.path && styles.activeCrumb]}>{crumb.label}</Text>
          </Pressable>
        </View>)}
      </ScrollView>
      <View style={styles.addBlock}>
        <Pressable accessibilityRole="button" onPress={() => void addEncryptedFile()} disabled={busyFile !== null || Platform.OS === 'web'} style={({ pressed }) => [styles.addButton, (pressed || busyFile !== null || Platform.OS === 'web') && styles.pressed]}>
          <Text style={styles.addText}>{busyFile ?? 'Add encrypted file'}</Text>
        </Pressable>
        <Text style={styles.limit}>{Platform.OS === 'web' ? 'Encrypted upload and export are supported in the native iOS and Android apps only.' : `Encrypted mobile uploads currently support files up to ${formatBytes(MAX_ENCRYPTED_FILE_BYTES)}.`}</Text>
      </View>
      <View style={styles.folderActions}>
        {currentPath ? <Pressable accessibilityRole="button" onPress={() => {
          const parent = parentVaultPath(currentPath);
          if (parent !== null) openFolder(parent);
        }} style={styles.secondaryButton}><Text style={styles.secondaryText}>Back</Text></Pressable> : null}
        <Pressable accessibilityRole="button" onPress={() => setShowFolderInput((visible) => !visible)} disabled={busyFile !== null} style={styles.secondaryButton}>
          <Text style={styles.secondaryText}>{showFolderInput ? 'Cancel' : 'New folder'}</Text>
        </Pressable>
      </View>
      {showFolderInput ? <View style={styles.folderForm}>
        <TextInput accessibilityLabel="Folder name" autoCapitalize="sentences" autoCorrect={false} maxLength={255} placeholder="Folder name" value={folderName} onChangeText={setFolderName} style={styles.folderInput} editable={busyFile === null} />
        <Pressable accessibilityRole="button" onPress={() => void createFolder()} disabled={busyFile !== null || folderName.trim().length === 0} style={({ pressed }) => [styles.createButton, (pressed || busyFile !== null || folderName.trim().length === 0) && styles.pressed]}>
          <Text style={styles.addText}>{busyFile === 'Creating folder…' ? busyFile : 'Create'}</Text>
        </Pressable>
      </View> : null}
      {loading && !directory ? <StateMessage title="Loading your files" busy /> : null}
      {error ? <StateMessage title="Files could not load" detail={error} /> : null}
      {directory && directory.folders.length === 0 && directory.files.length === 0 ? <StateMessage title={currentPath ? 'This folder is empty' : 'Your Vault is empty'} detail="Add encrypted files from an iOS or Android app, or add files from a connected computer." /> : null}
      {directory?.folders.map((folder) => <Card key={`folder-${folder.id}`}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open folder ${folder.name}`} onPress={() => openFolder(folder.path)} style={styles.folderRow}>
          <View style={styles.copy}><Text numberOfLines={1} style={styles.name}>📁 {folder.name}</Text><Text style={styles.path}>{folder.bytes > 0 ? formatBytes(folder.bytes) : 'Folder'}</Text></View>
          <Text style={styles.folderChevron}>›</Text>
        </Pressable>
      </Card>)}
      {directory?.files.map((file) => <Card key={file.id}>
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
  breadcrumbs: { alignItems: 'center', gap: 8, paddingVertical: 2 },
  crumbWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  crumb: { color: palette.muted, fontSize: 13, fontWeight: '600' },
  activeCrumb: { color: palette.ink },
  crumbSeparator: { color: palette.muted, fontSize: 18 },
  folderActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  secondaryButton: { minHeight: 40, borderWidth: 1, borderColor: palette.line, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  secondaryText: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  folderForm: { flexDirection: 'row', gap: 8 },
  folderInput: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: palette.line, borderRadius: 12, paddingHorizontal: 14, color: palette.ink },
  createButton: { minHeight: 48, minWidth: 88, borderRadius: 12, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  folderRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  folderChevron: { color: palette.muted, fontSize: 24 },
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
