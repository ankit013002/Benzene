import { signedHeaders } from "./protocol.js";

/**
 * Client for the control plane's node-agent API.
 *
 * Every call targets the `/agent` prefix, which the gateway routes without its
 * session filter: a machine mid-enrollment holds no session, and an enrolled
 * one proves itself by request signature instead.
 */

export interface EnrollmentTicket {
  id: string;
  code: string;
  expiresAt: string;
}

export interface EnrollmentStatus {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  deviceName: string;
  platform: string;
  expiresAt: string;
  deviceId: string | null;
  /** Present only once approved. */
  controlPlanePublicKey?: string;
}

export interface HeartbeatResult {
  status: string;
}

export interface PossessionResult {
  status: string;
}

export interface RepairFailureResult {
  status: "corrupt";
}

export interface RepairAssignment {
  objectHash: string;
  sizeBytes: number;
  repairAssignmentId: string;
  source: {
    deviceId: string;
    deviceName: string;
    url: string;
    grant: string;
    expiresAt: string;
  };
}

export class ControlPlaneError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message !== "") {
      return payload.message;
    }
  } catch {
    // Non-JSON error body; fall through.
  }
  return fallback;
}

export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Step one of enrollment. Unauthenticated: there are no credentials yet. */
  async requestEnrollment(input: {
    publicKey: string;
    deviceName: string;
    platform: string;
  }): Promise<EnrollmentTicket> {
    const res = await this.fetchImpl(`${this.baseUrl}/agent/enrollments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      throw new ControlPlaneError(
        res.status,
        await readError(res, "Could not start enrollment")
      );
    }

    const payload = (await res.json()) as { data: EnrollmentTicket };
    return payload.data;
  }

  /** Polled while the user approves the pairing code on another screen. */
  async getEnrollmentStatus(
    enrollmentId: string,
    publicKey: string
  ): Promise<EnrollmentStatus> {
    const url = `${this.baseUrl}/agent/enrollments/${encodeURIComponent(
      enrollmentId
    )}?publicKey=${encodeURIComponent(publicKey)}`;

    const res = await this.fetchImpl(url, { method: "GET" });
    if (!res.ok) {
      throw new ControlPlaneError(
        res.status,
        await readError(res, "Could not read enrollment status")
      );
    }

    const payload = (await res.json()) as { data: EnrollmentStatus };
    return payload.data;
  }

  /**
   * Presence and capacity report.
   *
   * The path signed must match what the server sees, including the `/agent`
   * prefix, or verification fails.
   */
  async heartbeat(input: {
    deviceId: string;
    privateKey: string;
    usedBytes: number;
    availableBytes: number;
    appVersion: string;
    advertisedUrl?: string;
  }): Promise<HeartbeatResult> {
    const path = "/agent/heartbeat";
    const body = JSON.stringify({
      usedBytes: input.usedBytes,
      availableBytes: input.availableBytes,
      appVersion: input.appVersion,
      ...(input.advertisedUrl ? { advertisedUrl: input.advertisedUrl } : {}),
    });

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders({
          deviceId: input.deviceId,
          privateKey: input.privateKey,
          method: "POST",
          path,
          body,
        }),
      },
      body,
    });

    if (!res.ok) {
      throw new ControlPlaneError(
        res.status,
        await readError(res, "Heartbeat rejected")
      );
    }

    const payload = (await res.json()) as { data: HeartbeatResult };
    return payload.data;
  }

  /** Reports that this device accepted and verified an object. */
  async reportPossession(input: {
    deviceId: string;
    privateKey: string;
    objectHash: string;
    sizeBytes: number;
  }): Promise<PossessionResult> {
    const path = "/agent/possession";
    const body = JSON.stringify({
      objectHash: input.objectHash,
      sizeBytes: input.sizeBytes,
    });
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders({
          deviceId: input.deviceId,
          privateKey: input.privateKey,
          method: "POST",
          path,
          body,
        }),
      },
      body,
    });

    if (!res.ok) {
      throw new ControlPlaneError(
        res.status,
        await readError(res, "Possession report rejected")
      );
    }

    const payload = (await res.json()) as { data: PossessionResult };
    return payload.data;
  }

  /** Polls for one bounded repair assignment for this device. */
  async pollRepair(input: {
    deviceId: string;
    privateKey: string;
  }): Promise<RepairAssignment | null> {
    const path = "/agent/repair";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        ...signedHeaders({
          deviceId: input.deviceId,
          privateKey: input.privateKey,
          method: "GET",
          path,
          body: "",
        }),
      },
    });

    if (!res.ok) {
      throw new ControlPlaneError(
        res.status,
        await readError(res, "Repair poll rejected")
      );
    }

    const payload = (await res.json()) as { data: RepairAssignment | null };
    return payload.data;
  }

  /** Reports a source whose transfer bytes failed the expected hash check. */
  async reportRepairFailure(input: {
    deviceId: string;
    privateKey: string;
    objectHash: string;
    sourceDeviceId: string;
    repairAssignmentId: string;
  }): Promise<RepairFailureResult> {
    const path = "/agent/repair-failure";
    const body = JSON.stringify({
      objectHash: input.objectHash,
      sourceDeviceId: input.sourceDeviceId,
      repairAssignmentId: input.repairAssignmentId,
      reason: "integrity",
    });
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders({
          deviceId: input.deviceId,
          privateKey: input.privateKey,
          method: "POST",
          path,
          body,
        }),
      },
      body,
    });

    if (!res.ok) {
      throw new ControlPlaneError(
        res.status,
        await readError(res, "Repair failure report rejected")
      );
    }

    const payload = (await res.json()) as { data: RepairFailureResult };
    return payload.data;
  }
}
