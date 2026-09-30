import { isRecord } from '../api/client';
import { isVaultFile, type VaultFile } from '../api/models';

export type VaultFolder = { id: string; name: string; path: string; bytes: number; lastModified: number | null };
export type VaultDirectory = { path: string; files: VaultFile[]; folders: VaultFolder[] };

/** Paths in the API are relative to the Vault root and use a trailing slash. */
export function normalizeVaultPath(value: string): string | null {
  if (value === '') return '';
  if (value.length > 1024 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return null;
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.length === 0 ? '' : `${segments.join('/')}/`;
}

export function filesRequestPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (normalized === null) throw new Error('This folder path is invalid.');
  return `/files?path=${encodeURIComponent(normalized)}`;
}

export function parseVaultDirectory(payload: unknown, expectedPath: string): VaultDirectory | null {
  const path = normalizeVaultPath(expectedPath);
  if (path === null || !isRecord(payload) || !isRecord(payload.data)) return null;
  const data = payload.data;
  if (data.path !== path || !Array.isArray(data.files) || !Array.isArray(data.folders)) return null;
  if (!data.files.every(isVaultFile) || !data.folders.every(isVaultFolder)) return null;
  if (!data.folders.every((folder) => isImmediateChildFolder(folder, path))) return null;
  if (!data.files.every((file) => file.path === path)) return null;
  return { path, files: data.files, folders: data.folders };
}

function isVaultFolder(value: unknown): value is VaultFolder {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.name === 'string' && isSafeFolderName(value.name)
    && typeof value.path === 'string' && normalizeVaultPath(value.path) === value.path
    && typeof value.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes >= 0
    && (typeof value.lastModified === 'number' && Number.isFinite(value.lastModified) || value.lastModified === null);
}

function isImmediateChildFolder(folder: VaultFolder, parentPath: string): boolean {
  const expected = `${parentPath}${folder.name}/`;
  return folder.path === expected;
}

export function isSafeFolderName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value.trim() === value
    && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
}

export function createFolderRequestBody(name: string, parentPath: string): { paths: string[] } {
  const normalizedParent = normalizeVaultPath(parentPath);
  const normalizedName = name.trim();
  if (normalizedParent === null || !isSafeFolderName(normalizedName)) {
    throw new Error('Enter a folder name without slashes or leading/trailing spaces.');
  }
  const path = `${normalizedParent}${normalizedName}`;
  if (path.length > 1024) throw new Error('This folder path is too long.');
  return { paths: [path] };
}

export function parentVaultPath(path: string): string | null {
  const normalized = normalizeVaultPath(path);
  if (normalized === null) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  segments.pop();
  return segments.length === 0 ? '' : `${segments.join('/')}/`;
}

export function vaultBreadcrumbs(path: string): { label: string; path: string }[] | null {
  const normalized = normalizeVaultPath(path);
  if (normalized === null) return null;
  const result = [{ label: 'Vault', path: '' }];
  const segments = normalized.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `${segment}/`;
    result.push({ label: segment, path: current });
  }
  return result;
}
