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

Build a platform installer on that platform with `npm run dist`. Cross-platform signing and notarization credentials are not included.

## Scope and limits

- The desktop UI reuses the configured web experience; it does not yet provide native file browsing or a mounted Finder/Explorer location.
- The agent and desktop window have separate lifecycles. The UI can close and reopen while storage participation continues. Stop the background agent through the operating system's process manager in this initial package.
- The agent uses the repository's existing transfer behavior and defaults. The web client currently supports development-LAN direct transfers; production remote transfer, a complete encryption and recovery lifecycle, signed installers, and a release acceptance are not supplied by this package.
- Use only a development Vault until the repository's documented production blockers and data-protection decisions are resolved.

This is an installable desktop MVP slice, not a claim that Benzene is production-ready or complete.
