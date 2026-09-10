"use client";

import React, { useCallback, useEffect, useState } from "react";
import StorageUsage from "./StorageUsage";
import RecentFiles from "./RecentFiles";
import { FileType } from "@/types/File";
import { getNormalizedSize } from "@/utils/file-system/NormalizedSize";
import { FileFolderBuffer } from "@/types/FileFolderBuffer";
import { splitBuffers } from "@/utils/file-system/FileSystemUtils";
import { ExistingDirectoryType } from "@/types/ExistingDirectory";
import { useRouter, useParams } from "next/navigation";
import { FolderType } from "@/types/Folder";
import {
  UploadProgress,
  deleteNode,
  downloadFile,
  downloadLegacyFile,
  uploadFiles,
} from "@/utils/file-system/uploadFiles";

interface ListedFile {
  id: string;
  name: string;
  path: string;
  bytes: number;
  contentType?: string;
  ext?: string;
  lastModified: number | null;
  hasContent: boolean;
  objectHash?: string;
  protection?: FileType["protection"];
}

interface ListedFolder {
  id: string;
  name: string;
  path: string;
  bytes: number;
  lastModified: number | null;
}

export default function DashboardContentSection() {
  const [isLoading, setIsLoading] = useState(true);
  const [existingDirectoryItems, setExistingDirectoryItems] =
    useState<ExistingDirectoryType | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const router = useRouter();
  const params = useParams() as { path?: string[] };
  const currPath = (params?.path ?? []).join("/");

  const fetchDir = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const res = await fetch(`/api/files?path=${encodeURIComponent(currPath)}`);
      if (!res.ok) {
        throw new Error(`Could not load this folder (${res.status})`);
      }

      const payload = (await res.json()) as {
        data?: { files?: ListedFile[]; folders?: ListedFolder[] };
      };

      // Pending reservations have no committed bytes and cannot be downloaded.
      // The backend has no cancellation endpoint, so keep abandoned uploads
      // out of the ordinary drive listing instead of leaving permanent rows.
      const files: FileType[] = (payload.data?.files ?? [])
        .filter((file) => file.hasContent !== false)
        .map((file) => ({
          id: file.id,
          name: file.name,
          path: file.path,
          size: getNormalizedSize(file.bytes),
          type: file.contentType,
          lastModified: file.lastModified ?? undefined,
          hasContent: file.hasContent,
          objectHash: file.objectHash,
          protection: file.protection,
        }));

      const folders: FolderType[] = (payload.data?.folders ?? []).map((folder) => ({
        id: folder.id,
        name: folder.name,
        path: folder.path,
        size: getNormalizedSize(folder.bytes),
        lastModified: folder.lastModified ?? undefined,
      }));

      const existingDirectory: ExistingDirectoryType = {
        ok: true,
        path: currPath,
        files,
        folders,
      };

      setExistingDirectoryItems(existingDirectory);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setExistingDirectoryItems({ ok: false, path: currPath, files: [], folders: [] });
    } finally {
      setIsLoading(false);
    }
  }, [currPath]);

  useEffect(() => {
    fetchDir();
  }, [fetchDir]);

  const uploadDirItems = async (items: FileFolderBuffer[]) => {
    const { files, emptyFolders, folders } = splitBuffers(items);

    // splitBuffers reports folders as {name, path} and empty ones as full
    // paths; the API takes absolute paths for both.
    const folderPaths = [
      ...folders.map((folder) => `${folder.path}${folder.name}`),
      ...emptyFolders,
    ];

    setError(null);
    setNotice(null);

    try {
      // The reservation owns both metadata and placement. It is completed
      // only after the device has accepted and signed possession of the bytes.
      const result = await uploadFiles(currPath, files, folderPaths, setUploadProgress);
      if (result.issues.length > 0) {
        setNotice(
          `${result.uploaded} of ${files.length} file(s) stored. ${result.issues.join(". ")}.`
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed";
      setError(message);
    } finally {
      setUploadProgress(null);
      await fetchDir();
    }
  };

  const handleDownload = async (file: FileType) => {
    setError(null);
    try {
      if (file.objectHash) {
        await downloadFile(file.objectHash, file.name);
      } else {
        // Older metadata may not have an object hash yet. Keep this explicit
        // fallback narrow so new device-backed files never use the old path.
        await downloadLegacyFile(file.id, file.name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    }
  };

  const handleDelete = async (nodeId: string) => {
    setError(null);
    try {
      await deleteNode(nodeId);
      await fetchDir();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const updatePath = (child: string) => {
    const next = [currPath, child].filter(Boolean).join("/");
    router.push(`/dashboard/${next}`);
  };

  return (
    <>
      <div>
        <StorageUsage />
      </div>

      {uploadProgress && (
        <div className="px-4 py-2">
          <progress
            className="progress progress-primary w-full"
            value={uploadProgress.completed}
            max={uploadProgress.total}
          />
          <p className="text-sm opacity-70">
            Uploading {uploadProgress.completed} of {uploadProgress.total}
            {uploadProgress.currentFile ? ` — ${uploadProgress.currentFile}` : ""}
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className="alert alert-error mx-4 my-2">
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div role="status" className="mx-4 my-2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      <div className="h-full">
        <RecentFiles
          isLoading={isLoading}
          existingDirItems={existingDirectoryItems}
          uploadDirItems={(f: FileFolderBuffer[]) => uploadDirItems(f)}
          updatePath={(p: string) => updatePath(p)}
          onDownload={handleDownload}
          onDelete={handleDelete}
        />
      </div>
    </>
  );
}
