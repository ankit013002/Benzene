import dotenv from "dotenv";

dotenv.config();

export type StorageDriverName = "s3" | "local";

export interface AppConfig {
  port: number;
  /** Postgres, holding the control-plane graph: vaults, devices, allocations. */
  databaseUrl: string;
  /** Mongo, still holding file metadata until it migrates to Postgres. */
  mongooseUri: string;
  storageDriver: StorageDriverName;
  /** Max bytes a single presigned upload is allowed to write. */
  maxUploadBytes: number;
  /** Seconds a presigned URL stays valid. */
  presignTtlSeconds: number;
  /** How long a device pairing code remains usable. */
  enrollmentCodeTtlSeconds: number;
  /** Maximum unauthenticated enrollment requests from one network peer per window. */
  enrollmentRateLimitMax: number;
  /** Window for unauthenticated enrollment creation throttling. */
  enrollmentRateLimitWindowSeconds: number;
  /** Maximum authenticated pairing attempts per owner in one window. */
  enrollmentPairingRateLimitMax: number;
  /** Window for authenticated pairing-attempt throttling. */
  enrollmentPairingRateLimitWindowSeconds: number;
  /** Tolerated clock difference when verifying a device request signature. */
  deviceClockSkewSeconds: number;
  /** Silence after which a device is reported offline rather than online. */
  deviceOfflineAfterSeconds: number;
  /**
   * Ed25519 private key (base64 PKCS8) the control plane signs transfer grants
   * with. Read lazily: only upload paths need it, so a deployment that has not
   * configured one still serves everything else rather than failing to boot.
   */
  transferSigningKey: string | undefined;
  /** How long a transfer grant stays usable. */
  transferGrantTtlSeconds: number;
  s3: {
    bucket: string;
    region: string;
    /** Set for LocalStack/MinIO; undefined uses real AWS endpoints. */
    endpoint: string | undefined;
    forcePathStyle: boolean;
  };
  local: {
    /** Directory the local driver writes objects into. */
    rootDir: string;
    /** Public base URL the browser uses to reach the local driver. */
    publicBaseUrl: string;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

function resolveDriver(): StorageDriverName {
  const raw = (optional("STORAGE_DRIVER") ?? "local").toLowerCase();
  if (raw !== "s3" && raw !== "local") {
    throw new Error(`STORAGE_DRIVER must be "s3" or "local", got "${raw}"`);
  }
  return raw;
}

export function loadConfig(): AppConfig {
  const storageDriver = resolveDriver();

  return {
    port: intFromEnv("PORT", 5000),
    databaseUrl: required("DATABASE_URL"),
    mongooseUri: required("MONGOOSE_URI"),
    enrollmentCodeTtlSeconds: intFromEnv("ENROLLMENT_CODE_TTL_SECONDS", 600),
    enrollmentRateLimitMax: intFromEnv("ENROLLMENT_RATE_LIMIT_MAX", 10),
    enrollmentRateLimitWindowSeconds: intFromEnv(
      "ENROLLMENT_RATE_LIMIT_WINDOW_SECONDS",
      60
    ),
    enrollmentPairingRateLimitMax: intFromEnv(
      "ENROLLMENT_PAIRING_RATE_LIMIT_MAX",
      10
    ),
    enrollmentPairingRateLimitWindowSeconds: intFromEnv(
      "ENROLLMENT_PAIRING_RATE_LIMIT_WINDOW_SECONDS",
      60
    ),
    deviceClockSkewSeconds: intFromEnv("DEVICE_CLOCK_SKEW_SECONDS", 300),
    deviceOfflineAfterSeconds: intFromEnv("DEVICE_OFFLINE_AFTER_SECONDS", 120),
    transferSigningKey: optional("TRANSFER_SIGNING_KEY"),
    transferGrantTtlSeconds: intFromEnv("TRANSFER_GRANT_TTL_SECONDS", 300),
    storageDriver,
    maxUploadBytes: intFromEnv("MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024),
    presignTtlSeconds: intFromEnv("PRESIGN_TTL_SECONDS", 900),
    s3: {
      // Only demanded when the S3 driver is actually selected, so local dev
      // and CI need no AWS configuration at all.
      bucket: storageDriver === "s3" ? required("S3_BUCKET") : "",
      region: storageDriver === "s3" ? required("AWS_REGION") : "",
      endpoint: optional("S3_ENDPOINT"),
      forcePathStyle: optional("S3_FORCE_PATH_STYLE") === "true",
    },
    local: {
      rootDir: optional("LOCAL_STORAGE_DIR") ?? "uploads",
      publicBaseUrl:
        optional("LOCAL_STORAGE_PUBLIC_URL") ?? "http://localhost:5000/local-objects",
    },
  };
}

let cached: AppConfig | undefined;

/** Lazily loaded so importing a module never throws on a missing env var. */
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: forget the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
