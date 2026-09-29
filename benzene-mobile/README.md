# Benzene Mobile

Native iOS and Android client built with Expo SDK 57, React Native and Expo
Router. This is a native app, not a WebView. The current mobile scope is account
sign-in, Vault summary, file and device lists, configured legal/support links,
and local session storage. Uploading/downloading files and pairing devices need
additional client and server work.

## Local setup

Requires Node.js 22.13 or newer. Copy `.env.example` to `.env.local` and set
`EXPO_PUBLIC_GATEWAY_ORIGIN` to a reachable HTTPS gateway. For development on
one computer, Expo can use a localhost origin over HTTP in development. A
physical phone needs a reachable HTTPS gateway. Do not use HTTP for production.

```sh
npm ci
npm run start
npm run typecheck
npm run lint
npm test
npm run export:web
```

The lockfile overrides two transitive packages with patched releases while
keeping Expo SDK 57 in place: Expo Router's `query-string` is pinned to 9.5.1,
and a small checked-in patch adapts the router's CommonJS imports to that
package's default export. The Expo iOS project parser uses `uuid` 11.1.1.
Focused tests cover real router path parsing/stringifying and Xcode project UUID
generation.
The full mobile dependency audit currently reports zero vulnerabilities; when
upstream Expo dependencies update, recheck these overrides before removing them.

Expo Application Services profiles are in `eas.json`. Native store builds
require the team's Apple/Google accounts, certificates, provisioning data and
store metadata; none are included here. Set `IOS_BUNDLE_IDENTIFIER` and
`ANDROID_APPLICATION_ID` to identifiers owned by the publisher before creating
production builds. Production EAS builds fail if either ID is absent or still
uses `com.example.*`. The default icons are scaffold assets
and also need Benzene-owned artwork before review.

## Native authentication contract

The app calls the gateway's `/auth/native/login`, `/auth/native/refresh` and
`/auth/native/logout` endpoints with `X-Benzene-Client-Kind: native-mobile`.
Login and refresh must return short-lived access tokens plus one-use rotating
refresh tokens in JSON. Protected API requests use `Authorization: Bearer`.
The app stores the opaque token pair in iOS Keychain / Android Keystore through
`expo-secure-store`; it never extracts the web-only HttpOnly cookies.

The native API depends on the matching backend contract and gateway Bearer
verification being deployed. Email-verification completion, password recovery
and signup are not yet implemented in this client. The in-app account-deletion
screen can record a password-verified request and check its phase. The service
revokes refresh credentials, but an already-issued access token can remain valid
for up to 15 minutes. Account/Vault cleanup is still pending for an operator;
this is not completed erasure. Store review must wait until a complete deletion
path and the publisher's real privacy, terms and support destinations are
available.

## Local key and encrypted-object foundation

The app includes the shared `benzene-encrypted-object` v1 format. It uses
Noble AES-256-GCM, HKDF-SHA-256 and SHA-256 primitives, and Expo's native
cryptographic random source. The mobile implementation produces the exact
bytes in `contracts/encrypted-object-v1/vectors.json`. Raw ciphertext and
compact metadata are distinct values; the caller must send ciphertext directly
to a storage device and send only metadata to the control plane.

`getOrCreateVaultMasterKey(vaultId)` creates a random 32-byte Vault Master Key
and stores it through Expo SecureStore with device-only, unlocked access.
`exportVaultRecoveryKit` creates a portable JSON kit encrypted under a
passphrase with PBKDF2-HMAC-SHA-256 (600,000 iterations) and AES-256-GCM.
`importRecoveryKit` authenticates and returns the original VMK, which the caller
must then write to SecureStore with `importVaultMasterKey`. The kit is a bearer
secret: keep it offline, use a unique high-entropy passphrase, and do not send
it to Benzene. A short or reused passphrase can be guessed offline if the kit
is stolen. Losing both the kit and every device holding the VMK permanently
loses access to encrypted files. Resetting the account password does not restore
or change the VMK.

These are cryptographic and local-key foundations, not an end-to-end encrypted
Vault journey. The mobile upload/download UI does not yet use them, no recovery
kit save/share/import screens exist, and there is no trusted-device recovery or
key rotation workflow. The format buffers each whole file in memory. The
installed Noble packages are from an independently audited project; the public
upstream audit report covers an earlier release, so it does not certify these
exact pinned versions or Benzene's integration. This code needs mobile platform
review and representative-file testing before production use. JavaScript memory
is managed by the runtime, so clearing temporary byte arrays is best effort and
cannot guarantee that every copy of a key has been erased from process memory.

## Configuration ownership

`EXPO_PUBLIC_GATEWAY_ORIGIN`, `EXPO_PUBLIC_PRIVACY_POLICY_URL`,
`EXPO_PUBLIC_TERMS_OF_SERVICE_URL` and `EXPO_PUBLIC_SUPPORT_URL` are public
runtime configuration, not secrets. The app bundle identifiers are placeholders
until the publisher chooses identifiers. EAS project IDs, signing credentials,
production URLs, legal/support URLs, and store account credentials are
deliberately unset.
