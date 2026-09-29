import { useCallback } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { isRecord } from '../../src/api/client';
import { formatBytes, isDeviceSummary } from '../../src/api/models';
import { Card, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useRemote } from '../../src/components/useRemote';
import { palette, type } from '../../src/theme';

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function DevicesScreen() {
  const select = useCallback((payload: unknown) => {
    if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.every(isDeviceSummary)) return null;
    return payload.data;
  }, []);
  const { data, loading, error, reload } = useRemote('/devices', select);
  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void reload()} tintColor={palette.ink} />}>
      <Wordmark />
      <PageTitle title="Devices" detail="Computers that contribute space to your Vault." />
      {loading && !data ? <StateMessage title="Finding your devices" busy /> : null}
      {error ? <StateMessage title="Devices could not load" detail={error} /> : null}
      {data?.length === 0 ? <StateMessage title="No devices connected" detail="Install the Benzene computer agent and pair it with your account to add storage." /> : null}
      {data?.map((device) => <Card key={device.id}>
        <View style={styles.row}><View style={styles.identity}><Text style={styles.name}>{device.name}</Text><Text style={styles.platform}>{device.platform}</Text></View><View style={styles.status}><View style={[styles.dot, device.status === 'online' ? styles.online : styles.offline]} /><Text style={styles.statusText}>{statusLabel(device.status)}</Text></View></View>
        <Text style={styles.capacity}>{formatBytes(device.usedBytes)} used · {formatBytes(device.allocatedBytes)} allocated</Text>
        {device.status === 'draining' && device.removalReady ? <Text style={styles.capacity}>Ready to be removed</Text> : null}
      </Card>)}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  identity: { gap: 4, flex: 1 },
  name: { color: palette.ink, ...type.section },
  platform: { color: palette.muted, ...type.small },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  online: { backgroundColor: palette.success },
  offline: { backgroundColor: palette.muted },
  statusText: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  capacity: { color: palette.muted, ...type.small, marginTop: 5 },
});
