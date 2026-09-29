import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import { createVaultKeyStore } from './vaultKeysCore';

const secureStore = createVaultKeyStore({
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
}, getRandomBytesAsync);

/** Gets or creates a random VMK, held only in this device's OS secure storage. */
export const getOrCreateVaultMasterKey = secureStore.getOrCreateVaultMasterKey;
/** Reads an existing key without silently creating one. */
export const loadVaultMasterKey = secureStore.loadVaultMasterKey;
/** Restores the exact VMK from an imported recovery kit on this device. */
export const importVaultMasterKey = secureStore.importVaultMasterKey;
export const deleteVaultMasterKey = secureStore.deleteVaultMasterKey;
