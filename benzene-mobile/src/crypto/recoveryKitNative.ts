import { getRandomBytesAsync } from 'expo-crypto';
import { exportRecoveryKitWithRandomValues, importRecoveryKit } from './recoveryKit';

/** Creates a randomly salted, passphrase-encrypted kit for user-controlled export. */
export function exportVaultRecoveryKit(vaultId: string, vmk: Uint8Array, passphrase: string): Promise<string> {
  return exportRecoveryKitWithRandomValues(vaultId, vmk, passphrase, getRandomBytesAsync);
}

/** Decrypts a recovery-kit string. The caller must immediately store the returned key in SecureStore. */
export { importRecoveryKit };
