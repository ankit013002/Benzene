import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedBuildIds } from '../scripts/record-store-builds.mjs';

const ios = { id: '12345678-1234-1234-1234-123456789abc', platform: 'IOS', status: 'FINISHED' };
const android = { id: '87654321-4321-4321-4321-cba987654321', platform: 'ANDROID', status: 'finished' };

test('selects the completed build IDs for the requested store platforms', () => {
  assert.deepEqual(selectedBuildIds([ios, android], 'all'), { ios: ios.id, android: android.id });
  assert.deepEqual(selectedBuildIds([ios, android], 'ios'), { ios: ios.id });
});

test('refuses missing, duplicate, malformed, or unfinished platform builds', () => {
  assert.throws(() => selectedBuildIds([ios], 'all'), /exactly one android build/);
  assert.throws(() => selectedBuildIds([ios, ios], 'ios'), /exactly one ios build/);
  assert.throws(() => selectedBuildIds([{ ...ios, id: 'bad' }], 'ios'), /valid ios build ID/);
  assert.throws(() => selectedBuildIds([{ ...ios, status: 'IN_PROGRESS' }], 'ios'), /not finished/);
  assert.throws(() => selectedBuildIds({}, 'ios'), /JSON array/);
  assert.throws(() => selectedBuildIds([ios], 'web'), /Platform must be/);
});
