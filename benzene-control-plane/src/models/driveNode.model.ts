import mongoose, { Schema, type HydratedDocument, type Model, type Types } from "mongoose";

export type DriveNodeType = "file" | "folder";

export interface DriveNode {
  ownerId: string;
  type: DriveNodeType;
  name: string;
  nameLower: string;
  /** Parent directory, normalised to "" or "a/b/" (always trailing slash). */
  path: string;
  parentId: Types.ObjectId | null;
  ancestors: Types.ObjectId[];
  bytes: number;
  contentType?: string;
  ext?: string;
  versionsCount: number;
  /** Set once bytes have actually landed in storage. */
  uploadedAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  originalPath?: string;
  originalParentId?: Types.ObjectId;
  createdBy?: string;
  updatedBy?: string;
  /** Short-lived compare-and-set lease used to serialize version promotion. */
  promotionLock?: {
    token: string;
    expiresAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export type DriveNodeDocument = HydratedDocument<DriveNode>;

/** "" | "a/" | "a/b/" — the single canonical form used by every query. */
export function normalizePath(input: string | null | undefined): string {
  let p = (input ?? "").replace(/\\/g, "/").trim();
  p = p.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

const driveNodeSchema = new Schema<DriveNode>(
  {
    ownerId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: { values: ["file", "folder"], message: "{VALUE} must be 'file' or 'folder'" },
      required: [true, "type is required"],
    },
    name: { type: String, required: [true, "file name is required"], trim: true },
    nameLower: { type: String, required: true, lowercase: true, index: true },
    path: { type: String, default: "", trim: true },
    parentId: { type: Schema.Types.ObjectId, ref: "DriveNode", default: null },
    ancestors: [{ type: Schema.Types.ObjectId, ref: "DriveNode" }],
    bytes: { type: Number, default: 0, min: 0 },
    contentType: { type: String },
    ext: { type: String },
    versionsCount: { type: Number, default: 0, min: 0 },
    uploadedAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    originalPath: { type: String },
    originalParentId: { type: Schema.Types.ObjectId, ref: "DriveNode" },
    createdBy: { type: String },
    updatedBy: { type: String },
    promotionLock: {
      type: new Schema(
        {
          token: { type: String, required: true },
          expiresAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      required: false,
      default: undefined,
    },
  },
  { timestamps: true }
);

driveNodeSchema.pre("validate", function (next) {
  if (this.name) this.nameLower = this.name.toLowerCase();
  this.path = normalizePath(this.path);

  if (this.type === "file" && !this.ext) {
    const match = this.name?.match(/\.[^.]+$/);
    this.ext = match ? match[0] : "";
  }
  next();
});

// One live name per directory per owner; soft-deleted rows are excluded so a
// name can be reused after deletion.
driveNodeSchema.index(
  { ownerId: 1, path: 1, nameLower: 1, isDeleted: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
driveNodeSchema.index({ ownerId: 1, path: 1, type: 1, isDeleted: 1 });
driveNodeSchema.index({ ownerId: 1, updatedAt: -1, isDeleted: 1 });

export const DriveNodeModel: Model<DriveNode> =
  (mongoose.models["DriveNode"] as Model<DriveNode>) ??
  mongoose.model<DriveNode>("DriveNode", driveNodeSchema);

export default DriveNodeModel;
