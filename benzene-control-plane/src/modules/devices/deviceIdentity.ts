import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

/**
 * Device identity.
 *
 * Each device generates an Ed25519 keypair during enrollment and keeps the
 * private half in platform-secure storage. The control plane only ever stores
 * the public key, so it can authenticate a device but never impersonate one —
 * and a control-plane database leak does not hand an attacker the ability to
 * act as somebody's computer.
 */

export interface DeviceKeyPair {
  /** Base64 SPKI DER — the form stored in `devices.public_key`. */
  publicKey: string;
  /** Base64 PKCS8 DER. Never sent to the control plane. */
  privateKey: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** Rejects anything that is not a well-formed Ed25519 SPKI public key. */
export function isValidPublicKey(publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * The exact bytes a device signs.
 *
 * Method, path and body are all covered so a captured signature cannot be
 * replayed against a different endpoint or with altered content. The timestamp
 * bounds how long a captured signature stays usable at all.
 */
export function canonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}): string {
  const bodyHash = createHash("sha256").update(input.body ?? "").digest("hex");
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    bodyHash,
  ].join("\n");
}

export function signRequest(privateKeyB64: string, message: string): string {
  const privateKey = {
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der" as const,
    type: "pkcs8" as const,
  };
  return cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
}

export function verifyRequestSignature(input: {
  publicKey: string;
  signature: string;
  message: string;
}): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(input.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(input.message, "utf8"),
      publicKey,
      Buffer.from(input.signature, "base64")
    );
  } catch {
    // A malformed key or signature is a failed verification, not a crash.
    return false;
  }
}

/**
 * Pairing code shown to the user.
 *
 * Deliberately excludes 0/O/1/I/L so a code read off one screen and typed into
 * another is not ambiguous. 8 characters over a 32-symbol alphabet is ~40 bits,
 * and codes expire in minutes and are single-use.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePairingCode(randomBytes: Buffer): string {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    const byte = randomBytes[i] ?? 0;
    out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Canonical form used for indexed pairing-code lookups. */
export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Constant-time comparison for user-supplied pairing codes. */
export function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(normalizePairingCode(a), "utf8");
  const right = Buffer.from(normalizePairingCode(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
