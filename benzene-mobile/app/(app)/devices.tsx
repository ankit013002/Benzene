import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { isRecord } from '../../src/api/client';
import { approveDeviceEnrollment, allocationBytesFromGb, validatePairingCode } from '../../src/api/deviceEnrollment';
import { formatBytes, isDeviceSummary } from '../../src/api/models';
import { ActionButton } from '../../src/components/ActionButton';
import { Body, Card, PageTitle, Screen, StateMessage, Wordmark } from '../../src/components/Screen';
import { useRemote } from '../../src/components/useRemote';
import { useAuth } from '../../src/session/AuthContext';
import { palette, type } from '../../src/theme';

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function DevicesScreen() {
  const [code, setCode] = useState('');
  const [allocationGb, setAllocationGb] = useState('100');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingNotice, setPairingNotice] = useState<string | null>(null);
  const { request } = useAuth();
  const select = useCallback((payload: unknown) => {
    if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.every(isDeviceSummary)) return null;
    return payload.data;
  }, []);
  const { data, loading, error, reload } = useRemote('/devices', select);

  async function addDevice() {
    setPairingError(null);
    setPairingNotice(null);
    let normalizedCode: string;
    try {
      normalizedCode = validatePairingCode(code);
      allocationBytesFromGb(allocationGb);
    } catch (cause) {
      setPairingError(cause instanceof Error ? cause.message : 'Check the pairing code and storage amount.');
      return;
    }
    setCode('');
    setPairingBusy(true);
    try {
      const device = await approveDeviceEnrollment(normalizedCode, allocationGb, request);
      setPairingNotice(`${device.name} was added to your Vault.`);
      await reload();
    } catch (cause) {
      setPairingError(cause instanceof Error ? cause.message : 'Benzene could not add that device. Try again.');
    } finally {
      setPairingBusy(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void reload()} tintColor={palette.ink} />}>
      <Wordmark />
      <PageTitle title="Devices" detail="Computers that contribute space to your Vault." />
      <Card>
        <Text style={styles.sectionTitle}>Add a computer</Text>
        <Body>Enter the short-lived pairing code shown in the Benzene agent on that computer. Codes are used once and expire after a short time.</Body>
        <Text style={styles.label}>Pairing code</Text>
        <TextInput
          value={code}
          onChangeText={(value) => { setCode(value.toUpperCase()); setPairingError(null); setPairingNotice(null); }}
          placeholder="ABCD-EFGH"
          placeholderTextColor={palette.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={9}
          returnKeyType="done"
          onSubmitEditing={() => void addDevice()}
          accessibilityLabel="Computer pairing code"
          accessibilityHint="Enter the current code displayed by the computer agent."
          style={[styles.input, styles.codeInput]}
        />
        <Text style={styles.label}>Storage to contribute (GB)</Text>
        <TextInput
          value={allocationGb}
          onChangeText={(value) => { setAllocationGb(value); setPairingError(null); }}
          placeholder="100"
          placeholderTextColor={palette.muted}
          keyboardType="decimal-pad"
          accessibilityLabel="Storage to contribute in gigabytes"
          style={styles.input}
        />
        {pairingError ? <Text accessibilityRole="alert" style={styles.error}>{pairingError}</Text> : null}
        {pairingNotice ? <Text accessibilityRole="text" style={styles.notice}>{pairingNotice}</Text> : null}
        <ActionButton title="Add to Vault" onPress={() => void addDevice()} busy={pairingBusy} disabled={!code.trim() || !allocationGb.trim()} />
      </Card>
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
  sectionTitle: { color: palette.ink, ...type.section },
  label: { color: palette.ink, fontSize: 13, fontWeight: '600', marginTop: 3 },
  input: { minHeight: 52, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card, borderRadius: 14, paddingHorizontal: 14, color: palette.ink, fontSize: 16 },
  codeInput: { fontFamily: 'monospace', letterSpacing: 2 },
  error: { color: palette.danger, ...type.small },
  notice: { color: palette.success, ...type.small },
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
