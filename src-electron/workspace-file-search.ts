import path from "node:path";

import { scanWorkspacePaths } from "./snapshot-ignore.js";

const DEFAULT_SEARCH_LIMIT = 20;

type WorkspaceFileIndex = {
  workspacePath: string;
  files: string[];
};

const workspaceFileIndexCache = new Map<string, WorkspaceFileIndex>();

async function getWorkspaceFileIndex(workspacePath: string): Promise<WorkspaceFileIndex> {
  const normalizedWorkspacePath = path.resolve(workspacePath);
  const cached = workspaceFileIndexCache.get(normalizedWorkspacePath);
  if (cached) {
    return cached;
  }

  const scanned = await scanWorkspacePaths(normalizedWorkspacePath);
  const nextIndex: WorkspaceFileIndex = {
    workspacePath: normalizedWorkspacePath,
    files: scanned.includedFiles,
  };
  workspaceFileIndexCache.set(normalizedWorkspacePath, nextIndex);
  return nextIndex;
}

export async function searchWorkspaceFilePaths(workspacePath: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<string[]> {
  const normalizedQuery = query.trim().replace(/\\/g, "/").toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const index = await getWorkspaceFileIndex(workspacePath);
  return index.files
    .map((relativePath) => ({
      relativePath,
      normalizedPath: relativePath.toLocaleLowerCase(),
    }))
    .map((entry) => ({
      ...entry,
      matchIndex: entry.normalizedPath.indexOf(normalizedQuery),
    }))
    .filter((entry) => entry.matchIndex >= 0)
    .sort((left, right) => {
      if (left.matchIndex !== right.matchIndex) {
        return left.matchIndex - right.matchIndex;
      }

      if (left.relativePath.length !== right.relativePath.length) {
        return left.relativePath.length - right.relativePath.length;
      }

      return left.relativePath.localeCompare(right.relativePath);
    })
    .slice(0, limit)
    .map((entry) => entry.relativePath);
}

export function clearWorkspaceFileIndex(workspacePath?: string): void {
  if (!workspacePath) {
    workspaceFileIndexCache.clear();
    return;
  }

  workspaceFileIndexCache.delete(path.resolve(workspacePath));
}
