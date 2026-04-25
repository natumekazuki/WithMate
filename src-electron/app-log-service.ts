import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type { AppLogEntry, AppLogError, AppLogInput } from "../src/app-log-types.js";

export type AppLogServiceRuntimeInfo = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
};

export type AppLogServiceOptions = {
  logsPath: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  runtimeInfo: AppLogServiceRuntimeInfo;
};

const DEFAULT_LOG_FILE_NAME = "withmate.jsonl";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const MAX_STRING_LENGTH = 4000;
const MAX_SERIALIZED_DATA_LENGTH = 12_000;

export class AppLogService {
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private currentLogBytes = 0;
  private directoryReady = false;
  private currentLogBytesLoaded = false;

  constructor(private readonly options: AppLogServiceOptions) {
    this.fileName = options.fileName ?? DEFAULT_LOG_FILE_NAME;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  }

  get logsPath(): string {
    return this.options.logsPath;
  }

  get logFilePath(): string {
    return path.join(this.logsPath, this.fileName);
  }

  write(input: AppLogInput): AppLogEntry {
    const entry = this.buildEntry(input);
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    this.ensureLogDirectory();
    this.ensureCurrentLogBytesLoaded();
    this.rotateIfNeeded(lineBytes);
    appendFileSync(this.logFilePath, line, "utf8");
    this.currentLogBytes += lineBytes;
    return entry;
  }

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

  private readCurrentLogBytes(): number {
    try {
      return statSync(this.logFilePath).size;
    } catch {
      return 0;
    }
  }

  private ensureLogDirectory(): void {
    if (this.directoryReady) {
      return;
    }

    mkdirSync(this.logsPath, { recursive: true });
    this.directoryReady = true;
  }

  private ensureCurrentLogBytesLoaded(): void {
    if (this.currentLogBytesLoaded) {
      return;
    }

    this.currentLogBytes = this.readCurrentLogBytes();
    this.currentLogBytesLoaded = true;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.currentLogBytes <= 0 || this.currentLogBytes + incomingBytes <= this.maxBytes) {
      return;
    }

    const rotatedFilePath = path.join(this.logsPath, `${this.fileName}.${Date.now()}`);
    try {
      renameSync(this.logFilePath, rotatedFilePath);
      this.currentLogBytes = 0;
      this.pruneOldLogs();
    } catch {
      this.currentLogBytes = this.readCurrentLogBytes();
    }
  }

  private pruneOldLogs(): void {
    const files = readdirSync(this.logsPath)
      .filter((fileName) => fileName === this.fileName || fileName.startsWith(`${this.fileName}.`))
      .map((fileName) => {
        const filePath = path.join(this.logsPath, fileName);
        return {
          filePath,
          mtimeMs: statSync(filePath).mtimeMs,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(this.maxFiles)) {
      rmSync(file.filePath, { force: true });
    }
  }
}

function sanitizeError(error: AppLogError): AppLogError {
  return {
    name: error.name ? truncateString(error.name) : undefined,
    message: truncateString(error.message),
    stack: error.stack ? truncateString(error.stack) : undefined,
  };
}

function sanitizeData(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  const text = safeStringify(value);
  if (text.length <= MAX_SERIALIZED_DATA_LENGTH) {
    return JSON.parse(text);
  }

  return {
    truncated: true,
    preview: text.slice(0, MAX_SERIALIZED_DATA_LENGTH),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "string") {
        return truncateString(item);
      }
      if (typeof item === "bigint") {
        return item.toString();
      }
      return item;
    }) ?? "null";
  } catch {
    return JSON.stringify("[unserializable]");
  }
}

function stringifyForMessage(value: unknown): string {
  const serialized = safeStringify(value);
  try {
    const parsed = JSON.parse(serialized);
    return typeof parsed === "string" ? parsed : serialized;
  } catch {
    return serialized;
  }
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
}
