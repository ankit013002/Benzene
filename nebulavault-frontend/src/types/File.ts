export type FileSizeUnit = "B" | "KB" | "MB" | "GB" | "TB";

export type FileSize = {
  raw: number;
  value: number;
  unit: FileSizeUnit;
};

export type FileType = {
  /** DriveNode id, used to delete the logical file (legacy downloads only). */
  id: string;
  name: string;
  owner?: string;
  size: FileSize;
  type?: string;
  lastModified?: number;
  path: string;
  /** False while an upload is reserved but its bytes have not landed yet. */
  hasContent?: boolean;
  /** Content address used for direct device downloads. */
  objectHash?: string;
  /** Current device protection state, when reported by the control plane. */
  protection?: {
    state?: string;
    healthyReplicas?: number;
    desiredReplicas?: number;
  };
};
