import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client';
import { allocationBytesFromGb, approveDeviceEnrollment, normalizePairingCode, validatePairingCode } from '../src/api/deviceEnrollment';

test('pairing code input is trimmed and canonicalized without accepting ambiguous characters', () => {
  assert.equal(normalizePairingCode('  abcd-efgh  '), 'ABCD-EFGH');
  assert.equal(validatePairingCode('abcd efgh'.replace(' ', '-')), 'ABCD-EFGH');
  assert.throws(() => validatePairingCode('ABCI-EFGH'), /8-character code/);
  assert.throws(() => validatePairingCode('ABCL-EFGH'), /8-character code/);
  assert.throws(() => validatePairingCode('ABC0-EFGH'), /8-character code/);
  assert.throws(() => validatePairingCode('ABCDEFG'), /8-character code/);
});

test('allocation input must be a safe positive whole-byte amount of at least one gigabyte', () => {
  assert.equal(allocationBytesFromGb('100'), 100 * 1024 ** 3);
  assert.equal(allocationBytesFromGb('1.5'), 1.5 * 1024 ** 3);
  for (const value of ['', '0', '0.5', '-1', 'Infinity', '9007199254740992']) {
    assert.throws(() => allocationBytesFromGb(value), /at least 1 GB/);
  }
});

test('approval validates locally and sends only the entered code and chosen allocation', async () => {
  let observed: { path: string; init?: RequestInit } | undefined;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    observed = { path, init };
    return { data: { id: 'device-id', name: 'Office Mac', status: 'offline' } } as T;
  };
  const result = await approveDeviceEnrollment(' abcd-efgh ', '25', request);
  assert.deepEqual(result, { id: 'device-id', name: 'Office Mac', status: 'offline' });
  assert.equal(observed?.path, '/devices/enrollments/approve');
  assert.equal(observed?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { code: 'ABCD-EFGH', allocatedBytes: 25 * 1024 ** 3 });

  let called = false;
  const shouldNotRun = async <T>(): Promise<T> => { called = true; throw new Error('Unexpected request'); };
  await assert.rejects(approveDeviceEnrollment('not-a-code', '25', shouldNotRun), /8-character code/);
  await assert.rejects(approveDeviceEnrollment('ABCD-EFGH', '0', shouldNotRun), /at least 1 GB/);
  assert.equal(called, false);
});

test('approval gives actionable messages for expired, unavailable and rate-limited codes', async () => {
  const failure = (status: number, message: string) => async <T>(): Promise<T> => { throw new ApiError(message, status); };
  await assert.rejects(approveDeviceEnrollment('ABCD-EFGH', '10', failure(400, 'That pairing code has expired')), /Get a fresh code/);
  await assert.rejects(approveDeviceEnrollment('ABCD-EFGH', '10', failure(404, 'No pending enrollment with that code')), /invalid, expired, or already used/);
  await assert.rejects(approveDeviceEnrollment('ABCD-EFGH', '10', failure(429, 'Too many enrollment attempts')), /Wait a moment/);
});
