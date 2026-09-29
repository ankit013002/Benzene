import { ApiError, isRecord } from './client';

const BYTES_PER_GB = 1024 ** 3;
const MAX_ALLOCATED_BYTES = Number.MAX_SAFE_INTEGER;
const PAIRING_CODE_PATTERN = /^[A-HJKM-NP-Z2-9]{4}-?[A-HJKM-NP-Z2-9]{4}$/;

export type DeviceEnrollmentResult = { id: string; name: string; status: string };
export type AuthenticatedRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase();
}

export function allocationBytesFromGb(value: string): number {
  const gb = Number(value.trim());
  const bytes = Math.round(gb * BYTES_PER_GB);
  if (!Number.isFinite(gb) || gb < 1 || !Number.isSafeInteger(bytes) || bytes > MAX_ALLOCATED_BYTES) {
    throw new Error('Choose a storage amount of at least 1 GB that fits within the supported limit.');
  }
  return bytes;
}

export function validatePairingCode(value: string): string {
  const code = normalizePairingCode(value);
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error('Enter the 8-character code shown by the Benzene computer agent.');
  }
  return code;
}

function parseEnrollmentResult(payload: unknown): DeviceEnrollmentResult {
  if (!isRecord(payload) || !isRecord(payload.data)
    || typeof payload.data.id !== 'string' || typeof payload.data.name !== 'string'
    || typeof payload.data.status !== 'string') {
    throw new Error('Benzene added the device but returned an unexpected response. Refresh your devices to check.');
  }
  return { id: payload.data.id, name: payload.data.name, status: payload.data.status };
}

export async function approveDeviceEnrollment(
  codeInput: string,
  allocationGb: string,
  request: AuthenticatedRequest,
): Promise<DeviceEnrollmentResult> {
  const code = validatePairingCode(codeInput);
  const allocatedBytes = allocationBytesFromGb(allocationGb);
  try {
    const payload = await request<unknown>('/devices/enrollments/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, allocatedBytes }),
    });
    return parseEnrollmentResult(payload);
  } catch (cause) {
    if (!(cause instanceof ApiError)) throw cause;
    if (cause.status === 429) {
      throw new Error('There have been several pairing attempts. Wait a moment, then try again.');
    }
    if (cause.status === 400 && /expired/i.test(cause.message)) {
      throw new Error('That pairing code has expired. Get a fresh code from the computer agent and try again.');
    }
    if (cause.status === 404 || cause.status === 400) {
      throw new Error('That code is invalid, expired, or already used. Check the computer agent and enter its current code.');
    }
    throw new Error('Benzene could not add that device. Check your connection and try again.');
  }
}
