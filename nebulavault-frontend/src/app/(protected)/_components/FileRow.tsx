"use client";

import React from "react";
import { IoMdDownload } from "react-icons/io";
import { FaRegTrashAlt } from "react-icons/fa";
import { FileType } from "@/types/File";
import { HiOutlineDotsHorizontal } from "react-icons/hi";

interface FileRowProps {
  file: FileType;
  onDownload: (file: FileType) => void;
  onDelete: (nodeId: string) => void;
}

const FileRow = ({ file, onDownload, onDelete }: FileRowProps) => {
  // A reserved-but-unfinished upload has no bytes to fetch yet.
  const canDownload = file.hasContent !== false;
  const protection = file.protection;
  const isReducedProtection =
    protection?.state === "at_risk" ||
    (typeof protection?.healthyReplicas === "number" &&
      typeof protection.desiredReplicas === "number" &&
      protection.healthyReplicas < protection.desiredReplicas);

  return (
    <>
      <div className="min-w-0 flex items-center gap-2">
        <span className="truncate">{file.name}</span>
        {!canDownload && (
          <span className="badge badge-sm badge-warning">Uploading</span>
        )}
        {canDownload && isReducedProtection && (
          <span className="badge badge-sm badge-warning">Reduced protection</span>
        )}
      </div>
      <div className="hidden min-w-0 truncate sm:block">
        {file.lastModified ? new Date(file.lastModified).toLocaleString() : "—"}
      </div>
      <div className="text-center">
        <span>{file.size.value + " " + file.size.unit}</span>
      </div>
      <div className="justify-self-center min-w-20 flex justify-center items-center">
        <div
          className="dropdown dropdown-end"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            tabIndex={0}
            className="btn btn-ghost btn-sm"
            aria-label={`Options for ${file.name}`}
            aria-haspopup="menu"
          >
            <HiOutlineDotsHorizontal />
          </button>
          <ul
            tabIndex={0}
            className="dropdown-content z-50 menu p-2 shadow bg-base-100 rounded-box"
          >
            <li className="tooltip" data-tip="Download">
              <button
                onClick={() => onDownload(file)}
                disabled={!canDownload}
                aria-label={`Download ${file.name}`}
              >
                <IoMdDownload />
              </button>
            </li>
            <li className="tooltip" data-tip="Delete">
              <button
                onClick={() => onDelete(file.id)}
                aria-label={`Delete ${file.name}`}
              >
                <FaRegTrashAlt />
              </button>
            </li>
          </ul>
        </div>
      </div>
    </>
  );
};

export default FileRow;
