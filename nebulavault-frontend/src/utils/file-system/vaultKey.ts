import { importRecoveryKit } from "./encryptedObject";

const unlockedKeys = new Map<string, Uint8Array>();
const pendingLoads = new Map<string, Promise<Uint8Array | null>>();
const persistedVaultKeys = new Set<string>();

declare global {
  interface Window {
    benzeneDesktop?: {
      loadVaultKey(vaultId: string): Promise<string | null>;
      saveVaultKey(vaultId: string, keyHex: string): Promise<boolean>;
    };
  }
}

/** Browsers keep keys in page memory; the desktop app may restore from OS-encrypted storage. */
export async function loadUnlockedVaultKey(vaultId: string): Promise<Uint8Array | null> {
  const current = unlockedKeys.get(vaultId);
  if (current) return current;
  if (typeof window === "undefined" || !window.benzeneDesktop) return null;
  const pending = pendingLoads.get(vaultId);
  if (pending) return pending;

  const request = window.benzeneDesktop.loadVaultKey(vaultId).then((keyHex) => {
    if (keyHex === null) return null;
    if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("The saved Vault key has an invalid format.");
    const restored = Uint8Array.from(keyHex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    const raced = unlockedKeys.get(vaultId);
    if (raced) {
      const matches = raced.every((byte, index) => byte === restored[index]);
      restored.fill(0);
      if (!matches) throw new Error("A different key is already unlocked for this Vault in this tab.");
      return raced;
    }
    unlockedKeys.set(vaultId, restored);
    persistedVaultKeys.add(vaultId);
    return restored;
  }).finally(() => pendingLoads.delete(vaultId));
  pendingLoads.set(vaultId, request);
  return request;
}

export async function unlockVaultWithRecoveryKit(
  vaultId: string,
  serializedKit: string,
  passphrase: string,
): Promise<boolean> {
  const imported = await importRecoveryKit(serializedKit, vaultId, passphrase);
  const current = unlockedKeys.get(vaultId);
  if (current) {
    const matches = current.every((byte, index) => byte === imported[index]);
    imported.fill(0);
    if (!matches) throw new Error("A different key is already unlocked for this Vault in this tab.");
    const persisted = await persistDesktopKey(vaultId, current);
    if (persisted) persistedVaultKeys.add(vaultId);
    else persistedVaultKeys.delete(vaultId);
    return persisted;
  }
  try {
    const persisted = await persistDesktopKey(vaultId, imported);
    unlockedKeys.set(vaultId, imported);
    if (persisted) persistedVaultKeys.add(vaultId);
    else persistedVaultKeys.delete(vaultId);
    return persisted;
  } catch (cause) {
    imported.fill(0);
    throw cause;
  }
}

async function persistDesktopKey(vaultId: string, key: Uint8Array): Promise<boolean> {
  if (typeof window === "undefined" || !window.benzeneDesktop) return false;
  const keyHex = [...key].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return window.benzeneDesktop.saveVaultKey(vaultId, keyHex);
}

export function hasDesktopKeyBridge(): boolean {
  return typeof window !== "undefined" && window.benzeneDesktop !== undefined;
}

export function isVaultKeyPersisted(vaultId: string): boolean {
  return persistedVaultKeys.has(vaultId);
}

export function lockVault(vaultId: string): void {
  unlockedKeys.get(vaultId)?.fill(0);
  unlockedKeys.delete(vaultId);
}
