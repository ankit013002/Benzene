import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);

test('Expo Router remains compatible with the patched query-string import', () => {
  const { getPathFromState } = require('expo-router/build/react-navigation/core/getPathFromState');
  const { getStateFromPath } = require('expo-router/build/react-navigation/core/getStateFromPath');
  const config = { screens: { search: 'search' } };

  const path = getPathFromState(
    { routes: [{ name: 'search', params: { name: 'Benzene Vault' } }] },
    config,
  );

  assert.equal(path, '/search?name=Benzene%20Vault');
  assert.deepEqual(getStateFromPath(path, config)?.routes[0]?.params, {
    name: 'Benzene Vault',
  });
});

test('Expo iOS project UUID generation remains compatible with patched uuid', () => {
  const project = require('xcode').project('unused.pbxproj');
  project.hash = { project: { objects: {} } };

  assert.match(project.generateUuid(), /^[A-F0-9]{24}$/);
});
