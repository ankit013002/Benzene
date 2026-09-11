import React from "react";
import { HiOutlineDotsHorizontal } from "react-icons/hi";
import { FaRegTrashAlt } from "react-icons/fa";
import { FolderType } from "@/types/Folder";

interface FolderRowProps {
  folder: FolderType;
  onOpen: () => void;
  onDelete: (nodeId: string) => void;
}

const FolderRow = ({ folder, onOpen, onDelete }: FolderRowProps) => {
  const folderName = folder.name.replace("/", "");
  const confirmDelete = () => {
    if (
      window.confirm(
        `Remove “${folderName}” and everything inside it from your Vault?`,
      )
    ) {
      onDelete(folder.id);
    }
  };

  return (
    <>
      <button
        type="button"
        className="min-w-0 truncate text-left"
        onClick={onOpen}
        aria-label={`Open folder ${folderName}`}
      >
        {folderName}
      </button>
      <div className="hidden min-w-0 truncate sm:block">
        {folder.lastModified
          ? new Date(folder.lastModified).toLocaleString()
          : "—"}
      </div>
      <div className="text-center">
        <span>{folder.size.value + " " + folder.size.unit}</span>
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
            aria-label={`Options for ${folder.name}`}
            aria-haspopup="menu"
          >
            <HiOutlineDotsHorizontal />
          </button>
          <ul
            tabIndex={0}
            className="dropdown-content z-50 menu p-2 shadow bg-base-100 rounded-box "
          >
            {/* Downloading a folder would mean zipping a subtree server-side,
                which the file service does not do yet. */}
            <li className="tooltip" data-tip="Delete">
              <button
                type="button"
                onClick={confirmDelete}
                aria-label={`Delete ${folderName} and everything inside it`}
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

export default FolderRow;
