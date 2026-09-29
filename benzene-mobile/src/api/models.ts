export type ApiEnvelope<T> = { data: T };

export type VaultSummary = {
  id: string;
  name: string;
  rawCapacityBytes: number;
  onlineCapacityBytes: number;
  usedBytes: number;
  deviceCount: number;
  onlineDeviceCount: number;
};

export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  status: string;
  allocatedBytes: number;
  usedBytes: number;
  lastSeenAt: string | null;
  removalReady: boolean;
};

export type VaultFile = {
  id: string;
  name: string;
  path: string;
  bytes: number;
  contentType?: string;
  objectHash?: string;
  lastModified: number | null;
  hasContent: boolean;
  protection?: {
    availability?: string;
    state?: string;
    healthyReplicas?: number;
    desiredReplicas?: number;
    reachableHealthyReplicas?: number;
  };
};

export function isVaultSummary(value: unknown): value is VaultSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VaultSummary>;
  return typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.rawCapacityBytes === 'number' && typeof item.onlineCapacityBytes === 'number'
    && typeof item.usedBytes === 'number' && typeof item.deviceCount === 'number'
    && typeof item.onlineDeviceCount === 'number';
}

export function isDeviceSummary(value: unknown): value is DeviceSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DeviceSummary>;
  return typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.platform === 'string' && typeof item.status === 'string'
    && typeof item.allocatedBytes === 'number' && typeof item.usedBytes === 'number'
    && (typeof item.lastSeenAt === 'string' || item.lastSeenAt === null)
    && typeof item.removalReady === 'boolean';
}

export function isVaultFile(value: unknown): value is VaultFile {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VaultFile>;
  return typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.path === 'string' && typeof item.bytes === 'number'
    && typeof item.hasContent === 'boolean'
    && (item.contentType === undefined || typeof item.contentType === 'string')
    && (item.objectHash === undefined || typeof item.objectHash === 'string')
    && (typeof item.lastModified === 'number' || item.lastModified === null)
    && (item.protection === undefined || (typeof item.protection === 'object' && item.protection !== null
      && (item.protection.availability === undefined || typeof item.protection.availability === 'string')
      && (item.protection.state === undefined || typeof item.protection.state === 'string')
      && (item.protection.healthyReplicas === undefined || typeof item.protection.healthyReplicas === 'number')
      && (item.protection.desiredReplicas === undefined || typeof item.protection.desiredReplicas === 'number')
      && (item.protection.reachableHealthyReplicas === undefined || typeof item.protection.reachableHealthyReplicas === 'number')));
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
