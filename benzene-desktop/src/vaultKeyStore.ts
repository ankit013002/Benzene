import { createHash } from "node:crypto";

export interface SafeStorageStatus {
  available: boolean;
  backend?: string;
}

export class CorruptStoredVaultKeyError extends Error {
  constructor() {
    super("Saved Vault key record is corrupt.");
  }
}

export class VaultKeyScopeMismatchError extends Error {
  constructor() {
    super("Saved Vault key belongs to a different app origin or Vault.");
  }
}

export async function saveVaultKeySafely(
  keyHexInput: unknown,
  operations: {
    load(): Promise<string | null>;
    writeNew(): Promise<void>;
    replaceCorrupt(): Promise<void>;
  },
): Promise<"saved" | "unchanged" | "repaired"> {
  const keyHex = validateVaultKeyHex(keyHexInput);
  let existing: string | null;
  try {
    existing = await operations.load();
  } catch (cause) {
    if (!(cause instanceof CorruptStoredVaultKeyError)) throw cause;
    await operations.replaceCorrupt();
    return "repaired";
  }
  if (existing !== null) {
    if (existing !== keyHex) throw new Error("A different key is already saved for this Vault. Key replacement is disabled.");
    return "unchanged";
  }
  await operations.writeNew();
  return "saved";
}

export function validateVaultKeyOrigin(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Vault app origin is invalid.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Vault app origin is invalid.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Vault app origin is invalid.");
  }
  return url.origin;
}

export function validateVaultKeyHex(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError("Vault key must contain exactly 32 bytes.");
  }
  return value.toLowerCase();
}

export function validateVaultId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Vault identifier is invalid.");
  }
  return value;
}

export function encryptedKeyFilename(appOrigin: string, vaultId: string): string {
  const origin = validateVaultKeyOrigin(appOrigin);
  const id = validateVaultId(vaultId);
  return `${createHash("sha256").update(`${origin}\n${id}`, "utf8").digest("hex")}.key`;
}

export function serializeVaultKey(appOrigin: string, vaultId: string, keyHex: string): string {
  return JSON.stringify({
    format: "benzene-desktop-vault-key",
    version: 1,
    appOrigin: validateVaultKeyOrigin(appOrigin),
    vaultId: validateVaultId(vaultId),
    keyHex: validateVaultKeyHex(keyHex),
  });
}

export function parseVaultKey(serialized: string, expectedOrigin: string, expectedVaultId: string): string {
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object") throw new TypeError("Stored Vault key is invalid.");
  const record = parsed as Record<string, unknown>;
  if (record.format !== "benzene-desktop-vault-key" || record.version !== 1) throw new TypeError("Stored Vault key format is unsupported.");
  if (record.appOrigin !== validateVaultKeyOrigin(expectedOrigin) || record.vaultId !== validateVaultId(expectedVaultId)) {
    throw new VaultKeyScopeMismatchError();
  }
  return validateVaultKeyHex(record.keyHex);
}

export function encryptVaultKeyRecord(
  appOrigin: string,
  vaultId: string,
  keyHex: string,
  encryptString: (plaintext: string) => Uint8Array,
): string {
  return Buffer.from(encryptString(serializeVaultKey(appOrigin, vaultId, keyHex))).toString("base64");
}

export function decryptVaultKeyRecord(
  encryptedBase64: string,
  appOrigin: string,
  vaultId: string,
  decryptString: (encrypted: Buffer) => string,
): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encryptedBase64)) {
    throw new TypeError("Stored Vault key is not encrypted data.");
  }
  return parseVaultKey(decryptString(Buffer.from(encryptedBase64, "base64")), appOrigin, vaultId);
}

export function canUseSafeStorage(status: SafeStorageStatus, platform: NodeJS.Platform): boolean {
  if (!status.available) return false;
  if (platform === "linux") {
    return status.backend !== undefined
      && ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(status.backend);
  }
  return platform === "darwin" || platform === "win32";
}

export function isTrustedVaultRequest(
  senderId: number,
  mainWindowId: number | undefined,
  frameUrl: string | undefined,
  isMainFrame: boolean,
  trustedOrigin: string | undefined,
): boolean {
  if (!mainWindowId || senderId !== mainWindowId || !isMainFrame || !frameUrl || !trustedOrigin) return false;
  try {
    return new URL(frameUrl).origin === new URL(trustedOrigin).origin;
  } catch {
    return false;
  }
}
