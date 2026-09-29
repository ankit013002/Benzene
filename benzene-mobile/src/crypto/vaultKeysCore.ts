import { encodeBase64Url, decodeBase64Url } from './bytes';

const VMK_BYTES = 32;
const KEY_PREFIX = 'benzene.vmk.v1.';
const RECOVERY_ACK_PREFIX = 'benzene.vmk.recovery-ack.v1.';

export interface SecureKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export type VaultKeyStore = {
  getOrCreateVaultMasterKey(vaultId: string): Promise<Uint8Array>;
  loadVaultMasterKey(vaultId: string): Promise<Uint8Array | null>;
  importVaultMasterKey(vaultId: string, vmk: Uint8Array): Promise<void>;
  deleteVaultMasterKey(vaultId: string): Promise<void>;
  recoveryAcknowledged(vaultId: string): Promise<boolean>;
  markRecoveryAcknowledged(vaultId: string): Promise<void>;
};

function validateVaultId(vaultId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(vaultId)) throw new TypeError('vaultId must be 1–128 ASCII letters, digits, _ or -');
}

function keyName(vaultId: string): string {
  validateVaultId(vaultId);
  return `${KEY_PREFIX}${vaultId}`;
}

function validateVmk(vmk: Uint8Array): void {
  if (!(vmk instanceof Uint8Array) || vmk.byteLength !== VMK_BYTES) throw new TypeError('Vault Master Key must be exactly 32 bytes');
}

/** Creates the Vault key lifecycle around an OS-backed secure key-value store. */
export function createVaultKeyStore(storage: SecureKeyValueStore, randomBytes: (length: number) => Promise<Uint8Array>): VaultKeyStore {
  const locks = new Map<string, Promise<void>>();

  async function withVaultLock<T>(vaultId: string, action: () => Promise<T>): Promise<T> {
    const name = keyName(vaultId);
    const previous = locks.get(name) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    locks.set(name, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(name) === current) locks.delete(name);
    }
  }

  async function readVmk(vaultId: string): Promise<Uint8Array | null> {
    const stored = await storage.getItem(keyName(vaultId));
    if (stored === null) return null;
    try {
      const vmk = decodeBase64Url(stored, 'stored Vault Master Key');
      validateVmk(vmk);
      return vmk;
    } catch {
      // A damaged key cannot justify a prior recovery confirmation. Preserve it
      // until the user explicitly imports a valid recovery kit.
      await storage.deleteItem(`${RECOVERY_ACK_PREFIX}${vaultId}`);
      throw new Error('The saved Vault key is damaged. Restore it from your recovery kit before continuing.');
    }
  }

  async function writeVmk(vaultId: string, vmk: Uint8Array): Promise<void> {
    validateVmk(vmk);
    await storage.setItem(keyName(vaultId), encodeBase64Url(vmk));
  }

  async function storeNewVmk(vaultId: string, vmk: Uint8Array): Promise<void> {
    await writeVmk(vaultId, vmk);
    // A prior confirmation may belong to a key that was removed or replaced.
    await storage.deleteItem(`${RECOVERY_ACK_PREFIX}${vaultId}`);
  }

  return {
    getOrCreateVaultMasterKey(vaultId) {
      return withVaultLock(vaultId, async () => {
        const existing = await readVmk(vaultId);
        if (existing) return existing;
        const generated = await randomBytes(VMK_BYTES);
        validateVmk(generated);
        await storeNewVmk(vaultId, generated);
        return generated;
      });
    },
    loadVaultMasterKey(vaultId) {
      return withVaultLock(vaultId, () => readVmk(vaultId));
    },
    importVaultMasterKey(vaultId, vmk) {
      validateVmk(vmk);
      return withVaultLock(vaultId, () => storeNewVmk(vaultId, vmk));
    },
    deleteVaultMasterKey(vaultId) {
      return withVaultLock(vaultId, async () => {
        await storage.deleteItem(keyName(vaultId));
        await storage.deleteItem(`${RECOVERY_ACK_PREFIX}${vaultId}`);
      });
    },
    async recoveryAcknowledged(vaultId) {
      validateVaultId(vaultId);
      return (await storage.getItem(`${RECOVERY_ACK_PREFIX}${vaultId}`)) === 'confirmed';
    },
    async markRecoveryAcknowledged(vaultId) {
      validateVaultId(vaultId);
      await storage.setItem(`${RECOVERY_ACK_PREFIX}${vaultId}`, 'confirmed');
    },
  };
}
