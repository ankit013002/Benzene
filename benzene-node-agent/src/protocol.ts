import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

/**
 * The signing half of the device-authentication protocol.
 *
 * The control plane holds the verifying half. The canonical string below must
 * agree with it byte for byte or every request fails authentication, so both
 * sides are pinned to the same shared test vectors (see protocol.test.ts and
 * the control plane's deviceIdentity tests). Duplicating ten lines is
 * preferable to coupling a deployable agent to the server's internals, but the
 * vectors are what actually keep them honest.
 */

export interface DeviceKeyPair {
  /** Base64 SPKI DER. Registered with the control plane. */
  publicKey: string;
  /** Base64 PKCS8 DER. Never leaves this machine. */
  privateKey: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/**
 * Method, path, timestamp and body hash, newline-joined.
 *
 * Covering all four means a captured signature cannot be replayed against a
 * different endpoint or with altered content, and the timestamp bounds how
 * long it stays usable at all.
 */
export function canonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}): string {
  const bodyHash = createHash("sha256").update(input.body ?? "").digest("hex");
  return [input.method.toUpperCase(), input.path, input.timestamp, bodyHash].join("\n");
}

export function signRequest(privateKeyB64: string, message: string): string {
  return cryptoSign(null, Buffer.from(message, "utf8"), {
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  }).toString("base64");
}

export interface SignedHeaders {
  "X-Device-Id": string;
  "X-Device-Timestamp": string;
  "X-Device-Signature": string;
}

/** Builds the headers for one authenticated call to the control plane. */
export function signedHeaders(input: {
  deviceId: string;
  privateKey: string;
  method: string;
  path: string;
  body: string;
  now?: number;
}): SignedHeaders {
  // Automatic calls retain millisecond uniqueness without a nonce or
  // process-global state. Explicit test/vector timestamps preserve the
  // established whole-second wire behavior.
  const timestamp =
    input.now === undefined
      ? String(Date.now() / 1000)
      : String(Math.floor(input.now / 1000));
  const signature = signRequest(
    input.privateKey,
    canonicalRequest({
      method: input.method,
      path: input.path,
      timestamp,
      body: input.body,
    })
  );
  return {
    "X-Device-Id": input.deviceId,
    "X-Device-Timestamp": timestamp,
    "X-Device-Signature": signature,
  };
}
