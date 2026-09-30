import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const RECEIPT_DOMAIN = "benzene-account-deletion-receipt:v1";
const RECEIPT_BYTES = 32;

function signingKey(): Buffer {
  const raw = process.env.AUTH_SECRET?.trim();
  if (!raw || raw.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  return /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "utf8");
}

/**
 * The request UUID and credential UUID are persisted before use and remain
 * stable across request retries. The domain-separated HMAC lets the API return
 * the same opaque receipt after a lost response without storing its plaintext.
 */
export function deriveAccountDeletionReceipt(
  requestId: string,
  credentialId: string,
): string {
  return createHmac("sha256", signingKey())
    .update(`${RECEIPT_DOMAIN}\0${requestId}\0${credentialId}`, "utf8")
    .digest("base64url");
}

export function hashAccountDeletionReceipt(receipt: string): Buffer {
  const bytes = Buffer.from(receipt, "base64url");
  if (
    bytes.length !== RECEIPT_BYTES ||
    bytes.toString("base64url") !== receipt
  ) {
    throw new Error("Invalid account deletion receipt format");
  }
  return createHash("sha256").update(bytes).digest();
}

export function accountDeletionReceiptMatches(
  receipt: string,
  expectedHash: Buffer,
): boolean {
  let candidateHash: Buffer;
  try {
    candidateHash = hashAccountDeletionReceipt(receipt);
  } catch {
    // Keep malformed values on the same fixed-size comparison path.
    candidateHash = createHash("sha256").update(Buffer.alloc(RECEIPT_BYTES)).digest();
  }
  return expectedHash.length === candidateHash.length && timingSafeEqual(candidateHash, expectedHash);
}
