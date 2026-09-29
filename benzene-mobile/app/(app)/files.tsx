import { useCallback } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { isRecord } from '../../src/api/client';
import { formatBytes, isVaultFile } from '../../src/api/models';
import { Card, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useRemote } from '../../src/components/useRemote';
import { palette, type } from '../../src/theme';

export default function FilesScreen() {
  const select = useCallback((payload: unknown) => {
    if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.files)) return null;
    if (!payload.data.files.every(isVaultFile)) return null;
    return payload.data.files;
  }, []);
  const { data, loading, error, reload } = useRemote('/files?path=', select);
  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void reload()} tintColor={palette.ink} />}>
      <Wordmark />
      <PageTitle title="Files" detail="Files in the root of your Vault." />
      {loading && !data ? <StateMessage title="Loading your files" busy /> : null}
      {error ? <StateMessage title="Files could not load" detail={error} /> : null}
      {data?.length === 0 ? <StateMessage title="Your Vault is empty" detail="Files will appear here after you add them from a connected computer. Uploading from this app is not available yet." /> : null}
      {data?.map((file) => <Card key={file.id}>
        <View style={styles.row}><View style={styles.copy}><Text numberOfLines={1} style={styles.name}>{file.name}</Text><Text numberOfLines={1} style={styles.path}>{file.path || 'Vault'}</Text></View><Text style={styles.size}>{formatBytes(file.bytes)}</Text></View>
        {!file.hasContent ? <Text style={styles.pending}>Upload still in progress</Text> : null}
        {file.hasContent ? <>
          <Text style={file.protection?.availability === 'unavailable' ? styles.warning : styles.path}>
            {availabilityLabel(file.protection?.availability)}
          </Text>
          {reducedProtectionLabel(file.protection) ? <Text style={styles.warning}>{reducedProtectionLabel(file.protection)}</Text> : null}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  copy: { flex: 1, gap: 4 },
  name: { color: palette.ink, ...type.section },
  path: { color: palette.muted, ...type.small },
  size: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  pending: { color: palette.muted, fontSize: 12, marginTop: 5 },
  warning: { color: palette.danger, ...type.small },
});
