"use client";

import React, { useState } from "react";
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

  const params = useParams() as { path?: string[] };
  const currPath = (params?.path ?? []).join("/");

  const areFilesBeingReplaced = (dirBuffer: FileFolderBuffer[]) => {
    const buffer: string[] = [];

    if (!existingDirItems) {
      return;
    }

    dirBuffer
      .filter((item) => {
        if (item.file) {
          return existingDirItems.files.find(
            (existingFile) => existingFile.name === item.file!.name
          );
        } else if (item.folder) {
          return existingDirItems.folders.find((existingFolder) => {
            const folderName = existingFolder.name.replace("/", "");
            return folderName === item.folder;
          });
        }
      })
      .map((item) => {
        if (item.file) {
          buffer.push(item.file.name);
        } else if (item.folder) {
          buffer.push(item.folder);
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

  const handleDragDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    setIsDragging(false);

    const items = [...e.dataTransfer.items];
    const rootBuffer: FileFolderBuffer = {
      file: null,
      folder: "root",
      path: currPath,
      buffer: [],
    };
    const root = rootBuffer.buffer!;

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
  };

  const handleConfirmReplace = async () => {
    uploadDirItems(pendingItems);
    setReplaceFiles([]);
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
        <div className="w-full h-full border-dashed border-2 flex justify-center items-center">
          <FaPlus className="text-5xl" />
        </div>
      ) : (
        <div className="flex flex-col gap-5 h-full">
          <div className="text-2xl font-medium">Recent Files</div>
          <div>
            <Breadcrumbs />
          </div>
          <div className="bg-card border border-border rounded-2xl flex flex-col p-0">
            <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] border-b border-border rounded-t-2xl p-2 text-lg font-medium">
              <div>Name</div>
              <div>Owner</div>
              <div>Last Modified</div>
              <div className="text-center">File Size</div>
              <div className="min-w-20 text-center">Options</div>
            </div>
            {existingDirItems &&
              existingDirItems.folders.map((dirItem, index) => {
                return (
                  <div
                    onClick={() => updatePath(dirItem.name.replace("/", ""))}
                    key={index}
                    className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] border-b border-border p-2 items-center hover:cursor-pointer hover:bg-muted"
                  >
                    <FolderRow folder={dirItem} onDelete={onDelete} />
                  </div>
                );
              })}
            {existingDirItems &&
              existingDirItems.files.map((dirItem, index) => {
                return (
                  <div
                    key={index}
                    className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] border-b border-border p-2 items-center"
                  >
                    <FileRow
                      file={dirItem}
                      onDownload={onDownload}
                      onDelete={onDelete}
                    />
                  </div>
                );
              })}
            <div className="rounded-b-2xl p-2">
              <div className="flex gap-2 text-sm">
                <div>
                  <span>{existingDirItems?.folders.length}</span>
                  <span>{" folders"}</span>
                </div>
                <div>
                  <span>{existingDirItems?.files.length}</span>
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
