import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type {
  AppLogEntry,
  AppLogError,
  AppLogInput,
} from "../../src-shared/window/app-log-types.js";
import {
  APP_LOG_MAX_SERIALIZED_DATA_LENGTH,
  APP_LOG_MAX_STRING_LENGTH,
} from "./app-log-limits.js";

/** 各ログ行に添えるアプリ・ランタイムのバージョンと実行環境。 */
export type AppLogServiceRuntimeInfo = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
};

/** JSONL の保存先・ローテーション上限と、各行に共通の実行環境情報。 */
export type AppLogServiceOptions = {
  logsPath: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  rotation?: boolean;
  runtimeInfo: AppLogServiceRuntimeInfo;
};

const DEFAULT_LOG_FILE_NAME = "withmate.jsonl";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/** アプリログを同期で JSONL に追記し、設定に応じて世代と容量を管理する。 */
export class AppLogService {
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private currentLogBytes = 0;
  private directoryReady = false;
  private currentLogBytesLoaded = false;
  private lastRotationTimestamp = 0;

  /** 既定値と最低保持数を確定する。ログのディレクトリや容量は書き込み時に準備する。 */
  constructor(private readonly options: AppLogServiceOptions) {
    this.fileName = options.fileName ?? DEFAULT_LOG_FILE_NAME;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  }

  /** 現行ファイルと退避した世代を置くディレクトリを返す。 */
  get logsPath(): string {
    return this.options.logsPath;
  }

  /** 退避済みの世代ではなく、次の追記先となる現行ファイルのパスを返す。 */
  get logFilePath(): string {
    return path.join(this.logsPath, this.fileName);
  }

  /** 正規化した一件を追記し、保存した行の内容を返す。ローテーション有効時は追記前に容量を判定する。 */
  write(input: AppLogInput): AppLogEntry {
    const entry = this.buildEntry(input);
    const line = `${JSON.stringify(entry)}\n`;
    const rotation = this.options.rotation !== false;
    const lineBytes = rotation ? Buffer.byteLength(line, "utf8") : 0;
    this.ensureLogDirectory();
    if (rotation) {
      this.ensureCurrentLogBytesLoaded();
      this.rotateIfNeeded(lineBytes);
    }
    appendFileSync(this.logFilePath, line, "utf8");
    if (rotation) {
      this.currentLogBytes += lineBytes;
    }
    return entry;
  }

  /** Error の種類とスタックを取り出し、Error 以外の例外値はメッセージに変換する。 */
  errorToLogError(error: unknown): AppLogError {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return {
      message: typeof error === "string" ? error : stringifyForMessage(error),
    };
  }

  /** 実行環境と日時を補い、本文・添付データ・エラーをログ行向けに整える。 */
  private buildEntry(input: AppLogInput): AppLogEntry {
    const data = sanitizeData(input.data);
    return {
      ...this.options.runtimeInfo,
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: truncateString(input.message),
      data,
      error: input.error ? sanitizeError(input.error) : undefined,
    };
  }

  /** 現行ファイルのバイト数を調べる。stat に失敗した場合は容量計算上のゼロを返す。 */
  private readCurrentLogBytes(): number {
    try {
      return statSync(this.logFilePath).size;
    } catch {
      return 0;
    }
  }

  /** 最初の追記までに保存先を作る。作成に失敗した場合は準備済みとして扱わない。 */
  private ensureLogDirectory(): void {
    if (this.directoryReady) {
      return;
    }

    mkdirSync(this.logsPath, { recursive: true });
    this.directoryReady = true;
  }

  /** 起動前から残っている現行ログのサイズを、初回の容量判定に取り込む。 */
  private ensureCurrentLogBytesLoaded(): void {
    if (this.currentLogBytesLoaded) {
      return;
    }

    this.currentLogBytes = this.readCurrentLogBytes();
    this.currentLogBytesLoaded = true;
  }

  /** 空でないログが次の追記で容量を超えるときに、名前が衝突しない旧世代へ退避する。 */
  private rotateIfNeeded(incomingBytes: number): void {
    if (
      this.currentLogBytes <= 0 ||
      this.currentLogBytes + incomingBytes <= this.maxBytes
    ) {
      return;
    }

    let timestamp = Math.max(Date.now(), this.lastRotationTimestamp + 1);
    let rotatedFilePath = path.join(
      this.logsPath,
      `${this.fileName}.${timestamp}`,
    );
    while (existsSync(rotatedFilePath)) {
      timestamp += 1;
      rotatedFilePath = path.join(
        this.logsPath,
        `${this.fileName}.${timestamp}`,
      );
    }
    try {
      renameSync(this.logFilePath, rotatedFilePath);
      this.lastRotationTimestamp = timestamp;
      this.currentLogBytes = 0;
      this.pruneOldLogs();
    } catch {
      this.currentLogBytes = this.readCurrentLogBytes();
    }
  }

  /** 更新日時と退避時刻で世代を並べ、新しい現行ログの枠を残して古いものを除く。 */
  private pruneOldLogs(): void {
    const files = readdirSync(this.logsPath)
      .filter(
        (fileName) =>
          fileName === this.fileName ||
          fileName.startsWith(`${this.fileName}.`),
      )
      .map((fileName) => {
        const filePath = path.join(this.logsPath, fileName);
        return {
          filePath,
          mtimeMs: statSync(filePath).mtimeMs,
          rotationTimestamp:
            Number(fileName.slice(this.fileName.length + 1)) || 0,
        };
      })
      .sort(
        (a, b) =>
          b.mtimeMs - a.mtimeMs || b.rotationTimestamp - a.rotationTimestamp,
      );

    for (const file of files.slice(this.maxFiles - 1)) {
      rmSync(file.filePath, { force: true });
    }
  }
}

/** エラーの名前、本文、スタックそれぞれに個別文字列の上限を適用する。 */
function sanitizeError(error: AppLogError): AppLogError {
  return {
    name: error.name ? truncateString(error.name) : undefined,
    message: truncateString(error.message),
    stack: error.stack ? truncateString(error.stack) : undefined,
  };
}

/** データ未指定は維持し、指定があれば JSON に制限する。全体の上限超過時はプレビューだけを残す。 */
function sanitizeData(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  const text = safeStringify(value);
  if (text.length <= APP_LOG_MAX_SERIALIZED_DATA_LENGTH) {
    return JSON.parse(text);
  }

  return {
    truncated: true,
    preview: text.slice(0, APP_LOG_MAX_SERIALIZED_DATA_LENGTH),
  };
}

/** 文字列を短縮し、bigint を文字列にして JSON 化する。循環参照などで失敗した場合は固定の代替文字列を返す。 */
function safeStringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "string") {
          return truncateString(item);
        }
        if (typeof item === "bigint") {
          return item.toString();
        }
        return item;
      }) ?? "null"
    );
  } catch {
    return JSON.stringify("[unserializable]");
  }
}

/** 例外値の JSON 表現をメッセージにし、文字列の場合は JSON の引用符を外す。 */
function stringifyForMessage(value: unknown): string {
  const serialized = safeStringify(value);
  try {
    const parsed = JSON.parse(serialized);
    return typeof parsed === "string" ? parsed : serialized;
  } catch {
    return serialized;
  }
}

/** 個別のログ文字列が上限を超える場合は先頭だけを残し、省略記号を付ける。 */
function truncateString(value: string): string {
  return value.length > APP_LOG_MAX_STRING_LENGTH
    ? `${value.slice(0, APP_LOG_MAX_STRING_LENGTH)}...`
    : value;
}
