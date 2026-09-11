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

  let server: ReturnType<ReturnType<typeof createTransferServer>["listen"]> | undefined;

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
    onRemovalStart: () =>
      new Promise<void>((resolve, reject) => {
        const activeServer = server;
        if (!activeServer) {
          resolve();
          return;
        }
        server = undefined;
        // close() stops new connections and waits for active HTTP requests to
        // finish, so no stale write can arrive between quiesce and erase.
        activeServer.close((err) => (err ? reject(err) : resolve()));
      }),
    onRemoved: () => {
      // No new grants are issued after removal, but closing the listener also
      // prevents a short-lived stale grant from writing into the emptied store.
      if (server) {
        server.close();
        server = undefined;
      }
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
  const startTransferServer = (): void => {
    if (server) return;
    const identity = agent.currentIdentity();
    if (
      !identity?.deviceId ||
      !identity.controlPlanePublicKey ||
      !agent.canServeTransfers()
    ) return;

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
  const startEnrolledAgent = async (): Promise<void> => {
    // Resolve a persisted drain/erase state before opening the listener after
    // a restart; an in-flight erase must never be exposed to stale grants.
    await agent.pollRemoval();
    agent.startHeartbeat();
    startTransferServer();
  };

  if (!enrolled) {
    // Poll until the user approves; the code is already on screen.
    const poll = setInterval(() => {
      void agent
        .pollEnrollment()
        .then((done) => {
          if (done) {
            clearInterval(poll);
            void startEnrolledAgent().catch((err: unknown) =>
              console.error("[agent] removal check failed:", err)
            );
          }
        })
        .catch((err: unknown) => console.error("[agent] enrollment check failed:", err));
    }, 5_000);
    poll.unref?.();
  } else {
    await startEnrolledAgent();
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
