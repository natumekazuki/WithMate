import type {
  SessionFileEncoding,
  FileRootChangesResult,
  FileRootGitDiffScope,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { findTextMatches } from "../../src-shared/text/find-text-matches.js";
import { detectSessionFileEncoding } from "../../src-shared/file-explorer/file-content-detection.js";

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
  if (result.status === "failed") {
    return { scopes: [], message: result.message || "Git status failed." };
  }
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
