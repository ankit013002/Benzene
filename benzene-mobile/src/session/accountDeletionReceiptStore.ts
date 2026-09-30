import * as SecureStore from 'expo-secure-store';

const RECEIPT_KEY = 'benzene.native.account-deletion-receipt.v1';

export type AccountDeletionReceipt = {
  requestId: string;
  receipt: string;
};

function isReceipt(value: unknown): value is AccountDeletionReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AccountDeletionReceipt>;
  return typeof candidate.requestId === 'string'
    && /^[0-9a-f-]{36}$/i.test(candidate.requestId)
    && typeof candidate.receipt === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(candidate.receipt);
}

export async function readAccountDeletionReceipt(): Promise<AccountDeletionReceipt | null> {
  const raw = await SecureStore.getItemAsync(RECEIPT_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isReceipt(parsed)) return parsed;
  } catch {
    // A damaged local receipt cannot authenticate a status request.
  }
  await SecureStore.deleteItemAsync(RECEIPT_KEY);
  return null;
}

export async function saveAccountDeletionReceipt(receipt: AccountDeletionReceipt): Promise<void> {
  if (!isReceipt(receipt)) throw new Error('The server returned an invalid deletion receipt.');
  await SecureStore.setItemAsync(RECEIPT_KEY, JSON.stringify(receipt), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export function clearAccountDeletionReceipt(): Promise<void> {
  return SecureStore.deleteItemAsync(RECEIPT_KEY);
}
