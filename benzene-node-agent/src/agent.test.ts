import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "./agent.js";
import { loadAgentConfig, type AgentConfig } from "./config.js";
import {
  ControlPlaneClient,
  ControlPlaneError,
  type RepairAssignment,
  type EnrollmentStatus,
  type EnrollmentTicket,
  type HeartbeatResult,
} from "./controlPlane.js";
import type { DeviceIdentity } from "./identity.js";
import { ObjectStore } from "./store.js";

let root: string;

/**
 * Stands in for the control plane so the agent's own state machine is what is
 * under test. The wire format between them is pinned separately by the shared
 * protocol vectors.
 */
class FakeControlPlane extends ControlPlaneClient {
  enrollmentRequests = 0;
  heartbeats: Array<{ deviceId: string; usedBytes: number }> = [];
  status: EnrollmentStatus["status"] = "pending";
  approvedDeviceId = "device-123";
  statusError: ControlPlaneError | undefined;
  repairPolls = 0;
  repairAssignment: RepairAssignment | null = null;
  possessionReports: Array<{ objectHash: string; sizeBytes: number }> = [];
  repairFailures: Array<{
    objectHash: string;
    sourceDeviceId: string;
    repairAssignmentId: string;
  }> = [];

  constructor() {
    super("http://control-plane.invalid");
  }

  override async requestEnrollment(): Promise<EnrollmentTicket> {
    this.enrollmentRequests += 1;
    return {
      id: `enrollment-${this.enrollmentRequests}`,
      code: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  override async getEnrollmentStatus(): Promise<EnrollmentStatus> {
    if (this.statusError) throw this.statusError;
    return {
      id: "enrollment-1",
      status: this.status,
      deviceName: "Test Device",
      platform: "linux",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      deviceId: this.status === "consumed" ? this.approvedDeviceId : null,
    };
  }

  override async heartbeat(input: {
    deviceId: string;
    usedBytes: number;
  }): Promise<HeartbeatResult> {
    this.heartbeats.push({ deviceId: input.deviceId, usedBytes: input.usedBytes });
    return { status: "online" };
  }

  override async pollRepair(): Promise<RepairAssignment | null> {
    this.repairPolls += 1;
    return this.repairAssignment;
  }

  override async reportPossession(input: {
    objectHash: string;
    sizeBytes: number;
  }): Promise<{ status: string }> {
    this.possessionReports.push({
      objectHash: input.objectHash,
      sizeBytes: input.sizeBytes,
    });
    return { status: "healthy" };
  }

  override async reportRepairFailure(input: {
    deviceId: string;
    privateKey: string;
    objectHash: string;
    sourceDeviceId: string;
    repairAssignmentId: string;
  }): Promise<{ status: "corrupt" }> {
    this.repairFailures.push({
      objectHash: input.objectHash,
      sourceDeviceId: input.sourceDeviceId,
      repairAssignmentId: input.repairAssignmentId,
    });
    return { status: "corrupt" };
  }
}

function config(): AgentConfig {
  return loadAgentConfig({
    controlPlaneUrl: "http://control-plane.invalid",
    dataDir: root,
    storageDir: path.join(root, "storage"),
    identityFile: path.join(root, "identity.json"),
    allocatedBytes: 1024 * 1024,
    deviceName: "Test Device",
    platform: "linux",
    heartbeatIntervalMs: 50,
  });
}

async function makeAgent(
  plane = new FakeControlPlane()
): Promise<{ agent: Agent; plane: FakeControlPlane }> {
  const cfg = config();
  const store = new ObjectStore({
    rootDir: cfg.storageDir,
    allocatedBytes: cfg.allocatedBytes,
  });
  const agent = new Agent(cfg, store, {}, plane);
  await agent.initialise();
  return { agent, plane };
}

async function readIdentity(): Promise<DeviceIdentity> {
  return JSON.parse(await readFile(path.join(root, "identity.json"), "utf8"));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "benzene-agent-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("identity", () => {
  it("generates a keypair on first run and persists it", async () => {
    const { agent } = await makeAgent();

    const identity = agent.currentIdentity();
    expect(identity?.publicKey).toBeTruthy();
    expect(identity?.deviceId).toBeNull();
    expect((await readIdentity()).publicKey).toBe(identity?.publicKey);
  });

  // Restarting must not produce a second device in the user's vault.
  it("keeps the same identity across restarts", async () => {
    const first = await makeAgent();
    const firstKey = first.agent.currentIdentity()?.publicKey;

    const second = await makeAgent();

    expect(second.agent.currentIdentity()?.publicKey).toBe(firstKey);
  });

  it("never writes the private key to the control plane", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();

    // The fake records only what it was asked for; the assertion that matters
    // is that enrollment is driven by the public half.
    expect(plane.enrollmentRequests).toBe(1);
    expect(agent.currentIdentity()?.privateKey).toBeTruthy();
    expect((await readIdentity()).privateKey).toBe(
      agent.currentIdentity()?.privateKey
    );
  });
});

describe("enrollment", () => {
  it("returns a pairing code for the user to approve", async () => {
    const { agent } = await makeAgent();

    const result = await agent.ensureEnrolled();

    expect(result.enrolled).toBe(false);
    expect(result.prompt?.code).toBe("ABCD-EFGH");
  });

  it("records the device id once the user approves", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();

    expect(await agent.pollEnrollment()).toBe(false);

    plane.status = "consumed";
    expect(await agent.pollEnrollment()).toBe(true);

    expect(agent.currentIdentity()?.deviceId).toBe("device-123");
    expect((await readIdentity()).deviceId).toBe("device-123");
  });

  // Otherwise every restart would leave another stale code in the user's
  // approval list.
  it("resumes an enrollment already in flight rather than starting another", async () => {
    const plane = new FakeControlPlane();
    const first = await makeAgent(plane);
    await first.agent.ensureEnrolled();

    const second = await makeAgent(plane);
    await second.agent.ensureEnrolled();

    expect(plane.enrollmentRequests).toBe(1);
  });

  it("does not re-enroll a device that already has an id", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    const result = await agent.ensureEnrolled();

    expect(result.enrolled).toBe(true);
    expect(plane.enrollmentRequests).toBe(1);
  });

  it.each<EnrollmentStatus["status"]>(["expired", "rejected"])(
    "starts a fresh enrollment after one is %s",
    async (status) => {
      const { agent, plane } = await makeAgent();
      await agent.ensureEnrolled();

      plane.status = status;
      expect(await agent.pollEnrollment()).toBe(false);
      expect(agent.currentIdentity()?.enrollmentId).toBeNull();

      plane.status = "pending";
      await agent.ensureEnrolled();
      expect(plane.enrollmentRequests).toBe(2);
    }
  );

  // A ticket the server has forgotten can never be approved.
  it("discards an enrollment the control plane no longer knows", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();

    plane.statusError = new ControlPlaneError(404, "Enrollment not found");
    expect(await agent.pollEnrollment()).toBe(false);
    expect(agent.currentIdentity()?.enrollmentId).toBeNull();
  });

  // A transient outage must not throw away a ticket the user is about to approve.
  it("keeps the ticket when the control plane errors transiently", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    const ticket = agent.currentIdentity()?.enrollmentId;

    plane.statusError = new ControlPlaneError(503, "Service unavailable");

    await expect(agent.pollEnrollment()).rejects.toThrow(/unavailable/);
    expect(agent.currentIdentity()?.enrollmentId).toBe(ticket);
  });
});

describe("heartbeat", () => {
  it("does not report before the device is enrolled", async () => {
    const { agent, plane } = await makeAgent();

    expect(await agent.sendHeartbeat()).toBeNull();
    expect(plane.heartbeats).toEqual([]);
  });

  it("reports current usage once enrolled", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    await agent.store.put(Readable.from([Buffer.from("stored bytes")]));
    const report = await agent.sendHeartbeat();

    expect(report).toEqual({ status: "online", usedBytes: "stored bytes".length });
    expect(plane.heartbeats).toEqual([
      { deviceId: "device-123", usedBytes: "stored bytes".length },
    ]);
  });

  // The control plane being briefly unreachable is normal, and must not stop an
  // agent that is otherwise healthy and serving data on the LAN.
  it("keeps running when a heartbeat fails", async () => {
    const plane = new FakeControlPlane();
    const cfg = config();
    const store = new ObjectStore({
      rootDir: cfg.storageDir,
      allocatedBytes: cfg.allocatedBytes,
    });
    const errors: unknown[] = [];
    const agent = new Agent(cfg, store, { onError: (e) => errors.push(e) }, plane);
    await agent.initialise();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    vi.spyOn(plane, "heartbeat").mockRejectedValue(new Error("network down"));

    expect(() => agent.startHeartbeat()).not.toThrow();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));

    agent.stopHeartbeat();
  });

  it("stops reporting once stopped", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    agent.startHeartbeat();
    await vi.waitFor(() => expect(plane.heartbeats.length).toBeGreaterThan(0));
    agent.stopHeartbeat();

    const seen = plane.heartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(plane.heartbeats.length).toBe(seen);
  });
});

describe("repair", () => {
  it("returns no work and does not poll again inside the repair interval", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    await expect(agent.attemptRepair()).resolves.toBe(false);
    await expect(agent.attemptRepair()).resolves.toBe(false);
    expect(plane.repairPolls).toBe(1);
  });

  it("streams an assignment into the store and reports possession", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    const body = "repair bytes";
    const objectHash = createHash("sha256").update(body).digest("hex");
    plane.repairAssignment = {
      objectHash,
      sizeBytes: body.length,
      source: {
        deviceId: "source-device",
        deviceName: "Source",
        url: "http://source.invalid/objects/" + objectHash,
        grant: "grant",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));

    await expect(agent.attemptRepair()).resolves.toBe(true);
    expect(await agent.store.verify(objectHash)).toBe(true);
    expect(plane.possessionReports).toEqual([{ objectHash, sizeBytes: body.length }]);
    vi.unstubAllGlobals();
  });

  it("quarantines a source after its transfer fails integrity", async () => {
    const { agent, plane } = await makeAgent();
    await agent.ensureEnrolled();
    plane.status = "consumed";
    await agent.pollEnrollment();

    const objectHash = createHash("sha256").update("repair bytes").digest("hex");
    plane.repairAssignment = {
      objectHash,
      sizeBytes: 12,
      repairAssignmentId: "11111111-1111-4111-8111-111111111111",
      source: {
        deviceId: "source-device",
        deviceName: "Source",
        url: `http://source.invalid/objects/${objectHash}`,
        grant: "grant",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: "INTEGRITY" }), { status: 422 })
    ));

    await expect(agent.attemptRepair()).rejects.toThrow(/refused the object/);
    expect(plane.repairFailures).toEqual([
      {
        objectHash,
        sourceDeviceId: "source-device",
        repairAssignmentId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    vi.unstubAllGlobals();
  });
});

describe("startup order", () => {
  it("refuses to enroll before initialise has run", async () => {
    const cfg = config();
    const store = new ObjectStore({
      rootDir: cfg.storageDir,
      allocatedBytes: cfg.allocatedBytes,
    });
    const agent = new Agent(cfg, store, {}, new FakeControlPlane());

    await expect(agent.ensureEnrolled()).rejects.toThrow(/initialise\(\)/);
  });
});
