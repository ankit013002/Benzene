# Benzene Mobile

Native iOS and Android client built with Expo SDK 57, React Native and Expo
Router. This is a native app, not a WebView. The current mobile scope is account
sign-in, native account signup, email-verification resend and confirmation,
password reset, Vault summary, file and device lists, device pairing by entering
the short-lived code shown by a computer agent, configured legal/support links,
encrypted file upload/download, local Vault-key management, and local session
storage. Mobile approves only the code the signed-in user enters; it does not
enumerate pending enrollments.

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
policy, permission list and EAS build-number settings. `npm run check:store-build`
is the live release gate: it requires publisher-owned iOS/Android identifiers,
the linked EAS project UUID, public HTTPS service/legal URLs, and a production
EAS profile configured for store distribution. Create or link the EAS project
with `eas init`, then set its ID as `EAS_PROJECT_ID` in local and EAS production
build environments. `EAS_OWNER` is optional; EAS Build uses the linked project
UUID to identify the project.

The native config includes the app-level iOS required-reason API entries used
by the file picker/cache flow and React Native runtime: file metadata in the
app container and user-selected files (`C617.1`, `3B52.1`), runtime timers
(`35F9.1`), and app-private user defaults (`CA92.1`). Expo's own privacy
manifests remain part of the native dependency build; the app manifest does not
copy the SDK-only `0A2A.1` reason. Android's resolved permission list is pinned
to `INTERNET`; document selection uses the system picker, and legacy storage,
overlay, and vibration permissions remain blocked. See [Expo's privacy manifest
guide](https://docs.expo.dev/guides/apple-privacy/), [Apple's required-reason
API list](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype),
and [Android's Storage Access Framework guide](https://developer.android.com/training/data-storage/shared/documents-files).
The app-level manifest intentionally makes no collected-data or tracking
declarations; the publisher must complete the App Store Connect privacy and
Google Play Data safety forms from the final service/data-flow inventory.

Before upload, configure `submit.production.ios` in `eas.json` with the numeric
App Store Connect app ID, API key ID/issuer ID and a path to the publisher's
`.p8` key. Configure `submit.production.android` with the Play track and path to
the publisher's service-account JSON. Keep credential files outside source
control. `npm run check:store-submit` validates the non-secret IDs, platform ID
matches and credential file paths; it checks that files exist without reading
or printing their contents. EAS and the store owners must still verify account
access, signing certificates, provisioning, Play Console access, and app-record
readiness. Fixture values in `check:store-config` only exercise config safety;
they cannot pass the live release gate. The app icon is a Benzene-owned, static rendering
of the same outer ring, hexagon and aromatic circle used by the web wordmark. Its
iOS image is opaque; Android's foreground and monochrome layers use transparent
backgrounds and keep the full mark within the adaptive-icon safe area. Regenerate
all three PNGs on macOS with `swift assets/images/generate-icons.swift assets/images`.

## Native authentication contract

The app calls the gateway's `/auth/native/signup`, `/auth/native/login`,
`/auth/native/resend-verification`, `/auth/native/refresh` and
`/auth/native/logout` endpoints with `X-Benzene-Client-Kind: native-mobile`.
Login and refresh must return short-lived access tokens plus one-use rotating
refresh tokens in JSON. Protected API requests use `Authorization: Bearer`.
The app stores the opaque token pair in iOS Keychain / Android Keystore through
`expo-secure-store`; it never extracts the web-only HttpOnly cookies.

The native API depends on the matching backend contract and gateway routing
being deployed. Signup does not issue or persist an unverified session. The app
keeps signup and resend passwords only in screen memory, and clears reset tokens
and new passwords after a successful reset. Verification email links currently
open the configured web app; the user returns to mobile and confirms completion
manually. Reset tokens can be pasted into the app from the reset URL. Native
app/universal links are not configured, so verification and reset links do not
yet reopen the app automatically. The in-app account-deletion screen can record
a password-verified request and check its phase using a private receipt retained
in device-only SecureStore. The receipt is removed when the service reports
completion. The service revokes refresh credentials, but an already-issued
access token can remain valid for up to 15 minutes. Cleanup can remain pending
until every configured phase, including device acknowledgements, completes.
Store review still requires a validated production deletion flow and the
publisher's real privacy, terms and support destinations.

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

## Relay receive foundation

Encrypted downloads remain direct-device-first. Once every direct target has
failed, the Files screen makes one authenticated `POST /placement/relay-read`
with the file node ID and a fresh UUID request ID. The API adapter accepts only
the explicit `kind: "relay_fallback"` response and maps its
`relayUrl/sessionId/ticket/storageHash/ciphertextBytes/expiresAt` fields into the
bounded receiver. The request ID is carried unchanged through authenticated
session refresh/retry, and the response must still match the metadata hash and
ciphertext length fetched for the selected file. No node ticket is accepted by
or exposed from this adapter.

The consumer follows the current relay protocol: it sends the signed client
ticket in the authenticate control frame, requires `paired`, accepts binary
frames only, and succeeds only after close code 1000 with reason
`transfer_complete`, the exact signed byte count, and a matching SHA-256
`storageHash`. It accepts only a `wss://` relay address and locally checks that
the ticket scope says client/get and matches the normalized fallback's session,
hash, byte count and expiration; the relay remains responsible for signature
verification and one-use ticket claiming. Its receive buffer is exactly the expected
ciphertext size and cannot exceed the existing 25 MiB plaintext mobile limit
plus the AES-GCM tag. The bytes then pass through the same encrypted-object
metadata, hash and AES-GCM authentication before plaintext export. The injected
WebSocket factory enables deterministic transport tests; it is not a live relay
or remote-network acceptance test.

The mobile API mapping now matches the control-plane response contract, but
this is not yet a verified end-to-end path: deployment must configure a public
WSS relay URL, signing key and matching node-agent relay settings; the running
control plane, node, relay and mobile app have not been exercised together.
There is no real node/mobile local protocol integration test. The deterministic
tests cover request serialization, safe error mapping, ticket scope matching,
bounded binary transport, timeout/close behavior and encrypted-object
authentication before export. Relay is never selected as the default byte path.

## Configuration ownership

`EXPO_PUBLIC_GATEWAY_ORIGIN`, `EXPO_PUBLIC_PRIVACY_POLICY_URL`,
`EXPO_PUBLIC_TERMS_OF_SERVICE_URL`, `EXPO_PUBLIC_SUPPORT_URL` and
`EXPO_PUBLIC_ACCOUNT_DELETION_URL` are public runtime configuration, not
secrets. Set the deletion URL to the published public HTTPS
`/account-deletion` information page; production Expo config and store preflight
reject missing, local, placeholder or non-HTTPS values. The app bundle
identifiers are placeholders until the publisher chooses identifiers. EAS
project IDs, signing credentials, production URLs, legal/support URLs, App Store
Connect IDs and Google Play credentials are deliberately unset. The live store
checks fail until the publisher provides these values.
