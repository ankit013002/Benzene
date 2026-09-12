"use client";

import React from "react";
import { IoMdDownload } from "react-icons/io";
import { FaRegTrashAlt } from "react-icons/fa";
import { FileType, type FileAvailability } from "@/types/File";
import { HiOutlineDotsHorizontal } from "react-icons/hi";

interface FileRowProps {
  file: FileType;
  onDownload: (file: FileType) => void;
  onDelete: (nodeId: string) => void;
}

const AVAILABILITY_LABEL: Record<FileAvailability, string> = {
  available: "Available",
  waiting_for_device: "Waiting for device",
  restoring_protection: "Restoring protection",
  unavailable: "Unavailable",
};

const FileRow = ({ file, onDownload, onDelete }: FileRowProps) => {
  // A reserved-but-unfinished upload has no bytes to fetch yet. A known
  // offline holder cannot serve a browser download until a device returns.
  const hasContent = file.hasContent !== false;
  const availability = file.protection?.availability;
  const canDownload =
    hasContent && availability !== "waiting_for_device" && availability !== "unavailable";
  const protection = file.protection;
  const confirmDelete = () => {
    if (window.confirm(`Remove “${file.name}” from your Vault?`)) {
      onDelete(file.id);
    }
  };
  const isReducedProtection =
    protection?.state === "at_risk" ||
    (typeof protection?.healthyReplicas === "number" &&
      typeof protection.desiredReplicas === "number" &&
      protection.healthyReplicas < protection.desiredReplicas);

  const statusLabel =
    availability === "unavailable" && protection?.state === "at_risk"
      ? "Unavailable · At risk"
      : availability && availability !== "available"
        ? AVAILABILITY_LABEL[availability]
        : isReducedProtection
          ? protection?.state === "at_risk"
            ? "At risk"
            : "Reduced protection"
          : null;
  const statusClass =
    availability === "unavailable" ||
    (availability !== "waiting_for_device" &&
      availability !== "restoring_protection" &&
      protection?.state === "at_risk")
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-warning/40 bg-warning/10 text-warning";

  return (
    <>
      <div className="min-w-0 flex items-center gap-2">
        <span className="truncate">{file.name}</span>
        {!hasContent && (
          <span className="badge badge-sm badge-warning">Uploading</span>
        )}
        {hasContent && statusLabel && (
          <span className={`badge badge-sm border ${statusClass}`}>
            {statusLabel}
          </span>
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
                type="button"
                onClick={() => onDownload(file)}
                disabled={!canDownload}
                aria-label={`Download ${file.name}`}
              >
                <IoMdDownload />
              </button>
            </li>
            <li className="tooltip" data-tip="Delete">
              <button
                type="button"
                onClick={confirmDelete}
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
