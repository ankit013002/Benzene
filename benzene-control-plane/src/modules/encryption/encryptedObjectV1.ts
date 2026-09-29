import { z } from "zod";

const canonicalBase64Url = (encodedLength: number, decodedLength: number) =>
  z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{${encodedLength}}$`))
    .refine(
      (value) => {
        const decoded = Buffer.from(value, "base64url");
        return decoded.length === decodedLength && decoded.toString("base64url") === value;
      },
      { message: "must be canonical unpadded base64url" }
    );

/** The control plane stores this compact descriptor, never its ciphertext. */
export const encryptedObjectV1MetadataSchema = z
  .object({
    format: z.literal("benzene-encrypted-object"),
    version: z.literal(1),
    payloadAlgorithm: z.literal("AES-256-GCM"),
    keyWrapAlgorithm: z.literal("HKDF-SHA-256+AES-256-GCM"),
    vaultId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    objectId: z.string().regex(/^[a-f0-9]{64}$/),
    storageHash: z.string().regex(/^[a-f0-9]{64}$/),
    plaintextSize: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 16),
    payloadNonce: canonicalBase64Url(16, 12),
    wrappedKeyNonce: canonicalBase64Url(16, 12),
    wrappedKeyCiphertext: canonicalBase64Url(64, 48),
  })
  .strict();

export type EncryptedObjectV1Metadata = z.infer<typeof encryptedObjectV1MetadataSchema>;

export const ENCRYPTED_OBJECT_V1_TAG_BYTES = 16;

/** WebCrypto AES-GCM appends a 16-byte authentication tag to each ciphertext. */
export function encryptedObjectStorageBytes(metadata: EncryptedObjectV1Metadata): number {
  const size = metadata.plaintextSize + ENCRYPTED_OBJECT_V1_TAG_BYTES;
  if (!Number.isSafeInteger(size)) throw new TypeError("Encrypted object is too large");
  return size;
}
