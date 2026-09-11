import express, { type Express } from "express";
import helmet from "helmet";

import {
  AllocationExceededError,
  IntegrityError,
  ObjectStore,
  SizeMismatchError,
} from "./store.js";
import { verifyTransferGrant, type TransferOperation } from "./transferGrant.js";

/**
 * Serves this device's objects to peers on the local network.
 *
 * Architecture §81: a node must not expose an unrestricted file server. Every
 * request must carry a grant from the control plane naming this device, this
 * object and this operation, and expiring within minutes.
 *
 * This replaced an earlier per-process shared secret, which authorised
 * everything on the device for as long as the process lived — one leak exposed
 * the whole store. A leaked grant exposes one object for a few minutes.
 */

export interface TransferServerOptions {
  store: ObjectStore;
  /** This device's id, as assigned at enrollment. */
  deviceId: string;
  /** Control plane's Ed25519 public key, received at enrollment. */
  controlPlanePublicKey: string;
  /** Called after a successful, hash-checked PUT to promote the placement. */
  reportPossession?: (input: { objectHash: string; sizeBytes: number }) => Promise<void>;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function createTransferServer(options: TransferServerOptions): Express {
  const app = express();

  app.use(helmet());

  // Browser-to-device transfers are direct LAN requests. CORS only makes the
  // narrowly scoped transfer methods/headers usable from a web origin; every
  // object request still requires a grant checked below. Override Helmet's
  // same-origin CORP because a cross-origin response is intentional here.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-Transfer-Grant, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, X-Object-Encryption");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "benzene-node-agent",
      usedBytes: options.store.usedBytes(),
      availableBytes: options.store.availableBytes(),
    });
  });

  /** Object keys are hashes; anything else is refused before touching disk. */
  app.param("hash", (req, res, next, value: string) => {
    if (!HASH_PATTERN.test(value)) {
      res.status(400).json({ message: "Not a valid object hash", code: "BAD_REQUEST" });
      return;
    }
    next();
  });

  /**
   * Authorises one request against the grant it carries.
   *
   * The expected object and operation come from the route, not the grant, so a
   * valid grant for one object cannot be replayed to reach another.
   */
  function authorise(
    req: express.Request,
    res: express.Response,
    op: TransferOperation
  ): boolean {
    const grant = req.get("x-transfer-grant") ?? "";
    const result = verifyTransferGrant({
      grant,
      controlPlanePublicKey: options.controlPlanePublicKey,
      expected: {
        objectHash: req.params["hash"] as string,
        deviceId: options.deviceId,
        op,
      },
    });

    if (!result.ok) {
      res.status(401).json({ message: "Transfer not authorised", code: result.reason });
      return false;
    }
    return true;
  }

  app.head("/objects/:hash", async (req, res, next) => {
    try {
      if (!authorise(req, res, "get")) return;
      const hash = req.params["hash"] as string;
      const meta = await options.store.metadata(hash);
      if (!meta) {
        res.status(404).end();
        return;
      }
      if (!(await options.store.verify(hash))) {
        res.status(422).json({ message: "Object failed integrity check", code: "INTEGRITY" });
        return;
      }
      res.setHeader("Content-Length", String(meta.size));
      res.setHeader("X-Object-Encryption", meta.encryption);
      res.status(200).end();
    } catch (err) {
      next(err);
    }
  });

  app.get("/objects/:hash", async (req, res, next) => {
    try {
      if (!authorise(req, res, "get")) return;
      const hash = req.params["hash"] as string;
      if (!(await options.store.has(hash))) {
        res.status(404).json({ message: "Object not held", code: "NOT_FOUND" });
        return;
      }
      // Verify before opening the stream. A silently corrupted object is
      // worse than a missing one because the caller could persist bad bytes.
      if (!(await options.store.verify(hash))) {
        res.status(422).json({ message: "Object failed integrity check", code: "INTEGRITY" });
        return;
      }

      res.setHeader("Content-Type", "application/octet-stream");
      const stream = options.store.read(hash);
      stream.once("error", next);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  app.put("/objects/:hash", (req, res) => {
    void (async () => {
      if (!authorise(req, res, "put")) return;
      const hash = req.params["hash"] as string;
      const declared = Number(req.get("content-length"));

      try {
        const stored = await options.store.put(req, {
          // The hash is in the URL, so a corrupted or substituted transfer is
          // rejected on arrival rather than discovered on a later read.
          expectedHash: hash,
          ...(Number.isFinite(declared) ? { expectedSize: declared } : {}),
        });

        if (options.reportPossession) {
          try {
            await options.reportPossession({
              objectHash: stored.hash,
              sizeBytes: stored.size,
            });
          } catch {
            // The bytes are safe on disk, but the control plane must not show
            // them as protected until the signed possession report arrives.
            // The browser can retry the idempotent PUT/report sequence.
            res.status(503).json({
              message: "Object stored but possession could not be confirmed",
              code: "POSSESSION_UNCONFIRMED",
            });
            return;
          }
        }
        res.status(201).json({ data: stored });
      } catch (err) {
        if (err instanceof AllocationExceededError) {
          res.status(507).json({ message: err.message, code: "ALLOCATION_EXCEEDED" });
          return;
        }
        if (err instanceof IntegrityError) {
          res.status(422).json({ message: err.message, code: "INTEGRITY" });
          return;
        }
        if (err instanceof SizeMismatchError) {
          res.status(422).json({ message: err.message, code: "SIZE_MISMATCH" });
          return;
        }
        res.status(500).json({ message: "Could not store object", code: "SERVER" });
      }
    })();
  });

  app.delete("/objects/:hash", async (req, res, next) => {
    try {
      if (!authorise(req, res, "delete")) return;
      await options.store.delete(req.params["hash"] as string);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ message: "Route not found", code: "NOT_FOUND" });
  });

  return app;
}
