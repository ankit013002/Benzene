import { gatewayOrigin } from '../config';
import type { TokenPair } from '../session/sessionStore';
import { isRecord } from './client';

export type DeletionStatus = {
  requestId: string;
  receipt?: string;
  status: string;
  currentPhase: string;
  requestedAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  deletionComplete: boolean;
  downstreamCleanupStarted: boolean;
  message?: string;
};

function parseDeletionStatus(payload: unknown): DeletionStatus {
  if (!isRecord(payload) || typeof payload.requestId !== 'string'
    || typeof payload.status !== 'string' || typeof payload.currentPhase !== 'string'
    || typeof payload.requestedAt !== 'string' || typeof payload.deletionComplete !== 'boolean'
    || typeof payload.downstreamCleanupStarted !== 'boolean') {
    throw new Error('The server returned an invalid account-deletion status.');
  }
  return {
    requestId: payload.requestId,
    ...(typeof payload.receipt === 'string' ? { receipt: payload.receipt } : {}),
    status: payload.status,
    currentPhase: payload.currentPhase,
    requestedAt: payload.requestedAt,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    completedAt: typeof payload.completedAt === 'string' ? payload.completedAt : null,
    deletionComplete: payload.deletionComplete,
    downstreamCleanupStarted: payload.downstreamCleanupStarted,
    ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
  };
}

async function accountDeletionPost(path: string, body: Record<string, string>, requiresReceipt = false): Promise<DeletionStatus> {
  const origin = gatewayOrigin();
  if (!origin) throw new Error('Benzene connection is not configured.');
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach Benzene. Your request may not have been recorded; you can safely retry.');
  }
  if (!response.ok) {
    if (response.status === 401 && path.endsWith('/status')) throw new Error('No deletion request was found for these credentials, or the email/password is incorrect.');
    if (response.status === 401) throw new Error('The email or password is incorrect.');
    if (response.status === 429) throw new Error('Too many requests. Wait a moment and try again.');
    throw new Error('Benzene could not process this account-deletion request.');
  }
  const result = parseDeletionStatus(await response.json());
  if (requiresReceipt && (!result.receipt || !/^[A-Za-z0-9_-]{43}$/.test(result.receipt))) {
    throw new Error('The server did not return a valid deletion receipt.');
  }
  return result;
}

export function requestAccountDeletion(email: string, password: string, idempotencyKey: string): Promise<DeletionStatus> {
  return accountDeletionPost('/auth/account-deletion', { email, password, idempotencyKey }, true);
}

export function readAccountDeletionStatus(email: string, password: string): Promise<DeletionStatus> {
  return accountDeletionPost('/auth/account-deletion/status', { email, password });
}

export function readAccountDeletionStatusByReceipt(requestId: string, receipt: string): Promise<DeletionStatus> {
  return accountDeletionPost('/auth/account-deletion/receipt-status', { requestId, receipt });
}

export async function revokeNativeSession(tokens: TokenPair): Promise<void> {
  const origin = gatewayOrigin();
  if (!origin) throw new Error('Benzene connection is not configured.');
  const response = await fetch(`${origin}/auth/native/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Benzene-Client-Kind': 'native-mobile' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  if (!response.ok) throw new Error('Benzene could not revoke this session.');
}
