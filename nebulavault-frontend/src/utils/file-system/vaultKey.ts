import { importRecoveryKit } from "./encryptedObject";

const unlockedKeys = new Map<string, Uint8Array>();

/** Web keys stay in page memory only; a reload requires importing the recovery kit again. */
export function loadUnlockedVaultKey(vaultId: string): Uint8Array | null {
  return unlockedKeys.get(vaultId) ?? null;
}

export async function unlockVaultWithRecoveryKit(
  vaultId: string,
  serializedKit: string,
  passphrase: string,
): Promise<void> {
  const imported = await importRecoveryKit(serializedKit, vaultId, passphrase);
  const current = unlockedKeys.get(vaultId);
  if (current) {
    const matches = current.every((byte, index) => byte === imported[index]);
    imported.fill(0);
    if (!matches) throw new Error("A different key is already unlocked for this Vault in this tab.");
    return;
  }
  unlockedKeys.set(vaultId, imported);
}

export function lockVault(vaultId: string): void {
  unlockedKeys.get(vaultId)?.fill(0);
  unlockedKeys.delete(vaultId);
}
