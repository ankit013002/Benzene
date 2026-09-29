import { useCallback } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { isRecord } from '../../src/api/client';
import { isVaultSummary, formatBytes } from '../../src/api/models';
import { Card, Label, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useRemote } from '../../src/components/useRemote';
import { palette, type } from '../../src/theme';

export default function VaultScreen() {
  const select = useCallback((payload: unknown) => {
    if (!isRecord(payload) || !isVaultSummary(payload.data)) return null;
    return payload.data;
  }, []);
  const { data, loading, error, reload } = useRemote('/vaults/me', select);
  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void reload()} tintColor={palette.ink} />}>
      <Wordmark subtitle="One drive. Every computer." />
      <PageTitle title={data?.name ?? 'Your Vault'} detail="Your storage, gathered in one place." />
      {loading && !data ? <StateMessage title="Connecting to your Vault" detail="This may take a moment." busy /> : null}
      {error ? <StateMessage title="Your Vault could not load" detail={error} /> : null}
      {data ? <>
        <Card style={styles.capacity}>
          <Label>Storage used</Label>
          <Text style={styles.bigNumber}>{formatBytes(data.usedBytes)}</Text>
          <Text style={styles.secondary}>{formatBytes(data.rawCapacityBytes)} contributed across your devices</Text>
          <View style={styles.rule} />
          <View style={styles.row}><Text style={styles.metricLabel}>Available devices</Text><Text style={styles.metricValue}>{data.onlineDeviceCount} of {data.deviceCount}</Text></View>
          <View style={styles.row}><Text style={styles.metricLabel}>Online capacity</Text><Text style={styles.metricValue}>{formatBytes(data.onlineCapacityBytes)}</Text></View>
        </Card>
        <Card>
          <Label>Built for your devices</Label>
          <Text style={styles.section}>Files stay on devices you trust.</Text>
          <Text style={styles.secondary}>Benzene places and protects files across your connected computers. A computer must be online to serve its files.</Text>
        </Card>
      </> : null}
      {!loading && !error && !data ? <StateMessage title="No Vault summary yet" detail="Your account does not have a Vault summary." /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  capacity: { paddingVertical: 23 },
  bigNumber: { color: palette.ink, fontSize: 36, fontWeight: '700', letterSpacing: -1.2, marginTop: 4 },
  secondary: { color: palette.muted, ...type.body },
  section: { color: palette.ink, ...type.section },
  rule: { height: 1, backgroundColor: palette.line, marginVertical: 7 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  metricLabel: { color: palette.muted, ...type.body },
  metricValue: { color: palette.ink, fontSize: 14, fontWeight: '600' },
});
