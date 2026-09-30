import assert from 'node:assert/strict';
import test from 'node:test';
import { createFolderRequestBody, filesRequestPath, normalizeVaultPath, parentVaultPath, parseVaultDirectory, vaultBreadcrumbs } from '../src/files/folders';

test('folder listing validates its path, files and immediate child folders', () => {
  const listing = {
    data: {
      path: 'Photos/2026/',
      files: [{ id: 'file-id', name: 'trip.jpg', path: 'Photos/2026/', bytes: 12, hasContent: true, lastModified: null }],
      folders: [{ id: 'folder-id', name: 'Day 1', path: 'Photos/2026/Day 1/', bytes: 24, lastModified: null }],
    },
  };
  assert.deepEqual(parseVaultDirectory(listing, 'Photos/2026'), {
    path: 'Photos/2026/',
    files: listing.data.files,
    folders: listing.data.folders,
  });
  assert.equal(parseVaultDirectory({ ...listing, data: { ...listing.data, path: 'Other/' } }, 'Photos/2026/'), null);
  assert.equal(parseVaultDirectory({ ...listing, data: { ...listing.data, folders: [{ ...listing.data.folders[0], path: 'Photos/Elsewhere/' }] } }, 'Photos/2026/'), null);
  assert.equal(parseVaultDirectory({ ...listing, data: { ...listing.data, files: [{ ...listing.data.files[0], bytes: '12' }] } }, 'Photos/2026/'), null);
});

test('folder paths cannot escape the Vault and folder query paths are encoded', () => {
  assert.equal(normalizeVaultPath('Photos/2026'), 'Photos/2026/');
  assert.equal(normalizeVaultPath('../outside'), null);
  assert.equal(normalizeVaultPath('/absolute'), null);
  assert.equal(normalizeVaultPath('Photos\\2026'), null);
  assert.equal(normalizeVaultPath('a'.repeat(1025)), null);
  assert.equal(filesRequestPath('Photos & Videos/'), '/files?path=Photos%20%26%20Videos%2F');
});

test('folder creation sends an absolute Vault path and rejects unsafe names', () => {
  assert.deepEqual(createFolderRequestBody('New Album', 'Photos/2026/'), { paths: ['Photos/2026/New Album'] });
  assert.deepEqual(createFolderRequestBody('New Album', ''), { paths: ['New Album'] });
  assert.throws(() => createFolderRequestBody('../outside', 'Photos/'), /folder name/);
  assert.throws(() => createFolderRequestBody('bad/name', 'Photos/'), /folder name/);
  assert.throws(() => createFolderRequestBody('nested', '../outside'), /folder name/);
  assert.throws(() => createFolderRequestBody('folder', `${'a'.repeat(1018)}/`), /too long/);
});

test('breadcrumbs and parent navigation stop at Vault root', () => {
  assert.deepEqual(vaultBreadcrumbs('Photos/2026/'), [
    { label: 'Vault', path: '' },
    { label: 'Photos', path: 'Photos/' },
    { label: '2026', path: 'Photos/2026/' },
  ]);
  assert.equal(parentVaultPath('Photos/2026/'), 'Photos/');
  assert.equal(parentVaultPath('Photos/'), '');
  assert.equal(parentVaultPath(''), null);
  assert.equal(vaultBreadcrumbs('../outside'), null);
});
