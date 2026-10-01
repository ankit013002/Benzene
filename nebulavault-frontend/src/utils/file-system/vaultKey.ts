import { exportRecoveryKit, importRecoveryKit } from "./encryptedObject";

const unlockedKeys = new Map<string, Uint8Array>();
const pendingLoads = new Map<string, Promise<Uint8Array | null>>();
const persistedVaultKeys = new Set<string>();
const acknowledgedVaultKeys = new Set<string>();
const pendingRecoveryKeys = new Map<string, Uint8Array>();
const vaultOperations = new Map<string, Promise<void>>();

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
    // A desktop key reaches safeStorage only through recovery-kit import or
    // the explicit confirmation step after export.
    acknowledgedVaultKeys.add(vaultId);
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
  return withVaultOperation(vaultId, async () => {
    const imported = await importRecoveryKit(serializedKit, vaultId, passphrase);
    const current = unlockedKeys.get(vaultId);
    if (current) {
      const matches = current.every((byte, index) => byte === imported[index]);
      imported.fill(0);
      if (!matches) throw new Error("A different key is already unlocked for this Vault in this tab.");
      const persisted = await persistDesktopKey(vaultId, current);
      if (hasDesktopKeyBridge() && !persisted) {
        throw new Error("This desktop could not save the Vault key in operating-system secure storage.");
      }
      if (persisted) persistedVaultKeys.add(vaultId);
      else persistedVaultKeys.delete(vaultId);
      acknowledgedVaultKeys.add(vaultId);
      return persisted;
    }
    try {
      const persisted = await persistDesktopKey(vaultId, imported);
      if (hasDesktopKeyBridge() && !persisted) {
        throw new Error("This desktop could not save the Vault key in operating-system secure storage.");
      }
      unlockedKeys.set(vaultId, imported);
      if (persisted) persistedVaultKeys.add(vaultId);
      else persistedVaultKeys.delete(vaultId);
      acknowledgedVaultKeys.add(vaultId);
      return persisted;
    } catch (cause) {
      imported.fill(0);
      throw cause;
    }
  });
}

/** Exports a kit for the current Vault key or creates one without replacing any existing key. */
export async function createVaultRecoveryKit(vaultId: string, passphrase: string): Promise<string> {
  return withVaultOperation(vaultId, async () => {
    let vmk = await loadUnlockedVaultKey(vaultId);
    let generated = false;
    if (!vmk) {
      vmk = crypto.getRandomValues(new Uint8Array(32));
      generated = true;
    }
    try {
      // Keep a new key only in memory until the user confirms saving the kit.
      // If PBKDF2/AES-GCM or the download step fails, OS storage stays untouched.
      const kit = await exportRecoveryKit(vaultId, vmk, passphrase);
      if (!unlockedKeys.has(vaultId)) unlockedKeys.set(vaultId, vmk);
      acknowledgedVaultKeys.delete(vaultId);
      pendingRecoveryKeys.get(vaultId)?.fill(0);
      pendingRecoveryKeys.set(vaultId, vmk.slice());
      return kit;
    } catch (cause) {
      if (generated) vmk.fill(0);
      throw cause;
    }
  });
}

/** Requires a deliberate user confirmation after the kit download is initiated. */
export async function acknowledgeRecoveryKitSaved(vaultId: string): Promise<boolean> {
  return withVaultOperation(vaultId, async () => {
    const expected = pendingRecoveryKeys.get(vaultId);
    const current = await loadUnlockedVaultKey(vaultId);
    if (!expected || !current || expected.some((byte, index) => byte !== current[index])) {
      throw new Error("The recovery kit no longer matches this Vault key. Export the kit again before confirming.");
    }
    const persisted = await persistDesktopKey(vaultId, current);
    if (hasDesktopKeyBridge() && !persisted) {
      throw new Error("This desktop could not save the Vault key in operating-system secure storage. Recovery is not confirmed.");
    }
    if (persisted) persistedVaultKeys.add(vaultId);
    pendingRecoveryKeys.delete(vaultId);
    expected.fill(0);
    acknowledgedVaultKeys.add(vaultId);
    return persisted;
  });
}

export function isVaultRecoveryAcknowledged(vaultId: string): boolean {
  return acknowledgedVaultKeys.has(vaultId);
}

async function withVaultOperation<T>(vaultId: string, action: () => Promise<T>): Promise<T> {
  const previous = vaultOperations.get(vaultId) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  vaultOperations.set(vaultId, queued);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (vaultOperations.get(vaultId) === queued) vaultOperations.delete(vaultId);
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
  pendingRecoveryKeys.get(vaultId)?.fill(0);
  pendingRecoveryKeys.delete(vaultId);
  acknowledgedVaultKeys.delete(vaultId);
}
