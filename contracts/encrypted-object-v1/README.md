# Benzene encrypted object contract, version 1

This is an executable cryptographic format foundation. The control plane has
an additive metadata and placement boundary, and the native mobile client has
local encryption/decryption and VMK/recovery-kit primitives that pass the
shared vectors. No shipped upload/download journey uses them end to end. This
is not evidence that encryption is live or that Benzene is ready for real user
data.

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

The VMK is an input to this primitive, not a password-derived key. The mobile
foundation generates a random 32-byte VMK, persists it in device-only OS secure
storage, and can export/import a passphrase-encrypted recovery-kit JSON format.
The server must not hold a plaintext VMK. A password reset alone therefore
cannot recover Vault contents. Trusted-device enrollment/rotation/revocation,
recovery-kit user screens and key backup policy are not implemented. The
recovery-kit passphrase can be guessed offline if the kit is stolen and the
passphrase is weak; losing both the kit and every key-holding device means
permanent data loss. These foundations still need product/security review
before callers persist encrypted data.

This format buffers complete files in memory and does not support streaming or
chunk manifests. The compact JSON metadata contains no file bytes; the raw
ciphertext is returned separately for data-plane storage and transfer. There
is no maximum object-size guard or streaming implementation, so this code is
only a cryptographic foundation for small test vectors and must not be used
for production-sized files.
Existing stored objects are plaintext-era data; no migration, mixed-version read policy,
re-encryption, or reference-safe old-object cleanup is implemented. The
visible SHA-256 object ID also preserves a deduplication equality leak. These
are explicit blockers, not properties solved by this primitive.

## Control-plane boundary

The authenticated control-plane API accepts this descriptor at
`POST /files/uploads/device/v1/encrypted`, accepts possession at
`POST /files/uploads/device/v1/encrypted/complete`, and returns the committed
current descriptor at `GET /files/{nodeId}/encrypted-object`. Requests contain
metadata only; extra ciphertext fields are rejected. Ciphertext must be PUT
directly to a device using the returned placement targets.

For encrypted v1 versions, Mongo stores the compact metadata, `bytes` records
the plaintext size for the file listing, and `storageBytes` records the
ciphertext size (plaintext size plus the 16-byte GCM tag). The existing
PostgreSQL `objectHash` names remain for compatibility, but they identify
physical bytes: their value is `storageHash` for encrypted objects and the
legacy SHA-256 of stored plaintext bytes for plaintext-era objects. Placement,
replica confirmation, repair, reads, rebalancing and garbage collection all use
that physical hash. `objectId` is never used as a replica address.

The control plane checks the metadata shape, Vault ID and size relationship. It
does not prove that the metadata decrypts to `objectId`; that proof belongs to
a client holding the VMK. A signed possession report proves only that a device
stores bytes matching `storageHash`. Existing web and node clients still use
the plaintext upload flow. The mobile crypto module has deterministic vector
coverage, but mobile upload/download, recovery-kit screens, trusted-device
recovery, old plaintext migration and end-to-end security testing remain
unimplemented.

`vectors.json` is a deterministic conformance fixture. Its fixed keys/nonces
are public test data and must never be used for real objects. Node's WebCrypto
implementation and the Expo mobile implementation both pass the same vector.
Any other client must match the bytes, strings, AAD, HKDF parameters, nonce and
tag semantics before exchanging objects.
