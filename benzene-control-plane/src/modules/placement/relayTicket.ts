import { createPrivateKey, sign as cryptoSign } from "node:crypto";

export const RELAY_TICKET_VERSION = 1;
export const MAX_RELAY_TICKET_SECONDS = 5 * 60;
export const MAX_RELAY_OBJECT_BYTES = 1024 * 1024 * 1024;

export type RelayTicketOperation = "get" | "put";
export type RelayTicketRole = "node" | "client";

export interface RelayTicketScope {
  v: 1;
  sessionId: string;
  ticketId: string;
  storageHash: string;
  deviceId: string;
  op: RelayTicketOperation;
  role: RelayTicketRole;
  exp: number;
  maxBytes: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function validateScope(scope: RelayTicketScope, now: number): void {
  if (scope.v !== RELAY_TICKET_VERSION
    || !UUID.test(scope.sessionId)
    || !UUID.test(scope.ticketId)
    || !UUID.test(scope.deviceId)
    || !HASH.test(scope.storageHash)
    || (scope.op !== "get" && scope.op !== "put")
    || (scope.role !== "node" && scope.role !== "client")
    || !Number.isSafeInteger(scope.exp)
    || !Number.isSafeInteger(scope.maxBytes)
    || scope.maxBytes < 1
    || scope.maxBytes > MAX_RELAY_OBJECT_BYTES) {
    throw new TypeError("Invalid relay ticket scope");
  }
  if (scope.exp <= now) throw new TypeError("Relay ticket expiry must be in the future");
  if (scope.exp > now + MAX_RELAY_TICKET_SECONDS) {
    throw new TypeError("Relay ticket lifetime exceeds five minutes");
  }
}

/** Signs the strict cross-package relay scope; ticket bytes remain opaque to the relay. */
export function issueRelayTicket(
  privateKeyB64: string,
  scope: RelayTicketScope,
  now = Math.floor(Date.now() / 1000)
): string {
  validateScope(scope, now);
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Relay ticket signing key must be Ed25519");
  }

  // Explicit field order is part of the shared byte-level contract.
  const payload = {
    v: scope.v,
    sessionId: scope.sessionId,
    ticketId: scope.ticketId,
    storageHash: scope.storageHash,
    deviceId: scope.deviceId,
    op: scope.op,
    role: scope.role,
    exp: scope.exp,
    maxBytes: scope.maxBytes,
  } satisfies RelayTicketScope;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = cryptoSign(null, Buffer.from(encoded, "utf8"), key).toString("base64url");
  return `${encoded}.${signature}`;
}
