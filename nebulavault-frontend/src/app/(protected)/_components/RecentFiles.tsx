"use client";

import React, { useId, useState } from "react";
import { FaPlus } from "react-icons/fa";
import LoadingSpinner from "@/components/LoadingSpinner";
import { FileFolderBuffer } from "@/types/FileFolderBuffer";
import { walkEntry } from "@/utils/file-system/FileSystemUtils";
import { ExistingDirectoryType } from "@/types/ExistingDirectory";
import ReplaceModal from "./ReplaceModal";
import Breadcrumbs from "./Breadcrumbs";
import FileRow from "./FileRow";
import FolderRow from "./FolderRow";
import { useParams } from "next/navigation";
import { FileType } from "@/types/File";

interface RecentFilesProps {
  isLoading: boolean;
  existingDirItems: ExistingDirectoryType | null;
  uploadDirItems: (f: FileFolderBuffer[]) => Promise<void>;
  updatePath: (path: string) => void;
  onDownload: (file: FileType) => void;
  onDelete: (nodeId: string) => void;
}

const RecentFiles = ({
  isLoading,
  existingDirItems,
  uploadDirItems,
  updatePath,
  onDownload,
  onDelete,
}: RecentFilesProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [replaceFiles, setReplaceFiles] = useState<string[]>([]);
  const [pendingItems, setPendingItems] = useState<FileFolderBuffer[]>([]);
  const fileInputId = useId();

  const params = useParams() as { path?: string[] };
  const currPath = (params?.path ?? []).join("/");

  const areFilesBeingReplaced = (dirBuffer: FileFolderBuffer[]) => {
    const buffer: string[] = [];

    if (!existingDirItems) {
      return;
    }

    dirBuffer.forEach((item) => {
      if (item.file) {
        const isReplacement = existingDirItems.files.some(
          (existingFile) => existingFile.name === item.file?.name,
        );
        if (isReplacement) buffer.push(item.file.name);
      } else if (item.folder) {
        const isReplacement = existingDirItems.folders.some((existingFolder) => {
          const folderName = existingFolder.name.replace("/", "");
          return folderName === item.folder;
        });
        if (isReplacement) buffer.push(item.folder);
      }
    });

    setReplaceFiles(buffer);
    setPendingItems(dirBuffer);
    return buffer.length > 0;
  };

  const prepareFileUpload = async (dirNode: FileFolderBuffer) => {
    if (!dirNode.buffer) {
      return;
    }

    const anyReplacements = areFilesBeingReplaced(dirNode.buffer);
    if (!anyReplacements) {
      await uploadDirItems(dirNode.buffer);
    }
  };

  const handleFileSelection = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const items: FileFolderBuffer[] = files.map((file) => ({
      file,
      folder: null,
      path: currPath ? `/${currPath}` : "/",
      buffer: null,
    }));
    await prepareFileUpload({
      file: null,
      folder: null,
      path: currPath,
      buffer: items,
    });
  };

  const handleDragDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    setIsDragging(false);

    const items = [...e.dataTransfer.items];
    const rootBuffer: FileFolderBuffer = {
      file: null,
      folder: "root",
      path: currPath,
      buffer: [],
    };
    const root = rootBuffer.buffer ?? [];
    rootBuffer.buffer = root;

    const promises = items.map(async (item) => {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        await walkEntry(entry, currPath ? currPath + "/" : "", root);
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          root.push({
            file,
            folder: currPath,
            path: "/" + currPath,
            buffer: null,
          });
        }
      }
    });

    await Promise.all(promises);
    await prepareFileUpload(rootBuffer);
  };

  const handleCancelReplace = () => {
    setReplaceFiles([]);
    setPendingItems([]);
  };

  const handleConfirmReplace = async () => {
    const items = pendingItems;
    setReplaceFiles([]);
    setPendingItems([]);
    await uploadDirItems(items);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDragEnd={(e) => {
        e.preventDefault();
        setIsDragging(false);
      }}
      onMouseLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        handleDragDrop(e);
      }}
      className="relative h-full"
    >
      {replaceFiles.length > 0 ? (
        <ReplaceModal
          replaceFiles={replaceFiles}
          handleCancelReplace={() => handleCancelReplace()}
          handleConfirmReplace={() => handleConfirmReplace()}
        />
      ) : isLoading ? (
        <LoadingSpinner />
      ) : isDragging ? (
        <div className="w-full h-full border-dashed border-2 flex flex-col gap-3 justify-center items-center text-center">
          <FaPlus className="text-5xl" />
          <p className="text-lg font-medium">Drop files or folders to add them here</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5 h-full">
          <div className="flex items-center justify-between gap-4">
            <div className="text-2xl font-medium">Files</div>
            <>
              <label
                htmlFor={fileInputId}
                className="btn btn-neutral btn-sm cursor-pointer"
              >
                Add files
              </label>
              <input
                id={fileInputId}
                type="file"
                multiple
                className="sr-only"
                onChange={handleFileSelection}
              />
            </>
          </div>
          <div>
            <Breadcrumbs />
          </div>
          <p className="text-sm text-muted-foreground">
            Add files above, or drop files and folders anywhere in this area.
          </p>
          <div className="bg-card border border-border rounded-2xl flex flex-col p-0">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] border-b border-border rounded-t-2xl p-2 text-lg font-medium">
              <div>Name</div>
              <div className="hidden sm:block">Last Modified</div>
              <div className="text-center">File Size</div>
              <div className="min-w-20 text-center">Options</div>
            </div>
            {existingDirItems &&
              existingDirItems.folders.map((dirItem) => {
                return (
                  <div
                    key={dirItem.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] border-b border-border p-2 items-center hover:bg-muted"
                  >
                    <FolderRow
                      folder={dirItem}
                      onOpen={() => updatePath(dirItem.name.replace("/", ""))}
                      onDelete={onDelete}
                    />
                  </div>
                );
              })}
            {existingDirItems &&
              existingDirItems.files.map((dirItem) => {
                return (
                  <div
                    key={dirItem.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] border-b border-border p-2 items-center"
                  >
                    <FileRow
                      file={dirItem}
                      onDownload={onDownload}
                      onDelete={onDelete}
                    />
                  </div>
                );
              })}
            {existingDirItems &&
              existingDirItems.folders.length === 0 &&
              existingDirItems.files.length === 0 && (
                <div className="p-6 text-center text-muted-foreground">
                  This folder is empty. Add files above or drop them here.
                </div>
              )}
            <div className="rounded-b-2xl p-2">
              <div className="flex gap-2 text-sm">
                <div>
                  <span>{existingDirItems?.folders.length ?? 0}</span>
                  <span>{" folders"}</span>
                </div>
                <div>
                  <span>{existingDirItems?.files.length ?? 0}</span>
                  <span>{" files"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RecentFiles;
