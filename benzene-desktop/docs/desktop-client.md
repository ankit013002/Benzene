# Benzene desktop client

This package builds an installable Electron client for macOS, Windows, and Linux. The client opens the configured Benzene web app and starts the existing node agent as a separate operating-system process. The agent persists its identity and object store under `~/.benzene`; it continues running after the desktop window closes and is reused when the desktop app starts again.

## Local development

Prerequisites: Node.js 20 or newer, and the local Benzene services described in the repository guide.

```sh
cd benzene-desktop
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The first launch asks for the Vault app origin, gateway origin, storage allocation in whole GB, and a computer name. For a local development stack, the default origins are `http://localhost:3000` and `http://localhost:8080`. For a different deployment, enter that deployment's HTTPS origins. The computer must be able to reach the configured gateway and transfer peers.

The app starts the independent agent, then opens the Devices page. The short-lived enrollment code is shown when the agent prints it; it can also be retrieved from the Benzene menu. Approve the code through the signed-in Devices page. Device approval remains user controlled.

Build an unsigned local installer on its target platform with `npm run dist`. It is for development only.

## Manual installer candidate workflow

`.github/workflows/desktop-release.yml` packages a macOS DMG or Windows NSIS candidate when manually dispatched from `master`. It uses the protected GitHub environment `desktop-production` and uploads a short-lived Actions artifact; it does not create a GitHub release or publish an installer. The validated `DESKTOP_APP_URL` and `DESKTOP_GATEWAY_URL` are embedded as first-launch defaults. Normal pull request CI never receives signing credentials.

Before enabling that environment, configure these environment variables:

- `DESKTOP_APP_URL` and `DESKTOP_GATEWAY_URL`: the intended public HTTPS service origins.
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`: Apple Developer signing/notarization account identifiers.

Configure these environment secrets:

- `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD`: a Developer ID Application certificate in a format accepted by electron-builder and its password.
- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`: a Windows code-signing certificate in a format accepted by electron-builder and its password.
- `APPLE_API_KEY_P8`: the App Store Connect private key. The workflow writes it to a temporary runner file with owner-only permissions and removes that file after packaging.

The release preflight rejects missing signing inputs and obvious local or placeholder service origins before packaging. It checks the package identity and installer targets too. After packaging, the workflow requires macOS code-signature verification, a Gatekeeper assessment, and a stapled notarization ticket, or a valid Windows Authenticode signature, before it uploads an artifact. A passing workflow is evidence that those runner checks succeeded for that artifact; certificate ownership, clean-machine installation, update behavior, and production approval still need separate review. Installer candidates are not published releases.

## Scope and limits

- The desktop UI reuses the configured web experience; it does not yet provide native file browsing or a mounted Finder/Explorer location.
- The agent and desktop window have separate lifecycles. The UI can close and reopen while storage participation continues. Stop the background agent through the operating system's process manager in this initial package.
- The agent uses the repository's existing transfer behavior and defaults. The web client currently supports development-LAN direct transfers; production remote transfer, a complete encryption and recovery lifecycle, signed installers, and a release acceptance are not supplied by this package.
- Use only a development Vault until the repository's documented production blockers and data-protection decisions are resolved.

This is an installable desktop MVP slice, not a claim that Benzene is production-ready or complete.
