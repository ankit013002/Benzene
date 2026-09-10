import {
  FileFolderBuffer,
  FlatFile,
  FlatFolder,
} from "../../types/FileFolderBuffer";

/** The webkit-prefixed drag/drop entry API is not consistently in lib.dom. */
interface FileSystemEntryLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (
    onSuccess: (file: File) => void,
    onError: (error: unknown) => void,
  ) => void;
  createReader?: () => FileSystemDirectoryReaderLike;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (
    onSuccess: (entries: FileSystemEntryLike[]) => void,
    onError: (error: unknown) => void,
  ) => void;
}

const entryToFile = (fileEntry: FileSystemEntryLike) =>
  new Promise<File>((resolve, reject) => {
    if (!fileEntry.file) {
      reject(new Error("Dropped file entry could not be read"));
      return;
    }
    fileEntry.file(resolve, reject);
  });

const readAllEntries = (reader: FileSystemDirectoryReaderLike) =>
  new Promise<FileSystemEntryLike[]>((resolve, reject) => {
    const out: FileSystemEntryLike[] = [];
    const read = () =>
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) resolve(out);
          else {
            out.push(...batch);
            read();
          }
        },
        reject,
      );
    read();
  });

export const walkEntry = async (
  entry: FileSystemEntryLike,
  parentPath: string,
  into: FileFolderBuffer[]
) => {
  if (entry.isFile) {
    const file = await entryToFile(entry);
    into.push({
      file,
      folder: null,
      path: parentPath,
      buffer: null,
    });
  } else if (entry.isDirectory) {
    const childBuffer: FileFolderBuffer[] = [];
    const dirNode: FileFolderBuffer = {
      file: null,
      folder: entry.name,
      path: parentPath,
      buffer: childBuffer,
    };
    into.push(dirNode);

    if (!entry.createReader) return;
    const reader = entry.createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await walkEntry(child, `${parentPath}${entry.name}/`, childBuffer);
    }
  }
};

export function splitBuffers(
  nodes: FileFolderBuffer[],
  base = ""
): {
  files: FlatFile[];
  emptyFolders: string[];
  folders: FlatFolder[];
} {
  const files: FlatFile[] = [];
  const emptyFolders: string[] = [];
  const folders: FlatFolder[] = [];

  const walk = (list: FileFolderBuffer[], currBase: string) => {
    for (const node of list) {
      const relPath = (node.path || "/")
        .replace(/^\/+/, "")
        .replace(/\\/g, "/");
      if (node.file) {
        files.push({ file: node.file, path: relPath ? relPath : "" });
      } else if (node.folder) {
        folders.push({ name: node.folder, path: relPath });
        const folderPath = (currBase + node.folder + "/").replace(/\\/g, "/");
        const children = node.buffer ?? [];
        if (children.length === 0) {
          emptyFolders.push(folderPath);
        } else {
          walk(children, folderPath);
        }
      }
    }
  };

  walk(nodes, base);
  return { files, emptyFolders, folders };
}
