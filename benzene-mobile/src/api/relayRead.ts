import { ApiError, isRecord } from './client';
import type { RelayFallbackResponse } from '../files/relayCiphertext';

export type RelayReadRequest = (path: string, init?: RequestInit) => Promise<unknown>;

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseFallback(value: unknown): RelayFallbackResponse {
  if (!isRecord(value)) throw new Error('Benzene returned an invalid secure relay response.');
  const keys = Object.keys(value).sort();
  const expectedKeys = ['ciphertextBytes', 'expiresAt', 'kind', 'relayUrl', 'sessionId', 'storageHash', 'ticket'].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
    || value.kind !== 'relay_fallback'
    || typeof value.relayUrl !== 'string'
    || typeof value.sessionId !== 'string' || !UUID_PATTERN.test(value.sessionId)
    || typeof value.ticket !== 'string' || value.ticket.length === 0 || value.ticket.length > 8_192
    || typeof value.storageHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.storageHash)
    || typeof value.ciphertextBytes !== 'number' || !Number.isSafeInteger(value.ciphertextBytes)
    || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || new Date(value.expiresAt).toISOString() !== value.expiresAt) {
    throw new Error('Benzene returned an invalid secure relay response.');
  }
  return {
    kind: 'relay_fallback',
    relayUrl: value.relayUrl,
    sessionId: value.sessionId,
    ticket: value.ticket,
    storageHash: value.storageHash,
    ciphertextBytes: value.ciphertextBytes,
    expiresAt: value.expiresAt,
  };
}

function relayRequestError(cause: unknown): Error {
  if (!(cause instanceof ApiError)) return new Error('Benzene could not arrange a secure relay fallback.');
  switch (cause.status) {
    case 401: return new Error('Your session has expired. Sign in again.');
    case 403: return new Error('You are not authorized to read this file.');
    case 404: return new Error('This file is no longer available in your Vault.');
    case 409: return new Error('No online encrypted copy is available for secure relay right now.');
    case 429: return new Error('Too many secure relay attempts. Wait a moment and try again.');
    case 503: return new Error('Secure relay is temporarily unavailable. Try again later.');
    default: return new Error('Benzene could not arrange a secure relay fallback.');
  }
}

/** Requests the control-plane client ticket only after direct reads have failed. */
export async function requestRelayReadFallback(
  request: RelayReadRequest,
  input: { nodeId: string; requestId: string; storageHash: string; ciphertextBytes: number },
): Promise<RelayFallbackResponse> {
  if (!OBJECT_ID_PATTERN.test(input.nodeId) || !UUID_PATTERN.test(input.requestId)
    || !/^[a-f0-9]{64}$/.test(input.storageHash)
    || !Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes < 16) {
    throw new Error('The encrypted file cannot use secure relay with invalid request metadata.');
  }

  let payload: unknown;
  try {
    payload = await request('/placement/relay-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: input.nodeId, requestId: input.requestId }),
    });
  } catch (cause) {
    throw relayRequestError(cause);
  }
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error('Benzene returned an invalid secure relay response.');
  const fallback = parseFallback(payload.data);
  if (fallback.storageHash !== input.storageHash || fallback.ciphertextBytes !== input.ciphertextBytes) {
    throw new Error('The file changed before secure relay could start. Refresh the file list and try again.');
  }
  return fallback;
}
