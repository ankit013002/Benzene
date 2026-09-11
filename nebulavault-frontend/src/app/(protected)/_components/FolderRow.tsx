import React from "react";
import { HiOutlineDotsHorizontal } from "react-icons/hi";
import { FaRegTrashAlt } from "react-icons/fa";
import { FolderType } from "@/types/Folder";

interface FolderRowProps {
  folder: FolderType;
  onDelete: (nodeId: string) => void;
}

const FolderRow = ({ folder, onDelete }: FolderRowProps) => {
  return (
    <>
      <div>{folder.name.replace("/", "")}</div>
      <div>
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
          <button tabIndex={0} className="btn btn-ghost btn-sm ">
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
                onClick={() => onDelete(folder.id)}
                aria-label={`Delete ${folder.name}`}
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
