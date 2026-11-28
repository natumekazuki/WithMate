import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  SessionDirectoryEntry,
  SessionDirectoryRequest,
  SessionFileChunkRequest,
  SessionFileChunkResult,
  SessionImageResourceRequest,
  SessionImageChunkRequest,
  SessionPdfResourceRequest,
  SessionPdfChunkRequest,
  SessionFileDescriptor,
  SessionFileOpenRequest,
  SessionFileAbsoluteResourceRequest,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRootResourceRequest,
  SessionFilePreviewTargetResolution,
  SessionFileRoot,
  SessionFileRootKind,
  SessionFilePin,
  SessionFilePinOwner,
  SessionFilePinReference,
  StoredSessionFilePin,
  SessionFileTreePathActionNodeKind,
  SessionFileTreePathActionTargetRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  isSessionFileAbsoluteResource,
  isSessionFileGitCommitResource,
  isSessionFileRootResource,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  detectSessionFileResourceKind,
  detectSessionFileEncoding,
} from "../../src-shared/file-explorer/file-content-detection.js";
import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";
import {
  listIdentityBoundDirectory,
  type IdentityBoundDirectorySnapshot,
} from "./identity-bound-directory-listing.js";
import {
  resolveCrewFilesDirectory,
  resolveSessionFilesDirectory,
} from "./session-files.js";
import { resolveOpenPathTarget } from "./open-path.js";
import type { SessionFilePinStorage } from "../storage/persistent-store-lifecycle-service.js";

const MAX_CHUNK_BYTES = 1024 * 1024;
const INSPECTION_BYTES = 8192;
const MAX_CONCURRENT_DIRECTORY_LISTINGS = 4;
const MAX_PENDING_DIRECTORY_LISTINGS = 32;

/** PDFの先頭識別子を確認し、拡張子だけでPDFとして扱わない。 */
function detectLocalPdfResource(bytes: Uint8Array): {
  kind: "pdf";
  mimeType: string;
} {
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("The local PDF target is not a PDF.");
  }
  return { kind: "pdf", mimeType: "application/pdf" };
}

/** 先頭のバイト列で対応形式を判定し、SVGとラスタ画像を区別する。判定できない種別は拒否する。 */
function detectLocalImageResource(bytes: Uint8Array): {
  kind: "image" | "svg";
  mimeType: string;
} {
  const text = new TextDecoder("latin1").decode(bytes);
  const svgEncoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const svgHeader = new TextDecoder(svgEncoding)
    .decode(bytes)
    .trimStart()
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, "")
    .replace(/^<!DOCTYPE\s+svg\b(?:[^>\[]|\[[\s\S]*?\])*>\s*/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, "");
  if (/^<svg\b/i.test(svgHeader)) {
    return { kind: "svg", mimeType: "image/svg+xml" };
  }
  /** ファイル先頭が指定のマジックバイト列と一致するか確認する。 */
  const signature = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  let mimeType: string | null = null;
  if (signature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    mimeType = "image/png";
  else if (signature(0xff, 0xd8, 0xff)) mimeType = "image/jpeg";
  else if (/^GIF8[79]a/.test(text)) mimeType = "image/gif";
  else if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP")
    mimeType = "image/webp";
  else if (signature(0x42, 0x4d)) mimeType = "image/bmp";
  else if (
    signature(0, 0, 1, 0) &&
    bytes.length >= 6 &&
    (bytes[4] !== 0 || bytes[5] !== 0)
  )
    mimeType = "image/x-icon";
  else if (text.slice(4, 8) === "ftyp") {
    const boxLength =
      bytes.length >= 4
        ? new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).getUint32(0)
        : 0;
    for (
      let offset = 8;
      offset + 4 <= Math.min(bytes.length, boxLength);
      offset += 4
    ) {
      if (offset === 12) continue;
      if (["avif", "avis"].includes(text.slice(offset, offset + 4))) {
        mimeType = "image/avif";
        break;
      }
    }
  }
  if (!mimeType) {
    throw new Error("The local image target is not a supported image.");
  }
  return { kind: "image", mimeType };
}

/** ディレクトリ一覧の待機中にファイルを開かないよう、要求の同一性と遅延実行をまとめる。 */
type DirectoryListingJob = {
  supersessionKey: string;
  /** 実行枠を取得してから、対象を検証して一覧を取得する。 */
  execute(): Promise<IdentityBoundDirectorySnapshot>;
  /** 取得結果をこの要求の呼び出し元に渡す。 */
  resolve(snapshot: IdentityBoundDirectorySnapshot): void;
  /** 実行失敗や後続要求による置き換えをこの要求の呼び出し元に伝える。 */
  reject(error: unknown): void;
};

const pendingDirectoryListings: DirectoryListingJob[] = [];
let activeDirectoryListings = 0;

/** 空いている実行枠を新しい待機要求から埋め、成功・失敗どちらでも枠を次の要求に戻す。 */
function drainDirectoryListingQueue(): void {
  while (
    activeDirectoryListings < MAX_CONCURRENT_DIRECTORY_LISTINGS &&
    pendingDirectoryListings.length > 0
  ) {
    const job = pendingDirectoryListings.pop()!;
    activeDirectoryListings += 1;
    Promise.resolve()
      .then(() => job.execute())
      .then(job.resolve, job.reject)
      .finally(() => {
        activeDirectoryListings -= 1;
        drainDirectoryListingQueue();
      });
  }
}

/** プロセス全体で実行・待機数を制限し、待機上限では同じ要求先の古い待機要求だけを置き換える。 */
function listDirectoryWithAdmission(
  supersessionKey: string,
  execute: () => Promise<IdentityBoundDirectorySnapshot>,
): Promise<IdentityBoundDirectorySnapshot> {
  return new Promise((resolve, reject) => {
    if (pendingDirectoryListings.length >= MAX_PENDING_DIRECTORY_LISTINGS) {
      const supersededIndex = pendingDirectoryListings.findIndex(
        (job) => job.supersessionKey === supersessionKey,
      );
      if (supersededIndex >= 0) {
        pendingDirectoryListings
          .splice(supersededIndex, 1)[0]
          ?.reject(
            new Error(
              "Directory listing was superseded by a newer request for the same directory.",
            ),
          );
      } else {
        reject(new Error("Too many directory listings are already waiting."));
        return;
      }
    }
    pendingDirectoryListings.push({
      supersessionKey,
      execute,
      resolve,
      reject,
    });
    drainDirectoryListingQueue();
  });
}

/** 要求元に使える参照ルートとピン所有者を決めるための、親・Crew・追加ディレクトリの情報。 */
export type SessionFileExplorerContext = {
  workspacePath: string;
  parentSessionId: string;
  parentIncarnationId?: string;
  crewRootSessionId?: string;
  allowedAdditionalDirectories: string[];
};

/** パスを再解決せず、開いた実体の照合と位置指定読み取りを行うハンドル。 */
type ReadableFileHandle = {
  /** 開いた実体の識別子と時刻を精度を落とさず取得する。 */
  stat(options: { bigint: true }): Promise<BigIntStats>;
  /** ファイル上の指定位置から、呼び出し元のバッファーへ読み取る。 */
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  /** 開いたハンドルを解放する。 */
  close(): Promise<void>;
};

/** セッションの許可情報・ピン保存・ファイルシステムとOS連携の依存先。 */
export type SessionFileExplorerServiceDeps = {
  userDataPath: string;
  /** 要求元の最新の参照範囲を取得する。セッションが見つからなければnullを返す。 */
  getSessionContext(
    sessionId: string,
  ): Promise<SessionFileExplorerContext | null>;
  /** 永続化されたピンを扱うときに保存先を取得する。 */
  getPinStorage?(): SessionFilePinStorage;
  /** リンクをたどって対象の情報を取得する。未指定時はNodeのstatを使う。 */
  statPath?(
    targetPath: string,
    options: { bigint: true },
  ): Promise<BigIntStats>;
  /** 末尾のリンクをたどらず対象の情報を取得する。未指定時はNodeのlstatを使う。 */
  lstatPath?(
    targetPath: string,
    options: { bigint: true },
  ): Promise<BigIntStats>;
  /** 認可対象を読み取り専用で開く。未指定時はNodeのopenを使う。 */
  openFile?(targetPath: string, flags: "r"): Promise<ReadableFileHandle>;
  /** 対象ディレクトリの実体の識別子と、その実体から取得した直下一覧を返す。 */
  listDirectory?(targetPath: string): Promise<IdentityBoundDirectorySnapshot>;
  /** 検証済みのパスをOSで開くか、ファイルマネージャーで表示する。 */
  openResolvedPath?(
    targetPath: string,
    reveal: boolean,
  ): Promise<OpenPathResult>;
};

/** パスを使った操作の結果と、操作後の再確認で同じ実体を指していたかを分けて返す。 */
export type AuthorizedSessionFileOperationResult<T> = {
  result: T;
  targetStillCurrent: boolean;
};

/** 表示用のルート情報に、Mainで参照先を解決する絶対パスを付けたもの。 */
export type ResolvedSessionFileRoot = SessionFileRoot & {
  absolutePath: string;
};

/** ルートの設定上のパスと正規パス、およびリンク解決前の対象を照合するための候補。 */
type ResolvedTargetCandidate = {
  rootAbsolutePath: string;
  rootRealPath: string;
  unresolvedTargetPath: string;
};

/** ツリーのパス操作で用いる、現在のルートとその配下のリンク解決前のパス。 */
type ResolvedPathActionCandidate = {
  rootAbsolutePath: string;
  rootKind: SessionFileRootKind;
  unresolvedTargetPath: string;
};

/** 検証済み実体のパスとハンドル。返却されたハンドルは呼び出し側が閉じる。 */
type AuthorizedOpenedFile = {
  candidate: ResolvedTargetCandidate;
  handle: ReadableFileHandle;
  stats: BigIntStats;
  targetRealPath: string;
};

/** ハンドルを開いた後に照合する対象種別。 */
type AuthorizedResourceKind = "file" | "directory";

/** 絶対パス形式のプレビュー要求を検証し、ルート指定との混在を拒否する。 */
function validateAbsoluteFileResource(
  request: SessionFileAbsoluteResourceRequest,
): string {
  if (
    typeof request.sessionId !== "string" ||
    !request.sessionId ||
    typeof request.absolutePath !== "string" ||
    !request.absolutePath ||
    !path.isAbsolute(request.absolutePath) ||
    "rootId" in request ||
    "relativePath" in request
  ) {
    throw new TypeError("Absolute file preview resource is invalid.");
  }
  return path.resolve(request.absolutePath);
}

/** セッションとルートを指定した要求の形を確認する。相対パスの内容は解決時に検証する。 */
function validateRootFileResource(
  request: SessionFileRootResourceRequest,
): void {
  if (
    typeof request.sessionId !== "string" ||
    !request.sessionId ||
    typeof request.rootId !== "string" ||
    !request.rootId ||
    typeof request.relativePath !== "string" ||
    "absolutePath" in request
  ) {
    throw new TypeError("Root-scoped file resource is invalid.");
  }
}

/** パスの比較・重複排除用に絶対パスへそろえ、Windowsのみ大文字小文字を区別しない。 */
function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

/** 追加ディレクトリの正規化済みパスから、要求で指定するルートIDを作る。 */
function makeAdditionalRootId(absolutePath: string): string {
  return `additional:${createHash("sha256").update(pathKey(absolutePath)).digest("hex").slice(0, 16)}`;
}

/** 元の表記を画面表示用に残し、参照先解決に使う絶対パスと分ける。 */
function makeRoot(
  kind: SessionFileRootKind,
  absolutePath: string,
  id: string,
  label: string,
): ResolvedSessionFileRoot {
  if (typeof absolutePath !== "string" || !absolutePath.trim()) {
    throw new Error("File root path cannot be empty.");
  }
  return {
    id,
    kind,
    label,
    displayPath: absolutePath,
    absolutePath: path.resolve(absolutePath),
  };
}

/** ルート指定を許す場合だけ空パスを受け入れ、絶対パスや親参照などを拒否して区切りを統一する。 */
function normalizeRelativePath(value: string, allowRoot: boolean): string {
  if (typeof value !== "string") {
    throw new TypeError("relativePath must be a string.");
  }
  if (!value) {
    if (allowRoot) {
      return "";
    }
    throw new Error("File path cannot be empty.");
  }
  if (
    path.isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    throw new Error("relativePath must not be absolute.");
  }

  const segments = value.replaceAll("\\", "/").split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("relativePath contains an invalid segment.");
  }
  return segments.join("/");
}

/** 相対パスで照合し、対象がルートそのものかその配下にあるかを判定する。 */
function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** 開いた実体とパスから調べた実体を、精度を落とさずデバイスとinodeで比較する。 */
function isSameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** 対象へ到達できないENOENT・ENOTDIRと、その他の調査エラーを区別する。 */
function isMissingPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 差し替えや同じサイズ・更新時刻の変更も照合できるよう、実体・サイズ・更新時刻・状態変更時刻をまとめる。 */
function makeFileRevision(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** セッションのファイルルート、ピン、一覧とプレビュー読み取りの参照条件を管理する。 */
export class SessionFileExplorerService {
  /** 参照時に最新のセッション情報を取得できる依存先を受け取る。 */
  constructor(private readonly deps: SessionFileExplorerServiceDeps) {}

  /** 組み込みルートと許可済みの追加ルートを組み立て、追加先が既出のパスなら省く。ディレクトリは作らない。 */
  private async resolveRoots(
    sessionId: string,
  ): Promise<ResolvedSessionFileRoot[]> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context) {
      throw new Error("The session could not be found.");
    }

    const workspace = makeRoot(
      "workspace",
      context.workspacePath,
      "workspace",
      "Workspace",
    );
    const sessionFolderPath = resolveSessionFilesDirectory(
      this.deps.userDataPath,
      context.parentSessionId,
    );
    const sessionFolder = makeRoot(
      "session-folder",
      sessionFolderPath,
      "session-folder",
      "Session Folder",
    );
    const crewFolder = context.crewRootSessionId
      ? makeRoot(
          "crew-folder",
          resolveCrewFilesDirectory(
            this.deps.userDataPath,
            context.crewRootSessionId,
          ),
          "crew-folder",
          "Crew Folder",
        )
      : null;
    const seen = new Set(
      [workspace, sessionFolder, ...(crewFolder ? [crewFolder] : [])].map(
        (root) => pathKey(root.absolutePath),
      ),
    );
    const additionalRoots: ResolvedSessionFileRoot[] = [];
    for (const directoryPath of context.allowedAdditionalDirectories) {
      const absolutePath = path.resolve(directoryPath);
      const key = pathKey(absolutePath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      additionalRoots.push(
        makeRoot(
          "additional",
          absolutePath,
          makeAdditionalRootId(absolutePath),
          path.basename(absolutePath),
        ),
      );
    }
    return [
      workspace,
      sessionFolder,
      ...(crewFolder ? [crewFolder] : []),
      ...additionalRoots,
    ];
  }

  /** ファイルツリーに表示するルートを、Main内部の解決用パスを除いて返す。 */
  async listRoots(sessionId: string): Promise<SessionFileRoot[]> {
    return (await this.resolveRoots(sessionId)).map(
      ({ absolutePath: _absolutePath, ...root }) => root,
    );
  }

  /** 補助セッションも親のピンを共有し、親の同一性を確定できない場合は操作を拒否する。 */
  private async resolvePinOwner(
    sessionId: string,
  ): Promise<SessionFilePinOwner> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context?.parentIncarnationId)
      throw new Error("The File Pin owner session is not available.");
    return {
      sessionId: context.parentSessionId,
      incarnationId: context.parentIncarnationId,
    };
  }

  /** ピン操作に必要な現在の保存先を取得し、未接続なら失敗を明示する。 */
  private pinStorage(): SessionFilePinStorage {
    if (!this.deps.getPinStorage)
      throw new Error("File Pin storage is not available.");
    return this.deps.getPinStorage();
  }

  /** リンク自体を除外し、認可ルート内の通常ファイルまたはディレクトリが照合中に変わっていないか確認する。 */
  private async inspectPinTarget(
    request: SessionFileRootResourceRequest,
  ): Promise<"file" | "directory"> {
    const candidate = await this.resolveTargetCandidate(request, false);
    const targetStats = await (this.deps.lstatPath ?? lstat)(
      candidate.unresolvedTargetPath,
      { bigint: true },
    );
    const kind = targetStats.isFile()
      ? "file"
      : targetStats.isDirectory()
        ? "directory"
        : null;
    if (!kind)
      throw new Error("Only regular files and directories can be pinned.");
    const targetRealPath = await realpath(candidate.unresolvedTargetPath);
    if (!isPathInside(candidate.rootRealPath, targetRealPath))
      throw new Error("The pinned path is outside the authorized root.");
    const confirmed = await this.resolveTargetCandidate(request, false);
    const confirmedStats = await (this.deps.lstatPath ?? lstat)(
      confirmed.unresolvedTargetPath,
      { bigint: true },
    );
    const confirmedTargetRealPath = await realpath(
      confirmed.unresolvedTargetPath,
    );
    if (
      pathKey(candidate.rootAbsolutePath) !==
        pathKey(confirmed.rootAbsolutePath) ||
      pathKey(candidate.rootRealPath) !== pathKey(confirmed.rootRealPath) ||
      pathKey(targetRealPath) !== pathKey(confirmedTargetRealPath) ||
      !isPathInside(confirmed.rootRealPath, confirmedTargetRealPath) ||
      !isSameFileIdentity(targetStats, confirmedStats) ||
      (kind === "file"
        ? !confirmedStats.isFile()
        : !confirmedStats.isDirectory())
    ) {
      throw new Error("File root changed during Pin authorization.");
    }
    return kind;
  }

  /** 現在許可されたルート内の対象を確認し、親セッションの同一性とルートの種別・パスを使ってピンを保存する。 */
  async pinSessionFile(
    request: SessionFileRootResourceRequest,
  ): Promise<SessionFilePin> {
    validateRootFileResource(request);
    const storage = this.pinStorage();
    const owner = await this.resolvePinOwner(request.sessionId);
    const root = await this.resolveRoot(request.sessionId, request.rootId);
    if (!root)
      throw new Error(
        "The specified file root is not available in the current session.",
      );
    const relativePath = normalizeRelativePath(request.relativePath, false);
    const kind = await this.inspectPinTarget({ ...request, relativePath });
    const currentRoot = await this.resolveRoot(
      request.sessionId,
      request.rootId,
    );
    if (
      !currentRoot ||
      pathKey(currentRoot.absolutePath) !== pathKey(root.absolutePath)
    )
      throw new Error("File root changed during Pin authorization.");
    const pin: StoredSessionFilePin = {
      rootKind: root.kind,
      rootPath: pathKey(root.absolutePath),
      relativePath,
      kind,
      rootLabel: root.label,
    };
    await storage.pinSessionFile(owner, pin);
    return { ...pin, rootId: root.id, unavailableReason: null };
  }

  /** 対象が移動・削除されていても、ピン参照と親セッションの同一性で保存済みピンだけを解除する。 */
  async unpinSessionFile(
    request: SessionFilePinReference & { sessionId: string },
  ): Promise<void> {
    if (
      !request ||
      typeof request.sessionId !== "string" ||
      !request.sessionId ||
      !["workspace", "session-folder", "crew-folder", "additional"].includes(
        request.rootKind,
      ) ||
      typeof request.rootPath !== "string" ||
      !path.isAbsolute(request.rootPath)
    ) {
      throw new TypeError("File Pin reference is invalid.");
    }
    const storage = this.pinStorage();
    const owner = await this.resolvePinOwner(request.sessionId);
    await storage.unpinSessionFile(owner, {
      rootKind: request.rootKind,
      rootPath: pathKey(request.rootPath),
      relativePath: normalizeRelativePath(request.relativePath, false),
    });
  }

  /** 保存先が返す順序を保ってピンを現在のルートと対象種別に照らし、開けないものも理由付きで返す。 */
  async listSessionFilePins(sessionId: string): Promise<SessionFilePin[]> {
    const storage = this.pinStorage();
    const owner = await this.resolvePinOwner(sessionId);
    const pins = await storage.listSessionFilePins(owner);
    const roots = await this.resolveRoots(sessionId);
    const results = new Array<SessionFilePin>(pins.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, pins.length) }, async () => {
        while (next < pins.length) {
          const index = next++;
          const pin = pins[index]!;
          const root = roots.find(
            (candidate) =>
              candidate.kind === pin.rootKind &&
              pathKey(candidate.absolutePath) === pin.rootPath,
          );
          let unavailableReason: string | null = root
            ? null
            : "The pinned root is not authorized in the current session.";
          if (root) {
            try {
              const kind = await this.inspectPinTarget({
                sessionId,
                rootId: root.id,
                relativePath: pin.relativePath,
              });
              if (kind !== pin.kind)
                throw new Error("The pinned path has a different file type.");
              const currentRoot = await this.resolveRoot(sessionId, root.id);
              if (
                !currentRoot ||
                pathKey(currentRoot.absolutePath) !== pin.rootPath
              )
                throw new Error(
                  "The pinned root changed during authorization.",
                );
            } catch (error) {
              unavailableReason =
                error instanceof Error
                  ? error.message
                  : "The pinned path could not be inspected.";
            }
          }
          results[index] = {
            ...pin,
            rootId: root?.id ?? null,
            rootLabel: root?.label ?? pin.rootLabel,
            unavailableReason,
          };
        }
      }),
    );
    return results;
  }

  /** 現在使えるルートからIDを照合し、見つからなければnullを返す。 */
  async resolveRoot(
    sessionId: string,
    rootId: string,
  ): Promise<ResolvedSessionFileRoot | null> {
    return (
      (await this.resolveRoots(sessionId)).find(
        (candidate) => candidate.id === rootId,
      ) ?? null
    );
  }

  /** Git履歴の候補をワークスペースと追加ルートに限り、Gitリポジトリかどうかは後段の判定に任せる。 */
  async resolveHistoryRoots(
    sessionId: string,
  ): Promise<ResolvedSessionFileRoot[]> {
    return (await this.resolveRoots(sessionId)).filter(
      (root) => root.kind !== "session-folder" && root.kind !== "crew-folder",
    );
  }

  /** IDが現在のGit履歴候補に含まれる場合だけ、Main用のルート情報を返す。 */
  async resolveHistoryRoot(
    sessionId: string,
    rootId: string,
  ): Promise<ResolvedSessionFileRoot | null> {
    return (
      (await this.resolveHistoryRoots(sessionId)).find(
        (candidate) => candidate.id === rootId,
      ) ?? null
    );
  }

  /** ツリーのノード種別と現在のルートを照合し、パス操作用の絶対パスを返す。未作成の管理ルートは作らない。 */
  async resolvePathActionTarget(
    request: SessionFileTreePathActionTargetRequest,
  ): Promise<string> {
    if (!(["root", "directory", "file"] as const).includes(request.nodeKind)) {
      throw new TypeError("File tree path action node kind is invalid.");
    }
    const candidate = await this.resolvePathActionCandidate(request);
    if ((request.nodeKind === "root") !== (request.relativePath === "")) {
      throw new Error(
        "File tree path action node kind does not match its path.",
      );
    }
    await this.confirmPathActionNodeKind(candidate, request.nodeKind);
    const confirmedCandidate = await this.resolvePathActionCandidate(request);
    if (
      pathKey(confirmedCandidate.rootAbsolutePath) !==
        pathKey(candidate.rootAbsolutePath) ||
      pathKey(confirmedCandidate.unresolvedTargetPath) !==
        pathKey(candidate.unresolvedTargetPath)
    ) {
      throw new Error("File tree root changed during path authorization.");
    }
    await this.confirmPathActionNodeKind(confirmedCandidate, request.nodeKind);
    return confirmedCandidate.unresolvedTargetPath;
  }

  /** 許可済みルートに検証済みの相対パスを結合し、種別確認前の候補を作る。 */
  private async resolvePathActionCandidate(
    request: SessionFileTreePathActionTargetRequest,
  ): Promise<ResolvedPathActionCandidate> {
    validateRootFileResource(request);
    const root = await this.resolveRoot(request.sessionId, request.rootId);
    if (!root) {
      throw new Error(
        "The specified file root is not available in the current session.",
      );
    }
    const relativePath = normalizeRelativePath(
      request.relativePath,
      request.nodeKind === "root",
    );
    return {
      rootAbsolutePath: root.absolutePath,
      rootKind: root.kind,
      unresolvedTargetPath: relativePath
        ? path.join(root.absolutePath, ...relativePath.split("/"))
        : root.absolutePath,
    };
  }

  /** 子ノードでは末尾のリンクをたどらず種別を確認し、未作成を許すのは管理フォルダーのルートに限る。 */
  private async confirmPathActionNodeKind(
    candidate: ResolvedPathActionCandidate,
    nodeKind: SessionFileTreePathActionNodeKind,
  ): Promise<void> {
    try {
      const targetStats =
        nodeKind === "root"
          ? await (this.deps.statPath ?? stat)(candidate.unresolvedTargetPath, {
              bigint: true,
            })
          : await (this.deps.lstatPath ?? lstat)(
              candidate.unresolvedTargetPath,
              { bigint: true },
            );
      const kindMatches =
        nodeKind === "file" ? targetStats.isFile() : targetStats.isDirectory();
      if (!kindMatches) {
        throw new Error(
          "File tree path action node kind does not match the current target.",
        );
      }
    } catch (error) {
      if (
        nodeKind === "root" &&
        (candidate.rootKind === "session-folder" ||
          candidate.rootKind === "crew-folder") &&
        isMissingPathError(error)
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * 既存プレビューやワークスペースを基準にリンクを解決し、外部URL・ディレクトリ・ファイルを区別する。
   * ファイルは最も具体的な認可ルートに割り当て、ルート外の実在ファイルはルートを追加せず絶対パスの参照として返す。
   */
  async resolvePreviewTarget(
    sessionId: string,
    target: string,
    baseResource?: SessionFilePreviewResourceRequest,
  ): Promise<SessionFilePreviewTargetResolution> {
    const context = await this.deps.getSessionContext(sessionId);
    if (!context) {
      return {
        type: "failed",
        targetPath: target,
        message: "The session could not be found.",
      };
    }

    try {
      const externalTarget = resolveOpenPathTarget(target, {
        baseDirectory: context.workspacePath,
      });
      if (externalTarget.type === "external-url") {
        return externalTarget;
      }
    } catch {
      // 対象のローカルパスを解決できなかった場合は、適切なプレビュー基準を適用してから失敗を返す。
    }

    if (baseResource && isSessionFileGitCommitResource(baseResource)) {
      return {
        type: "not-previewable",
        targetPath: target,
        message:
          "Relative links from a Git commit file preview are not available.",
      };
    }

    let baseDirectory = context.workspacePath;
    if (baseResource) {
      if (baseResource.sessionId !== sessionId) {
        return {
          type: "failed",
          targetPath: target,
          message: "Preview link base does not belong to this Session.",
        };
      }
      try {
        if (isSessionFileAbsoluteResource(baseResource)) {
          baseDirectory = path.dirname(
            validateAbsoluteFileResource(baseResource),
          );
        } else {
          validateRootFileResource(baseResource);
          const candidate = await this.resolveTargetCandidate(
            baseResource,
            false,
          );
          baseDirectory = path.dirname(
            await realpath(candidate.unresolvedTargetPath),
          );
        }
      } catch (error) {
        return {
          type: "failed",
          targetPath: target,
          message:
            error instanceof Error
              ? error.message
              : "Preview link base could not be resolved.",
        };
      }
    }

    let resolvedTarget: ReturnType<typeof resolveOpenPathTarget>;
    try {
      resolvedTarget = resolveOpenPathTarget(target, { baseDirectory });
    } catch (error) {
      return {
        type: "failed",
        targetPath: target,
        message:
          error instanceof Error
            ? error.message
            : "The link target could not be resolved.",
      };
    }
    if (resolvedTarget.type === "external-url") {
      return resolvedTarget;
    }

    const roots = await this.resolveRoots(sessionId);
    const resolvedRoots: Array<{
      root: ResolvedSessionFileRoot;
      realPath: string;
    }> = [];
    for (const root of roots) {
      try {
        resolvedRoots.push({
          root,
          realPath: await realpath(root.absolutePath),
        });
      } catch {
        // 現時点で利用できないルートからは、そのルートに限定されたリソースを提供できない。
      }
    }

    let targetPath = resolvedTarget.targetPath;
    const fallbackPath =
      /^(.*):[1-9]\d*:[1-9]\d*$/.exec(targetPath)?.[1] ??
      /^(.*):[1-9]\d*$/.exec(targetPath)?.[1] ??
      "";
    const lexicalCandidates = fallbackPath
      ? [targetPath, fallbackPath]
      : [targetPath];
    const priority: Record<SessionFileRootKind, number> = {
      workspace: 0,
      "session-folder": 1,
      "crew-folder": 2,
      additional: 3,
    };
    const lstatPath = this.deps.lstatPath ?? lstat;
    let targetStats: BigIntStats | null = null;
    let targetRealPath = "";
    let selectedTargetPath = "";
    for (const candidatePath of lexicalCandidates) {
      const absoluteCandidate = path.resolve(candidatePath);
      try {
        await lstatPath(absoluteCandidate, { bigint: true });
        targetRealPath = await realpath(absoluteCandidate);
        targetStats = await (this.deps.statPath ?? stat)(targetRealPath, {
          bigint: true,
        });
        selectedTargetPath = absoluteCandidate;
        break;
      } catch (error) {
        if (!isMissingPathError(error)) {
          return {
            type: "failed",
            targetPath: absoluteCandidate,
            message:
              error instanceof Error
                ? error.message
                : "The local path could not be inspected.",
          };
        }
      }
    }
    if (!targetStats || !selectedTargetPath) {
      return {
        type: "not-found",
        targetPath,
        message: "The local path was not found.",
      };
    }
    targetPath = selectedTargetPath;

    if (targetStats.isDirectory()) {
      return { type: "directory", targetPath: targetRealPath };
    }
    if (!targetStats.isFile()) {
      return {
        type: "not-previewable",
        targetPath,
        message: "The local path is not a file or directory.",
      };
    }

    try {
      const matchingRoots = resolvedRoots.filter(({ realPath: rootRealPath }) =>
        isPathInside(rootRealPath, targetRealPath),
      );
      matchingRoots.sort(
        (left, right) =>
          right.realPath.length - left.realPath.length ||
          priority[left.root.kind] - priority[right.root.kind],
      );
      const match = matchingRoots[0];
      if (!match) {
        return {
          type: "file",
          resource: { sessionId, absolutePath: targetRealPath },
        };
      }
      const relativePath = path
        .relative(match.realPath, targetRealPath)
        .split(path.sep)
        .join("/");
      return {
        type: "file",
        resource: { sessionId, rootId: match.root.id, relativePath },
      };
    } catch (error) {
      return {
        type: "failed",
        targetPath,
        message:
          error instanceof Error
            ? error.message
            : "The file could not be resolved.",
      };
    }
  }

  /** 現在のルートから候補を作る。管理フォルダーのルート自体を列挙する場合は未作成なら作る。 */
  private async resolveTargetCandidate(
    request: SessionFileRootResourceRequest,
    allowRoot: boolean,
  ): Promise<ResolvedTargetCandidate> {
    validateRootFileResource(request);
    const root = await this.resolveRoot(request.sessionId, request.rootId);
    if (!root) {
      throw new Error(
        "The specified file root is not available in the current session.",
      );
    }
    const relativePath = normalizeRelativePath(request.relativePath, allowRoot);
    if (
      allowRoot &&
      !relativePath &&
      (root.kind === "session-folder" || root.kind === "crew-folder")
    ) {
      await mkdir(root.absolutePath, { recursive: true });
    }
    const rootRealPath = await realpath(root.absolutePath);
    const unresolvedTarget = relativePath
      ? path.join(root.absolutePath, ...relativePath.split("/"))
      : root.absolutePath;
    return {
      rootAbsolutePath: root.absolutePath,
      rootRealPath,
      unresolvedTargetPath: unresolvedTarget,
    };
  }

  /** セッションとルートの指定を現在の候補へ解決し、要求種別と実体を確認してハンドルを返す。 */
  private async openAuthorizedTarget(
    request: SessionFileRootResourceRequest,
    allowRoot: boolean,
    expectedKind: AuthorizedResourceKind,
  ): Promise<AuthorizedOpenedFile> {
    const candidate = await this.resolveTargetCandidate(request, allowRoot);
    return this.openAuthorizedCandidate(candidate, expectedKind);
  }

  /** 読み取り専用で開いた実体が期待した種別でルート内にあるか確認し、失敗時はハンドルを閉じる。 */
  private async openAuthorizedCandidate(
    candidate: ResolvedTargetCandidate,
    expectedKind: AuthorizedResourceKind,
  ): Promise<AuthorizedOpenedFile> {
    const handle = await (this.deps.openFile ?? open)(
      candidate.unresolvedTargetPath,
      "r",
    );
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (
        expectedKind === "file"
          ? !openedStats.isFile()
          : !openedStats.isDirectory()
      ) {
        throw new Error(`The specified path is not a ${expectedKind}.`);
      }
      const targetRealPath = await this.confirmOpenedTarget(
        candidate,
        openedStats,
      );
      return { candidate, handle, stats: openedStats, targetRealPath };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** ルート自身ではなく、ルート配下の通常ファイルを対象として開く。 */
  private openAuthorizedFile(
    request: SessionFileRootResourceRequest,
  ): Promise<AuthorizedOpenedFile> {
    return this.openAuthorizedTarget(request, false, "file");
  }

  /** 絶対パスの通常ファイルを開き、正規パスとハンドルの実体が確認中に変わっていないか照合する。 */
  private async openAbsoluteFile(
    request: SessionFileAbsoluteResourceRequest,
  ): Promise<AuthorizedOpenedFile> {
    const absolutePath = validateAbsoluteFileResource(request);
    const handle = await (this.deps.openFile ?? open)(absolutePath, "r");
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (!openedStats.isFile()) {
        throw new Error("The specified path is not a file.");
      }
      const targetRealPath = await realpath(absolutePath);
      const statPath = this.deps.statPath ?? stat;
      const targetStats = await statPath(targetRealPath, { bigint: true });
      const confirmedTargetRealPath = await realpath(absolutePath);
      const confirmedTargetStats = await statPath(confirmedTargetRealPath, {
        bigint: true,
      });
      if (
        pathKey(confirmedTargetRealPath) !== pathKey(targetRealPath) ||
        !isSameFileIdentity(openedStats, targetStats) ||
        !isSameFileIdentity(openedStats, confirmedTargetStats)
      ) {
        throw new Error(
          "The resource path changed during verification. Try again.",
        );
      }
      return {
        candidate: {
          rootAbsolutePath: path.dirname(targetRealPath),
          rootRealPath: path.dirname(targetRealPath),
          unresolvedTargetPath: absolutePath,
        },
        handle,
        stats: openedStats,
        targetRealPath,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** ローカルファイル参照の形式に応じて開き方を選び、履歴など他の参照形式は受け付けない。 */
  private openLocalFile(
    request: SessionFileResourceRequest,
  ): Promise<AuthorizedOpenedFile> {
    if (isSessionFileAbsoluteResource(request)) {
      return this.openAbsoluteFile(request);
    }
    if (isSessionFileRootResource(request)) {
      return this.openAuthorizedFile(request);
    }
    throw new TypeError("File resource is invalid.");
  }

  /** ルートと対象の正規パスを再解決し、ルート内にあるパスが開いたハンドルと同じ実体を指すか確認する。 */
  private async confirmOpenedTarget(
    candidate: ResolvedTargetCandidate,
    openedStats: BigIntStats,
  ): Promise<string> {
    const targetRealPath = await realpath(candidate.unresolvedTargetPath);
    if (!isPathInside(candidate.rootRealPath, targetRealPath)) {
      throw new Error("The specified path is outside the file root.");
    }
    const statPath = this.deps.statPath ?? stat;
    const targetStats = await statPath(targetRealPath, { bigint: true });
    const confirmedRootRealPath = await realpath(candidate.rootAbsolutePath);
    const confirmedTargetRealPath = await realpath(
      candidate.unresolvedTargetPath,
    );
    const confirmedTargetStats = await statPath(confirmedTargetRealPath, {
      bigint: true,
    });
    if (
      pathKey(confirmedRootRealPath) !== pathKey(candidate.rootRealPath) ||
      pathKey(confirmedTargetRealPath) !== pathKey(targetRealPath) ||
      !isPathInside(confirmedRootRealPath, confirmedTargetRealPath) ||
      !isSameFileIdentity(openedStats, targetStats) ||
      !isSameFileIdentity(openedStats, confirmedTargetStats)
    ) {
      throw new Error(
        "The resource path changed during authorization. Try again.",
      );
    }
    return targetRealPath;
  }

  /** 実行枠を得てからディレクトリを開き、認可した実体と一致する直下の一覧をディレクトリ優先で返す。 */
  async listDirectory(
    request: SessionDirectoryRequest,
  ): Promise<SessionDirectoryEntry[]> {
    const supersessionKey = JSON.stringify([
      request.sessionId,
      request.rootId,
      request.relativePath,
    ]);
    const snapshot = await listDirectoryWithAdmission(
      supersessionKey,
      async () => {
        const opened = await this.openAuthorizedTarget(
          request,
          true,
          "directory",
        );
        try {
          const result = await (
            this.deps.listDirectory ?? listIdentityBoundDirectory
          )(opened.targetRealPath);
          if (
            result.device !== opened.stats.dev ||
            result.inode !== opened.stats.ino
          ) {
            throw new Error(
              "The directory path changed after authorization. Try again.",
            );
          }
          return result;
        } finally {
          await opened.handle.close();
        }
      },
    );
    const results = snapshot.entries.map((entry): SessionDirectoryEntry => {
      const relativePath = request.relativePath
        ? `${request.relativePath}/${entry.name}`
        : entry.name;
      return { ...entry, relativePath };
    });
    return results.sort((left, right) => {
      const leftDirectory = left.kind === "directory" ? 0 : 1;
      const rightDirectory = right.kind === "directory" ? 0 : 1;
      return (
        leftDirectory - rightDirectory ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      );
    });
  }

  /** 検証したファイルの正規パスをOSで開くか表示し、処理後に検証用のハンドルを閉じる。 */
  async openFile(request: SessionFileOpenRequest): Promise<OpenPathResult> {
    if (!this.deps.openResolvedPath) {
      throw new Error("The file open service is unavailable.");
    }
    const opened = await this.openLocalFile(request);
    try {
      // ここで Electron が OS に渡せるのはパスだけ。元のファイルを編集できるようにするため、
      // ADR 013 に記載されたパスの再解決が起こり得る境界を意図的に受け入れる。
      return await this.deps.openResolvedPath(
        opened.targetRealPath,
        request.reveal === true,
      );
    } finally {
      await opened.handle.close();
    }
  }

  /** 検証済みの正規パスで操作し、終了後の再照合が通ったかを操作結果とは別に返す。 */
  async withAuthorizedFilePath<T>(
    request: SessionFileResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>> {
    const opened = await this.openLocalFile(request);
    try {
      const result = await operation(opened.targetRealPath);
      let targetStillCurrent = false;
      try {
        const confirmedTargetRealPath = await this.confirmOpenedTarget(
          opened.candidate,
          opened.stats,
        );
        targetStillCurrent =
          pathKey(confirmedTargetRealPath) === pathKey(opened.targetRealPath);
      } catch {
        targetStillCurrent = false;
      }
      return { result, targetStillCurrent };
    } finally {
      await opened.handle.close();
    }
  }

  /** ツリー上の末尾リンクを受け付けず、実体を照合してから操作し、操作後も同じ実体か確認する。 */
  async withAuthorizedTreeFilePath<T>(
    request: SessionFileRootResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>> {
    const candidate = await this.resolveTargetCandidate(request, false);
    const lstatPath = this.deps.lstatPath ?? lstat;
    const lexicalStats = await lstatPath(candidate.unresolvedTargetPath, {
      bigint: true,
    });
    if (!lexicalStats.isFile()) {
      throw new Error("File tree target is not a regular file.");
    }
    const opened = await this.openAuthorizedCandidate(candidate, "file");
    try {
      const confirmedLexicalStats = await lstatPath(
        candidate.unresolvedTargetPath,
        { bigint: true },
      );
      if (
        !confirmedLexicalStats.isFile() ||
        !isSameFileIdentity(opened.stats, confirmedLexicalStats)
      ) {
        throw new Error("File tree target changed during authorization.");
      }
      const result = await operation(opened.targetRealPath);
      let targetStillCurrent = false;
      try {
        const finalLexicalStats = await lstatPath(
          candidate.unresolvedTargetPath,
          { bigint: true },
        );
        const confirmedTargetRealPath = await this.confirmOpenedTarget(
          candidate,
          opened.stats,
        );
        targetStillCurrent =
          finalLexicalStats.isFile() &&
          isSameFileIdentity(opened.stats, finalLexicalStats) &&
          pathKey(confirmedTargetRealPath) === pathKey(opened.targetRealPath);
      } catch {
        targetStillCurrent = false;
      }
      return { result, targetStillCurrent };
    } finally {
      await opened.handle.close();
    }
  }

  /** 検証して開いたファイルの先頭から表示に使う情報を取り、後続の読み取りに使う版を返す。 */
  async inspectFile(
    request: SessionFileResourceRequest,
  ): Promise<SessionFileDescriptor> {
    const opened = await this.openLocalFile(request);
    return this.inspectOpenedFile(request, opened);
  }

  /** HTMLと依存ファイルの参照ルートを決め、配下のファイルを検証して開く手段を返す。 */
  async createHtmlPreviewResourceRoot(
    request: SessionFileResourceRequest,
  ): Promise<{
    rootRealPath: string;
    relativePath: string;
    /** ルート相対の依存ファイルを開く。成功時のハンドルは呼び出し元が閉じる。 */
    open(
      relativePath: string,
    ): Promise<{ handle: ReadableFileHandle; byteLength: number }>;
  }> {
    const resolution = isSessionFileAbsoluteResource(request)
      ? await this.resolvePreviewTarget(request.sessionId, request.absolutePath)
      : null;
    const source = await this.openLocalFile(
      resolution?.type === "file" ? resolution.resource : request,
    );
    try {
      const rootPath = source.candidate.rootAbsolutePath;
      const rootRealPath = source.candidate.rootRealPath;
      const rootStats = await stat(rootRealPath, { bigint: true });
      const relativePath = path
        .relative(rootRealPath, source.targetRealPath)
        .split(path.sep)
        .join("/");
      return {
        rootRealPath,
        relativePath,
        /** 依存ファイルをルート内で開き、HTMLを開いたときのルート実体が変わっていないか確認する。 */
        open: async (assetPath) => {
          const normalized = normalizeRelativePath(assetPath, false);
          const opened = await this.openAuthorizedCandidate(
            {
              rootAbsolutePath: rootPath,
              rootRealPath,
              unresolvedTargetPath: path.join(
                rootPath,
                ...normalized.split("/"),
              ),
            },
            "file",
          );
          try {
            if (
              !isSameFileIdentity(
                rootStats,
                await stat(rootRealPath, { bigint: true }),
              )
            ) {
              throw new Error("The HTML preview file root changed.");
            }
            return {
              handle: opened.handle,
              byteLength: Number(opened.stats.size),
            };
          } catch (error) {
            await opened.handle.close();
            throw error;
          }
        },
      };
    } finally {
      await source.handle.close();
    }
  }

  /** 同じセッションの基準ファイルまたはワークスペースから画像・PDFのローカルリンクを解決し、通常ファイルを開く。 */
  private async openLinkedFile(
    request: SessionImageResourceRequest | SessionPdfResourceRequest,
    kind: "image" | "PDF",
  ): Promise<AuthorizedOpenedFile> {
    const context = await this.deps.getSessionContext(request.sessionId);
    if (!context) {
      throw new Error("The session could not be found.");
    }
    const target = request.target.trim();
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)?.[1];
    if (
      scheme &&
      scheme.toLowerCase() !== "file" &&
      !/^[a-zA-Z]:[\\/]/.test(target)
    ) {
      throw new Error(
        `Local ${kind} requests must use a local path or file URL.`,
      );
    }
    const absoluteTarget =
      /^file:/i.test(target) ||
      path.isAbsolute(target) ||
      /^[a-zA-Z]:[\\/]/.test(target) ||
      /^\/[a-zA-Z]:[\\/]/.test(target);
    let baseDirectory = context.workspacePath;
    if (request.baseResource) {
      if (request.baseResource.sessionId !== request.sessionId) {
        throw new Error(`${kind} base does not belong to this Session.`);
      }
      if (!absoluteTarget) {
        if (isSessionFileGitCommitResource(request.baseResource)) {
          throw new Error(
            `Relative ${kind === "image" ? "images" : "PDFs"} from a Git commit file preview are not available.`,
          );
        }
        const base = await this.openLocalFile(request.baseResource);
        try {
          baseDirectory = path.dirname(base.targetRealPath);
        } finally {
          await base.handle.close();
        }
      }
    }
    const resolved = resolveOpenPathTarget(target, { baseDirectory });
    if (resolved.type !== "local-path") {
      throw new Error(
        `Local ${kind} requests must use a local path or file URL.`,
      );
    }
    return this.openAbsoluteFile({
      sessionId: request.sessionId,
      absolutePath: resolved.targetPath,
    });
  }

  /** ローカル画像の先頭を調べ、対応するラスタ形式またはSVGの表示情報を返す。 */
  async inspectImage(
    request: SessionImageResourceRequest,
  ): Promise<SessionFileDescriptor> {
    const opened = await this.openLinkedFile(request, "image");
    return this.inspectOpenedFile(
      { sessionId: request.sessionId, absolutePath: opened.targetRealPath },
      opened,
      "image",
    );
  }

  /** ローカルファイルを先頭の識別子でPDFとして確認し、分割読み取りに必要な版を返す。 */
  async inspectPdf(
    request: SessionPdfResourceRequest,
  ): Promise<SessionFileDescriptor> {
    const opened = await this.openLinkedFile(request, "PDF");
    return this.inspectOpenedFile(
      { sessionId: request.sessionId, absolutePath: opened.targetRealPath },
      opened,
      "pdf",
    );
  }

  /** 先頭の一定範囲から種別と文字コード候補を調べ、途中で版が変わった場合は失敗させてハンドルを閉じる。 */
  private async inspectOpenedFile(
    request: SessionFileResourceRequest,
    opened: AuthorizedOpenedFile,
    restrictedKind?: "image" | "pdf",
  ): Promise<SessionFileDescriptor> {
    try {
      const { handle, stats: fileStats, targetRealPath } = opened;
      const inspection = new Uint8Array(
        Math.min(INSPECTION_BYTES, Number(fileStats.size)),
      );
      const { bytesRead } = await handle.read(
        inspection,
        0,
        inspection.byteLength,
        0,
      );
      const fileStatsAfterInspection = await handle.stat({ bigint: true });
      if (
        makeFileRevision(fileStatsAfterInspection) !==
        makeFileRevision(fileStats)
      ) {
        throw new Error(
          "The file changed during inspection. Reload and try again.",
        );
      }
      const inspectedBytes = inspection.subarray(0, bytesRead);
      const resource =
        restrictedKind === "pdf"
          ? detectLocalPdfResource(inspectedBytes)
          : restrictedKind === "image"
            ? detectLocalImageResource(inspectedBytes)
            : detectSessionFileResourceKind(targetRealPath, inspectedBytes);
      return {
        ...request,
        absoluteFilePath: targetRealPath,
        name: path.basename(targetRealPath),
        kind: resource.kind,
        byteLength: Number(fileStats.size),
        modifiedAt: fileStats.mtime.toISOString(),
        mimeType: resource.mimeType,
        suggestedEncoding: detectSessionFileEncoding(inspectedBytes),
        revision: makeFileRevision(fileStats),
      };
    } finally {
      await opened.handle.close();
    }
  }

  /** ローカルファイルを検証して開き、指定の版に一致するときだけ要求範囲を返す。 */
  async readFileChunk(
    request: SessionFileChunkRequest,
  ): Promise<SessionFileChunkResult> {
    this.validateChunkRequest(request);
    const opened = await this.openLocalFile(request);
    return this.readOpenedFileChunk(request, opened);
  }

  /** ローカル画像を開き直し、指定の版と対応画像形式を確認して要求範囲を返す。 */
  async readImageChunk(
    request: SessionImageChunkRequest,
  ): Promise<SessionFileChunkResult> {
    this.validateChunkRequest(request);
    const opened = await this.openLinkedFile(request, "image");
    return this.readOpenedFileChunk(request, opened, "image");
  }

  /** ローカルPDFを開き直し、指定の版とPDFの先頭識別子を確認して要求範囲を返す。 */
  async readPdfChunk(
    request: SessionPdfChunkRequest,
  ): Promise<SessionFileChunkResult> {
    this.validateChunkRequest(request);
    const opened = await this.openLinkedFile(request, "PDF");
    return this.readOpenedFileChunk(request, opened, "pdf");
  }

  /** オフセットと長さを安全な整数に限り、ファイルを開く前に読み取りサイズの上限を確認する。 */
  private validateChunkRequest(
    request: Pick<SessionFileChunkRequest, "offset" | "length">,
  ): void {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      throw new Error("The file chunk offset is invalid.");
    }
    if (
      !Number.isSafeInteger(request.length) ||
      request.length < 1 ||
      request.length > MAX_CHUNK_BYTES
    ) {
      throw new Error(
        `File chunk length must be between 1 and ${MAX_CHUNK_BYTES} bytes.`,
      );
    }
  }

  /** 指定範囲を読み、前後で同じ版か確認してから実読取バイトと次の位置を返す。ハンドルは必ず閉じる。 */
  private async readOpenedFileChunk(
    request: Pick<
      SessionFileChunkRequest,
      "offset" | "length" | "expectedRevision"
    >,
    opened: AuthorizedOpenedFile,
    restrictedKind?: "image" | "pdf",
  ): Promise<SessionFileChunkResult> {
    try {
      const { handle, stats: fileStats } = opened;
      const revision = makeFileRevision(fileStats);
      if (request.expectedRevision !== revision) {
        throw new Error(
          "The file changed while it was being read. Reload and try again.",
        );
      }
      if (restrictedKind) {
        const header = new Uint8Array(
          Math.min(INSPECTION_BYTES, Number(fileStats.size)),
        );
        const inspection = await handle.read(header, 0, header.byteLength, 0);
        const inspectedBytes = header.subarray(0, inspection.bytesRead);
        if (restrictedKind === "pdf") detectLocalPdfResource(inspectedBytes);
        else detectLocalImageResource(inspectedBytes);
      }
      const byteLength = Number(fileStats.size);
      const bytes = new Uint8Array(
        Math.min(request.length, Math.max(0, byteLength - request.offset)),
      );
      const { bytesRead } = await handle.read(
        bytes,
        0,
        bytes.byteLength,
        request.offset,
      );
      const fileStatsAfterRead = await handle.stat({ bigint: true });
      const revisionAfterRead = makeFileRevision(fileStatsAfterRead);
      if (revisionAfterRead !== revision) {
        throw new Error(
          "The file changed while it was being read. Reload and try again.",
        );
      }
      const data = bytes.slice(0, bytesRead).buffer;
      const nextOffset = request.offset + bytesRead;
      return {
        data,
        offset: request.offset,
        nextOffset,
        totalBytes: byteLength,
        done: nextOffset >= byteLength,
        revision,
      };
    } finally {
      await opened.handle.close();
    }
  }
}
