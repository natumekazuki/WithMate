import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { BackgroundMemoryFileAccess } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { isPathWithinAnyDirectory, isPathWithinDirectory } from "../files/additional-directories.js";

export class BackgroundMemoryFileAccessError extends Error {
  constructor(readonly effect: "none" | "partial" = "none") {
    super("Background Memory file path is not accessible.");
    this.name = "BackgroundMemoryFileAccessError";
  }
}

export async function captureBackgroundMemoryFileAccess(input: {
  readRoots: readonly string[];
  sessionFolderPath: string;
  writable: boolean;
}): Promise<BackgroundMemoryFileAccess> {
  const canonicalDirectory = async (directory: string): Promise<string | null> => {
    if (!directory.trim() || !path.isAbsolute(directory)) return null;
    try {
      const resolved = await realpath(directory);
      if (!(await stat(resolved)).isDirectory()) return null;
      await access(resolved, constants.R_OK);
      return resolved;
    } catch {
      return null;
    }
  };
  const sessionFolder = await canonicalDirectory(input.sessionFolderPath);
  const roots = await Promise.all(input.readRoots.map(canonicalDirectory));
  return {
    readRoots: [...new Set([...roots, sessionFolder].filter((root): root is string => root !== null))],
    exportRoot: input.writable && sessionFolder ? path.join(sessionFolder, "memory-exports") : null,
  };
}

export async function resolveBackgroundMemoryImportPath(filePath: string, scope: BackgroundMemoryFileAccess): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new BackgroundMemoryFileAccessError();
  return resolveThroughExistingAncestor(filePath, (_ancestor, resolved) => isPathWithinAnyDirectory(resolved, scope.readRoots));
}

/** Resolve missing descendants through their nearest existing ancestor without creating directories. */
export async function resolveBackgroundMemoryExportPath(outputPath: string, scope: BackgroundMemoryFileAccess): Promise<string> {
  const root = scope.exportRoot;
  if (!root || !path.isAbsolute(outputPath) || !isPathWithinDirectory(outputPath, root)) {
    throw new BackgroundMemoryFileAccessError();
  }
  return resolveThroughExistingAncestor(outputPath, (ancestor, resolved) =>
    isPathWithinDirectory(ancestor, path.dirname(root)) && isPathWithinDirectory(resolved, root));
}

async function resolveThroughExistingAncestor(targetPath: string, permitted: (ancestor: string, resolved: string) => boolean): Promise<string> {
  let ancestor = path.resolve(targetPath);
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      const resolved = path.join(canonical, ...missing);
      if (!permitted(canonical, resolved)) {
        throw new BackgroundMemoryFileAccessError();
      }
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) throw new BackgroundMemoryFileAccessError();
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new BackgroundMemoryFileAccessError();
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
