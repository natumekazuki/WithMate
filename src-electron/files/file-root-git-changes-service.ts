import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDefaultGitExecutablePath } from "../platform/git-executable.js";

import type {
  FileRootChangesRequest,
  FileRootChangesRepositoriesRequest,
  FileRootChangesRepositoriesResult,
  FileRootChangesResult,
  FileRootFileDiffRequest,
  FileRootFileDiffResult,
  FileRootGitChangeEntry,
  FileRootGitChangeKind,
  FileRootGitHistoryCommit,
  FileRootGitHistoryCommitDetailRequest,
  FileRootGitHistoryCommitDetailResult,
  FileRootGitHistoryCommitsRequest,
  FileRootGitHistoryCommitsResult,
  FileRootGitHistoryAvailableRef,
  FileRootGitHistoryComparison,
  FileRootGitHistoryComparisonRequest,
  FileRootGitHistoryComparisonResult,
  FileRootGitHistoryComparisonSelector,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryDiffResult,
  FileRootGitHistoryRequest,
  FileRootGitHistoryRef,
  FileRootGitHistoryRefKind,
  FileRootGitHistoryRepositoriesRequest,
  FileRootGitHistoryRepositoriesResult,
  SessionFileChunkRequest,
  SessionFileChunkResult,
  SessionFileDescriptor,
  SessionFileGitCommitResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  detectSessionFileEncoding,
  detectSessionFileResourceKind,
} from "../../src-shared/file-explorer/file-content-detection.js";
import { isFileRootGitHistoryComparisonDiffRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  normalizeGitRelativePath as normalizeGitRelativePathParser,
  normalizeHistoryBranch as normalizeHistoryBranchParser,
  normalizeHistoryObjectId as normalizeHistoryObjectIdParser,
  normalizeWorkspacePrefix as normalizeWorkspacePrefixParser,
  parseGitHistoryAvailableRefs as parseGitHistoryAvailableRefsParser,
  parseGitHistoryLog as parseGitHistoryLogParser,
  parseGitHistoryNameStatusZ as parseGitHistoryNameStatusZParser,
  parseGitPorcelainV1Z as parseGitPorcelainV1ZParser,
} from "./file-root-git-parsers.js";

/** 認可済みのファイルルートを Git 操作の起点になるディレクトリで表す。 */
export type FileRootGitContext = {
  rootPath: string;
};

/** 履歴候補を表示・選択するためのルート識別子、表示情報、実パスを持つ。 */
export type FileRootGitHistoryRootContext = {
  rootId: string;
  label: string;
  displayPath: string;
  rootPath: string;
};

/** 認可済みルートや Git 実行手段を上位から受け取り、期限とリソース解放も注入できる。 */
export type FileRootGitChangesServiceDeps = {
  /** 差分要求を認可済みルートへ引き直し、利用できない場合は null を返す。 */
  resolveRootContext(
    request: FileRootChangesRequest,
  ): Promise<FileRootGitContext | null>;
  resolveHistoryRootContexts?: (
    sessionId: string,
  ) => Promise<FileRootGitHistoryRootContext[]>;
  resolveHistoryRootContext?: (
    request: FileRootGitHistoryRequest,
  ) => Promise<FileRootGitContext | null>;
  runGit?: (
    workspacePath: string,
    args: string[],
    options: WorkspaceGitProcessOptions,
  ) => Promise<{ exitCode: number; stdout: Buffer; stderr: string }>;
  resolveGitExecutablePath?: () => Promise<string>;
  processEnv?: NodeJS.ProcessEnv;
  operationTimeoutMs?: number;
  cleanupRetryDelayMs?: number;
  removeTemporaryDirectory?: (directoryPath: string) => Promise<void>;
  closeDirectoryLease?: (fileHandle: FileHandle) => Promise<void>;
};

/** Git 子プロセスに渡す実行環境・標準入力・中断信号と、出力の取得・打ち切り条件。 */
type WorkspaceGitProcessOptions = {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  stdin?: Buffer;
  signal?: AbortSignal;
  captureStdoutBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

/** 終了コードとバイト列の標準出力を保持し、標準エラーは診断用の文字列として扱う。 */
type GitCommandResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
};

const GIT_GLOBAL_ARGS = [
  "--no-optional-locks",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
] as const;
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;
const WINDOWS_UV_FS_O_TEMPORARY = 0x0040;
const MAX_CONCURRENT_WORKSPACE_GIT_OPERATIONS = 2;
const MAX_PENDING_WORKSPACE_GIT_OPERATIONS = 16;
const DEFAULT_WORKSPACE_GIT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_RETRY_DELAY_MS = 50;
const CLEANUP_ATTEMPTS = 3;
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_LIST_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_DETAIL_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_DIFF_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_FILE_BLOB_BYTES = 64 * 1024 * 1024;
const HISTORY_FILE_INSPECTION_BYTES = 8 * 1024;
const MAX_HISTORY_STDERR_BYTES = 64 * 1024;
const HISTORY_LOG_FORMAT =
  "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D%x00%x01";

/** Windows のディレクトリパスだけを Git 設定向けのスラッシュ区切りに揃える。 */
function normalizeGitConfigPath(directoryPath: string): string {
  return process.platform === "win32"
    ? directoryPath.replace(/\\/g, "/")
    : directoryPath;
}

/** リポジトリの探索候補となる絶対パスを、指定ディレクトリからファイルシステムの根まで列挙する。 */
function listAncestorDirectoryPaths(directoryPath: string): string[] {
  const ancestors: string[] = [];
  let currentPath = path.resolve(directoryPath);
  while (true) {
    ancestors.push(currentPath);
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return ancestors;
    }
    currentPath = parentPath;
  }
}

/** 指定されたディレクトリを、永続設定を変えずコマンド単位の safe.directory として渡す。 */
function createSafeDirectoryArgs(directoryPaths: string[]): string[] {
  return directoryPaths.flatMap((directoryPath) => [
    "-c",
    `safe.directory=${normalizeGitConfigPath(directoryPath)}`,
  ]);
}

const WORK_TREE_CONFIG_KEYS = [
  "core.autocrlf",
  "core.eol",
  "core.filemode",
  "core.symlinks",
  "core.ignorecase",
  "core.precomposeunicode",
] as const;

/** 省略値・真偽語・基数や単位付きの数値を Git の真偽値へ揃え、解釈不能または範囲外なら null を返す。 */
function normalizeGitBoolean(value: string | null): "true" | "false" | null {
  if (value === null) {
    return "true";
  }
  if (value === "") {
    return "false";
  }
  if (/^(?:true|yes|on|1)$/i.test(value)) {
    return "true";
  }
  if (/^(?:false|no|off|0)$/i.test(value)) {
    return "false";
  }
  const numericMatch =
    /^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)$/.exec(value);
  if (numericMatch) {
    const [, , digits, suffix] = numericMatch;
    const radix = digits.toLowerCase().startsWith("0x")
      ? 16
      : digits.length > 1 && digits.startsWith("0")
        ? 8
        : 10;
    const magnitudeDigits = (
      radix === 16 ? digits.slice(2) : radix === 8 ? digits.slice(1) : digits
    )
      .replace(/^0+/, "")
      .toLowerCase();
    if (!magnitudeDigits) {
      return "false";
    }
    const multiplier =
      suffix.toLowerCase() === "k"
        ? 1024n
        : suffix.toLowerCase() === "m"
          ? 1024n ** 2n
          : suffix.toLowerCase() === "g"
            ? 1024n ** 3n
            : 1n;
    const maximumMagnitude =
      process.platform === "win32" ? 0x7fffffffn : 0x7fffffffffffffffn;
    const maximumInputDigits = (maximumMagnitude / multiplier).toString(radix);
    if (
      magnitudeDigits.length > maximumInputDigits.length ||
      (magnitudeDigits.length === maximumInputDigits.length &&
        magnitudeDigits > maximumInputDigits)
    ) {
      return null;
    }
    return "true";
  }
  return null;
}

/** 許可した作業ツリー設定だけを、隔離実行へ引き継げる値に正規化する。 */
function normalizeWorkTreeConfigValue(
  key: string,
  value: string | null,
): string | null {
  if (
    [
      "core.filemode",
      "core.symlinks",
      "core.ignorecase",
      "core.precomposeunicode",
    ].includes(key)
  ) {
    return normalizeGitBoolean(value);
  }
  if (key === "core.autocrlf") {
    const normalizedBoolean = normalizeGitBoolean(value);
    return (
      normalizedBoolean ?? (value?.toLowerCase() === "input" ? "input" : null)
    );
  }
  if (key === "core.eol") {
    const normalized = value?.toLowerCase();
    return normalized === "lf" ||
      normalized === "crlf" ||
      normalized === "native"
      ? normalized
      : null;
  }
  return null;
}

/** NUL 区切りの設定を読み、許可キーの最後の値をコマンド単位の設定へ変換する。不正な値は拒む。 */
function parseWorkTreeConfigArgs(output: Buffer): string[] {
  const values = new Map<string, string>();
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) {
      continue;
    }
    const separatorIndex = record.indexOf("\n");
    if (separatorIndex === 0) {
      throw new Error("Git work tree config returned an unsupported result.");
    }
    const key = (
      separatorIndex < 0 ? record : record.slice(0, separatorIndex)
    ).toLowerCase();
    if (
      !WORK_TREE_CONFIG_KEYS.includes(
        key as (typeof WORK_TREE_CONFIG_KEYS)[number],
      )
    ) {
      continue;
    }
    const value = normalizeWorkTreeConfigValue(
      key,
      separatorIndex < 0 ? null : record.slice(separatorIndex + 1),
    );
    if (value === null) {
      throw new Error(`Git work tree config ${key} has an unsupported value.`);
    }
    values.set(key, value);
  }
  return WORK_TREE_CONFIG_KEYS.flatMap((key) => {
    const value = values.get(key);
    return value === undefined ? [] : ["-c", `${key}=${value}`];
  });
}

/** グローバル除外ファイルが一意に得られた場合だけ、コマンド単位の設定として渡す。 */
function parseGlobalExcludesFileArgs(output: Buffer): string[] {
  const values = output.toString("utf8").split("\0").filter(Boolean);
  if (values.length !== 1) {
    throw new Error(
      "Git global core.excludesFile returned an unsupported result.",
    );
  }
  return ["-c", `core.excludesFile=${values[0]}`];
}

/** 同じ用途の新しい要求に置換され得る、まだ実行枠を取得していない Git 要求。 */
type WorkspaceGitAdmissionJob = {
  supersessionKey: string;
  /** 待機列から取り出された要求を実行する。 */
  start(): Promise<void>;
  /** 開始できない要求の呼び出し元へ失敗を返す。 */
  reject(error: unknown): void;
};

const pendingWorkspaceGitOperations: WorkspaceGitAdmissionJob[] = [];
let activeWorkspaceGitOperations = 0;

/** 即時に削除できなかった一時ディレクトリを後続処理で削除するための記録。 */
type PendingTemporaryDirectoryCleanup = {
  /** 追跡中の一時ディレクトリを削除する。失敗は呼び出し元へ伝える。 */
  remove(): Promise<void>;
};

/** 即時に閉じられなかったディレクトリの保持ハンドルを後続処理で閉じるための記録。 */
type PendingLeaseCleanup = {
  /** 追跡中の保持ハンドルを閉じる。失敗は呼び出し元へ伝える。 */
  close(): Promise<void>;
};

const pendingWorkspaceGitTemporaryDirectories = new Map<
  string,
  PendingTemporaryDirectoryCleanup
>();
const pendingWorkspaceGitLeaseHandles = new Map<
  FileHandle,
  PendingLeaseCleanup
>();
let workspaceGitCleanupTail: Promise<void> = Promise.resolve();

/** Git プレビューの実行枠取得後に期限を超えたことを示す。 */
class WorkspaceGitOperationTimeoutError extends Error {
  /** 期限切れを示す既定の Git プレビュー診断を設定する。 */
  constructor() {
    super("File root Git preview timed out before the operation completed.");
  }
}

/** 中断に付された Error を引き継ぎ、ない場合はプレビューの期限切れとして扱う。 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new WorkspaceGitOperationTimeoutError();
}

/** 信号がすでに中断されていれば、後続の Git 操作に進まず中断理由を投げる。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

/** 空いている実行枠へ待機順に要求を割り当て、終了した枠を次の要求に明け渡す。 */
function drainWorkspaceGitOperationQueue(): void {
  while (
    activeWorkspaceGitOperations < MAX_CONCURRENT_WORKSPACE_GIT_OPERATIONS &&
    pendingWorkspaceGitOperations.length > 0
  ) {
    const job = pendingWorkspaceGitOperations.shift()!;
    activeWorkspaceGitOperations += 1;
    job.start().finally(() => {
      activeWorkspaceGitOperations -= 1;
      drainWorkspaceGitOperationQueue();
    });
  }
}

/** プロセス全体で待機数を制限し、同じキーの待機要求を新しい要求で置き換える。期限は開始時から数える。 */
function runWorkspaceGitOperationWithAdmission<T>(
  supersessionKey: string,
  timeoutMs: number,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const supersededIndex = pendingWorkspaceGitOperations.findIndex(
      (job) => job.supersessionKey === supersessionKey,
    );
    if (supersededIndex >= 0) {
      pendingWorkspaceGitOperations
        .splice(supersededIndex, 1)[0]
        ?.reject(
          new Error("File root Git preview was superseded by a newer request."),
        );
    }
    if (
      pendingWorkspaceGitOperations.length >=
      MAX_PENDING_WORKSPACE_GIT_OPERATIONS
    ) {
      reject(new Error("Too many file root Git previews are already waiting."));
      return;
    }
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    pendingWorkspaceGitOperations.push({
      supersessionKey,
      reject,
      /** 実行枠取得後に期限信号を設定し、要求の成否を通知してタイマーを解放する。 */
      async start() {
        timeout = setTimeout(() => {
          abortController.abort(new WorkspaceGitOperationTimeoutError());
        }, timeoutMs);
        timeout.unref?.();
        try {
          const result = await execute(abortController.signal);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
        }
      },
    });
    drainWorkspaceGitOperationQueue();
  });
}

/** 継承された Git 固有の環境変数を取り除き、設定照会時のロケールを固定する。 */
function createWorkspaceGitConfigReadEnv(
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inheritedEnv = Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...inheritedEnv,
    LC_ALL: "C",
    LANG: "C",
  };
}

/** 通常の Git 操作用に、設定照会の環境に加えてシステムとグローバルの設定ファイルを無効にする。 */
function createWorkspaceGitProcessEnv(
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...createWorkspaceGitConfigReadEnv(sourceEnv),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
  };
}

/** シェルを介さず Git を起動し、中断または出力上限の超過時は子を停止する。標準出力は指定された先頭部分だけ保持できる。 */
function runGitProcess(
  workspacePath: string,
  args: string[],
  options: WorkspaceGitProcessOptions,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.executablePath, args, {
        cwd: workspacePath,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdin || !childStdout || !childStderr) {
      child.kill();
      reject(
        new Error("Git process did not expose the required standard streams."),
      );
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let capturedStdoutBytes = 0;
    let stderrBytes = 0;
    let processError: Error | null = null;
    let outputLimitError: Error | null = null;
    let settled = false;
    /** 処理の確定を一度に限り、確定前に中断リスナーを解除する。 */
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (options.signal) {
        options.signal.removeEventListener("abort", handleAbort);
      }
      callback();
    };
    /** 中断された実行中の Git 子プロセスに終了を要求する。 */
    const handleAbort = () => {
      child.kill();
    };
    childStdout.on("data", (chunk: Buffer) => {
      const remainingCaptureBytes =
        options.captureStdoutBytes === undefined
          ? chunk.length
          : Math.max(0, options.captureStdoutBytes - capturedStdoutBytes);
      if (remainingCaptureBytes > 0) {
        const capturedChunk = chunk.subarray(0, remainingCaptureBytes);
        stdoutChunks.push(capturedChunk);
        capturedStdoutBytes += capturedChunk.length;
      }
      stdoutBytes += chunk.length;
      if (
        options.maxStdoutBytes !== undefined &&
        stdoutBytes > options.maxStdoutBytes
      ) {
        outputLimitError = new Error(
          "Git stdout exceeded the configured resource limit.",
        );
        child.kill();
      }
    });
    childStderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      if (
        options.maxStderrBytes !== undefined &&
        stderrBytes > options.maxStderrBytes
      ) {
        outputLimitError = new Error(
          "Git stderr exceeded the configured resource limit.",
        );
        child.kill();
      }
    });
    child.once("error", (error) => {
      processError = error;
      if (child.pid === undefined) {
        settle(() => reject(error));
      }
    });
    childStdin.once("error", (error) => {
      processError = error;
      child.kill();
    });
    child.once("close", (exitCode) => {
      settle(() => {
        if (options.signal?.aborted) {
          reject(abortReason(options.signal));
          return;
        }
        if (processError) {
          reject(processError);
          return;
        }
        if (outputLimitError) {
          reject(outputLimitError);
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        });
      });
    });
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
    }
    childStdin.end(options.stdin);
  });
}

/** リポジトリパスから履歴選択用の ID を作る。Windows ではパスの大文字・小文字を区別しない。 */
function createHistoryRepositoryId(repositoryPath: string): string {
  const identityPath =
    process.platform === "win32"
      ? repositoryPath.toLowerCase()
      : repositoryPath;
  return `git:${createHash("sha256").update(identityPath, "utf8").digest("hex").slice(0, 24)}`;
}

/** 履歴ページのカーソルを取得済み件数へ戻す。未指定・空は先頭、不正な整数表現は拒否する。 */
function normalizeHistoryCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") {
    return 0;
  }
  if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(cursor)) {
    throw new Error("Git history cursor is invalid.");
  }
  return Number(cursor);
}

/** 完全参照名のローカルブランチ一覧から名前を切り出し、初出順で重複を除く。 */
function parseHistoryBranchList(output: Buffer): string[] {
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const rawBranch of output.toString("utf8").split(/\r?\n/u)) {
    if (!rawBranch) continue;
    const branch = normalizeHistoryBranchParser(
      rawBranch.slice("refs/heads/".length),
    );
    if (seen.has(branch)) continue;
    seen.add(branch);
    branches.push(branch);
  }
  return branches;
}

/** symbolic-ref 出力から現在のローカルブランチ名を取り出し、空出力なら null を返す。 */
function parseCurrentHistoryBranch(output: Buffer): string | null {
  const value = output.toString("utf8").replace(/\r?\n$/u, "");
  return value
    ? normalizeHistoryBranchParser(value.slice("refs/heads/".length))
    : null;
}

/** 比較方式ごとの参照名や短縮 ID の書式を検査する。参照の存在や実体の確定は別に行う。 */
function normalizeHistoryComparisonSelector(
  selector: FileRootGitHistoryComparisonSelector,
): FileRootGitHistoryComparisonSelector {
  if (!selector || typeof selector !== "object") {
    throw new HistoryComparisonFailure(
      "invalid-selector",
      "The Git comparison selector is invalid.",
    );
  }
  if (selector.kind === "head") {
    return { kind: "head" };
  }
  if (
    selector.kind === "branch" ||
    selector.kind === "remote" ||
    selector.kind === "tag"
  ) {
    try {
      const name = normalizeHistoryBranchParser(selector.name);
      if (name.trim() !== name || name.includes("\\") || name.includes("..")) {
        throw new Error("invalid ref name");
      }
      return { kind: selector.kind, name };
    } catch {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison ref is invalid.",
      );
    }
  }
  if (selector.kind === "commit") {
    if (
      typeof selector.objectId !== "string" ||
      !/^[0-9a-f]{7,64}$/iu.test(selector.objectId)
    ) {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison commit id is invalid.",
      );
    }
    return { kind: "commit", objectId: selector.objectId.toLowerCase() };
  }
  throw new HistoryComparisonFailure(
    "invalid-selector",
    "The Git comparison selector is invalid.",
  );
}

/** ディレクトリが存在しない場合と途中の構成要素がディレクトリでない場合を、パスの消失として扱う。 */
function isMissingFilesystemError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** ファイルルートが Git 管理外の場合と Git 操作が失敗した場合を区別する。 */
type WorkspaceGitFailure = {
  status: "not-git" | "failed";
  message: string;
};

/** 差分操作の準備段階で、ルート自体が見つからない場合も含めて失敗を表す。 */
type WorkspaceGitOperationFailure =
  | WorkspaceGitFailure
  | {
      status: "root-not-found";
      message: string;
    };

/** 履歴のリポジトリが選択範囲にない場合と、解決処理が失敗した場合を区別する。 */
type HistoryGitOperationFailure = {
  status: "repository-not-found" | "failed";
  message: string;
};

/** 履歴に使えるローカルブランチ名と、現在のブランチがある場合はその名前を持つ。 */
type HistoryBranchState = {
  branches: string[];
  currentBranch: string | null;
};

/** 入力不正・コミット欠落・共通祖先の欠落または曖昧さを区別する比較失敗コード。 */
type HistoryComparisonFailureStatus =
  | "invalid-selector"
  | "commit-not-found"
  | "merge-base-unavailable"
  | "ambiguous-merge-base";

/** 履歴比較の失敗を、応答に引き継げる判別コードと診断で表す。 */
class HistoryComparisonFailure extends Error {
  /** 比較要求へ返す失敗コードと診断を組み合わせて保持する。 */
  constructor(
    readonly status: HistoryComparisonFailureStatus,
    message: string,
  ) {
    super(message);
  }
}

/** 差分失敗の応答を作り、診断が空なら既定メッセージを補う。 */
function failedStatus(message: string): WorkspaceGitFailure {
  return { status: "failed", message: message || "Git status failed." };
}

/** 正規パスとデバイス・inode の組で、操作対象のディレクトリを識別する。 */
type DirectoryIdentity = {
  realPath: string;
  device: bigint;
  inode: bigint;
};

/** 作業ツリーの最上位、Git ディレクトリ、共有ディレクトリを個別に識別する。 */
type GitRepositoryIdentity = {
  topLevel: DirectoryIdentity;
  gitDirectory: DirectoryIdentity;
  commonDirectory: DirectoryIdentity;
};

/** 認可されたルートとリポジトリの識別情報、保持ハンドル、隔離用の状態、中断信号を一操作に束ねる。 */
type WorkspaceGitOperation = {
  workspacePath: string;
  workspaceIdentity: DirectoryIdentity;
  repositoryIdentity: GitRepositoryIdentity;
  workspaceLease: DirectoryLease;
  repositoryLeases: DirectoryLease[];
  isolatedGitDirectoryPath: string | null;
  workTreeConfigArgs: string[] | null;
  signal: AbortSignal;
};

/** 履歴ツリー内のファイルについて、モード、blob のオブジェクト ID、バイト長を保持する。 */
type HistoryFileBlobEntry = {
  mode: string;
  objectId: string;
  byteLength: number;
};

/** ディレクトリの保持に使う開いたファイルハンドルと、そのファイル名を保持する。 */
type DirectoryLease = {
  fileHandle: FileHandle;
  fileName: string;
};

/** 作業ツリーはそのまま参照しつつ、差分計算の Git ディレクトリと設定を隔離するための情報。 */
type IsolatedGitContext = {
  gitDirectoryPath: string;
  lockRepositoryRelativePath: string;
  workTreeConfigArgs: string[];
};

/** 操作中にワークスペースまたはリポジトリを同じディレクトリとして確認できなくなったことを示す。 */
class OperationIdentityChangedError extends Error {
  /** 対象の差し替えや消失を示す操作失敗の診断を設定する。 */
  constructor() {
    super("Workspace or Git repository changed during the operation.");
  }
}

/** Git の探索で、選択ルートがリポジトリに属さないと判明した場合を表す。 */
class WorkspaceNotGitRepositoryError extends Error {
  /** Git 管理外のファイルルートを示す診断を設定する。 */
  constructor() {
    super("File root is not a Git repository.");
  }
}

/** プレビューが残したファイルやハンドルを解放できなかった場合の診断をまとめる。 */
class WorkspaceGitCleanupError extends Error {
  /** 複数のリソース解放失敗を一つの診断に連結する。 */
  constructor(messages: string[]) {
    super(`File root Git preview cleanup failed: ${messages.join("; ")}`);
  }
}

/** ディレクトリのシンボリックリンク等を解決し、正規パスと実体を識別する値を読む。ディレクトリ以外は拒む。 */
async function captureDirectoryIdentity(
  directoryPath: string,
): Promise<DirectoryIdentity> {
  const canonicalPath = await realpath(directoryPath);
  const directoryStat = await stat(canonicalPath, { bigint: true });
  if (!directoryStat.isDirectory()) {
    throw new Error("Expected a directory while resolving Git identity.");
  }
  return {
    realPath: canonicalPath,
    device: directoryStat.dev,
    inode: directoryStat.ino,
  };
}

/** 正規パス、デバイス、inode のすべてが一致する場合だけ同じ対象とみなす。 */
function directoryIdentityMatches(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

/** Git 出力が小文字の完全オブジェクト ID なら返し、形式が異なる場合は null を返す。 */
function normalizeObjectId(output: Buffer): string | null {
  const value = output.toString("utf8").trim();
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** 隔離リポジトリに引き継げるオブジェクト形式を SHA-1 と SHA-256 に限定する。 */
function normalizeObjectFormat(output: Buffer): "sha1" | "sha256" {
  const value = output.toString("utf8").trim();
  if (value !== "sha1" && value !== "sha256") {
    throw new Error("Git repository uses an unsupported object format.");
  }
  return value;
}

/** 隔離側へ書ける HEAD の参照を、許可した文字から成るローカルブランチの完全参照名に限定する。 */
function normalizeSymbolicHead(output: Buffer): string {
  const value = output.toString("utf8").trim();
  if (
    !/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(value) ||
    value.includes("..") ||
    value.endsWith("/")
  ) {
    throw new Error("Git HEAD uses an unsupported symbolic reference.");
  }
  return value;
}

/** rev-parse の結果からトップレベル、Git ディレクトリ、共有ディレクトリを順に取り出す。空行や過不足を拒む。 */
function parseRepositoryIdentityPaths(
  output: Buffer,
): [string, string, string] {
  const lines = output
    .toString("utf8")
    .replace(/\r?\n$/, "")
    .split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => !line)) {
    throw new Error("Git repository identity returned an unsupported result.");
  }
  return [lines[0]!, lines[1]!, lines[2]!];
}

/** Git インデックスに記録された項目のモード、オブジェクト ID、競合ステージ、パスを保持する。 */
type GitIndexEntry = {
  mode: string;
  objectId: string;
  stage: number;
  path: string;
};

/** ls-files の NUL 区切りのステージ情報を読み、タブより前のモード・オブジェクト ID・ステージを検証する。 */
function parseGitIndexEntries(output: Buffer): GitIndexEntry[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tabIndex = record.indexOf("\t");
      const match =
        tabIndex >= 0
          ? /^(\d+) ([0-9a-f]+) ([0-3])$/.exec(record.slice(0, tabIndex))
          : null;
      if (!match) {
        throw new Error("Git index returned an unsupported stage record.");
      }
      return {
        mode: match[1]!,
        objectId: match[2]!,
        stage: Number(match[3]),
        path: record.slice(tabIndex + 1),
      };
    });
}

/** ステージとパスを保持したまま、隔離インデックスへ渡す NUL 区切りの入力に直す。 */
function serializeGitIndexEntries(entries: GitIndexEntry[]): Buffer {
  return Buffer.from(
    entries
      .map(
        (entry) =>
          `${entry.mode} ${entry.objectId} ${entry.stage}\t${entry.path}\0`,
      )
      .join(""),
    "utf8",
  );
}

/** NUL 区切りで得たパスを、空要素なしの照合用集合へ変換する。 */
function parseNullSeparatedPaths(output: Buffer): Set<string> {
  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

/** ls-files のタグの大小文字と S を手掛かりに、assume-unchanged と skip-worktree を個別に復元する。 */
function parseGitIndexFlags(output: Buffer): {
  assumeUnchangedPaths: string[];
  skipWorktreePaths: string[];
} {
  const assumeUnchangedPaths: string[] = [];
  const skipWorktreePaths: string[] = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) {
      continue;
    }
    if (record.length < 3 || record[1] !== " ") {
      throw new Error("Git index returned an unsupported flag record.");
    }
    const tag = record[0]!;
    const filePath = record.slice(2);
    if (tag === tag.toLowerCase()) {
      assumeUnchangedPaths.push(filePath);
    }
    if (tag.toUpperCase() === "S") {
      skipWorktreePaths.push(filePath);
    }
  }
  return { assumeUnchangedPaths, skipWorktreePaths };
}

/** 空白や改行を含むパスも区別できるよう、各パスに NUL を付けた標準入力を作る。 */
function serializeNullSeparatedPaths(paths: string[]): Buffer {
  return Buffer.from(paths.map((filePath) => `${filePath}\0`).join(""), "utf8");
}

/** check-attr の三つ組から有効な filter 名を重複なく集め、扱えない名前を拒む。 */
function parseActiveGitFilterDrivers(output: Buffer): string[] {
  const fields = output.toString("utf8").split("\0");
  const drivers = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (
      attribute !== "filter" ||
      !value ||
      value === "unspecified" ||
      value === "unset"
    ) {
      continue;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
      throw new Error(
        "Git clean/process filters are not supported for Workspace changes.",
      );
    }
    drivers.add(value);
  }
  return [...drivers];
}

/** 認可済みファイルルートの作業差分・履歴・履歴ファイルを読み、取得中の対象と一時リソースを管理する。 */
export class FileRootGitChangesService {
  readonly #resolveRootContext: FileRootGitChangesServiceDeps["resolveRootContext"];
  readonly #resolveHistoryRootContexts: NonNullable<
    FileRootGitChangesServiceDeps["resolveHistoryRootContexts"]
  > | null;
  readonly #resolveHistoryRootContext: NonNullable<
    FileRootGitChangesServiceDeps["resolveHistoryRootContext"]
  > | null;
  readonly #runGit: NonNullable<FileRootGitChangesServiceDeps["runGit"]>;
  readonly #resolveGitExecutablePath: () => Promise<string>;
  readonly #gitProcessEnv: NodeJS.ProcessEnv;
  readonly #gitConfigReadEnv: NodeJS.ProcessEnv;
  readonly #operationTimeoutMs: number;
  readonly #cleanupRetryDelayMs: number;
  readonly #removeTemporaryDirectory: (directoryPath: string) => Promise<void>;
  readonly #closeDirectoryLease: (fileHandle: FileHandle) => Promise<void>;
  #gitExecutablePath: Promise<string> | null = null;

  /** ルート解決、Git 実行と後始末の依存を設定する。Git の実行ファイルは初回使用まで解決しない。 */
  constructor(deps: FileRootGitChangesServiceDeps) {
    this.#resolveRootContext = deps.resolveRootContext;
    this.#resolveHistoryRootContexts = deps.resolveHistoryRootContexts ?? null;
    this.#resolveHistoryRootContext = deps.resolveHistoryRootContext ?? null;
    this.#runGit = deps.runGit ?? runGitProcess;
    this.#resolveGitExecutablePath =
      deps.resolveGitExecutablePath ??
      (deps.runGit ? async () => "git" : getDefaultGitExecutablePath);
    this.#gitProcessEnv = createWorkspaceGitProcessEnv(
      deps.processEnv ?? process.env,
    );
    this.#gitConfigReadEnv = createWorkspaceGitConfigReadEnv(
      deps.processEnv ?? process.env,
    );
    this.#operationTimeoutMs =
      deps.operationTimeoutMs ?? DEFAULT_WORKSPACE_GIT_OPERATION_TIMEOUT_MS;
    this.#cleanupRetryDelayMs =
      deps.cleanupRetryDelayMs ?? DEFAULT_CLEANUP_RETRY_DELAY_MS;
    this.#removeTemporaryDirectory =
      deps.removeTemporaryDirectory ??
      ((directoryPath) => rm(directoryPath, { recursive: true, force: true }));
    this.#closeDirectoryLease =
      deps.closeDirectoryLease ?? ((fileHandle) => fileHandle.close());
  }

  /** 複数の要求で Git の解決結果を共有する。解決が失敗した場合は次回に再試行できるよう保持を解除する。 */
  async #getGitExecutablePath(): Promise<string> {
    if (!this.#gitExecutablePath) {
      this.#gitExecutablePath = Promise.resolve().then(() =>
        this.#resolveGitExecutablePath(),
      );
    }
    try {
      return await this.#gitExecutablePath;
    } catch (error) {
      this.#gitExecutablePath = null;
      throw error;
    }
  }

  /** 環境と共通オプションを揃えて Git を呼び出し、注入された実行手段の結果にも出力制限を適用する。 */
  async #runGitCommand(
    workspacePath: string,
    args: string[],
    stdin?: Buffer,
    commonDirectoryPath?: string,
    signal?: AbortSignal,
    indexFilePath?: string,
    safeDirectoryPaths: string[] = [],
    limits?: {
      captureStdoutBytes?: number;
      maxStdoutBytes?: number;
      maxStderrBytes?: number;
    },
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    throwIfAborted(signal);
    const executablePath = await this.#getGitExecutablePath();
    const options: WorkspaceGitProcessOptions = {
      executablePath,
      env:
        commonDirectoryPath || indexFilePath
          ? {
              ...this.#gitProcessEnv,
              ...(commonDirectoryPath
                ? { GIT_COMMON_DIR: commonDirectoryPath }
                : {}),
              ...(indexFilePath ? { GIT_INDEX_FILE: indexFilePath } : {}),
            }
          : this.#gitProcessEnv,
      stdin,
      signal,
    };
    if (limits?.maxStdoutBytes !== undefined) {
      options.maxStdoutBytes = limits.maxStdoutBytes;
    }
    if (limits?.captureStdoutBytes !== undefined) {
      options.captureStdoutBytes = limits.captureStdoutBytes;
    }
    if (limits?.maxStderrBytes !== undefined) {
      options.maxStderrBytes = limits.maxStderrBytes;
    }
    const result = await this.#runGit(
      workspacePath,
      [
        ...GIT_GLOBAL_ARGS,
        ...createSafeDirectoryArgs(safeDirectoryPaths),
        ...args,
      ],
      options,
    );
    if (
      limits?.maxStdoutBytes !== undefined &&
      result.stdout.length > limits.maxStdoutBytes
    ) {
      throw new Error("Git stdout exceeded the configured resource limit.");
    }
    if (
      limits?.maxStderrBytes !== undefined &&
      Buffer.byteLength(result.stderr, "utf8") > limits.maxStderrBytes
    ) {
      throw new Error("Git stderr exceeded the configured resource limit.");
    }
    return limits?.captureStdoutBytes !== undefined &&
      result.stdout.length > limits.captureStdoutBytes
      ? {
          ...result,
          stdout: result.stdout.subarray(0, limits.captureStdoutBytes),
        }
      : result;
  }

  /** 対象リポジトリの実体を操作前後で確かめ、作業ツリーの解釈に関わる許可設定だけを読み出す。 */
  async #readWorkTreeConfigArgs(
    operation: WorkspaceGitOperation,
  ): Promise<string[]> {
    await this.#assertOperationIdentity(operation);
    const executablePath = await this.#getGitExecutablePath();
    let result: GitCommandResult;
    try {
      result = await this.#runGit(
        operation.workspaceIdentity.realPath,
        [
          ...GIT_GLOBAL_ARGS,
          ...createSafeDirectoryArgs([
            operation.repositoryIdentity.topLevel.realPath,
          ]),
          `--git-dir=${operation.repositoryIdentity.gitDirectory.realPath}`,
          `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
          "config",
          "--null",
          "--get-regexp",
          "^core\\.(autocrlf|eol|filemode|symlinks|ignorecase|precomposeunicode)$",
        ],
        {
          executablePath,
          env: {
            ...this.#gitConfigReadEnv,
            GIT_COMMON_DIR:
              operation.repositoryIdentity.commonDirectory.realPath,
          },
          signal: operation.signal,
        },
      );
    } finally {
      await this.#assertOperationIdentity(operation);
    }
    if (result.exitCode === 1 && result.stdout.length === 0) {
      return [];
    }
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || "Git work tree config could not be resolved.",
      );
    }
    return parseWorkTreeConfigArgs(result.stdout);
  }

  /** グローバル設定の core.excludesFile だけを取得する。設定がなければ追加引数を返さない。 */
  async #readGlobalExcludesFileArgs(
    operation: WorkspaceGitOperation,
  ): Promise<string[]> {
    await this.#assertOperationIdentity(operation);
    const executablePath = await this.#getGitExecutablePath();
    let result: GitCommandResult;
    try {
      result = await this.#runGit(
        operation.workspaceIdentity.realPath,
        [
          ...GIT_GLOBAL_ARGS,
          "config",
          "--global",
          "--includes",
          "--null",
          "--path",
          "--get",
          "core.excludesFile",
        ],
        {
          executablePath,
          env: this.#gitConfigReadEnv,
          signal: operation.signal,
        },
      );
    } finally {
      await this.#assertOperationIdentity(operation);
    }
    if (result.exitCode === 1 && result.stdout.length === 0) {
      return [];
    }
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || "Git global core.excludesFile could not be resolved.",
      );
    }
    return parseGlobalExcludesFileArgs(result.stdout);
  }

  /** 認可されたワークスペースで Git ディレクトリを探索し、実パスを識別情報に変換する。管理外は専用エラーで伝える。 */
  async #captureRepositoryIdentity(
    workspacePath: string,
    expectedWorkspaceIdentity: DirectoryIdentity,
    signal: AbortSignal,
  ): Promise<GitRepositoryIdentity> {
    throwIfAborted(signal);
    await this.#assertWorkspaceIdentity(
      workspacePath,
      expectedWorkspaceIdentity,
    );
    let result: GitCommandResult;
    try {
      result = await this.#runGitCommand(
        expectedWorkspaceIdentity.realPath,
        [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-dir",
          "--git-common-dir",
        ],
        undefined,
        undefined,
        signal,
        undefined,
        listAncestorDirectoryPaths(expectedWorkspaceIdentity.realPath),
      );
    } finally {
      await this.#assertWorkspaceIdentity(
        workspacePath,
        expectedWorkspaceIdentity,
      );
    }
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr)) {
        throw new WorkspaceNotGitRepositoryError();
      }
      throw new Error(
        result.stderr || "Git repository identity could not be resolved.",
      );
    }
    const [topLevelPath, gitDirectoryPath, commonDirectoryPath] =
      parseRepositoryIdentityPaths(result.stdout);
    const identity = {
      topLevel: await captureDirectoryIdentity(topLevelPath),
      gitDirectory: await captureDirectoryIdentity(gitDirectoryPath),
      commonDirectory: await captureDirectoryIdentity(commonDirectoryPath),
    };
    await this.#assertWorkspaceIdentity(
      workspacePath,
      expectedWorkspaceIdentity,
    );
    return identity;
  }

  /** 元のワークスペースパスが現在も期待どおりのディレクトリへ解決されるかを確かめる。 */
  async #assertWorkspaceIdentity(
    workspacePath: string,
    expected: DirectoryIdentity,
  ): Promise<void> {
    try {
      const current = await captureDirectoryIdentity(workspacePath);
      if (!directoryIdentityMatches(current, expected)) {
        throw new OperationIdentityChangedError();
      }
    } catch (error) {
      if (error instanceof OperationIdentityChangedError) {
        throw error;
      }
      throw new OperationIdentityChangedError();
    }
  }

  /** 操作前に保存した作業ツリー、Git ディレクトリ、共有ディレクトリの実体を再確認し、差し替えや消失を失敗にする。 */
  async #assertOperationIdentity(
    operation: WorkspaceGitOperation,
  ): Promise<void> {
    throwIfAborted(operation.signal);
    try {
      await this.#assertWorkspaceIdentity(
        operation.workspacePath,
        operation.workspaceIdentity,
      );
      for (const expectedIdentity of [
        operation.repositoryIdentity.topLevel,
        operation.repositoryIdentity.gitDirectory,
        operation.repositoryIdentity.commonDirectory,
      ]) {
        const currentIdentity = await captureDirectoryIdentity(
          expectedIdentity.realPath,
        );
        if (!directoryIdentityMatches(currentIdentity, expectedIdentity)) {
          throw new OperationIdentityChangedError();
        }
      }
      await this.#assertWorkspaceIdentity(
        operation.workspacePath,
        operation.workspaceIdentity,
      );
    } catch (error) {
      if (error instanceof OperationIdentityChangedError) {
        throw error;
      }
      throw new OperationIdentityChangedError();
    }
  }

  /** Git ディレクトリと作業ツリーを明示して実行し、呼び出しの前後に認可済みの実体を確かめる。 */
  async #runIdentityBoundGit(
    operation: WorkspaceGitOperation,
    args: string[],
    stdin?: Buffer,
    limits?: {
      captureStdoutBytes?: number;
      maxStdoutBytes?: number;
      maxStderrBytes?: number;
    },
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    await this.#assertOperationIdentity(operation);
    let result: GitCommandResult;
    try {
      result = await this.#runGitCommand(
        operation.workspaceIdentity.realPath,
        [
          `--git-dir=${operation.repositoryIdentity.gitDirectory.realPath}`,
          `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
          ...args,
        ],
        stdin,
        operation.repositoryIdentity.commonDirectory.realPath,
        operation.signal,
        undefined,
        [operation.repositoryIdentity.topLevel.realPath],
        limits,
      );
    } catch (error) {
      await this.#assertOperationIdentity(operation);
      throw error;
    }
    await this.#assertOperationIdentity(operation);
    return result;
  }

  /** ドライバーの clean または process に空白でない設定値があるかを調べ、照会そのものの失敗とは区別する。 */
  async #hasConfiguredFilterCommand(
    operation: WorkspaceGitOperation,
    driver: string,
    commandName: "clean" | "process",
  ): Promise<boolean> {
    const result = await this.#runIdentityBoundGit(operation, [
      "config",
      "--includes",
      "--get-all",
      `filter.${driver}.${commandName}`,
    ]);
    if (result.exitCode === 1) {
      return false;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || "Git filter configuration could not be inspected.",
      );
    }
    return result.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .some((value) => value.trim().length > 0);
  }

  /** 対象の追跡済み・未追跡パスに適用される属性を読み、外部 clean/process を必要とする場合は差分準備を止める。 */
  async #assertNoActiveExternalFilters(
    operation: WorkspaceGitOperation,
    lockRepositoryRelativePath: string,
  ): Promise<void> {
    const files = await this.#runIdentityBoundGit(operation, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      `:(exclude,top,literal)${lockRepositoryRelativePath}`,
    ]);
    if (files.exitCode !== 0) {
      throw new Error(
        files.stderr || "Git file attributes could not be inspected.",
      );
    }
    if (files.stdout.length === 0) {
      return;
    }
    const attributes = await this.#runIdentityBoundGit(
      operation,
      ["check-attr", "-z", "--stdin", "filter"],
      files.stdout,
    );
    if (attributes.exitCode !== 0) {
      throw new Error(
        attributes.stderr || "Git file attributes could not be inspected.",
      );
    }
    for (const driver of parseActiveGitFilterDrivers(attributes.stdout)) {
      if (
        (await this.#hasConfiguredFilterCommand(operation, driver, "clean")) ||
        (await this.#hasConfiguredFilterCommand(operation, driver, "process"))
      ) {
        throw new Error(
          "Git clean/process filters are not supported for Workspace changes.",
        );
      }
    }
  }

  /** 作業ツリーを参照しつつ Git メタデータと設定を隔離したディレクトリで処理し、実行前後の実体を照合する。 */
  async #runIsolatedGit(
    operation: WorkspaceGitOperation,
    isolatedContext: IsolatedGitContext,
    args: string[],
    stdin?: Buffer,
  ): Promise<GitCommandResult> {
    await this.#assertOperationIdentity(operation);
    const result = await this.#runGitCommand(
      operation.workspaceIdentity.realPath,
      [
        `--git-dir=${isolatedContext.gitDirectoryPath}`,
        `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
        "-c",
        "core.bare=false",
        ...isolatedContext.workTreeConfigArgs,
        ...args,
      ],
      stdin,
      undefined,
      operation.signal,
    );
    await this.#assertOperationIdentity(operation);
    return result;
  }

  /** 元のインデックスから通常エントリ、intent-to-add、拡張フラグを復元し、元の作業ツリーを書き換えず隔離側へ反映する。 */
  async #projectWorkspaceIndex(
    operation: WorkspaceGitOperation,
    rootPath: string,
    gitDirectoryPath: string,
    headObjectId: string | null,
  ): Promise<void> {
    const indexEntriesResult = await this.#runIdentityBoundGit(operation, [
      "ls-files",
      "--stage",
      "--full-name",
      "-z",
      "--",
      ".",
    ]);
    if (indexEntriesResult.exitCode !== 0) {
      throw new Error(
        indexEntriesResult.stderr || "Git index could not be captured.",
      );
    }
    const indexFlagsResult = await this.#runIdentityBoundGit(operation, [
      "ls-files",
      "-v",
      "--full-name",
      "-z",
      "--",
      ".",
    ]);
    if (indexFlagsResult.exitCode !== 0) {
      throw new Error(
        indexFlagsResult.stderr || "Git index flags could not be captured.",
      );
    }
    const cachedAddedResult = await this.#runIdentityBoundGit(operation, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--diff-filter=A",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ".",
    ]);
    if (cachedAddedResult.exitCode !== 0) {
      throw new Error(
        cachedAddedResult.stderr ||
          "Git staged additions could not be captured.",
      );
    }
    const headPaths = new Set<string>();
    if (headObjectId) {
      const headPathsResult = await this.#runIdentityBoundGit(operation, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ".",
      ]);
      if (headPathsResult.exitCode !== 0) {
        throw new Error(
          headPathsResult.stderr || "Git HEAD paths could not be captured.",
        );
      }
      for (const filePath of parseNullSeparatedPaths(headPathsResult.stdout)) {
        headPaths.add(filePath);
      }
    }
    const emptyBlobResult = await this.#runGitCommand(
      rootPath,
      [`--git-dir=${gitDirectoryPath}`, "hash-object", "--stdin"],
      Buffer.alloc(0),
      undefined,
      operation.signal,
    );
    const emptyBlobObjectId =
      emptyBlobResult.exitCode === 0
        ? normalizeObjectId(emptyBlobResult.stdout)
        : null;
    if (!emptyBlobObjectId) {
      throw new Error(
        emptyBlobResult.stderr ||
          "Git empty blob identity could not be resolved.",
      );
    }

    const indexEntries = parseGitIndexEntries(indexEntriesResult.stdout);
    const cachedAddedPaths = parseNullSeparatedPaths(cachedAddedResult.stdout);
    const intentToAddEntries = indexEntries.filter(
      (entry) =>
        entry.stage === 0 &&
        entry.objectId === emptyBlobObjectId &&
        !headPaths.has(entry.path) &&
        !cachedAddedPaths.has(entry.path),
    );
    const intentToAddPaths = intentToAddEntries.map((entry) => entry.path);
    const intentToAddPathSet = new Set(intentToAddPaths);
    const materializedEntries = indexEntries.filter(
      (entry) => !intentToAddPathSet.has(entry.path),
    );
    if (intentToAddPaths.length > 0) {
      const intentWorkTreePath = path.join(rootPath, "intent-worktree");
      const intentIndexPath = path.join(rootPath, "intent-index");
      await mkdir(intentWorkTreePath, { recursive: true });
      for (const intentToAddPath of intentToAddPaths) {
        const placeholderPath = path.resolve(
          intentWorkTreePath,
          ...normalizeGitRelativePathParser(intentToAddPath).split("/"),
        );
        const relativePlaceholderPath = path.relative(
          intentWorkTreePath,
          placeholderPath,
        );
        if (
          !relativePlaceholderPath ||
          relativePlaceholderPath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePlaceholderPath)
        ) {
          throw new Error("Intent-to-add path escaped the isolated work tree.");
        }
      }

      const emptyTreeResult = await this.#runGitCommand(
        rootPath,
        [
          `--git-dir=${gitDirectoryPath}`,
          "hash-object",
          "-w",
          "-t",
          "tree",
          "--stdin",
        ],
        Buffer.alloc(0),
        undefined,
        operation.signal,
      );
      const emptyTreeObjectId =
        emptyTreeResult.exitCode === 0
          ? normalizeObjectId(emptyTreeResult.stdout)
          : null;
      if (!emptyTreeObjectId) {
        throw new Error(
          emptyTreeResult.stderr ||
            "Git empty tree identity could not be resolved.",
        );
      }

      // 各パスの引用処理は Git に任せ、元の index のモードを隔離した intent-to-add エントリに引き継ぐ。
      const intentIndexResult = await this.#runGitCommand(
        intentWorkTreePath,
        [
          `--git-dir=${gitDirectoryPath}`,
          `--work-tree=${intentWorkTreePath}`,
          "-c",
          "core.bare=false",
          "update-index",
          "-z",
          "--index-info",
        ],
        serializeGitIndexEntries(intentToAddEntries),
        undefined,
        operation.signal,
        intentIndexPath,
      );
      if (intentIndexResult.exitCode !== 0) {
        throw new Error(
          intentIndexResult.stderr ||
            "Intent-to-add index metadata could not be projected.",
        );
      }
      const intentPatchResult = await this.#runGitCommand(
        intentWorkTreePath,
        [
          `--git-dir=${gitDirectoryPath}`,
          `--work-tree=${intentWorkTreePath}`,
          "-c",
          "core.bare=false",
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          emptyTreeObjectId,
        ],
        undefined,
        undefined,
        operation.signal,
        intentIndexPath,
      );
      if (
        intentPatchResult.exitCode !== 0 ||
        intentPatchResult.stdout.length === 0
      ) {
        throw new Error(
          intentPatchResult.stderr ||
            "Intent-to-add patch could not be projected.",
        );
      }
      const intentResult = await this.#runGitCommand(
        intentWorkTreePath,
        [
          `--git-dir=${gitDirectoryPath}`,
          `--work-tree=${intentWorkTreePath}`,
          "-c",
          "core.bare=false",
          "-c",
          "core.symlinks=false",
          "apply",
          "--intent-to-add",
          "--unidiff-zero",
          "--whitespace=nowarn",
          "-",
        ],
        intentPatchResult.stdout,
        undefined,
        operation.signal,
      );
      if (intentResult.exitCode !== 0) {
        throw new Error(
          intentResult.stderr ||
            "Intent-to-add index entries could not be projected.",
        );
      }
    }
    if (materializedEntries.length > 0) {
      const updateIndexResult = await this.#runGitCommand(
        rootPath,
        [
          `--git-dir=${gitDirectoryPath}`,
          `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
          "-c",
          "core.bare=false",
          "update-index",
          "-z",
          "--index-info",
        ],
        serializeGitIndexEntries(materializedEntries),
        undefined,
        operation.signal,
      );
      if (updateIndexResult.exitCode !== 0) {
        throw new Error(
          updateIndexResult.stderr ||
            "Isolated Git index could not be created.",
        );
      }
    }

    const { assumeUnchangedPaths, skipWorktreePaths } = parseGitIndexFlags(
      indexFlagsResult.stdout,
    );
    for (const [flag, filePaths] of [
      ["--assume-unchanged", assumeUnchangedPaths],
      ["--skip-worktree", skipWorktreePaths],
    ] as const) {
      if (filePaths.length === 0) {
        continue;
      }
      const flagResult = await this.#runGitCommand(
        rootPath,
        [
          `--git-dir=${gitDirectoryPath}`,
          `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
          "-c",
          "core.bare=false",
          "update-index",
          flag,
          "-z",
          "--stdin",
        ],
        serializeNullSeparatedPaths(filePaths),
        undefined,
        operation.signal,
      );
      if (flagResult.exitCode !== 0) {
        throw new Error(
          flagResult.stderr || "Git index flags could not be projected.",
        );
      }
    }
  }

  /** 同じ操作内で再利用できる一時 Git ディレクトリを準備する。元のオブジェクトを参照し、HEAD とインデックスは隔離側へ再現する。 */
  async #prepareIsolatedGit(
    operation: WorkspaceGitOperation,
    workspacePrefix: string,
  ): Promise<IsolatedGitContext> {
    if (operation.isolatedGitDirectoryPath) {
      return {
        gitDirectoryPath: path.join(
          operation.isolatedGitDirectoryPath,
          "repository.git",
        ),
        lockRepositoryRelativePath: `${normalizeWorkspacePrefixParser(workspacePrefix)}${operation.workspaceLease.fileName}`,
        workTreeConfigArgs: operation.workTreeConfigArgs ?? [],
      };
    }
    throwIfAborted(operation.signal);
    operation.workTreeConfigArgs = [
      ...(await this.#readWorkTreeConfigArgs(operation)),
      ...(await this.#readGlobalExcludesFileArgs(operation)),
    ];
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "withmate-git-preview-"),
    );
    operation.isolatedGitDirectoryPath = rootPath;
    const gitDirectoryPath = path.join(rootPath, "repository.git");

    const objectFormatResult = await this.#runIdentityBoundGit(operation, [
      "rev-parse",
      "--show-object-format",
    ]);
    if (objectFormatResult.exitCode !== 0) {
      throw new Error(
        objectFormatResult.stderr || "Git object format could not be resolved.",
      );
    }
    const objectFormat = normalizeObjectFormat(objectFormatResult.stdout);
    const initResult = await this.#runGitCommand(
      rootPath,
      [
        "init",
        "--bare",
        "--quiet",
        ...(objectFormat === "sha256" ? ["--object-format=sha256"] : []),
        gitDirectoryPath,
      ],
      undefined,
      undefined,
      operation.signal,
    );
    if (initResult.exitCode !== 0) {
      throw new Error(
        initResult.stderr || "Isolated Git metadata could not be initialized.",
      );
    }

    const objectDirectoryPath = path.join(
      operation.repositoryIdentity.commonDirectory.realPath,
      "objects",
    );
    if (/\r|\n/.test(objectDirectoryPath)) {
      throw new Error(
        "Git object directory path contains an unsupported newline.",
      );
    }
    await mkdir(path.join(gitDirectoryPath, "objects", "info"), {
      recursive: true,
    });
    await writeFile(
      path.join(gitDirectoryPath, "objects", "info", "alternates"),
      `${objectDirectoryPath.replaceAll("\\", "/")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const headResult = await this.#runIdentityBoundGit(operation, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const headObjectId =
      headResult.exitCode === 0 ? normalizeObjectId(headResult.stdout) : null;
    if (headResult.exitCode === 0 && !headObjectId) {
      throw new Error("Git HEAD returned an unsupported object ID.");
    }
    if (headObjectId) {
      await writeFile(
        path.join(gitDirectoryPath, "HEAD"),
        `${headObjectId}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } else {
      const symbolicHeadResult = await this.#runIdentityBoundGit(operation, [
        "symbolic-ref",
        "-q",
        "HEAD",
      ]);
      if (symbolicHeadResult.exitCode !== 0) {
        throw new Error(
          symbolicHeadResult.stderr || "Git HEAD could not be resolved.",
        );
      }
      const symbolicHead = normalizeSymbolicHead(symbolicHeadResult.stdout);
      await writeFile(
        path.join(gitDirectoryPath, "HEAD"),
        `ref: ${symbolicHead}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }

    await this.#projectWorkspaceIndex(
      operation,
      rootPath,
      gitDirectoryPath,
      headObjectId,
    );

    return {
      gitDirectoryPath,
      lockRepositoryRelativePath: `${normalizeWorkspacePrefixParser(workspacePrefix)}${operation.workspaceLease.fileName}`,
      workTreeConfigArgs: operation.workTreeConfigArgs,
    };
  }

  /** 解放処理を設定回数まで再試行し、最後まで失敗した場合だけ対象名とエラーコードを返す。 */
  async #retryCleanup(
    label: string,
    execute: () => Promise<void>,
  ): Promise<Error | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await execute();
        return null;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < CLEANUP_ATTEMPTS && this.#cleanupRetryDelayMs > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.#cleanupRetryDelayMs),
          );
        }
      }
    }
    const code =
      typeof lastError === "object" && lastError !== null && "code" in lastError
        ? String(lastError.code)
        : "unknown error";
    return new Error(`${label} (${code})`);
  }

  /** 全サービスインスタンスの解放処理を直列化し、並行要求が同じリソースを解放しないようにする。 */
  async #cleanupPendingResources(): Promise<WorkspaceGitCleanupError | null> {
    let releaseCleanup!: () => void;
    const previousCleanup = workspaceGitCleanupTail;
    workspaceGitCleanupTail = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    await previousCleanup;
    try {
      return await this.#cleanupPendingResourcesExclusive();
    } finally {
      releaseCleanup();
    }
  }

  /** 追跡中の一時ディレクトリと保持ハンドルを解放する。失敗した項目は次回の再試行対象に残す。 */
  async #cleanupPendingResourcesExclusive(): Promise<WorkspaceGitCleanupError | null> {
    const failures: string[] = [];
    for (const [directoryPath, cleanup] of [
      ...pendingWorkspaceGitTemporaryDirectories,
    ]) {
      const error = await this.#retryCleanup(
        "temporary Git directory could not be removed",
        cleanup.remove,
      );
      if (error) {
        failures.push(error.message);
      } else {
        pendingWorkspaceGitTemporaryDirectories.delete(directoryPath);
      }
    }
    for (const [fileHandle, cleanup] of [...pendingWorkspaceGitLeaseHandles]) {
      const error = await this.#retryCleanup(
        "directory lease could not be released",
        cleanup.close,
      );
      if (error) {
        failures.push(error.message);
      } else {
        pendingWorkspaceGitLeaseHandles.delete(fileHandle);
      }
    }
    return failures.length > 0 ? new WorkspaceGitCleanupError(failures) : null;
  }

  /** 一時ディレクトリを、作成側の削除手段と組み合わせて後始末の対象に登録する。 */
  #trackTemporaryDirectory(directoryPath: string): void {
    pendingWorkspaceGitTemporaryDirectories.set(directoryPath, {
      /** この一時ディレクトリを登録元の削除手段で取り除く。 */
      remove: () => this.#removeTemporaryDirectory(directoryPath),
    });
  }

  /** 開いた保持ハンドルを、取得側のクローズ手段と組み合わせて後始末の対象に登録する。 */
  #trackLeaseHandle(fileHandle: FileHandle): void {
    pendingWorkspaceGitLeaseHandles.set(fileHandle, {
      /** この保持ハンドルを登録元のクローズ手段で解放する。 */
      close: () => this.#closeDirectoryLease(fileHandle),
    });
  }

  /** Windows の自動削除付き一時ファイルを開いて対象ディレクトリを保持し、取得後に実体が変わっていないか確かめる。 */
  async #acquireDirectoryLease(
    identity: DirectoryIdentity,
  ): Promise<DirectoryLease> {
    if (process.platform !== "win32") {
      throw new Error(
        "Secure file root Git preview is not available on this platform.",
      );
    }
    const fileName = `.withmate-git-preview-${randomUUID()}.tmp`;
    const filePath = path.join(identity.realPath, fileName);
    const flags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_RDWR |
      WINDOWS_UV_FS_O_TEMPORARY;
    const fileHandle = await open(filePath, flags, 0o600);
    try {
      const currentIdentity = await captureDirectoryIdentity(identity.realPath);
      if (!directoryIdentityMatches(currentIdentity, identity)) {
        throw new OperationIdentityChangedError();
      }
      return { fileHandle, fileName };
    } catch (error) {
      this.#trackLeaseHandle(fileHandle);
      const cleanupError = await this.#cleanupPendingResources();
      throw cleanupError ?? error;
    }
  }

  /** 認可ルートと対象リポジトリを特定して、異なる実体ごとに保持ハンドルを確保する。途中で失敗したら取得済みの分を解放する。 */
  async #openOperation(
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGitOperation> {
    throwIfAborted(signal);
    const workspaceIdentity = await captureDirectoryIdentity(workspacePath);
    const workspaceLease = await this.#acquireDirectoryLease(workspaceIdentity);
    const repositoryLeases: DirectoryLease[] = [];
    try {
      const repositoryIdentity = await this.#captureRepositoryIdentity(
        workspacePath,
        workspaceIdentity,
        signal,
      );
      const leasedIdentityKeys = new Set([
        `${workspaceIdentity.device}:${workspaceIdentity.inode}`,
      ]);
      for (const identity of [
        repositoryIdentity.topLevel,
        repositoryIdentity.gitDirectory,
        repositoryIdentity.commonDirectory,
      ]) {
        const identityKey = `${identity.device}:${identity.inode}`;
        if (leasedIdentityKeys.has(identityKey)) {
          continue;
        }
        repositoryLeases.push(await this.#acquireDirectoryLease(identity));
        leasedIdentityKeys.add(identityKey);
      }
      return {
        workspacePath,
        workspaceIdentity,
        repositoryIdentity,
        workspaceLease,
        repositoryLeases,
        isolatedGitDirectoryPath: null,
        workTreeConfigArgs: null,
        signal,
      };
    } catch (error) {
      for (const lease of [workspaceLease, ...repositoryLeases]) {
        this.#trackLeaseHandle(lease.fileHandle);
      }
      const cleanupError = await this.#cleanupPendingResources();
      throw cleanupError ?? error;
    }
  }

  /** 操作が所有する一時 Git ディレクトリと保持ハンドルを解放し、解放が失敗した場合は診断を返す。 */
  async #closeOperation(
    operation: WorkspaceGitOperation,
  ): Promise<WorkspaceGitCleanupError | null> {
    if (operation.isolatedGitDirectoryPath) {
      this.#trackTemporaryDirectory(operation.isolatedGitDirectoryPath);
    }
    for (const lease of [
      operation.workspaceLease,
      ...operation.repositoryLeases,
    ]) {
      this.#trackLeaseHandle(lease.fileHandle);
    }
    return this.#cleanupPendingResources();
  }

  /** Git のルート相対接頭辞を取り出し、その接頭辞が認可済みディレクトリと同じ実体を指すか確認する。 */
  async #readWorkspacePrefix(
    operation: WorkspaceGitOperation,
  ): Promise<string> {
    const prefixResult = await this.#runIdentityBoundGit(operation, [
      "rev-parse",
      "--show-prefix",
    ]);
    if (prefixResult.exitCode !== 0) {
      throw new Error(
        prefixResult.stderr || "Git file root prefix could not be resolved.",
      );
    }
    const prefix = prefixResult.stdout.toString("utf8").replace(/\r?\n$/, "");
    const prefixedDirectory = await captureDirectoryIdentity(
      path.resolve(operation.repositoryIdentity.topLevel.realPath, prefix),
    );
    if (
      !directoryIdentityMatches(prefixedDirectory, operation.workspaceIdentity)
    ) {
      throw new OperationIdentityChangedError();
    }
    return prefix;
  }

  /** 隔離 Git で対象ディレクトリの状態を読み、保持用一時ファイルを除いたルート相対の変更一覧を返す。 */
  async #listChangesInOperation(
    operation: WorkspaceGitOperation,
  ): Promise<FileRootGitChangeEntry[]> {
    const workspacePrefix = await this.#readWorkspacePrefix(operation);
    const isolatedContext = await this.#prepareIsolatedGit(
      operation,
      workspacePrefix,
    );
    await this.#assertNoActiveExternalFilters(
      operation,
      isolatedContext.lockRepositoryRelativePath,
    );
    const result = await this.#runIsolatedGit(operation, isolatedContext, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=dirty",
      "--",
      ".",
      `:(exclude,top,literal)${isolatedContext.lockRepositoryRelativePath}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Git status failed.");
    }
    return parseGitPorcelainV1ZParser(result.stdout, workspacePrefix);
  }

  /** 差分要求を認可済みルートへ解決し、消失・Git 管理外・その他の失敗を区別して操作を開く。 */
  async #resolveOperation(
    request: FileRootChangesRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceGitOperation | WorkspaceGitOperationFailure> {
    throwIfAborted(signal);
    const context = await this.#resolveRootContext(request);
    throwIfAborted(signal);
    if (!context) {
      return {
        status: "root-not-found",
        message: "File root could not be resolved for this session.",
      };
    }
    try {
      return await this.#openOperation(context.rootPath, signal);
    } catch (error) {
      if (error instanceof WorkspaceGitCleanupError) {
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : "File root directory was not found.";
      if (error instanceof WorkspaceNotGitRepositoryError) {
        return { status: "not-git", message };
      }
      if (error instanceof OperationIdentityChangedError) {
        return { status: "failed", message };
      }
      try {
        const workspaceStat = await stat(context.rootPath);
        if (!workspaceStat.isDirectory()) {
          return {
            status: "root-not-found",
            message: "File root directory was not found.",
          };
        }
      } catch {
        return {
          status: "root-not-found",
          message: "File root directory was not found.",
        };
      }
      return failedStatus(message);
    }
  }

  /** 履歴要求を認可済みルートに引き直し、現在のリポジトリ ID が要求と一致する場合だけ操作を渡す。 */
  async #resolveHistoryOperation(
    request: FileRootGitHistoryRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceGitOperation | HistoryGitOperationFailure> {
    throwIfAborted(signal);
    if (!this.#resolveHistoryRootContext) {
      return {
        status: "failed",
        message: "Git history is not available for this session.",
      };
    }
    const context = await this.#resolveHistoryRootContext(request);
    throwIfAborted(signal);
    if (!context) {
      return {
        status: "repository-not-found",
        message: "The selected Git repository is no longer available.",
      };
    }
    try {
      const operation = await this.#openOperation(context.rootPath, signal);
      if (
        createHistoryRepositoryId(
          operation.repositoryIdentity.topLevel.realPath,
        ) !== request.repositoryId
      ) {
        const cleanupError = await this.#closeOperation(operation);
        if (cleanupError) {
          throw cleanupError;
        }
        return {
          status: "repository-not-found",
          message: "The selected Git repository is no longer available.",
        };
      }
      return operation;
    } catch (error) {
      if (error instanceof WorkspaceGitCleanupError) {
        throw error;
      }
      const message =
        error instanceof Error
          ? error.message
          : "Git repository could not be resolved.";
      if (error instanceof WorkspaceNotGitRepositoryError) {
        return { status: "repository-not-found", message };
      }
      if (error instanceof OperationIdentityChangedError) {
        return { status: "failed", message };
      }
      try {
        const workspaceStat = await stat(context.rootPath);
        if (!workspaceStat.isDirectory()) {
          return {
            status: "repository-not-found",
            message: "Git repository directory was not found.",
          };
        }
      } catch {
        return {
          status: "repository-not-found",
          message: "Git repository directory was not found.",
        };
      }
      return { status: "failed", message };
    }
  }

  /** 前回の後始末を済ませてから差分一覧を読み、対象の再確認と保持ハンドルの解放を経て成否を返す。 */
  async #listChangesRequest(
    request: FileRootChangesRequest,
    signal: AbortSignal,
  ): Promise<FileRootChangesResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return failedStatus(pendingCleanupError.message);
    }
    throwIfAborted(signal);
    const operation = await this.#resolveOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let result: FileRootChangesResult;
    try {
      const entries = await this.#listChangesInOperation(operation);
      await this.#assertOperationIdentity(operation);
      result = { status: "ok", entries };
    } catch (error) {
      result = failedStatus(
        error instanceof Error ? error.message : "Git status failed.",
      );
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return failedStatus(cleanupError.message);
    }
    throwIfAborted(signal);
    return result;
  }

  /** セッションのファイルルートでステージ済み・作業ツリーの変更を列挙する。同じルートの待機中の一覧要求は新しい要求で置き換える。 */
  async listChanges(
    request: FileRootChangesRequest,
  ): Promise<FileRootChangesResult> {
    try {
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:${request.rootId}:list`,
        this.#operationTimeoutMs,
        (signal) => this.#listChangesRequest(request, signal),
      );
    } catch (error) {
      return failedStatus(
        error instanceof Error ? error.message : "Git status failed.",
      );
    }
  }

  /** 指定ルートのうち Git 操作を開けるルートを列挙し、Git 管理外や未解決と区別して操作失敗を収集する。 */
  async #listChangesRepositoriesRequest(
    request: FileRootChangesRepositoriesRequest,
    signal: AbortSignal,
  ): Promise<FileRootChangesRepositoriesResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return { status: "failed", message: pendingCleanupError.message };
    }
    const repositories: Array<{ rootId: string }> = [];
    const failures: Array<{ rootId: string; message: string }> = [];
    for (const rootId of request.rootIds) {
      throwIfAborted(signal);
      const operation = await this.#resolveOperation(
        { sessionId: request.sessionId, rootId },
        signal,
      );
      if (!("workspacePath" in operation)) {
        if (operation.status === "failed") {
          failures.push({ rootId, message: operation.message });
        }
        continue;
      }
      const cleanupError = await this.#closeOperation(operation);
      if (cleanupError) {
        return { status: "failed", message: cleanupError.message };
      }
      repositories.push({ rootId });
    }
    return { status: "ok", repositories, failures };
  }

  /** セッション内の候補ルートについて、変更一覧を取得せずに Git の差分対象を探す。 */
  async listChangesRepositories(
    request: FileRootChangesRepositoriesRequest,
  ): Promise<FileRootChangesRepositoriesResult> {
    try {
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:changes:repositories`,
        this.#operationTimeoutMs,
        (signal) => this.#listChangesRepositoriesRequest(request, signal),
      );
    } catch (error) {
      return {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Git repositories could not be resolved.",
      };
    }
  }

  /** 指定範囲の変更を隔離側で確認し、対象なら改名前も含めたパッチを読む。未追跡や変更なしはパッチと区別する。 */
  async #getFileDiffRequest(
    request: FileRootFileDiffRequest,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<FileRootFileDiffResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return failedStatus(pendingCleanupError.message);
    }
    throwIfAborted(signal);
    const operation = await this.#resolveOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let response: FileRootFileDiffResult;
    try {
      const entries = await this.#listChangesInOperation(operation);
      const change = entries.find(
        (entry) => entry.relativePath === relativePath,
      );
      if (!change || !change.scopes.includes(request.scope)) {
        await this.#assertOperationIdentity(operation);
        response = {
          status: "not-changed",
          message: "The selected file is not changed in this scope.",
        };
      } else if (change.kinds[request.scope] === "untracked") {
        await this.#assertOperationIdentity(operation);
        response = {
          status: "untracked",
          message: "Untracked files do not have a Git diff yet.",
        };
      } else {
        const workspacePrefix = normalizeWorkspacePrefixParser(
          await this.#readWorkspacePrefix(operation),
        );
        const repositoryRelativePath = `${workspacePrefix}${relativePath}`;
        const isolatedContext = await this.#prepareIsolatedGit(
          operation,
          workspacePrefix,
        );
        const args = [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          "--ignore-submodules=dirty",
        ];
        if (request.scope === "staged") {
          args.push("--cached");
        }
        const diffPathspecs = [`:(top,literal)${repositoryRelativePath}`];
        if (
          change.kinds[request.scope] === "renamed" &&
          change.previousRelativePath
        ) {
          diffPathspecs.push(
            `:(top,literal)${workspacePrefix}${change.previousRelativePath}`,
          );
        }
        args.push("--", ...diffPathspecs);
        await this.#assertNoActiveExternalFilters(
          operation,
          isolatedContext.lockRepositoryRelativePath,
        );
        const result = await this.#runIsolatedGit(
          operation,
          isolatedContext,
          args,
        );
        if (result.exitCode !== 0) {
          response = {
            status: "failed",
            message: result.stderr || "Git diff failed.",
          };
        } else {
          const patch = result.stdout.toString("utf8");
          await this.#assertOperationIdentity(operation);
          response = patch
            ? { status: "ok", relativePath, scope: request.scope, patch }
            : {
                status: "not-changed",
                message: "Git returned an empty diff for this file.",
              };
        }
      }
    } catch (error) {
      response = {
        status: "failed",
        message: error instanceof Error ? error.message : "Git diff failed.",
      };
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return failedStatus(cleanupError.message);
    }
    throwIfAborted(signal);
    return response;
  }

  /** 相対パスを検証し、ステージ済みまたは作業ツリーのファイル差分を要求する。未対応の範囲は失敗として返す。 */
  async getFileDiff(
    request: FileRootFileDiffRequest,
  ): Promise<FileRootFileDiffResult> {
    const relativePath = normalizeGitRelativePathParser(request.relativePath);
    if (request.scope !== "working-tree" && request.scope !== "staged") {
      return { status: "failed", message: "Unknown Git change scope." };
    }
    try {
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:${request.rootId}:diff`,
        this.#operationTimeoutMs,
        (signal) => this.#getFileDiffRequest(request, relativePath, signal),
      );
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Git diff failed.",
      };
    }
  }

  /** ローカルブランチを列挙し、HEAD がその一覧にあるブランチを指す場合だけ現在ブランチとして返す。 */
  async #readHistoryBranches(
    operation: WorkspaceGitOperation,
  ): Promise<HistoryBranchState> {
    const currentBranchResult = await this.#runIdentityBoundGit(
      operation,
      ["symbolic-ref", "--quiet", "HEAD"],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_LIST_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (
      currentBranchResult.exitCode !== 0 &&
      currentBranchResult.exitCode !== 1
    ) {
      throw new Error(
        currentBranchResult.stderr || "Git current branch could not be read.",
      );
    }
    const branchesResult = await this.#runIdentityBoundGit(
      operation,
      ["for-each-ref", "--format=%(refname)", "refs/heads"],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_LIST_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (branchesResult.exitCode !== 0) {
      throw new Error(
        branchesResult.stderr || "Git branches could not be read.",
      );
    }
    const branches = parseHistoryBranchList(branchesResult.stdout);
    const reportedCurrentBranch =
      currentBranchResult.exitCode === 0
        ? parseCurrentHistoryBranch(currentBranchResult.stdout)
        : null;
    return {
      branches,
      currentBranch:
        reportedCurrentBranch && branches.includes(reportedCurrentBranch)
          ? reportedCurrentBranch
          : null,
    };
  }

  /** ローカルの Git が持つブランチ・リモート追跡ブランチ・タグを、履歴比較の候補にする。 */
  async #readHistoryAvailableRefs(
    operation: WorkspaceGitOperation,
  ): Promise<FileRootGitHistoryAvailableRef[]> {
    const result = await this.#runIdentityBoundGit(
      operation,
      [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_LIST_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Git refs could not be read.");
    }
    return parseGitHistoryAvailableRefsParser(result.stdout);
  }

  /** 認可ルートを正規リポジトリ単位にまとめ、最初に見つかったルートの表示情報と参照候補を返す。 */
  async #listHistoryRepositoriesRequest(
    request: FileRootGitHistoryRepositoriesRequest,
    signal: AbortSignal,
  ): Promise<FileRootGitHistoryRepositoriesResult> {
    if (!this.#resolveHistoryRootContexts) {
      return {
        status: "failed",
        message: "Git history is not available for this session.",
      };
    }
    const repositories = new Map<
      string,
      {
        repositoryId: string;
        rootId: string;
        label: string;
        displayPath: string;
        branches: string[];
        currentBranch: string | null;
        refs: FileRootGitHistoryAvailableRef[];
      }
    >();
    const contexts = await this.#resolveHistoryRootContexts(request.sessionId);
    for (const context of contexts) {
      throwIfAborted(signal);
      let operation: WorkspaceGitOperation;
      try {
        operation = await this.#openOperation(context.rootPath, signal);
      } catch (error) {
        if (
          error instanceof WorkspaceNotGitRepositoryError ||
          isMissingFilesystemError(error)
        ) {
          continue;
        }
        throw error;
      }
      const repositoryId = createHistoryRepositoryId(
        operation.repositoryIdentity.topLevel.realPath,
      );
      try {
        if (!repositories.has(repositoryId)) {
          const branchState = await this.#readHistoryBranches(operation);
          const refs = await this.#readHistoryAvailableRefs(operation);
          repositories.set(repositoryId, {
            repositoryId,
            rootId: context.rootId,
            label: context.label,
            displayPath: context.displayPath,
            refs,
            ...branchState,
          });
        }
      } finally {
        const cleanupError = await this.#closeOperation(operation);
        if (cleanupError) {
          throw cleanupError;
        }
      }
    }
    return { status: "ok", repositories: [...repositories.values()] };
  }

  /** セッションに許可されたルートから、ブランチと比較参照を持つ履歴リポジトリ候補を列挙する。 */
  async listHistoryRepositories(
    request: FileRootGitHistoryRepositoriesRequest,
  ): Promise<FileRootGitHistoryRepositoriesResult> {
    try {
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:history:repositories`,
        this.#operationTimeoutMs,
        (signal) => this.#listHistoryRepositoriesRequest(request, signal),
      );
    } catch (error) {
      return {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Git repositories could not be resolved.",
      };
    }
  }

  /** 完全 ID でコミット一件を読み、見つからない場合や返された ID が要求と異なる場合は null を返す。 */
  async #readHistoryCommit(
    operation: WorkspaceGitOperation,
    commitId: string,
  ): Promise<FileRootGitHistoryCommit | null> {
    const normalizedCommitId = normalizeHistoryObjectIdParser(commitId);
    const result = await this.#runIdentityBoundGit(
      operation,
      [
        "log",
        "--no-walk",
        "-1",
        "--date=iso-strict",
        "--decorate=full",
        `--format=${HISTORY_LOG_FORMAT}`,
        normalizedCommitId,
      ],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_DETAIL_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode === 1 || result.exitCode === 128) {
      return null;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || "Git commit metadata could not be read.",
      );
    }
    const [commit] = parseGitHistoryLogParser(result.stdout);
    return commit?.id === normalizedCommitId ? commit : null;
  }

  /** ルート内の完全一致パスを履歴ツリーから探す。単一の blob でメタデータとサイズが有効な場合だけ返す。 */
  async #readHistoryFileBlobEntry(
    operation: WorkspaceGitOperation,
    commitId: string,
    relativePath: string,
    workspacePrefix: string,
  ): Promise<HistoryFileBlobEntry | null> {
    const repositoryRelativePath = `${normalizeWorkspacePrefixParser(workspacePrefix)}${relativePath}`;
    const result = await this.#runIdentityBoundGit(
      operation,
      [
        "ls-tree",
        "-z",
        "-l",
        "--full-tree",
        commitId,
        "--",
        `:(top,literal)${repositoryRelativePath}`,
      ],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_DETAIL_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || "Git commit file metadata could not be read.",
      );
    }
    const records = result.stdout.toString("utf8").split("\0").filter(Boolean);
    if (records.length !== 1) {
      return null;
    }
    const separatorIndex = records[0]!.indexOf("\t");
    if (
      separatorIndex < 0 ||
      records[0]!.slice(separatorIndex + 1) !== repositoryRelativePath
    ) {
      return null;
    }
    const [mode, objectType, objectId, byteLengthText] = records[0]!
      .slice(0, separatorIndex)
      .trim()
      .split(/\s+/u);
    const byteLength = Number(byteLengthText);
    if (
      objectType !== "blob" ||
      !mode ||
      !objectId ||
      !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(objectId) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > MAX_HISTORY_FILE_BLOB_BYTES
    ) {
      return null;
    }
    return { mode, objectId, byteLength };
  }

  /** コミットの blob をサイズ制限付きで全読みし、メタデータにあるバイト長と一致するか検証する。 */
  async #readHistoryFileBlob(
    operation: WorkspaceGitOperation,
    entry: HistoryFileBlobEntry,
  ): Promise<Buffer> {
    const result = await this.#runIdentityBoundGit(
      operation,
      ["cat-file", "blob", entry.objectId],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_FILE_BLOB_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0 || result.stdout.length !== entry.byteLength) {
      throw new Error(
        result.stderr || "Git commit file contents could not be read.",
      );
    }
    return result.stdout;
  }

  /** コミットの blob から種別とエンコーディング判定に必要な先頭バイトだけを保持する。 */
  async #readHistoryFileBlobPrefix(
    operation: WorkspaceGitOperation,
    entry: HistoryFileBlobEntry,
  ): Promise<Buffer> {
    const result = await this.#runIdentityBoundGit(
      operation,
      ["cat-file", "blob", entry.objectId],
      undefined,
      {
        captureStdoutBytes: HISTORY_FILE_INSPECTION_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || "Git commit file contents could not be inspected.",
      );
    }
    return result.stdout;
  }

  /** 要求を認可済みルート内のコミットとプレビュー可能な blob に解決し、見つからなければ例外で伝える。 */
  async #resolveHistoryFile(
    operation: WorkspaceGitOperation,
    request: SessionFileGitCommitResourceRequest,
    workspacePrefix: string,
  ): Promise<{
    commit: FileRootGitHistoryCommit;
    entry: HistoryFileBlobEntry;
    relativePath: string;
  }> {
    const relativePath = normalizeGitRelativePathParser(request.relativePath);
    const commit = await this.#readHistoryCommit(operation, request.commitId);
    if (!commit) {
      throw new Error("The selected commit could not be found.");
    }
    const entry = await this.#readHistoryFileBlobEntry(
      operation,
      commit.id,
      relativePath,
      workspacePrefix,
    );
    if (!entry) {
      throw new Error("The selected file is not previewable at this commit.");
    }
    return { commit, entry, relativePath };
  }

  /** 履歴上のファイル名・種別・バイト長などを組み立て、著者日時を更新日時、blob ID を版として使う。 */
  async #inspectHistoryFileRequest(
    request: SessionFileGitCommitResourceRequest,
    signal: AbortSignal,
  ): Promise<SessionFileDescriptor> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      throw pendingCleanupError;
    }
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throw new Error(operation.message);
    }
    try {
      const workspacePrefix = await this.#readWorkspacePrefix(operation);
      const { commit, entry, relativePath } = await this.#resolveHistoryFile(
        operation,
        request,
        workspacePrefix,
      );
      const inspectedBytes = await this.#readHistoryFileBlobPrefix(
        operation,
        entry,
      );
      const resource = detectSessionFileResourceKind(
        relativePath,
        inspectedBytes,
      );
      return {
        ...request,
        commitId: commit.id,
        relativePath,
        absoluteFilePath: path.resolve(operation.workspacePath, relativePath),
        name: path.posix.basename(relativePath),
        kind: resource.kind,
        byteLength: entry.byteLength,
        modifiedAt: commit.authoredAt,
        mimeType: resource.mimeType,
        suggestedEncoding: detectSessionFileEncoding(inspectedBytes),
        revision: entry.objectId,
      };
    } finally {
      const cleanupError = await this.#closeOperation(operation);
      if (cleanupError) {
        throw cleanupError;
      }
    }
  }

  /** 指定コミットのファイル内容を調べ、プレビューで使う記述子を返す。作業ツリーの現行ファイルは読まない。 */
  async inspectHistoryFile(
    request: SessionFileGitCommitResourceRequest,
  ): Promise<SessionFileDescriptor> {
    normalizeHistoryObjectIdParser(request.commitId);
    normalizeGitRelativePathParser(request.relativePath);
    return runWorkspaceGitOperationWithAdmission(
      `${request.sessionId}:${request.repositoryId}:history:file:inspect:${request.commitId}:${request.relativePath}`,
      this.#operationTimeoutMs,
      (signal) => this.#inspectHistoryFileRequest(request, signal),
    );
  }

  /** 指定コミットの通常ファイルから HTML プレビューに渡すバイト列を取得する。シンボリックリンク等は受け付けない。 */
  async readHtmlPreviewHistoryFile(
    request: SessionFileGitCommitResourceRequest,
  ): Promise<Uint8Array> {
    normalizeHistoryObjectIdParser(request.commitId);
    normalizeGitRelativePathParser(request.relativePath);
    return runWorkspaceGitOperationWithAdmission(
      `${request.sessionId}:${request.repositoryId}:history:html:${request.commitId}:${request.relativePath}`,
      this.#operationTimeoutMs,
      async (signal) => {
        const pendingCleanupError = await this.#cleanupPendingResources();
        if (pendingCleanupError) throw pendingCleanupError;
        const operation = await this.#resolveHistoryOperation(request, signal);
        if (!("workspacePath" in operation)) throw new Error(operation.message);
        try {
          const prefix = await this.#readWorkspacePrefix(operation);
          const { entry } = await this.#resolveHistoryFile(
            operation,
            request,
            prefix,
          );
          if (entry.mode !== "100644" && entry.mode !== "100755") {
            throw new Error(
              "HTML preview cannot load symbolic links from a Git commit.",
            );
          }
          return Uint8Array.from(
            await this.#readHistoryFileBlob(operation, entry),
          );
        } finally {
          const cleanupError = await this.#closeOperation(operation);
          if (cleanupError) throw cleanupError;
        }
      },
    );
  }

  /** コミット上に対象ファイルがあると確認した上で、表示用のファイル名とルート基準の絶対パスを作る。 */
  async #resolveHistoryFilePreviewRequest(
    request: SessionFileGitCommitResourceRequest,
    signal: AbortSignal,
  ): Promise<{ name: string; absoluteFilePath: string }> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      throw pendingCleanupError;
    }
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throw new Error(operation.message);
    }
    try {
      const workspacePrefix = await this.#readWorkspacePrefix(operation);
      const { relativePath } = await this.#resolveHistoryFile(
        operation,
        request,
        workspacePrefix,
      );
      return {
        name: path.posix.basename(relativePath),
        absoluteFilePath: path.resolve(operation.workspacePath, relativePath),
      };
    } finally {
      const cleanupError = await this.#closeOperation(operation);
      if (cleanupError) {
        throw cleanupError;
      }
    }
  }

  /** 履歴ファイルの存在を確認してプレビュー用の名前と表示パスを返す。呼び出し時にコミット ID とパスの書式を検証する。 */
  async resolveHistoryFilePreview(
    request: SessionFileGitCommitResourceRequest,
  ): Promise<{ name: string; absoluteFilePath: string }> {
    normalizeHistoryObjectIdParser(request.commitId);
    normalizeGitRelativePathParser(request.relativePath);
    return runWorkspaceGitOperationWithAdmission(
      `${request.sessionId}:${request.repositoryId}:history:file:open:${request.commitId}:${request.relativePath}`,
      this.#operationTimeoutMs,
      (signal) => this.#resolveHistoryFilePreviewRequest(request, signal),
    );
  }

  /** 要求した版と blob ID が一致することを確かめ、対象範囲のバイト列と次のオフセットを返す。 */
  async #readHistoryFileChunkRequest(
    request: SessionFileChunkRequest & SessionFileGitCommitResourceRequest,
    signal: AbortSignal,
  ): Promise<SessionFileChunkResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      throw pendingCleanupError;
    }
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throw new Error(operation.message);
    }
    try {
      const workspacePrefix = await this.#readWorkspacePrefix(operation);
      const { entry } = await this.#resolveHistoryFile(
        operation,
        request,
        workspacePrefix,
      );
      if (entry.objectId !== request.expectedRevision) {
        throw new Error("The Git commit file revision is no longer available.");
      }
      const bytes = await this.#readHistoryFileBlob(operation, entry);
      const end =
        request.offset +
        Math.min(
          request.length,
          Math.max(0, entry.byteLength - request.offset),
        );
      const chunk = Uint8Array.from(bytes.subarray(request.offset, end));
      return {
        data: chunk.buffer,
        offset: request.offset,
        nextOffset: end,
        totalBytes: entry.byteLength,
        done: end >= entry.byteLength,
        revision: entry.objectId,
      };
    } finally {
      const cleanupError = await this.#closeOperation(operation);
      if (cleanupError) {
        throw cleanupError;
      }
    }
  }

  /** 履歴ファイルの読み出し位置と長さを検証し、指定した版のチャンクを取得する。無効な範囲は例外で伝える。 */
  async readHistoryFileChunk(
    request: SessionFileChunkRequest & SessionFileGitCommitResourceRequest,
  ): Promise<SessionFileChunkResult> {
    normalizeHistoryObjectIdParser(request.commitId);
    normalizeGitRelativePathParser(request.relativePath);
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      throw new Error("Git commit file chunk offset is invalid.");
    }
    if (
      !Number.isSafeInteger(request.length) ||
      request.length < 1 ||
      request.length > MAX_HISTORY_FILE_BLOB_BYTES
    ) {
      throw new Error(
        `Git commit file chunk length must be between 1 and ${MAX_HISTORY_FILE_BLOB_BYTES} bytes.`,
      );
    }
    return runWorkspaceGitOperationWithAdmission(
      `${request.sessionId}:${request.repositoryId}:history:file:read:${request.commitId}:${request.relativePath}`,
      this.#operationTimeoutMs,
      (signal) => this.#readHistoryFileChunkRequest(request, signal),
    );
  }

  /** 選択したローカルブランチから到達可能な履歴を取得し、ページ上限より一件多く読んで次ページの有無を決める。 */
  async #listHistoryCommitsInOperation(
    operation: WorkspaceGitOperation,
    request: FileRootGitHistoryCommitsRequest,
  ): Promise<FileRootGitHistoryCommitsResult> {
    const branchState = await this.#readHistoryBranches(operation);
    if (
      request.branch !== null &&
      !branchState.branches.includes(request.branch)
    ) {
      return {
        status: "branch-not-found",
        message: "The selected Git branch is no longer available.",
      };
    }
    if (branchState.branches.length === 0) {
      return {
        status: "empty-repository",
        message: "The Git repository has no committed branches.",
      };
    }
    if (request.branch === null) {
      return {
        status: "detached-head",
        message: "Git HEAD is detached. Select a branch to view its history.",
      };
    }
    const skip = normalizeHistoryCursor(request.cursor);
    const result = await this.#runIdentityBoundGit(
      operation,
      [
        "log",
        "--date-order",
        "--date=iso-strict",
        "--decorate=full",
        `--format=${HISTORY_LOG_FORMAT}`,
        "--max-count",
        String(HISTORY_PAGE_SIZE + 1),
        "--skip",
        String(skip),
        `refs/heads/${request.branch}`,
      ],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_LIST_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Git commit history could not be read.");
    }
    const commits = parseGitHistoryLogParser(result.stdout);
    const entries = commits.slice(0, HISTORY_PAGE_SIZE);
    const hasMore = commits.length > HISTORY_PAGE_SIZE;
    return {
      status: "ok",
      page: {
        entries,
        nextCursor: hasMore ? String(skip + HISTORY_PAGE_SIZE) : null,
        hasMore,
      },
    };
  }

  /** 現在の認可範囲で履歴操作を開き、コミットページを読んだ後に保持ハンドルを解放して応答を返す。 */
  async #listHistoryCommitsRequest(
    request: FileRootGitHistoryCommitsRequest,
    signal: AbortSignal,
  ): Promise<FileRootGitHistoryCommitsResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return { status: "failed", message: pendingCleanupError.message };
    }
    throwIfAborted(signal);
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let response: FileRootGitHistoryCommitsResult;
    try {
      response = await this.#listHistoryCommitsInOperation(operation, request);
    } catch (error) {
      response = {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Git commit history could not be read.",
      };
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return { status: "failed", message: cleanupError.message };
    }
    throwIfAborted(signal);
    return response;
  }

  /** ブランチ名とカーソルの書式を検証し、選択したブランチのコミット履歴をページ単位で返す。 */
  async listHistoryCommits(
    request: FileRootGitHistoryCommitsRequest,
  ): Promise<FileRootGitHistoryCommitsResult> {
    try {
      if (request.branch !== null) {
        normalizeHistoryBranchParser(request.branch);
      }
      normalizeHistoryCursor(request.cursor);
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:${request.repositoryId}:history:list:${request.branch}:${request.cursor ?? "0"}`,
        this.#operationTimeoutMs,
        (signal) => this.#listHistoryCommitsRequest(request, signal),
      );
    } catch (error) {
      return {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Git commit history could not be read.",
      };
    }
  }

  /** コミット詳細の比較元を第一親に固定し、初回コミットでは空ツリーと比較する。 */
  async #resolveSingleCommitComparison(
    operation: WorkspaceGitOperation,
    commit: FileRootGitHistoryCommit,
  ): Promise<[string, string]> {
    const parentId = commit.parentIds[0];
    if (parentId) {
      return [parentId, commit.id];
    }
    const emptyTreeResult = await this.#runIdentityBoundGit(
      operation,
      ["hash-object", "-t", "tree", "--stdin"],
      Buffer.alloc(0),
      {
        maxStdoutBytes: 256,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (emptyTreeResult.exitCode !== 0) {
      throw new Error(
        emptyTreeResult.stderr || "Git empty tree could not be resolved.",
      );
    }
    return [
      normalizeHistoryObjectIdParser(emptyTreeResult.stdout.toString("utf8")),
      commit.id,
    ];
  }

  /** 比較に使う参照や ID をコミットへ解決する。コミットへ解決できない場合は null を返す。 */
  async #resolveHistoryCommitExpression(
    operation: WorkspaceGitOperation,
    expression: string,
  ): Promise<string | null> {
    const result = await this.#runIdentityBoundGit(
      operation,
      ["rev-parse", "--verify", "--quiet", `${expression}^{commit}`],
      undefined,
      {
        maxStdoutBytes: 256,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      return null;
    }
    return normalizeObjectId(result.stdout);
  }

  /** 参照の種別と名前を現在の候補に照合し、HEAD や短縮 ID を含む比較指定を完全なコミット ID に固定する。 */
  async #resolveHistorySelector(
    operation: WorkspaceGitOperation,
    selector: FileRootGitHistoryComparisonSelector,
    refs: FileRootGitHistoryAvailableRef[],
  ): Promise<{
    selector: FileRootGitHistoryComparisonSelector;
    commitId: string;
  }> {
    const normalizedSelector = normalizeHistoryComparisonSelector(selector);
    let expression: string;
    if (normalizedSelector.kind === "head") {
      expression = "HEAD";
    } else if (normalizedSelector.kind === "commit") {
      expression = normalizedSelector.objectId;
    } else {
      const availableRef = refs.find(
        (candidate) =>
          candidate.kind === normalizedSelector.kind &&
          candidate.name === normalizedSelector.name,
      );
      if (!availableRef) {
        throw new HistoryComparisonFailure(
          "invalid-selector",
          "The selected Git ref is no longer available.",
        );
      }
      const refPrefix =
        normalizedSelector.kind === "branch"
          ? "refs/heads/"
          : normalizedSelector.kind === "remote"
            ? "refs/remotes/"
            : "refs/tags/";
      expression = `${refPrefix}${availableRef.name}`;
    }
    const commitId = await this.#resolveHistoryCommitExpression(
      operation,
      expression,
    );
    if (!commitId) {
      throw new HistoryComparisonFailure(
        "commit-not-found",
        "The selected Git ref does not point to a commit.",
      );
    }
    return {
      selector:
        normalizedSelector.kind === "commit"
          ? { kind: "commit", objectId: commitId }
          : normalizedSelector,
      commitId,
    };
  }

  /** 比較する二つのコミットの共通祖先を求め、利用できる候補が一つに決まらない場合は区別して失敗を返す。 */
  async #resolveHistoryMergeBase(
    operation: WorkspaceGitOperation,
    baseCommitId: string,
    targetCommitId: string,
  ): Promise<string> {
    const result = await this.#runIdentityBoundGit(
      operation,
      ["merge-base", "--all", baseCommitId, targetCommitId],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_DETAIL_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new HistoryComparisonFailure(
        "merge-base-unavailable",
        result.stderr ||
          "Git could not resolve a common ancestor for the selected commits.",
      );
    }
    const mergeBases = result.stdout
      .toString("utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(normalizeHistoryObjectIdParser);
    if (mergeBases.length === 0) {
      throw new HistoryComparisonFailure(
        "merge-base-unavailable",
        "The selected commits do not have a common ancestor available locally.",
      );
    }
    if (mergeBases.length > 1) {
      throw new HistoryComparisonFailure(
        "ambiguous-merge-base",
        "The selected commits have multiple possible common ancestors.",
      );
    }
    return mergeBases[0]!;
  }

  /** 比較の両端をコミット ID に固定し、ブランチ比較の場合にだけ一意な共通祖先も保存する。 */
  async #resolveHistoryComparisonPair(
    operation: WorkspaceGitOperation,
    request: FileRootGitHistoryComparisonRequest,
  ): Promise<FileRootGitHistoryComparison> {
    const refs = await this.#readHistoryAvailableRefs(operation);
    const base = await this.#resolveHistorySelector(
      operation,
      request.base,
      refs,
    );
    const target = await this.#resolveHistorySelector(
      operation,
      request.target,
      refs,
    );
    const mergeBaseCommitId =
      request.mode === "branch"
        ? await this.#resolveHistoryMergeBase(
            operation,
            base.commitId,
            target.commitId,
          )
        : null;
    return {
      mode: request.mode,
      base: base.selector,
      target: target.selector,
      baseCommitId: base.commitId,
      targetCommitId: target.commitId,
      mergeBaseCommitId: request.mode === "branch" ? mergeBaseCommitId : null,
    };
  }

  /** 取得済みの比較を参照名から再解決せず、固定したコミットの利用可否とブランチ比較の共通祖先を再検証する。 */
  async #validateHistoryComparison(
    operation: WorkspaceGitOperation,
    input: FileRootGitHistoryComparison,
  ): Promise<FileRootGitHistoryComparison> {
    if (input.mode !== "direct" && input.mode !== "branch") {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison mode is invalid.",
      );
    }
    const base = normalizeHistoryComparisonSelector(input.base);
    const target = normalizeHistoryComparisonSelector(input.target);
    if (
      !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(input.baseCommitId) ||
      !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(input.targetCommitId) ||
      (input.mergeBaseCommitId !== null &&
        !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(input.mergeBaseCommitId))
    ) {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison snapshot is invalid.",
      );
    }
    const baseCommitId = normalizeHistoryObjectIdParser(input.baseCommitId);
    const targetCommitId = normalizeHistoryObjectIdParser(input.targetCommitId);
    const resolvedBaseId = await this.#resolveHistoryCommitExpression(
      operation,
      baseCommitId,
    );
    const resolvedTargetId = await this.#resolveHistoryCommitExpression(
      operation,
      targetCommitId,
    );
    if (
      resolvedBaseId !== baseCommitId ||
      resolvedTargetId !== targetCommitId
    ) {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison snapshot is no longer available.",
      );
    }
    if (input.mode === "direct") {
      if (input.mergeBaseCommitId !== null) {
        throw new HistoryComparisonFailure(
          "invalid-selector",
          "The direct comparison snapshot has an unexpected merge-base.",
        );
      }
      return {
        mode: "direct",
        base,
        target,
        baseCommitId,
        targetCommitId,
        mergeBaseCommitId: null,
      };
    }
    if (!input.mergeBaseCommitId) {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The branch comparison snapshot has no merge-base.",
      );
    }
    const mergeBaseCommitId = normalizeHistoryObjectIdParser(
      input.mergeBaseCommitId,
    );
    const resolvedMergeBaseId = await this.#resolveHistoryCommitExpression(
      operation,
      mergeBaseCommitId,
    );
    if (resolvedMergeBaseId !== mergeBaseCommitId) {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison merge-base is no longer available.",
      );
    }
    const currentMergeBaseId = await this.#resolveHistoryMergeBase(
      operation,
      baseCommitId,
      targetCommitId,
    );
    if (currentMergeBaseId !== mergeBaseCommitId) {
      throw new HistoryComparisonFailure(
        "invalid-selector",
        "The Git comparison snapshot is no longer valid.",
      );
    }
    return {
      mode: "branch",
      base,
      target,
      baseCommitId,
      targetCommitId,
      mergeBaseCommitId,
    };
  }

  /** 指定したコミットまたはツリーの組から変更一覧を読み、認可されたファイルルートの相対パスに変換する。 */
  async #readHistoryChangedFiles(
    operation: WorkspaceGitOperation,
    comparison: [string, string],
    workspacePrefix: string,
    isComparison = false,
  ): Promise<FileRootGitChangeEntry[]> {
    const normalizedPrefix = normalizeWorkspacePrefixParser(workspacePrefix);
    const result = await this.#runIdentityBoundGit(
      operation,
      [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        "--no-ext-diff",
        "--no-textconv",
        "-r",
        ...comparison,
        "--",
        ...(normalizedPrefix ? [`:(top,literal)${normalizedPrefix}`] : []),
      ],
      undefined,
      {
        maxStdoutBytes: MAX_HISTORY_DETAIL_STDOUT_BYTES,
        maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr ||
          (isComparison
            ? "Git comparison changes could not be read."
            : "Git commit changes could not be read."),
      );
    }
    return parseGitHistoryNameStatusZParser(result.stdout, normalizedPrefix);
  }

  /** 直接比較では指定した比較元、ブランチ比較では共通祖先から対象への変更を取得し、固定した比較情報とともに返す。 */
  async #getHistoryComparisonRequest(
    request: FileRootGitHistoryComparisonRequest,
    signal: AbortSignal,
  ): Promise<FileRootGitHistoryComparisonResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return { status: "failed", message: pendingCleanupError.message };
    }
    throwIfAborted(signal);
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let response: FileRootGitHistoryComparisonResult;
    try {
      const comparison = await this.#resolveHistoryComparisonPair(
        operation,
        request,
      );
      const workspacePrefix = await this.#readWorkspacePrefix(operation);
      const beforeCommitId =
        comparison.mergeBaseCommitId ?? comparison.baseCommitId;
      const entries = await this.#readHistoryChangedFiles(
        operation,
        [beforeCommitId, comparison.targetCommitId],
        workspacePrefix,
        true,
      );
      response = { status: "ok", comparison, entries };
    } catch (error) {
      response =
        error instanceof HistoryComparisonFailure
          ? { status: error.status, message: error.message }
          : {
              status: "failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Git comparison could not be read.",
            };
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return { status: "failed", message: cleanupError.message };
    }
    throwIfAborted(signal);
    return response;
  }

  /** 比較方式と両端の指定を検証し、コミット ID に固定された比較と変更ファイル一覧を返す。 */
  async getHistoryComparison(
    request: FileRootGitHistoryComparisonRequest,
  ): Promise<FileRootGitHistoryComparisonResult> {
    try {
      if (request.mode !== "direct" && request.mode !== "branch") {
        throw new HistoryComparisonFailure(
          "invalid-selector",
          "The Git comparison mode is invalid.",
        );
      }
      normalizeHistoryComparisonSelector(request.base);
      normalizeHistoryComparisonSelector(request.target);
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:${request.repositoryId}:history:comparison:${request.mode}:${JSON.stringify([request.base, request.target])}`,
        this.#operationTimeoutMs,
        (signal) => this.#getHistoryComparisonRequest(request, signal),
      );
    } catch (error) {
      return error instanceof HistoryComparisonFailure
        ? { status: error.status, message: error.message }
        : {
            status: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Git comparison could not be read.",
          };
    }
  }

  /** コミットのメタデータと第一親または空ツリーからの変更一覧を読み、存在しないコミットを別の状態にする。 */
  async #getHistoryCommitDetailRequest(
    request: FileRootGitHistoryCommitDetailRequest,
    signal: AbortSignal,
  ): Promise<FileRootGitHistoryCommitDetailResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return { status: "failed", message: pendingCleanupError.message };
    }
    throwIfAborted(signal);
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let response: FileRootGitHistoryCommitDetailResult;
    try {
      const commit = await this.#readHistoryCommit(operation, request.commitId);
      if (!commit) {
        response = {
          status: "commit-not-found",
          message: "The selected commit could not be found.",
        };
      } else {
        const comparison = await this.#resolveSingleCommitComparison(
          operation,
          commit,
        );
        const workspacePrefix = await this.#readWorkspacePrefix(operation);
        const entries = await this.#readHistoryChangedFiles(
          operation,
          comparison,
          workspacePrefix,
        );
        response = { status: "ok", commit, entries };
      }
    } catch (error) {
      response = {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Git commit detail could not be read.",
      };
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return { status: "failed", message: cleanupError.message };
    }
    throwIfAborted(signal);
    return response;
  }

  /** 完全コミット ID を検証して履歴の詳細を返す。変更の対象範囲は要求元のファイルルートに限る。 */
  async getHistoryCommitDetail(
    request: FileRootGitHistoryCommitDetailRequest,
  ): Promise<FileRootGitHistoryCommitDetailResult> {
    try {
      normalizeHistoryObjectIdParser(request.commitId);
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:${request.repositoryId}:history:detail:${request.commitId}`,
        this.#operationTimeoutMs,
        (signal) => this.#getHistoryCommitDetailRequest(request, signal),
      );
    } catch (error) {
      return {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Git commit detail could not be read.",
      };
    }
  }

  /** 単一コミットまたは固定済み比較のパッチを読み、ファイル指定時は実在する側の履歴プレビュー参照も組み立てる。 */
  async #getHistoryDiffRequest(
    request: FileRootGitHistoryDiffRequest,
    relativePath: string | null,
    signal: AbortSignal,
  ): Promise<FileRootGitHistoryDiffResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return { status: "failed", message: pendingCleanupError.message };
    }
    throwIfAborted(signal);
    const operation = await this.#resolveHistoryOperation(request, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    const isComparisonDiff = isFileRootGitHistoryComparisonDiffRequest(request);
    let response: FileRootGitHistoryDiffResult = {
      status: "failed",
      message: isComparisonDiff
        ? "Git comparison diff could not be read."
        : "Git commit diff could not be read.",
    };
    try {
      const workspacePrefix = await this.#readWorkspacePrefix(operation);
      let commit: FileRootGitHistoryCommit | null = null;
      let resolvedComparison: FileRootGitHistoryComparison | null = null;
      let comparison: [string, string] | null = null;
      if (isComparisonDiff) {
        resolvedComparison = await this.#validateHistoryComparison(
          operation,
          request.comparison,
        );
        comparison = [
          resolvedComparison.mergeBaseCommitId ??
            resolvedComparison.baseCommitId,
          resolvedComparison.targetCommitId,
        ];
      } else {
        commit = await this.#readHistoryCommit(operation, request.commitId);
        if (!commit) {
          response = {
            status: "commit-not-found",
            message: "The selected commit could not be found.",
          };
        } else {
          comparison = await this.#resolveSingleCommitComparison(
            operation,
            commit,
          );
        }
      }
      let entry: FileRootGitChangeEntry | undefined;
      if (relativePath && comparison && (resolvedComparison || commit)) {
        const entries = await this.#readHistoryChangedFiles(
          operation,
          comparison,
          workspacePrefix,
          isComparisonDiff,
        );
        entry = entries.find(
          (candidate) =>
            candidate.relativePath === relativePath ||
            (resolvedComparison !== null &&
              candidate.previousRelativePath === relativePath),
        );
        if (!entry) {
          response = {
            status: "not-changed",
            message: resolvedComparison
              ? "The selected file is not changed in this comparison."
              : "The selected file is not changed in this commit.",
          };
        }
      }
      if (
        (resolvedComparison || commit) &&
        comparison &&
        (!relativePath || entry)
      ) {
        const normalizedPrefix =
          normalizeWorkspacePrefixParser(workspacePrefix);
        const pathspecs = entry
          ? [
              entry.relativePath,
              ...(entry.previousRelativePath
                ? [entry.previousRelativePath]
                : []),
            ].map((value) => `${normalizedPrefix}${value}`)
          : normalizedPrefix
            ? [normalizedPrefix]
            : [];
        const workTreeConfigArgs =
          await this.#readWorkTreeConfigArgs(operation);
        const result = await this.#runIdentityBoundGit(
          operation,
          [
            ...workTreeConfigArgs,
            "diff-tree",
            "--no-commit-id",
            "--patch",
            "--full-index",
            "--find-renames",
            "--find-copies",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "-r",
            ...comparison,
            "--",
            ...pathspecs.map((value) => `:(top,literal)${value}`),
          ],
          undefined,
          {
            maxStdoutBytes: MAX_HISTORY_DIFF_STDOUT_BYTES,
            maxStderrBytes: MAX_HISTORY_STDERR_BYTES,
          },
        );
        if (result.exitCode !== 0) {
          response = {
            status: "failed",
            message:
              result.stderr ||
              (isComparisonDiff
                ? "Git comparison diff could not be read."
                : "Git commit diff could not be read."),
          };
        } else {
          const patch = result.stdout.toString("utf8");
          if (patch) {
            if (resolvedComparison) {
              const beforeRelativePath =
                entry?.previousRelativePath ?? entry?.relativePath ?? null;
              const afterRelativePath = entry?.relativePath ?? null;
              const beforeEntry = beforeRelativePath
                ? await this.#readHistoryFileBlobEntry(
                    operation,
                    comparison[0],
                    beforeRelativePath,
                    workspacePrefix,
                  )
                : null;
              const afterEntry = afterRelativePath
                ? await this.#readHistoryFileBlobEntry(
                    operation,
                    comparison[1],
                    afterRelativePath,
                    workspacePrefix,
                  )
                : null;
              response = {
                status: "ok",
                comparison: resolvedComparison,
                displayPath: path.resolve(
                  operation.workspacePath,
                  relativePath ?? ".",
                ),
                relativePath,
                patch,
                previewBeforeResource:
                  beforeRelativePath && beforeEntry
                    ? {
                        resourceKind: "git-commit-file",
                        sessionId: request.sessionId,
                        rootId: request.rootId,
                        repositoryId: request.repositoryId,
                        commitId: comparison[0],
                        relativePath: beforeRelativePath,
                      }
                    : null,
                previewAfterResource:
                  afterRelativePath && afterEntry
                    ? {
                        resourceKind: "git-commit-file",
                        sessionId: request.sessionId,
                        rootId: request.rootId,
                        repositoryId: request.repositoryId,
                        commitId: comparison[1],
                        relativePath: afterRelativePath,
                      }
                    : null,
              };
            } else {
              const previewEntry =
                relativePath && commit
                  ? await this.#readHistoryFileBlobEntry(
                      operation,
                      commit.id,
                      relativePath,
                      workspacePrefix,
                    )
                  : null;
              response = {
                status: "ok",
                commitId: commit!.id,
                displayPath: path.resolve(
                  operation.workspacePath,
                  relativePath ?? ".",
                ),
                relativePath,
                patch,
                previewResource:
                  relativePath && previewEntry
                    ? {
                        resourceKind: "git-commit-file",
                        sessionId: request.sessionId,
                        rootId: request.rootId,
                        repositoryId: request.repositoryId,
                        commitId: commit!.id,
                        relativePath,
                      }
                    : null,
              };
            }
          } else {
            response = {
              status: "not-changed",
              message: resolvedComparison
                ? "Git returned an empty diff for this comparison."
                : "Git returned an empty diff for this commit.",
            };
          }
        }
      }
    } catch (error) {
      response =
        error instanceof HistoryComparisonFailure
          ? { status: error.status, message: error.message }
          : {
              status: "failed",
              message:
                error instanceof Error
                  ? error.message
                  : isComparisonDiff
                    ? "Git comparison diff could not be read."
                    : "Git commit diff could not be read.",
            };
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return { status: "failed", message: cleanupError.message };
    }
    throwIfAborted(signal);
    return response;
  }

  /** コミットまたは比較の指定と任意の相対パスを検証し、認可されたルート全体または一ファイルの履歴差分を取得する。 */
  async getHistoryDiff(
    request: FileRootGitHistoryDiffRequest,
  ): Promise<FileRootGitHistoryDiffResult> {
    let relativePath: string | null = null;
    let isComparisonDiff = false;
    try {
      isComparisonDiff = isFileRootGitHistoryComparisonDiffRequest(request);
      if (isFileRootGitHistoryComparisonDiffRequest(request)) {
        normalizeHistoryComparisonSelector(request.comparison.base);
        normalizeHistoryComparisonSelector(request.comparison.target);
      } else {
        normalizeHistoryObjectIdParser(request.commitId);
      }
      if (request.relativePath !== undefined && request.relativePath !== null) {
        relativePath = normalizeGitRelativePathParser(request.relativePath);
      }
      const comparisonKey = isFileRootGitHistoryComparisonDiffRequest(request)
        ? JSON.stringify(request.comparison)
        : request.commitId;
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:${request.repositoryId}:history:diff:${comparisonKey}:${relativePath ?? "all"}`,
        this.#operationTimeoutMs,
        (signal) => this.#getHistoryDiffRequest(request, relativePath, signal),
      );
    } catch (error) {
      return error instanceof HistoryComparisonFailure
        ? { status: error.status, message: error.message }
        : {
            status: "failed",
            message:
              error instanceof Error
                ? error.message
                : isComparisonDiff
                  ? "Git comparison diff could not be read."
                  : "Git commit diff could not be read.",
          };
    }
  }
}
