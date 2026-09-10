import { Agent, AGENT_VERSION } from "./agent.js";
import { loadAgentConfig } from "./config.js";
import { ObjectStore } from "./store.js";
import { createTransferServer } from "./transferServer.js";

/**
 * Entry point for the Benzene node agent.
 *
 * Runs three things: an identity, a heartbeat, and a transfer server. It is
 * deliberately a separate process from any UI, so restarting the app does not
 * interrupt storage (architecture §65).
 */
async function main(): Promise<void> {
  const config = loadAgentConfig();

  const store = new ObjectStore({
    rootDir: config.storageDir,
    allocatedBytes: config.allocatedBytes,
  });

  const agent = new Agent(config, store, {
    onEnrollmentPending: ({ code, expiresAt }) => {
      console.log("");
      console.log("  This device is waiting to join a vault.");
      console.log(`  Approve it with the code:  ${code}`);
      console.log(`  The code expires at ${new Date(expiresAt).toLocaleTimeString()}.`);
      console.log("");
    },
    onEnrolled: (deviceId) => {
      console.log(`[agent] enrolled as device ${deviceId}`);
    },
    onError: (err) => {
      console.error("[agent] background error:", err);
    },
  });

  await agent.initialise();
  console.log(`[agent] benzene node agent ${AGENT_VERSION}`);
  console.log(`[agent] storage: ${config.storageDir}`);
  console.log(
    `[agent] contributing ${config.allocatedBytes} bytes, ${store.usedBytes()} used`
  );

  /**
   * The transfer server can only run once enrolled: it needs this device's id
   * and the control plane's public key to verify grants. Serving before then
   * would mean serving with nothing to check against.
   */
  let server: ReturnType<ReturnType<typeof createTransferServer>["listen"]> | undefined;

  const startTransferServer = (): void => {
    if (server) return;
    const identity = agent.currentIdentity();
    if (!identity?.deviceId || !identity.controlPlanePublicKey) return;

    server = createTransferServer({
      store,
      deviceId: identity.deviceId,
      controlPlanePublicKey: identity.controlPlanePublicKey,
      reportPossession: ({ objectHash, sizeBytes }) =>
        agent.reportPossession(objectHash, sizeBytes),
    }).listen(config.port, () => {
      console.log(`[agent] transfer server listening on ${config.advertisedUrl}`);
    });
  };

  const { enrolled } = await agent.ensureEnrolled();
  if (!enrolled) {
    // Poll until the user approves; the code is already on screen.
    const poll = setInterval(() => {
      void agent
        .pollEnrollment()
        .then((done) => {
          if (done) {
            clearInterval(poll);
            agent.startHeartbeat();
            startTransferServer();
          }
        })
        .catch((err: unknown) => console.error("[agent] enrollment check failed:", err));
    }, 5_000);
    poll.unref?.();
  } else {
    agent.startHeartbeat();
    startTransferServer();
  }

  const shutdown = (signal: string): void => {
    console.log(`[agent] ${signal} received, shutting down`);
    agent.stopHeartbeat();
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[agent] failed to start:", err);
  process.exit(1);
});
