import type {
  SessionFileEncoding,
  SessionFileRoot,
  FileRootChangesResult,
  FileRootGitDiffScope,
} from "./file-explorer-contract.js";
import { findTextMatches } from "../find-text-matches.js";
import { detectSessionFileEncoding } from "./file-content-detection.js";

export type SessionFileEncodingSelection = "auto" | SessionFileEncoding;

export const SESSION_FILE_READ_CHUNK_BYTES = 1024 * 1024;
export const SESSION_FILE_LARGE_WARNING_BYTES = 50 * 1024 * 1024;

export class PreviewByteAccumulator {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private released = false;

  get retainedByteLength(): number {
    return this.byteLength;
  }

  append(bytes: Uint8Array): void {
    if (this.released) {
      throw new Error("File load was replaced.");
    }
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
  }

  finish(expectedByteLength: number): Uint8Array {
    if (this.released) {
      throw new Error("File load was replaced.");
    }
    if (this.byteLength !== expectedByteLength) {
      this.release();
      throw new Error("File contents changed while they were being read.");
    }
    const result = new Uint8Array(expectedByteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.release();
    return result;
  }

  release(): void {
    this.chunks = [];
    this.byteLength = 0;
    this.released = true;
  }
}

export function projectFileRootDiffAvailability(
  result: FileRootChangesResult,
  relativePath: string,
): { scopes: FileRootGitDiffScope[]; message: string } {
  if (result.status !== "ok") {
    return { scopes: [], message: "" };
  }
  const change = result.entries.find((entry) => entry.relativePath === relativePath);
  return {
    scopes: change?.scopes.filter((scope): scope is FileRootGitDiffScope => (
      scope !== "commit" && change.kinds[scope] !== "untracked"
    )) ?? [],
    message: "",
  };
}

export type AuthorizedMarkdownResource = {
  rootId: string;
  relativePath: string;
};

export type MarkdownImageTarget =
  | { kind: "external"; source: string }
  | { kind: "local"; resource: AuthorizedMarkdownResource }
  | { kind: "unsupported" };

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripQueryAndFragment(target: string): string {
  return target.split(/[?#]/, 1)[0] ?? target;
}

function isWindowsAbsolutePath(target: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(target) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(target);
}

function normalizeAbsolutePath(target: string): string {
  const slashPath = target.replace(/\\/g, "/");
  const normalized = slashPath.startsWith("//")
    ? `//${slashPath.slice(2).replace(/\/{2,}/g, "/")}`
    : slashPath.replace(/\/{2,}/g, "/");
  if (/^[a-zA-Z]:\/$/.test(normalized) || normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/$/, "");
}

function fileUrlToAbsolutePath(target: string): string | null {
  try {
    const url = new URL(target);
    if (url.protocol !== "file:") {
      return null;
    }
    const pathname = decodeUriComponentSafely(url.pathname);
    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${pathname}`;
    }
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

function absoluteMarkdownResourcePath(target: string): string | null {
  if (/^file:/i.test(target)) {
    return fileUrlToAbsolutePath(target);
  }
  const pathTarget = decodeUriComponentSafely(stripQueryAndFragment(target));
  return isWindowsAbsolutePath(pathTarget) || pathTarget.startsWith("/") ? pathTarget : null;
}

export function decodeSessionFileBytes(
  bytes: Uint8Array,
  selectedEncoding: SessionFileEncodingSelection,
  _suggestedEncoding: SessionFileEncoding,
): string {
  const encoding = selectedEncoding === "auto" ? detectSessionFileEncoding(bytes) : selectedEncoding;
  return new TextDecoder(encoding).decode(bytes);
}

export function splitPreviewLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export type PreviewTextMatch = {
  lineIndex: number;
  startOffset: number;
  endOffset: number;
};

export function findPreviewTextMatches(lines: string[], query: string): PreviewTextMatch[] {
  const matches: PreviewTextMatch[] = [];
  lines.forEach((line, index) => {
    for (const match of findTextMatches(line, query)) {
      matches.push({ lineIndex: index, ...match });
    }
  });
  return matches;
}

export function resolveRelativeMarkdownResourcePath(
  markdownRelativePath: string,
  resourceTarget: string,
): string | null {
  const normalizedTarget = decodeUriComponentSafely(stripQueryAndFragment(resourceTarget)).replace(/\\/g, "/");
  const baseSegments = markdownRelativePath.replace(/\\/g, "/").split("/").slice(0, -1);
  const targetSegments = normalizedTarget.startsWith("/") ? [] : baseSegments;

  for (const segment of normalizedTarget.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (targetSegments.length === 0) {
        return null;
      }
      targetSegments.pop();
      continue;
    }
    targetSegments.push(segment);
  }

  return targetSegments.join("/");
}

export function resolveAuthorizedMarkdownResource(
  roots: SessionFileRoot[],
  target: string,
): AuthorizedMarkdownResource | null {
  const absolutePath = absoluteMarkdownResourcePath(target);
  if (!absolutePath) {
    return null;
  }
  const normalizedTarget = normalizeAbsolutePath(absolutePath);
  const windowsPath = /^[a-zA-Z]:\//.test(normalizedTarget) || normalizedTarget.startsWith("//");
  const comparableTarget = windowsPath ? normalizedTarget.toLocaleLowerCase() : normalizedTarget;

  const matches = roots.flatMap((root) => {
    const normalizedRoot = normalizeAbsolutePath(root.displayPath);
    const comparableRoot = windowsPath ? normalizedRoot.toLocaleLowerCase() : normalizedRoot;
    if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}/`)) {
      return [];
    }
    const relativePath = normalizedTarget.slice(normalizedRoot.length).replace(/^\//, "");
    return relativePath ? [{ rootId: root.id, relativePath, rootLength: normalizedRoot.length }] : [];
  });
  matches.sort((left, right) => right.rootLength - left.rootLength);
  const match = matches[0];
  return match ? { rootId: match.rootId, relativePath: match.relativePath } : null;
}

export function resolveMarkdownImageTarget(
  roots: SessionFileRoot[],
  currentRootId: string,
  markdownRelativePath: string,
  target: string,
): MarkdownImageTarget {
  const trimmedTarget = target.trim();
  if (trimmedTarget.startsWith("//")) {
    return { kind: "external", source: `https:${trimmedTarget}` };
  }
  if (/^(?:https?:|data:image\/|blob:)/i.test(trimmedTarget)) {
    return { kind: "external", source: trimmedTarget };
  }

  const absoluteResource = resolveAuthorizedMarkdownResource(roots, trimmedTarget);
  if (absoluteResource) {
    return { kind: "local", resource: absoluteResource };
  }
  if (/^(?:file:|[a-zA-Z]:[\\/]|\\\\|\/)/i.test(trimmedTarget)) {
    return { kind: "unsupported" };
  }

  const relativePath = resolveRelativeMarkdownResourcePath(markdownRelativePath, trimmedTarget);
  return relativePath
    ? { kind: "local", resource: { rootId: currentRootId, relativePath } }
    : { kind: "unsupported" };
}

export function formatFileByteLength(byteLength: number): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KiB`;
  }
  if (byteLength < 1024 * 1024 * 1024) {
    return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(byteLength / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
