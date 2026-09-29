import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";

/**
 * Short-lived authorisation to move one object to or from one device.
 *
 * Architecture §81: a node must not expose an unrestricted file server. The
 * control plane signs a grant naming exactly one object, one device, one
 * operation and an expiry; the agent verifies it against the control plane's
 * public key, which it received at enrollment.
 *
 * This replaces the agent's earlier per-process shared secret. That token
 * authorised *everything* on the device for as long as the process lived, so a
 * single leak exposed the whole store. A grant leaks one object for a few
 * minutes.
 *
 * Deliberately not a JWT: the format is fixed, so there is no algorithm field
 * for an attacker to negotiate down and no library surface beyond Ed25519.
 */

export const GRANT_VERSION = 2;

export type TransferOperation = "put" | "get" | "delete";
export type TransferEncryption = "none" | "benzene-encrypted-object-v1";

interface TransferGrantBase {
  /** SHA-256 of the object's bytes, lowercase hex. */
  objectHash: string;
  deviceId: string;
  /** Unix seconds. */
  exp: number;
}

export type TransferGrantInput = TransferGrantBase & (
  | { op: "put"; size: number; encryption: TransferEncryption }
  | { op: "get"; encryption: TransferEncryption }
  | { op: "delete" }
);
export type TransferGrantPayload = { v: 2 } & TransferGrantInput;

export interface TransferSigningKeys {
  /** Base64 PKCS8 DER. Held only by the control plane. */
  privateKey: string;
  /** Base64 SPKI DER. Handed to agents at enrollment. */
  publicKey: string;
}

export function generateTransferSigningKeys(): TransferSigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Derives the public half, so only the private key needs configuring. */
export function publicKeyFor(privateKeyB64: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Transfer signing key must be an Ed25519 private key");
  }
  return createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encodes and signs a grant.
 *
 * The signature covers the exact encoded payload rather than a re-serialised
 * object, so the verifier never has to reproduce this function's JSON key
 * ordering to check it.
 */
export function issueTransferGrant(
  privateKeyB64: string,
  payload: TransferGrantInput
): string {
  const full = { v: GRANT_VERSION, ...payload };
  const encoded = base64url(Buffer.from(JSON.stringify(full), "utf8"));

  const signature = cryptoSign(null, Buffer.from(encoded, "utf8"), {
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });

  return `${encoded}.${base64url(signature)}`;
}
