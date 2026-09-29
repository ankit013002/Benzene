import { getRandomBytesAsync } from 'expo-crypto';
import { decryptObject, encryptObject as encryptWithRandomSource, type EncryptedObject, type EncryptedObjectMetadata } from './encryptedObjectCore';

export type { EncryptedObject, EncryptedObjectMetadata };

/** Encrypts in memory; callers upload ciphertext directly to storage devices and metadata to the control plane. */
export function encryptObject(plaintext: Uint8Array, vaultMasterKey: Uint8Array, vaultId: string): Promise<EncryptedObject> {
  return encryptWithRandomSource(plaintext, vaultMasterKey, vaultId, getRandomBytesAsync);
}

/** Decrypts only after authenticating the metadata, ciphertext hash, and GCM tags. */
export { decryptObject };
