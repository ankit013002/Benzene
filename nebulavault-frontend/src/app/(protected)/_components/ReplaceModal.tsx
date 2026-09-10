"use client";

import React from "react";

interface ReplaceModalProps {
  replaceFiles: string[];
  handleCancelReplace: () => void;
  handleConfirmReplace: () => Promise<void>;
}

const ReplaceModal = ({
  replaceFiles,
  handleCancelReplace,
  handleConfirmReplace,
}: ReplaceModalProps) => {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background/70 z-50">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-[90%] max-w-md p-6 flex flex-col gap-4 animate-fade-in">
        <div className="text-center text-xl font-semibold text-foreground">
          Replace Files?
        </div>
        <div className="bg-muted rounded-lg p-3 max-h-40 overflow-y-auto text-sm text-muted-foreground">
          {replaceFiles.map((file) => (
            <div
              key={file}
              className="border-b border-border py-1 last:border-none"
            >
              {file}
            </div>
          ))}
        </div>
        <div className="flex w-full justify-end gap-3">
          <button
            className="btn btn-secondary px-5"
            onClick={() => handleCancelReplace()}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary px-5"
            onClick={() => handleConfirmReplace()}
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReplaceModal;
