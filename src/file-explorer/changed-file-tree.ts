import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
} from "./file-explorer-contract.js";

export type ChangedFileTreeDirectory = {
  type: "directory";
  name: string;
  relativePath: string;
  children: ChangedFileTreeNode[];
};

export type ChangedFileTreeFile = {
  type: "file";
  name: string;
  relativePath: string;
  entry: FileRootGitChangeEntry;
};

export type ChangedFileTreeNode = ChangedFileTreeDirectory | ChangedFileTreeFile;

type MutableDirectory = {
  name: string;
  relativePath: string;
  directories: Map<string, MutableDirectory>;
  files: ChangedFileTreeFile[];
};

function pathBasename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" })
    || left.localeCompare(right);
}

function compareNodes(left: ChangedFileTreeNode, right: ChangedFileTreeNode): number {
  const typeOrder = (left.type === "directory" ? 0 : 1) - (right.type === "directory" ? 0 : 1);
  return typeOrder
    || compareNames(left.name, right.name)
    || left.relativePath.localeCompare(right.relativePath);
}

function finishDirectory(directory: MutableDirectory): ChangedFileTreeNode[] {
  return [
    ...[...directory.directories.values()].map((child): ChangedFileTreeDirectory => ({
      type: "directory",
      name: child.name,
      relativePath: child.relativePath,
      children: finishDirectory(child),
    })),
    ...directory.files,
  ].sort(compareNodes);
}

export function changedFileDisplayName(entry: FileRootGitChangeEntry): string {
  return entry.previousRelativePath
    ? `${pathBasename(entry.previousRelativePath)} → ${pathBasename(entry.relativePath)}`
    : pathBasename(entry.relativePath);
}

export function buildChangedFileTree(
  entries: FileRootGitChangeEntry[],
  scope: FileRootGitChangeScope,
): ChangedFileTreeNode[] {
  const root: MutableDirectory = {
    name: "",
    relativePath: "",
    directories: new Map(),
    files: [],
  };
  for (const entry of entries) {
    if (!entry.scopes.includes(scope)) {
      continue;
    }
    const segments = entry.relativePath.split("/");
    const fileName = segments.pop();
    if (!fileName) {
      continue;
    }
    let directory = root;
    let directoryPath = "";
    for (const segment of segments) {
      directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = {
          name: segment,
          relativePath: directoryPath,
          directories: new Map(),
          files: [],
        };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({
      type: "file",
      name: fileName,
      relativePath: entry.relativePath,
      entry,
    });
  }
  return finishDirectory(root);
}
