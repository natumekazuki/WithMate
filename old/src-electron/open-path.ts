import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenPathOptions } from "../src/withmate-window-types.js";

export type ResolvedOpenPathTarget =
  | {
      type: "external-url";
      target: string;
    }
  | {
      type: "local-path";
      targetPath: string;
    };

export type OpenPathFallbackCommand = {
  command: string;
  args: string[];
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

function isWindowsFileUrl(url: URL): boolean {
  const hostname = url.hostname;
  if (hostname && hostname !== "localhost") {
    return true;
  }
  return /^\/[a-zA-Z]:\//.test(url.pathname);
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

  if (trimmed.startsWith("file://")) {
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

  if (path.isAbsolute(decodedTarget) || isWindowsAbsolutePath(decodedTarget)) {
    return {
      type: "local-path",
      targetPath: decodedTarget,
    };
  }

  const baseDirectory = options.baseDirectory?.trim();
  if (baseDirectory) {
    if (isWindowsAbsolutePath(baseDirectory)) {
      return {
        type: "local-path",
        targetPath: path.win32.resolve(baseDirectory, decodedTarget),
      };
    }
    return {
      type: "local-path",
      targetPath: path.resolve(baseDirectory, decodedTarget),
    };
  }

  return {
    type: "local-path",
    targetPath: decodedTarget,
  };
}

export function buildDirectoryOpenFallbackCommand(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): OpenPathFallbackCommand | null {
  if (platform !== "win32") {
    return null;
  }

  return {
    command: "explorer.exe",
    args: [targetPath],
  };
}
