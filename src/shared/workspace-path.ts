import { createHash } from "node:crypto";
import path from "node:path";

export const WORKSPACE_PATH_MAX_LENGTH = 32_768;

export type WorkspaceIdentity = Readonly<{
  workspacePath: string;
  workspaceKey: string;
}>;

export function resolveWorkspaceIdentity(value: string): WorkspaceIdentity | undefined {
  const normalized = normalizeHostAbsolutePath(value);
  if (normalized === undefined || normalized.path.length > WORKSPACE_PATH_MAX_LENGTH) return undefined;
  return {
    workspacePath: normalized.path,
    workspaceKey: `workspace-sha256-${createHash("sha256").update(normalized.comparisonKey, "utf8").digest("hex")}`,
  };
}

export function normalizeHostAbsolutePath(
  value: string,
): Readonly<{ path: string; comparisonKey: string }> | undefined {
  if (!isHostFullyQualifiedPath(value)) return undefined;
  const normalizedPath = stripTrailingSeparators(path.normalize(value));
  return {
    path: normalizedPath,
    comparisonKey: process.platform === "win32" ? normalizedPath.toLocaleLowerCase("en-US") : normalizedPath,
  };
}

function stripTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  let end = value.length;
  while (end > root.length && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

function isHostFullyQualifiedPath(value: string): boolean {
  if (process.platform !== "win32") return path.isAbsolute(value);

  const windowsPath = value.replaceAll("/", "\\");
  if (/^[A-Za-z]:\\/.test(windowsPath)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(windowsPath)) return true;
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(windowsPath)) return true;
  if (/^\\\\[.?]\\/.test(windowsPath)) return false;
  return /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(windowsPath);
}
