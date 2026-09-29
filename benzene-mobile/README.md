# Benzene Mobile

Native iOS and Android client built with Expo SDK 57, React Native and Expo
Router. This is a native app, not a WebView. The current mobile scope is account
sign-in, Vault summary, file and device lists, configured legal/support links,
encrypted file upload/download, local Vault-key management, and local session
storage. Pairing devices and account signup/verification/recovery still need
additional client work.

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
uses `com.example.*`. The production profile increments the local iOS build
number and Android version code. Its generated iOS transport policy rejects
arbitrary cleartext traffic while permitting local-network connections for
device transfers. Android excludes legacy shared-storage, overlay and
vibration permissions; file selection uses the system document picker. The
app does not request Face ID access. These are config-level safeguards, not a
review of the final signed native binaries.

Run `npm run check:store-config` to resolve the production Expo native config
with fixture identifiers and URLs and verify the identifier guards, transport
policy, permission list and EAS build-number settings. The fixture values only
exercise validation; the publisher must provide real owned identifiers and
service URLs for an actual build. The default icons are scaffold assets and
need Benzene-owned artwork before review.

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

The native Files screen picks one local file, encrypts it, reserves compact
metadata with the authenticated control plane, PUTs ciphertext to each granted
reachable device, and completes only after a device confirms possession. A
download obtains the current compact metadata and physical read plan, tries
holders in turn, checks the ciphertext hash and GCM authentication locally, and
opens the iOS/Android share sheet for the decrypted cache copy. Only metadata
and short-lived API calls use the bearer session; transfer requests send only
the scoped device grant and ciphertext. The mobile whole-file limit is 25 MiB.
Uploads require a local VMK and a user-confirmed recovery kit. Existing
unencrypted files are not decrypted by this path. There is no trusted-device
recovery or key rotation workflow. The format buffers each whole file in memory. The
installed Noble packages are from an independently audited project; the public
upstream audit report covers an earlier release, so it does not certify these
exact pinned versions or Benzene's integration. This code needs mobile platform
review and representative-file testing before production use. JavaScript memory
is managed by the runtime, so clearing temporary byte arrays is best effort and
cannot guarantee that every copy of a key has been erased from process memory.
Native transfer uses HTTPS targets. Development builds can explicitly permit
HTTP only for private/local-network device addresses with
`EXPO_PUBLIC_ALLOW_INSECURE_LAN_TRANSFERS=true`; this does not provide remote
access, NAT traversal or a relay. The web export still builds, but encrypted
picker/transfer/export flows are disabled there; no browser CORS/mixed-content
or transfer journey has been verified.

## Configuration ownership

`EXPO_PUBLIC_GATEWAY_ORIGIN`, `EXPO_PUBLIC_PRIVACY_POLICY_URL`,
`EXPO_PUBLIC_TERMS_OF_SERVICE_URL` and `EXPO_PUBLIC_SUPPORT_URL` are public
runtime configuration, not secrets. The app bundle identifiers are placeholders
until the publisher chooses identifiers. EAS project IDs, signing credentials,
production URLs, legal/support URLs, and store account credentials are
deliberately unset.
