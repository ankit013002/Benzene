import assert from "node:assert/strict";
import { test } from "node:test";
import { exportRecoveryKitWithRandomValues } from "./encryptedObject";
import {
  acknowledgeRecoveryKitSaved,
  createVaultRecoveryKit,
  isVaultKeyPersisted,
  isVaultRecoveryAcknowledged,
  loadUnlockedVaultKey,
  lockVault,
  unlockVaultWithRecoveryKit,
} from "./vaultKey";

const vaultId = "desktop-onboarding-vault";
const passphrase = "correct horse battery staple";
const otherPassphrase = "another correct horse phrase";
const originalWindow = globalThis.window;
const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function setDesktopBridge(load: () => Promise<string | null>, save: (keyHex: string) => Promise<boolean>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { benzeneDesktop: { loadVaultKey: async () => load(), saveVaultKey: async (_vault: string, key: string) => save(key) } },
  });
}

function clearVaultState(): void {
  lockVault(vaultId);
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
}

test("browser creation keeps the key in memory until the user acknowledges the downloaded kit", async () => {
  try {
    Reflect.deleteProperty(globalThis, "window");
    const kit = await createVaultRecoveryKit(vaultId, passphrase);
    const key = await loadUnlockedVaultKey(vaultId);
    assert.ok(key);
    assert.equal(isVaultKeyPersisted(vaultId), false);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), false);
    assert.equal(await acknowledgeRecoveryKitSaved(vaultId), false);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), true);

    // An exported kit re-imports the same key and does not write browser storage.
    lockVault(vaultId);
    assert.equal(await loadUnlockedVaultKey(vaultId), null);
    const persisted = await unlockVaultWithRecoveryKit(vaultId, kit, passphrase);
    assert.equal(persisted, false);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), true);
  } finally {
    clearVaultState();
  }
});

test("verifying the exact recovery kit consumes its pending proof", async () => {
  try {
    Reflect.deleteProperty(globalThis, "window");
    const kit = await createVaultRecoveryKit(vaultId, passphrase);

    assert.equal(await unlockVaultWithRecoveryKit(vaultId, kit, passphrase), false);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), true);
    await assert.rejects(acknowledgeRecoveryKitSaved(vaultId), /recovery kit no longer matches/);
  } finally {
    clearVaultState();
  }
});

test("mismatched recovery verification leaves the pending proof available", async () => {
  try {
    Reflect.deleteProperty(globalThis, "window");
    const pendingKit = await createVaultRecoveryKit(vaultId, passphrase);
    const differentKit = await exportRecoveryKitWithRandomValues(
      vaultId,
      new Uint8Array(32).fill(9),
      otherPassphrase,
      (length) => new Uint8Array(length).fill(4),
    );

    await assert.rejects(unlockVaultWithRecoveryKit(vaultId, differentKit, otherPassphrase), /different key is already unlocked/);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), false);
    assert.equal(await acknowledgeRecoveryKitSaved(vaultId), false);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), true);
    assert.equal(await unlockVaultWithRecoveryKit(vaultId, pendingKit, passphrase), false);
  } finally {
    clearVaultState();
  }
});

test("failed desktop persistence keeps the pending recovery proof for retry", async () => {
  const retryVaultId = "desktop-recovery-retry-vault";
  try {
    let stored: string | null = null;
    let canSave = false;
    setDesktopBridge(async () => stored, async (keyHex) => {
      if (!canSave) return false;
      stored = keyHex;
      return true;
    });
    const kit = await createVaultRecoveryKit(retryVaultId, passphrase);

    await assert.rejects(unlockVaultWithRecoveryKit(retryVaultId, kit, passphrase), /could not save/);
    assert.equal(isVaultRecoveryAcknowledged(retryVaultId), false);
    canSave = true;
    assert.equal(await acknowledgeRecoveryKitSaved(retryVaultId), true);
    assert.equal(isVaultRecoveryAcknowledged(retryVaultId), true);
  } finally {
    lockVault(retryVaultId);
    clearVaultState();
  }
});

test("desktop creation persists only after confirmation and restored keys remain acknowledged after reload", async () => {
  try {
    let stored: string | null = null;
    setDesktopBridge(async () => stored, async (keyHex) => {
      stored = keyHex;
      return true;
    });
    const kit = await createVaultRecoveryKit(vaultId, passphrase);
    assert.equal(stored, null);
    const exportedKey = await importKeyFromKit(kit, passphrase);
    assert.equal(isVaultKeyPersisted(vaultId), false);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), false);
    assert.equal(await acknowledgeRecoveryKitSaved(vaultId), true);
    assert.equal(stored, toHex(exportedKey));
    assert.equal(isVaultKeyPersisted(vaultId), true);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), true);

    lockVault(vaultId);
    const restored = await loadUnlockedVaultKey(vaultId);
    assert.equal(toHex(restored as Uint8Array), stored);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), true);
  } finally {
    clearVaultState();
  }
});

test("desktop creation never replaces a different key already in memory or OS storage", async () => {
  try {
    Reflect.deleteProperty(globalThis, "window");
    const inMemoryKey = new Uint8Array(32).fill(7);
    const kit = await exportRecoveryKitWithRandomValues(vaultId, inMemoryKey, otherPassphrase, (length) => new Uint8Array(length).fill(3));
    await unlockVaultWithRecoveryKit(vaultId, kit, otherPassphrase);
    const currentHex = toHex(inMemoryKey);
    const osHex = "09".repeat(32);
    const stored = osHex;
    setDesktopBridge(async () => stored, async (keyHex) => {
      if (keyHex !== stored) throw new Error("A different key is already saved for this Vault. Key replacement is disabled.");
      return true;
    });
    await createVaultRecoveryKit(vaultId, passphrase);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), false);
    await assert.rejects(acknowledgeRecoveryKitSaved(vaultId), /different key is already saved/);
    assert.equal(isVaultRecoveryAcknowledged(vaultId), false);
    assert.equal(stored, osHex);
    assert.equal(toHex((await loadUnlockedVaultKey(vaultId)) as Uint8Array), currentHex);
  } finally {
    clearVaultState();
  }
});

test("desktop confirmation fails closed when OS secure storage is unavailable", async () => {
  const unavailableVaultId = "desktop-storage-unavailable";
  try {
    setDesktopBridge(async () => null, async () => false);
    await createVaultRecoveryKit(unavailableVaultId, passphrase);
    assert.equal(isVaultRecoveryAcknowledged(unavailableVaultId), false);
    await assert.rejects(acknowledgeRecoveryKitSaved(unavailableVaultId), /Recovery is not confirmed/);
    assert.equal(isVaultKeyPersisted(unavailableVaultId), false);
    assert.equal(isVaultRecoveryAcknowledged(unavailableVaultId), false);
  } finally {
    lockVault(unavailableVaultId);
    clearVaultState();
  }
});

test("corrupt or ambiguous desktop key state blocks creation", async () => {
  try {
    setDesktopBridge(async () => { throw new Error("Saved Vault key record is corrupt."); }, async () => {
      assert.fail("must not write over unreadable stored state");
    });
    await assert.rejects(createVaultRecoveryKit(vaultId, passphrase), /corrupt/);
    await assert.rejects(loadUnlockedVaultKey(vaultId), /corrupt/);
  } finally {
    clearVaultState();
  }
});

async function importKeyFromKit(kit: string, phrase: string): Promise<Uint8Array> {
  const { importRecoveryKit } = await import("./encryptedObject");
  return importRecoveryKit(kit, vaultId, phrase);
}
