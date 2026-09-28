export interface EncryptedObjectMetadataV1 {
  format: 'benzene-encrypted-object';
  version: 1;
  payloadAlgorithm: 'AES-256-GCM';
  keyWrapAlgorithm: 'HKDF-SHA-256+AES-256-GCM';
  vaultId: string;
  objectId: string;
  storageHash: string;
  plaintextSize: number;
  payloadNonce: string;
  wrappedKeyNonce: string;
  wrappedKeyCiphertext: string;
}

export declare function encryptObject(
  plaintext: Uint8Array,
  vaultMasterKey: Uint8Array,
  vaultId: string,
): Promise<{ metadata: EncryptedObjectMetadataV1; ciphertext: Uint8Array }>;

export declare function decryptObject(
  metadata: EncryptedObjectMetadataV1,
  ciphertext: Uint8Array,
  vaultMasterKey: Uint8Array,
): Promise<Uint8Array>;
