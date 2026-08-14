import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenPathOptions, OpenPathResult } from "../src/withmate-window-types.js";

export type ResolvedOpenPathTarget =
  | {
      type: "external-url";
      target: string;
    }
  | {
      type: "local-path";
      targetPath: string;
    };

export type LocalPathStat = {
  isDirectory(): boolean;
  isFile(): boolean;
};

export type OpenLocalPathDeps = {
  statTarget(targetPath: string): Promise<LocalPathStat>;
  openWithDefaultApp(targetPath: string): Promise<string>;
};

export type RevealLocalPathDeps = OpenLocalPathDeps & {
  revealInFileManager(targetPath: string): void;
};

function stripLocalPathFragment(target: string): string {
  const hashIndex = target.indexOf("#");
  const withoutFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const queryIndex = withoutFragment.indexOf("?");
  return queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
}

function isWindowsAbsolutePath(targetPath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(targetPath) || /^\\\\[^\\]+\\[^\\]+/.test(targetPath);
}

function normalizeLeadingSlashWindowsAbsolutePath(targetPath: string): string {
  return /^\/[a-zA-Z]:[\\/]/.test(targetPath) ? targetPath.slice(1) : targetPath;
}

function isWindowsFileUrl(url: URL): boolean {
  const hostname = url.hostname;
  if (hostname && hostname !== "localhost") {
    return true;
  }
  return /^\/[a-zA-Z]:\//.test(url.pathname)
    || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname);
}

function isSupportedExternalUrlScheme(scheme: string): boolean {
  return scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel";
}

function isProtocolRelativeExternalUrl(target: string): boolean {
  const match = /^\/\/([^/?#]+)(\/[^?#]*)?/.exec(target);
  const authority = match?.[1] ?? "";
  if (authority.includes(".") || authority.includes(":") || authority.toLowerCase() === "localhost") {
    return true;
  }

  const pathSegments = (match?.[2] ?? "").split("/").filter(Boolean);
  return pathSegments.length === 1;
}

function decodeLocalPathTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isForwardSlashUncPath(target: string): boolean {
  return /^\/\/[^/?#]+\/[^/?#]+(?:\/|$)/.test(target);
}

// Inputs that already look like protocol-relative URLs must not trigger UNC network probes.
export function resolveForwardSlashUncPathCandidate(target: string): string | null {
  const trimmed = target.trim();
  if (isProtocolRelativeExternalUrl(trimmed)) {
    return null;
  }

  const normalizedTarget = stripLocalPathFragment(trimmed).trim();
  if (!normalizedTarget) {
    return null;
  }
  const decodedTarget = decodeLocalPathTarget(normalizedTarget);
  if (!isForwardSlashUncPath(decodedTarget)) {
    return null;
  }
  return decodedTarget;
}

export function resolveProtocolRelativeExternalFallback(target: string): string | null {
  const trimmed = target.trim();
  return /^\/\/[^/?#]+/.test(trimmed) ? `https:${trimmed}` : null;
}

export function resolveOpenPathTarget(target: string, options: OpenPathOptions = {}): ResolvedOpenPathTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("開く対象が空だよ。");
  }

  const normalizedTarget = stripLocalPathFragment(trimmed).trim();
  const decodedTarget = normalizedTarget ? decodeLocalPathTarget(normalizedTarget) : "";
  if (isForwardSlashUncPath(decodedTarget) && !isProtocolRelativeExternalUrl(trimmed)) {
    return {
      type: "local-path",
      targetPath: decodedTarget,
    };
  }

  if (isProtocolRelativeExternalUrl(trimmed)) {
    return {
      type: "external-url",
      target: `https:${trimmed}`,
    };
  }

  const externalUrlSchemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (externalUrlSchemeMatch && isSupportedExternalUrlScheme(externalUrlSchemeMatch[1].toLowerCase())) {
    return {
      type: "external-url",
      target: trimmed,
    };
  }

  if (/^file:/i.test(trimmed)) {
    const fileUrl = new URL(trimmed);
    fileUrl.hash = "";
    fileUrl.search = "";
    if (isWindowsFileUrl(fileUrl)) {
      const pathname = decodeURIComponent(fileUrl.pathname).replace(/\//g, "\\");
      const hostname = fileUrl.hostname;
      const targetPath =
        hostname && hostname !== "localhost"
          ? `\\\\${hostname}${pathname}`
          : /^[\\][a-zA-Z]:\\/.test(pathname)
            ? pathname.slice(1)
            : pathname;
      return {
        type: "local-path",
        targetPath,
      };
    }
    return {
      type: "local-path",
      targetPath: fileURLToPath(fileUrl),
    };
  }

  if (!normalizedTarget) {
    throw new Error("開く対象の path が空だよ。");
  }

  const localTarget = normalizeLeadingSlashWindowsAbsolutePath(decodedTarget);

  if (path.isAbsolute(localTarget) || isWindowsAbsolutePath(localTarget)) {
    return {
      type: "local-path",
      targetPath: localTarget,
    };
  }

  const baseDirectory = options.baseDirectory?.trim();
  if (baseDirectory) {
    if (isWindowsAbsolutePath(baseDirectory)) {
      return {
        type: "local-path",
        targetPath: path.win32.resolve(baseDirectory, localTarget),
      };
    }
    return {
      type: "local-path",
      targetPath: path.resolve(baseDirectory, localTarget),
    };
  }

  return {
    type: "local-path",
    targetPath: localTarget,
  };
}

export function resolveMarkdownLinkCopyTarget(target: string): string {
  const resolvedTarget = resolveOpenPathTarget(target);
  const copyTarget = resolvedTarget.type === "local-path"
    ? resolvedTarget.targetPath
    : target;
  if (/[\u0000-\u001f\u007f]/.test(copyTarget)) {
    throw new Error("Markdown link copy target contains control characters.");
  }
  return copyTarget;
}

function isMissingLocalPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

export function resolveProtocolRelativeExternalFallbackAfterLocalOpen(
  target: string,
  localResult: OpenPathResult,
): string | null {
  return localResult.status === "not-found"
    ? resolveProtocolRelativeExternalFallback(target)
    : null;
}

function describeLocalPathError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error || "Unknown filesystem error");
}

function projectLocalPathStatError(targetPath: string, error: unknown): OpenPathResult {
  if (isMissingLocalPathError(error)) {
    return {
      status: "not-found",
      targetType: "local-path",
      target: targetPath,
      message: "The local path was not found.",
    };
  }

  return {
    status: "failed",
    targetType: "local-path",
    target: targetPath,
    message: `The local path could not be inspected: ${describeLocalPathError(error)}`,
  };
}

function projectUnsupportedLocalPathType(targetPath: string): OpenPathResult {
  return {
    status: "failed",
    targetType: "local-path",
    target: targetPath,
    message: "The local path is not a file or directory.",
  };
}

type InspectedLocalPath =
  | {
      targetPath: string;
      targetStat: LocalPathStat;
    }
  | {
      result: OpenPathResult;
    };

function resolveTextLocationFallbackPath(targetPath: string): string | null {
  const match = /^(.*):[1-9]\d*:[1-9]\d*$/.exec(targetPath)
    ?? /^(.*):[1-9]\d*$/.exec(targetPath);
  const fallbackPath = match?.[1] ?? "";
  return fallbackPath ? fallbackPath : null;
}

async function inspectLocalPath(
  targetPath: string,
  statTarget: OpenLocalPathDeps["statTarget"],
): Promise<InspectedLocalPath> {
  try {
    return {
      targetPath,
      targetStat: await statTarget(targetPath),
    };
  } catch (error) {
    if (!isMissingLocalPathError(error)) {
      return { result: projectLocalPathStatError(targetPath, error) };
    }

    const fallbackPath = resolveTextLocationFallbackPath(targetPath);
    if (!fallbackPath) {
      return { result: projectLocalPathStatError(targetPath, error) };
    }

    try {
      return {
        targetPath: fallbackPath,
        targetStat: await statTarget(fallbackPath),
      };
    } catch (fallbackError) {
      return {
        result: isMissingLocalPathError(fallbackError)
          ? projectLocalPathStatError(targetPath, error)
          : projectLocalPathStatError(fallbackPath, fallbackError),
      };
    }
  }
}

async function openExistingLocalPathWithDefaultApp(
  targetPath: string,
  openWithDefaultApp: OpenLocalPathDeps["openWithDefaultApp"],
): Promise<OpenPathResult> {
  try {
    const errorMessage = await openWithDefaultApp(targetPath);
    return errorMessage
      ? { status: "failed", targetType: "local-path", target: targetPath, message: errorMessage }
      : { status: "opened", targetType: "local-path", target: targetPath };
  } catch (error) {
    return {
      status: "failed",
      targetType: "local-path",
      target: targetPath,
      message: `The default application could not open this path: ${describeLocalPathError(error)}`,
    };
  }
}

export async function openLocalPathWithDefaultApp(
  targetPath: string,
  deps: OpenLocalPathDeps,
): Promise<OpenPathResult> {
  const inspected = await inspectLocalPath(targetPath, deps.statTarget);
  if ("result" in inspected) {
    return inspected.result;
  }

  if (!inspected.targetStat.isFile() && !inspected.targetStat.isDirectory()) {
    return projectUnsupportedLocalPathType(inspected.targetPath);
  }

  return openExistingLocalPathWithDefaultApp(inspected.targetPath, deps.openWithDefaultApp);
}

export async function revealLocalPathInFileManager(
  targetPath: string,
  deps: RevealLocalPathDeps,
): Promise<OpenPathResult> {
  const inspected = await inspectLocalPath(targetPath, deps.statTarget);
  if ("result" in inspected) {
    return inspected.result;
  }

  if (inspected.targetStat.isFile()) {
    try {
      deps.revealInFileManager(inspected.targetPath);
      return {
        status: "revealed",
        targetType: "local-path",
        target: inspected.targetPath,
        message: "The file was revealed in the file manager.",
      };
    } catch (error) {
      return {
        status: "failed",
        targetType: "local-path",
        target: inspected.targetPath,
        message: `The file could not be revealed: ${describeLocalPathError(error)}`,
      };
    }
  }

  if (inspected.targetStat.isDirectory()) {
    return openExistingLocalPathWithDefaultApp(inspected.targetPath, deps.openWithDefaultApp);
  }

  return projectUnsupportedLocalPathType(inspected.targetPath);
}
