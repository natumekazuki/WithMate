import type {
  SessionFileEncoding,
  FileRootChangesResult,
  FileRootGitDiffScope,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { findTextMatches } from "../../src-shared/text/find-text-matches.js";
import { detectSessionFileEncoding } from "../../src-shared/file-explorer/file-content-detection.js";

/** ファイル本文を自動判定で読むか、特定の文字コードで読むかの選択。 */
export type SessionFileEncodingSelection = "auto" | SessionFileEncoding;

/** プレビューがファイルを分割して取得するときの一片の大きさ。 */
export const SESSION_FILE_READ_CHUNK_BYTES = 1024 * 1024;
/** 大きなファイルの読み取りを開始する前に確認を表示する基準。 */
export const SESSION_FILE_LARGE_WARNING_BYTES = 50 * 1024 * 1024;

/** 取得した順で読み取り片を保持し、期待した総バイト数に達したときだけ連結結果を返す。 */
export class PreviewByteAccumulator {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private released = false;

  /** まだ解放していない読み取り片の総バイト数を返す。 */
  get retainedByteLength(): number {
    return this.byteLength;
  }

  /** 受け取った片を順序を保って追加し、解放後に届いた追加は拒否する。 */
  append(bytes: Uint8Array): void {
    if (this.released) {
      throw new Error("File load was replaced.");
    }
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
  }

  /** サイズが一致すれば連結して解放し、不一致なら保持済みの片を捨てて失敗にする。 */
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

  /** 片への参照を手放し、同じ読み取りの続きや再利用を受け付けない状態にする。 */
  release(): void {
    this.chunks = [];
    this.byteLength = 0;
    this.released = true;
  }
}

/** 指定パスの取得可能な作業差分を示す。未追跡・コミットの範囲は除き、Git の取得失敗は別に返す。 */
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
  const change = result.entries.find(
    (entry) => entry.relativePath === relativePath,
  );
  return {
    scopes:
      change?.scopes.filter(
        (scope): scope is FileRootGitDiffScope =>
          scope !== "commit" && change.kinds[scope] !== "untracked",
      ) ?? [],
    message: "",
  };
}

/** 手動指定した文字コードを使い、自動の場合は提案値ではなく取得したバイト列から判定する。 */
export function decodeSessionFileBytes(
  bytes: Uint8Array,
  selectedEncoding: SessionFileEncodingSelection,
  _suggestedEncoding: SessionFileEncoding,
): string {
  const encoding =
    selectedEncoding === "auto"
      ? detectSessionFileEncoding(bytes)
      : selectedEncoding;
  return new TextDecoder(encoding).decode(bytes);
}

/** CRLF、LF、CR のいずれでも本文を行へ分け、空行も残す。 */
export function splitPreviewLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** プレビューの一致箇所を、行番号とその行内の開始・終了オフセットで示す。 */
export type PreviewTextMatch = {
  lineIndex: number;
  startOffset: number;
  endOffset: number;
};

/** 各行を個別に検索し、一致範囲に行インデックスを付けて本文順に返す。 */
export function findPreviewTextMatches(
  lines: string[],
  query: string,
): PreviewTextMatch[] {
  const matches: PreviewTextMatch[] = [];
  lines.forEach((line, index) => {
    for (const match of findTextMatches(line, query)) {
      matches.push({ lineIndex: index, ...match });
    }
  });
  return matches;
}

/** サイズを1024基準で B・KiB・MiB・GiB に分け、単位に応じた桁数で表示する。 */
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
