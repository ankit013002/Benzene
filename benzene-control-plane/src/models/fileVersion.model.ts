import mongoose, { Schema, type HydratedDocument, type Model, type Types } from "mongoose";

import {
  encryptedObjectStorageBytes,
  encryptedObjectV1MetadataSchema,
  type EncryptedObjectV1Metadata,
} from "../modules/encryption/encryptedObjectV1.js";

export type UploadStatus = "pending" | "committed";

export interface FileVersion {
  nodeId: Types.ObjectId;
  ownerId: string;
  version: number;
  bytes: number;
  contentType?: string;
  etag?: string;
  sha256?: string;
  /** Content-addressed object held by one or more Benzene devices. */
  objectHash?: string;
  /**
   * Explicit representation for new encrypted versions. Missing means a
   * legacy plaintext version, so existing rows and writers remain readable.
   */
  storageFormat?: "benzene-encrypted-object-v1";
  /** Physical ciphertext length; `bytes` remains the user-visible plaintext size. */
  storageBytes?: number;
  /** Compact client-produced metadata only. Ciphertext never belongs in Mongo. */
  encryptedObject?: EncryptedObjectV1Metadata;
  /** Legacy cloud/local storage descriptor. Absent for device-backed versions. */
  storage?: {
    driver: string;
    bucket: string;
    key: string;
  };
  /**
   * "pending" is written before bytes move; it flips to "committed" only
   * after the selected storage path confirms possession. Rows left pending
   * represent abandoned uploads and are safe to reap.
   */
  status: UploadStatus;
  uploadedBy: string;
  uploadedAt: Date;
  isCurrent: boolean;
  meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type FileVersionDocument = HydratedDocument<FileVersion>;

const fileVersionSchema = new Schema<FileVersion>(
  {
    nodeId: {
      type: Schema.Types.ObjectId,
      ref: "DriveNode",
      required: [true, "nodeId (DriveNode reference) is required"],
      index: true,
    },
    ownerId: { type: String, required: [true, "must have owner"], index: true },
    version: { type: Number, min: 1, required: true },
    bytes: { type: Number, default: 0, min: 0 },
    contentType: { type: String },
    etag: { type: String, trim: true },
    sha256: { type: String, trim: true },
    objectHash: { type: String, trim: true, lowercase: true, index: true },
    storageFormat: {
      type: String,
      enum: ["benzene-encrypted-object-v1"],
    },
    storageBytes: { type: Number, min: 0 },
    encryptedObject: {
      type: new Schema(
        {
          format: { type: String, required: true, enum: ["benzene-encrypted-object"] },
          version: { type: Number, required: true, enum: [1] },
          payloadAlgorithm: { type: String, required: true, enum: ["AES-256-GCM"] },
          keyWrapAlgorithm: {
            type: String,
            required: true,
            enum: ["HKDF-SHA-256+AES-256-GCM"],
          },
          vaultId: { type: String, required: true },
          objectId: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
          storageHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
          plaintextSize: { type: Number, required: true, min: 0 },
          payloadNonce: { type: String, required: true },
          wrappedKeyNonce: { type: String, required: true },
          wrappedKeyCiphertext: { type: String, required: true },
        },
        { _id: false, strict: "throw" }
      ),
      required: false,
      default: undefined,
    },
    storage: {
      type: new Schema(
        {
          driver: { type: String, required: [true, "storage.driver is required"] },
          bucket: { type: String, required: [true, "storage.bucket is required"] },
          key: { type: String, required: [true, "storage.key is required"] },
        },
        { _id: false }
      ),
      required: false,
      default: undefined,
    },
    status: {
      type: String,
      enum: { values: ["pending", "committed"], message: "{VALUE} is not a valid status" },
      default: "pending",
      index: true,
    },
    uploadedBy: { type: String, required: [true, "uploadedBy is required"] },
    uploadedAt: { type: Date, default: Date.now },
    isCurrent: { type: Boolean, default: false, index: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

fileVersionSchema.pre("validate", function (next) {
  if (this.storageFormat === "benzene-encrypted-object-v1") {
    const metadata = this.encryptedObject;
    if (!metadata) this.invalidate("encryptedObject", "encrypted v1 metadata is required");
    else {
      const parsed = encryptedObjectV1MetadataSchema.safeParse({
        format: metadata.format,
        version: metadata.version,
        payloadAlgorithm: metadata.payloadAlgorithm,
        keyWrapAlgorithm: metadata.keyWrapAlgorithm,
        vaultId: metadata.vaultId,
        objectId: metadata.objectId,
        storageHash: metadata.storageHash,
        plaintextSize: metadata.plaintextSize,
        payloadNonce: metadata.payloadNonce,
        wrappedKeyNonce: metadata.wrappedKeyNonce,
        wrappedKeyCiphertext: metadata.wrappedKeyCiphertext,
      });
      if (!parsed.success) {
        this.invalidate(
          "encryptedObject",
          parsed.error.issues[0]?.message ?? "encrypted v1 metadata is invalid"
        );
      } else if (this.objectHash !== parsed.data.storageHash) {
        this.invalidate("objectHash", "must be the encrypted object's physical storageHash");
      } else if (this.bytes !== parsed.data.plaintextSize) {
        this.invalidate("bytes", "must retain the encrypted object's logical plaintext size");
      } else if (this.storageBytes !== encryptedObjectStorageBytes(parsed.data)) {
        this.invalidate("storageBytes", "must include the encrypted payload's 16-byte GCM tag");
      }
    }
  } else if (this.encryptedObject) {
    this.invalidate("storageFormat", "encrypted metadata requires the encrypted v1 format marker");
  }
  next();
});

// At most one current version per node.
fileVersionSchema.index(
  { nodeId: 1, isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } }
);
fileVersionSchema.index({ nodeId: 1, version: -1 }, { unique: true });
// Supports reaping abandoned uploads.
fileVersionSchema.index({ status: 1, createdAt: 1 });

export const FileVersionModel: Model<FileVersion> =
  (mongoose.models["FileVersion"] as Model<FileVersion>) ??
  mongoose.model<FileVersion>("FileVersion", fileVersionSchema);

export default FileVersionModel;
