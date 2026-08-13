import { spawn } from "node:child_process";

import type { SessionDirectoryEntry } from "../src/file-explorer/file-explorer-contract.js";

const WORKER_SOURCE = String.raw`
const { lstat, opendir, stat } = require("node:fs/promises");

const STAT_CONCURRENCY = 32;

function toKind(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symbolic-link";
  return "other";
}

(async () => {
  const directoryStats = await stat(".");
  process.stdout.write(JSON.stringify({
    type: "ready",
    device: directoryStats.dev,
    inode: directoryStats.ino,
  }) + "\n");
  const delayMs = Number(process.env.WITHMATE_IDENTITY_DIRECTORY_DELAY_MS || 0);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (process.env.WITHMATE_IDENTITY_DIRECTORY_HANG_AFTER_READY === "1") {
    await new Promise(() => {
      setInterval(() => undefined, 1_000);
    });
  }
  const maxEntries = Number(process.env.WITHMATE_IDENTITY_DIRECTORY_MAX_ENTRIES || 0);
  const dirents = [];
  const directory = await opendir(".");
  for await (const entry of directory) {
    dirents.push(entry);
    if (maxEntries > 0 && dirents.length > maxEntries) {
      throw Object.assign(new Error("directory scan limit exceeded"), { code: "DIRECTORY_SCAN_LIMIT" });
    }
  }
  const entries = new Array(dirents.length);
  let nextIndex = 0;
  let activeStats = 0;
  let maxConcurrentStats = 0;
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, dirents.length) }, async () => {
    while (nextIndex < dirents.length) {
      const index = nextIndex++;
      const entry = dirents[index];
      activeStats += 1;
      maxConcurrentStats = Math.max(maxConcurrentStats, activeStats);
      try {
        const entryStats = await lstat(entry.name);
        const kind = entryStats.isDirectory()
          ? "directory"
          : entryStats.isFile()
            ? "file"
            : entryStats.isSymbolicLink()
              ? "symbolic-link"
              : "other";
        entries[index] = {
          name: entry.name,
          kind,
          byteLength: kind === "file" ? entryStats.size : null,
          modifiedAt: entryStats.mtime.toISOString(),
        };
      } catch {
        entries[index] = {
          name: entry.name,
          kind: toKind(entry),
          byteLength: null,
          modifiedAt: null,
        };
      } finally {
        activeStats -= 1;
      }
    }
  }));
  process.stdout.write(JSON.stringify({ type: "result", entries, scannedEntries: dirents.length, maxConcurrentStats }) + "\n");
})().catch((error) => {
  process.stderr.write(error && error.code === "DIRECTORY_SCAN_LIMIT"
    ? "DIRECTORY_SCAN_LIMIT"
    : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;

export type IdentityBoundDirectorySnapshot = {
  device: number;
  inode: number;
  entries: Array<Pick<SessionDirectoryEntry, "name" | "kind" | "byteLength" | "modifiedAt">>;
  scannedEntries: number;
  maxConcurrentStats: number;
};

type IdentityBoundDirectoryListingOptions = {
  delayAfterReadyMs?: number;
  hangAfterReady?: boolean;
  timeoutMs?: number;
  maxEntries?: number;
  onIdentityBound?: () => void;
  onWorkerStarted?: () => void;
  onWorkerSettled?: () => void;
};

const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

type WorkerMessage =
  | { type: "ready"; device: number; inode: number }
  | {
      type: "result";
      entries: IdentityBoundDirectorySnapshot["entries"];
      scannedEntries: number;
      maxConcurrentStats: number;
    };

function parseWorkerMessage(line: string): WorkerMessage {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("directory worker の応答形式が不正だよ。");
  }
  if (value.type === "ready" && "device" in value && "inode" in value) {
    if (typeof value.device !== "number" || typeof value.inode !== "number") {
      throw new Error("directory worker の identity が不正だよ。");
    }
    return { type: "ready", device: value.device, inode: value.inode };
  }
  if (
    value.type === "result" &&
    "entries" in value &&
    Array.isArray(value.entries) &&
    "maxConcurrentStats" in value &&
    typeof value.maxConcurrentStats === "number" &&
    "scannedEntries" in value &&
    typeof value.scannedEntries === "number"
  ) {
    const entries = value.entries.map((entry): IdentityBoundDirectorySnapshot["entries"][number] => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || !("kind" in entry)) {
        throw new Error("directory worker の entry が不正だよ。");
      }
      if (
        typeof entry.name !== "string" ||
        (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symbolic-link" && entry.kind !== "other") ||
        !("byteLength" in entry) ||
        (entry.byteLength !== null && typeof entry.byteLength !== "number") ||
        !("modifiedAt" in entry) ||
        (entry.modifiedAt !== null && typeof entry.modifiedAt !== "string")
      ) {
        throw new Error("directory worker の entry が不正だよ。");
      }
      return {
        name: entry.name,
        kind: entry.kind,
        byteLength: entry.byteLength,
        modifiedAt: entry.modifiedAt,
      };
    });
    return { type: "result", entries, scannedEntries: value.scannedEntries, maxConcurrentStats: value.maxConcurrentStats };
  }
  throw new Error("directory worker の応答形式が不正だよ。");
}

export function listIdentityBoundDirectory(
  targetPath: string,
  options: IdentityBoundDirectoryListingOptions = {},
): Promise<IdentityBoundDirectorySnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", WORKER_SOURCE], {
      cwd: targetPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        WITHMATE_IDENTITY_DIRECTORY_DELAY_MS: String(options.delayAfterReadyMs ?? 0),
        WITHMATE_IDENTITY_DIRECTORY_HANG_AFTER_READY: options.hangAfterReady ? "1" : "0",
        WITHMATE_IDENTITY_DIRECTORY_MAX_ENTRIES: String(options.maxEntries ?? 0),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let identity: Pick<IdentityBoundDirectorySnapshot, "device" | "inode"> | null = null;
    let entries: IdentityBoundDirectorySnapshot["entries"] | null = null;
    let maxConcurrentStats: number | null = null;
    let scannedEntries: number | null = null;
    let settled = false;
    let terminalError: Error | null = null;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      terminate(new Error(`directory worker が ${timeoutMs}ms 以内に完了しなかったよ。`));
    }, timeoutMs);

    const settle = (error: Error | null, snapshot?: IdentityBoundDirectorySnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        options.onWorkerSettled?.();
      } catch {
        // Test diagnostics must not change worker settlement.
      }
      if (error) {
        reject(error);
      } else {
        resolve(snapshot!);
      }
    };

    function terminate(error: unknown) {
      if (settled || terminalError) {
        return;
      }
      terminalError = error instanceof Error ? error : new Error(String(error));
      child.kill();
    }

    const consumeLines = () => {
      while (true) {
        const newlineIndex = stdout.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const message = parseWorkerMessage(line);
        if (message.type === "ready") {
          identity = { device: message.device, inode: message.inode };
          options.onIdentityBound?.();
        } else {
          entries = message.entries;
          scannedEntries = message.scannedEntries;
          maxConcurrentStats = message.maxConcurrentStats;
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      try {
        consumeLines();
      } catch (error) {
        terminate(error);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("spawn", () => {
      try {
        options.onWorkerStarted?.();
      } catch {
        // Test diagnostics must not change worker settlement.
      }
    });
    child.once("error", (error) => {
      settle(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      try {
        consumeLines();
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (terminalError) {
        settle(terminalError);
        return;
      }
      if (code !== 0) {
        if (stderr.trim() === "DIRECTORY_SCAN_LIMIT") {
          settle(new IdentityBoundDirectoryLimitError());
          return;
        }
        settle(new Error(stderr.trim() || `directory worker が code ${code ?? "unknown"} で終了したよ。`));
        return;
      }
      if (!identity || !entries || maxConcurrentStats === null || scannedEntries === null) {
        settle(new Error("directory worker の応答が途中で終了したよ。"));
        return;
      }
      settle(null, { ...identity, entries, scannedEntries, maxConcurrentStats });
    });
  });
}

export class IdentityBoundDirectoryLimitError extends Error {
  constructor() {
    super("directory scan limit exceeded");
    this.name = "IdentityBoundDirectoryLimitError";
  }
}
