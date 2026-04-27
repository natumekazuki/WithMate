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

export function resolveOpenPathTarget(target: string, options: OpenPathOptions = {}): ResolvedOpenPathTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("開く対象が空だよ。");
  }

  if (/^https?:\/\//i.test(trimmed)) {
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
      const targetPath = /^[\\][a-zA-Z]:\\/.test(pathname) ? pathname.slice(1) : pathname;
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

  const normalizedTarget = stripLocalPathFragment(trimmed).trim();
  if (!normalizedTarget) {
    throw new Error("開く対象の path が空だよ。");
  }

  if (path.isAbsolute(normalizedTarget) || isWindowsAbsolutePath(normalizedTarget)) {
    return {
      type: "local-path",
      targetPath: normalizedTarget,
    };
  }

  const baseDirectory = options.baseDirectory?.trim();
  if (baseDirectory) {
    if (isWindowsAbsolutePath(baseDirectory)) {
      return {
        type: "local-path",
        targetPath: path.win32.resolve(baseDirectory, normalizedTarget),
      };
    }
    return {
      type: "local-path",
      targetPath: path.resolve(baseDirectory, normalizedTarget),
    };
  }

  return {
    type: "local-path",
    targetPath: normalizedTarget,
  };
}
