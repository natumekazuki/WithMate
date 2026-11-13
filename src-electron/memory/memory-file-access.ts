import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { MemoryFileAccess } from "../../src-shared/memory/memory-file-access.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { isPathWithinAnyDirectory, isPathWithinDirectory } from "../files/additional-directories.js";

export class MemoryFileAccessError extends Error {
  constructor(readonly effect: "none" | "partial" = "none") {
    super("Memory file path is not accessible.");
    this.name = "MemoryFileAccessError";
  }
}

export async function captureBackgroundMemoryFileAccess(input: {
  readRoots: readonly string[];
  sessionFolderPath: string;
  writable: boolean;
}): Promise<MemoryFileAccess> {
  const sessionFolder = await canonicalDirectory(input.sessionFolderPath);
  const roots = await Promise.all(input.readRoots.map(canonicalDirectory));
  return {
    readRoots: [...new Set([...roots, sessionFolder].filter((root): root is string => root !== null))],
    exportRoot: input.writable && sessionFolder ? path.join(sessionFolder, "memory-exports") : null,
  };
}

export async function captureSessionMemoryFileAccess(
  session: Pick<Session, "workspacePath" | "allowedAdditionalDirectories" | "provider">,
  executionOptions: SessionExecutionOptions | undefined,
  sessionFolderPath: string,
  outputPath?: string,
): Promise<MemoryFileAccess> {
  const roots = await Promise.all([session.workspacePath, ...session.allowedAdditionalDirectories, sessionFolderPath].map(canonicalDirectory));
  const readRoots = [...new Set(roots.filter((root): root is string => root !== null))];
  const writable = executionOptions && executionOptions.approvalMode !== "plan"
    && (session.provider !== "codex" || executionOptions.codexSandboxMode !== "read-only");
  let exportRoot: string | null = null;
  if (writable && outputPath && path.isAbsolute(outputPath)) {
    const resolved = await resolveThroughExistingAncestor(outputPath, () => true).catch(() => null);
    exportRoot = resolved ? readRoots.find((root) => isPathWithinDirectory(resolved, root)) ?? null : null;
  }
  return {
    readRoots,
    exportRoot,
  };
}

async function canonicalDirectory(directory: string): Promise<string | null> {
  if (!directory.trim() || !path.isAbsolute(directory)) return null;
  try {
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) return null;
    await access(resolved, constants.R_OK);
    return resolved;
  } catch {
    return null;
  }
}

export async function resolveMemoryImportPath(filePath: string, scope: MemoryFileAccess): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new MemoryFileAccessError();
  return resolveThroughExistingAncestor(filePath, (_ancestor, resolved) => isPathWithinAnyDirectory(resolved, scope.readRoots));
}

/** Resolve missing descendants through their nearest existing ancestor without creating directories. */
export async function resolveMemoryExportPath(outputPath: string, scope: MemoryFileAccess): Promise<string> {
  const root = scope.exportRoot;
  if (!root || !path.isAbsolute(outputPath)) {
    throw new MemoryFileAccessError();
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
        throw new MemoryFileAccessError();
      }
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) throw new MemoryFileAccessError();
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new MemoryFileAccessError();
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
