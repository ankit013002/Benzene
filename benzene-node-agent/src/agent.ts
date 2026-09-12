import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

import type { AgentConfig } from "./config.js";
import { ControlPlaneClient, ControlPlaneError } from "./controlPlane.js";
import { IdentityStore, type DeviceIdentity } from "./identity.js";
import { generateDeviceKeyPair } from "./protocol.js";
import { IntegrityError, ObjectStore, type StoredObject } from "./store.js";

export const AGENT_VERSION = "0.1.0";
const REPAIR_FETCH_TIMEOUT_MS = 30_000;

export interface EnrollmentPrompt {
  code: string;
  expiresAt: string;
}

export interface AgentEvents {
  /** Raised with the pairing code the user must approve. */
  onEnrollmentPending?: (prompt: EnrollmentPrompt) => void;
  onEnrolled?: (deviceId: string) => void;
  onHeartbeat?: (result: { status: string; usedBytes: number }) => void;
  /** Stops the transfer listener and drains active requests before erasure. */
  onRemovalStart?: () => Promise<void> | void;
  /** Raised after the control plane accepts device removal. */
  onRemoved?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * Ties the pieces together: identity, enrollment, storage and presence.
 *
 * Deliberately has no timers of its own beyond the heartbeat loop, so it can be
 * driven step by step from tests and from a UI that wants to show progress.
 */
export class Agent {
  private readonly identityStore: IdentityStore;
  private readonly client: ControlPlaneClient;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private identity: DeviceIdentity | undefined;
  private repairInFlight = false;
  private removalInFlight = false;
  private transferServingAllowed = true;
  private lastRepairAttemptAt = 0;
  private inventoryReconciliationInFlight: Promise<void> | undefined;
  private inventoryReconciled = false;
  private inventoryRecoveryRequired = false;
  private inventoryStatusGeneration = 0;

  constructor(
    private readonly config: AgentConfig,
    readonly store: ObjectStore,
    private readonly events: AgentEvents = {},
    client?: ControlPlaneClient
  ) {
    this.identityStore = new IdentityStore(config.identityFile);
    this.client = client ?? new ControlPlaneClient(config.controlPlaneUrl);
  }

  currentIdentity(): DeviceIdentity | undefined {
    return this.identity;
  }

  /** False after an erase directive until this device is removed. */
  canServeTransfers(): boolean {
    return this.transferServingAllowed;
  }

  /** Loads or generates this machine's keypair. */
  async initialise(): Promise<DeviceIdentity> {
    this.identity = await this.identityStore.loadOrCreate();
    await this.store.load();
    this.transferServingAllowed = !this.store.removalPending();
    return this.identity;
  }

  /**
   * Ensures this device is enrolled, starting the flow if not.
   *
   * Returns as soon as a pairing code exists — approval happens on another
   * screen and may take arbitrarily long, so blocking here would be wrong.
   */
  async ensureEnrolled(): Promise<{ enrolled: boolean; prompt?: EnrollmentPrompt }> {
    const identity = this.requireIdentity();
    if (identity.deviceId) return { enrolled: true };

    // Resume an enrollment already in flight rather than orphaning it, which
    // would leave a stale pending code in the user's approval list.
    if (identity.enrollmentId) {
      const resumed = await this.pollEnrollment();
      if (resumed) return { enrolled: true };
    }

    if (!this.requireIdentity().enrollmentId) {
      const ticket = await this.client.requestEnrollment({
        publicKey: identity.publicKey,
        deviceName: this.config.deviceName,
        platform: this.config.platform,
      });

      identity.enrollmentId = ticket.id;
      await this.identityStore.save(identity);

      const prompt = { code: ticket.code, expiresAt: ticket.expiresAt };
      this.events.onEnrollmentPending?.(prompt);
      return { enrolled: false, prompt };
    }

    return { enrolled: false };
  }

  /**
   * Checks whether the user has approved yet.
   *
   * Returns true once the device has an id. An expired or rejected enrollment
   * is cleared so the next attempt starts a fresh one instead of polling a
   * ticket that can never be approved.
   */
  async pollEnrollment(): Promise<boolean> {
    const identity = this.requireIdentity();
    if (identity.deviceId) return true;
    if (!identity.enrollmentId) return false;

    let status;
    try {
      status = await this.client.getEnrollmentStatus(
        identity.enrollmentId,
        identity.publicKey
      );
    } catch (err) {
      // A 404 means the control plane no longer knows this ticket; anything
      // else is transient and worth retrying with the same one.
      if (err instanceof ControlPlaneError && err.status === 404) {
        identity.enrollmentId = null;
        await this.identityStore.save(identity);
        return false;
      }
      throw err;
    }

    if (status.status === "consumed" && status.deviceId) {
      identity.deviceId = status.deviceId;
      identity.enrollmentId = null;
      if (status.controlPlanePublicKey) {
        identity.controlPlanePublicKey = status.controlPlanePublicKey;
      }
      await this.identityStore.save(identity);
      this.events.onEnrolled?.(status.deviceId);
      return true;
    }

    if (status.status === "expired" || status.status === "rejected") {
      identity.enrollmentId = null;
      await this.identityStore.save(identity);
    }

    return false;
  }

  /** One presence report. Returns null when the device is not yet enrolled. */
  async sendHeartbeat(): Promise<{ status: string; usedBytes: number } | null> {
    if (this.removalInFlight) return null;
    const identity = this.requireIdentity();
    if (!identity.deviceId) return null;

    const usedBytes = this.store.usedBytes();
    const result = await this.client.heartbeat({
      deviceId: identity.deviceId,
      privateKey: identity.privateKey,
      usedBytes,
      availableBytes: this.store.availableBytes(),
      appVersion: AGENT_VERSION,
      // Advertised by this device rather than inferred from the request's
      // source address, which NAT would make wrong.
      ...(this.config.advertisedUrl ? { advertisedUrl: this.config.advertisedUrl } : {}),
    });

    const report = { status: result.status, usedBytes };
    await this.reconcileInventoryIfNeeded(
      result.status,
      identity.deviceId,
      identity.privateKey
    );
    this.events.onHeartbeat?.(report);
    return report;
  }

  private async reconcileInventoryIfNeeded(
    status: string,
    deviceId: string,
    privateKey: string
  ): Promise<void> {
    if (status !== "suspected_lost") {
      // An online response is authoritative after a lost inventory response:
      // the server may have committed the report before the client observed a
      // transport failure. Do not rescan and replay it indefinitely.
      this.inventoryRecoveryRequired = false;
      this.inventoryReconciled = false;
      this.inventoryStatusGeneration += 1;
      return;
    }

    this.inventoryRecoveryRequired = true;

    // A normal heartbeat may complete while an earlier suspected-lost
    // reconciliation is still scanning. Do not let that stale scan mark the
    // next suspected-lost episode as reconciled.
    const generation = this.inventoryStatusGeneration;
    if (this.inventoryReconciled) {
      this.inventoryRecoveryRequired = false;
      return;
    }
    if (this.inventoryReconciliationInFlight) {
      await this.inventoryReconciliationInFlight;
      if (this.inventoryReconciled || generation !== this.inventoryStatusGeneration) {
        return;
      }
    }

    const reconciliation = (async (): Promise<void> => {
      const objects = await this.store.inventory();
      await this.client.submitInventory({
        deviceId,
        privateKey,
        objects: objects.map(({ hash, size }) => ({
          objectHash: hash,
          sizeBytes: size,
        })),
      });
      if (generation === this.inventoryStatusGeneration) {
        this.inventoryReconciled = true;
        this.inventoryRecoveryRequired = false;
      }
    })();
    this.inventoryReconciliationInFlight = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.inventoryReconciliationInFlight === reconciliation) {
        this.inventoryReconciliationInFlight = undefined;
      }
    }
  }

  /** Reports possession using the device key, never a browser credential. */
  async reportPossession(objectHash: string, sizeBytes: number): Promise<void> {
    const identity = this.requireIdentity();
    if (!identity.deviceId) {
      throw new Error("Cannot report possession before enrollment");
    }

    await this.client.reportPossession({
      deviceId: identity.deviceId,
      privateKey: identity.privateKey,
      objectHash,
      sizeBytes,
    });
  }

  /**
   * Polls and performs the bounded removal handshake. The store is erased
   * before the signed completion report; identity is replaced only after the
   * control plane accepts (or confirms) the terminal removed state.
   */
  async pollRemoval(): Promise<boolean> {
    const identity = this.requireIdentity();
    if (!identity.deviceId || this.removalInFlight) return false;
    this.removalInFlight = true;

    try {
      const directive = await this.client.pollRemoval({
        deviceId: identity.deviceId,
        privateKey: identity.privateKey,
      });
      if (directive?.status === "removed") {
        if (this.store.removalPending()) await this.store.clearRemovalPending();
        await this.relinquishIdentity();
        return true;
      }
      if (!directive && !this.store.removalPending()) return false;

      if (directive?.status === "erase" || this.store.removalPending()) {
        this.transferServingAllowed = false;
        await this.events.onRemovalStart?.();
        await this.store.erase();
      }
      const completion = await this.client.completeRemoval({
        deviceId: identity.deviceId,
        privateKey: identity.privateKey,
      });
      if (completion.status === "removed") {
        await this.store.clearRemovalPending();
        await this.relinquishIdentity();
        return true;
      }
      return false;
    } finally {
      this.removalInFlight = false;
    }
  }

  /**
   * Performs at most one whole-file LAN repair when work is available.
   *
   * The source streams directly into this agent; neither the browser nor the
   * control plane sees object bytes. A failed transfer leaves the durable
   * An integrity failure consumes the `placing` reservation into a missing
   * state so a later bounded poll can assign a fresh source and nonce;
   * transport failures remain retryable against the existing assignment.
   */
  async attemptRepair(): Promise<boolean> {
    const identity = this.requireIdentity();
    if (
      !identity.deviceId ||
      this.repairInFlight ||
      this.removalInFlight ||
      this.inventoryRecoveryRequired ||
      this.inventoryReconciliationInFlight
    ) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastRepairAttemptAt < this.config.repairIntervalMs) return false;
    this.lastRepairAttemptAt = now;
    this.repairInFlight = true;

    try {
      const assignment = await this.client.pollRepair({
        deviceId: identity.deviceId,
        privateKey: identity.privateKey,
      });
      if (!assignment) return false;

      const response = await fetch(assignment.source.url, {
        method: "GET",
        headers: { "X-Transfer-Grant": assignment.source.grant },
        signal: AbortSignal.timeout(REPAIR_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (response.status === 422) {
          await this.client.reportRepairFailure({
            deviceId: identity.deviceId,
            privateKey: identity.privateKey,
            objectHash: assignment.objectHash,
            sourceDeviceId: assignment.source.deviceId,
            repairAssignmentId: assignment.repairAssignmentId,
          });
        }
        throw new Error(
          `Repair source ${assignment.source.deviceName} refused the object (${response.status})`
        );
      }
      if (!response.body) throw new Error("Repair source returned no body");

      let stored: StoredObject;
      try {
        stored = await this.store.put(
          Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
          { expectedHash: assignment.objectHash, expectedSize: assignment.sizeBytes }
        );
      } catch (err) {
        // A successful response can still change between the source's
        // preflight hash check and streaming. Quarantine only a hash failure;
        // a size mismatch is metadata inconsistency and must remain retryable.
        if (err instanceof IntegrityError) {
          await this.client.reportRepairFailure({
            deviceId: identity.deviceId,
            privateKey: identity.privateKey,
            objectHash: assignment.objectHash,
            sourceDeviceId: assignment.source.deviceId,
            repairAssignmentId: assignment.repairAssignmentId,
          });
        }
        throw err;
      }
      await this.reportPossession(stored.hash, stored.size);
      return true;
    } finally {
      this.repairInFlight = false;
    }
  }

  /**
   * Begins reporting presence on a timer.
   *
   * Failures are surfaced but never throw out of the interval: the control
   * plane being briefly unreachable is normal and must not stop an agent that
   * is otherwise healthy and serving data on the LAN.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    const tick = (): void => {
      // Poll removal first so a device whose final completion response was
      // lost can still learn that it is already removed; late heartbeats are
      // intentionally rejected after the control-plane transition.
      void this.pollRemoval()
        .then((removed) => {
          if (removed || this.removalInFlight) return false;
          return this.sendHeartbeat().then(() => this.attemptRepair());
        })
        .catch((err: unknown) => {
          this.events.onError?.(err);
        });
    };

    tick();
    this.heartbeatTimer = setInterval(tick, this.config.heartbeatIntervalMs);
    // Do not hold the process open on this timer alone.
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private requireIdentity(): DeviceIdentity {
    if (!this.identity) {
      throw new Error("Agent.initialise() must be awaited before use");
    }
    return this.identity;
  }

  private async relinquishIdentity(): Promise<void> {
    this.stopHeartbeat();
    this.identity = {
      ...generateDeviceKeyPair(),
      deviceId: null,
      enrollmentId: null,
      controlPlanePublicKey: null,
      createdAt: new Date().toISOString(),
    };
    this.transferServingAllowed = false;
    await this.identityStore.save(this.identity);
    this.events.onRemoved?.();
  }
}
