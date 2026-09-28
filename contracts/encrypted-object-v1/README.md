# Benzene encrypted object contract, version 1

This is an executable cryptographic format foundation. It is deliberately not
connected to upload, repair, download, or garbage collection paths yet.

## Format

`benzene-encrypted-object` version 1 encrypts one complete file in memory. The
caller supplies a random 32-byte Vault Master Key (VMK); Benzene services must
never receive or persist it. The implementation creates a fresh random
32-byte Object Data Key (ODK), encrypts the plaintext with AES-256-GCM, and
wraps the ODK with an AES-256-GCM key derived from the VMK using HKDF-SHA-256.

`encryptObject` returns two separate values: compact `metadata` and raw
`ciphertext` bytes. The metadata is UTF-8 JSON with these exact fields:

```json
{
  "format": "benzene-encrypted-object",
  "version": 1,
  "payloadAlgorithm": "AES-256-GCM",
  "keyWrapAlgorithm": "HKDF-SHA-256+AES-256-GCM",
  "vaultId": "opaque-id",
  "objectId": "64 lowercase hex characters",
  "storageHash": "64 lowercase hex characters",
  "plaintextSize": 123,
  "payloadNonce": "base64url without padding",
  "wrappedKeyNonce": "base64url without padding",
  "wrappedKeyCiphertext": "base64url without padding, including 16-byte GCM tag"
}
```

The matching `ciphertext` value is a `Uint8Array` containing only AES-GCM
payload ciphertext followed by its 16-byte tag. It is not embedded in or
base64-encoded into metadata. Persist only the `metadata` value on the control
plane; do not JSON-serialize the combined return value. `decryptObject(metadata,
ciphertext, vmk)` takes the two values separately.

`objectId` is SHA-256 of the plaintext and remains the logical content identity.
`storageHash` is SHA-256 of the raw `ciphertext` bytes, which are the exact
bytes stored and transferred as the data-plane object. Existing agents
that name and verify objects by SHA-256 of stored bytes must use `storageHash`,
never `objectId`. Since encryption uses a fresh ODK and nonce, encrypting the
same plaintext twice preserves `objectId` but produces different ciphertext bytes
and therefore different `storageHash` values. The current system has no rule
for deduplicating those independent ciphertexts; callers must not treat
`objectId` as a physical replica address. `storageHash` does not include the
metadata or wrapped-key bytes. The compact metadata must be persisted with the
logical file version and supplied to decryptors. Only this compact metadata
belongs on the control plane; raw ciphertext bytes belong exclusively on the
data plane and must travel directly between the client and storage node (or
approved relay).

`objectId` is visible in this version and reveals equality for identical
plaintext within and across Vaults. The 12-byte payload nonce and 12-byte key
wrap nonce are independently generated with the platform CSPRNG for every
object. The GCM tag is the final 16 bytes returned by WebCrypto AES-GCM.

The payload additional authenticated data is the UTF-8 encoding of exactly:

```text
benzene/encrypted-object/v1\n{vaultId}\n{objectId}\n{plaintextSize}
```

In these templates, each `\n` escape is one LF byte (`0x0a`), not two literal
characters and not a platform-specific line ending.

The key-wrap HKDF salt is UTF-8 `benzene/v1/vault/{vaultId}` and its info is
UTF-8 `benzene/v1/object-key-wrap/{objectId}`. HKDF produces a 256-bit AES-GCM
wrapping key. The wrapping additional authenticated data is UTF-8:

```text
benzene/object-key-wrap/v1\n{vaultId}\n{objectId}
```

IDs are restricted to ASCII letters, digits, `_` and `-` (1–128 characters)
so the newline-delimited AAD has one unambiguous encoding. Decryption validates
the compact metadata and separate ciphertext, derives the same wrapping key, authenticates/unpacks the
ODK, verifies ciphertext `storageHash`, authenticates/decrypts the payload,
then checks both the exact byte length and SHA-256 object ID. The ciphertext
must be exactly `plaintextSize + 16` bytes before decryption. Wrong keys,
modified fields, malformed encodings and truncation fail closed.

## Key lifecycle and scope

The VMK is an input to this primitive, not a password-derived key. The intended
product direction is a privacy-first recovery kit plus trusted-device recovery:
the recovery kit and trusted devices may hold VMK-encrypted material; the
server must not hold a plaintext VMK. A password reset alone therefore cannot
recover Vault contents. This repo contract does not yet implement VMK creation,
recovery-kit encoding, trusted-device enrollment/rotation/revocation, or key
backup. Those flows require their own review and tests before callers persist
encrypted data.

This format buffers complete files in memory and does not support streaming or
chunk manifests. The compact JSON metadata contains no file bytes; the raw
ciphertext is returned separately for data-plane storage and transfer. There
is no maximum object-size guard or streaming implementation, so this code is
only a cryptographic foundation for small test vectors and must not be used
for production-sized files. It has not been integrated into live paths.
Existing stored objects are plaintext-era data; no migration, mixed-version read policy,
re-encryption, or reference-safe old-object cleanup is implemented. The
visible SHA-256 object ID also preserves a deduplication equality leak. These
are explicit blockers, not properties solved by this primitive.

`vectors.json` is a deterministic conformance fixture. Its fixed keys/nonces
are public test data and must never be used for real objects. Node's WebCrypto
implementation is executable here; React Native clients must implement the
same bytes, strings, AAD, HKDF parameters, nonce and tag semantics and pass the
same vector before they exchange objects.
