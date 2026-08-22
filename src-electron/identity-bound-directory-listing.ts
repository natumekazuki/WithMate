import { spawn } from "node:child_process";

import type { SessionDirectoryEntry } from "../src/file-explorer/file-explorer-contract.js";

const WORKER_SOURCE = String.raw`
const { lstat, opendir, readdir, stat } = require("node:fs/promises");

const STAT_CONCURRENCY = 32;

function toKind(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symbolic-link";
  return "other";
}

function compareStableName(left, right) {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function pushBoundedDirent(heap, entry, maxEntries) {
  if (maxEntries === 0) {
    return;
  }
  if (heap.length < maxEntries) {
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareStableName(heap[parent], heap[index]) >= 0) {
        break;
      }
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (compareStableName(entry, heap[0]) >= 0) {
    return;
  }
  heap[0] = entry;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let largest = index;
    if (left < heap.length && compareStableName(heap[left], heap[largest]) > 0) {
      largest = left;
    }
    if (right < heap.length && compareStableName(heap[right], heap[largest]) > 0) {
      largest = right;
    }
    if (largest === index) {
      break;
    }
    [heap[index], heap[largest]] = [heap[largest], heap[index]];
    index = largest;
  }
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
  const rawMaxEntries = process.env.WITHMATE_IDENTITY_DIRECTORY_MAX_ENTRIES || "";
  const configuredMaxEntries = rawMaxEntries === "" ? null : Number(rawMaxEntries);
  const hasMaxEntries = configuredMaxEntries !== null
    && Number.isInteger(configuredMaxEntries)
    && configuredMaxEntries >= 0;
  let selectedDirents;
  let truncated = false;
  if (hasMaxEntries) {
    const heap = [];
    let totalEntryCount = 0;
    const directory = await opendir(".");
    try {
      for await (const entry of directory) {
        totalEntryCount += 1;
        pushBoundedDirent(heap, entry, configuredMaxEntries);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    selectedDirents = heap.sort(compareStableName);
    truncated = totalEntryCount > configuredMaxEntries;
  } else {
    selectedDirents = await readdir(".", { withFileTypes: true });
  }
  const entries = new Array(selectedDirents.length);
  let nextIndex = 0;
  let activeStats = 0;
  let maxConcurrentStats = 0;
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, selectedDirents.length) }, async () => {
    while (nextIndex < selectedDirents.length) {
      const index = nextIndex++;
      const entry = selectedDirents[index];
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
  process.stdout.write(JSON.stringify({
    type: "result",
    entries,
    maxConcurrentStats,
    ...(hasMaxEntries ? { truncated } : {}),
  }) + "\n");
})().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;

export type IdentityBoundDirectorySnapshot = {
  device: number;
  inode: number;
  entries: Array<Pick<SessionDirectoryEntry, "name" | "kind" | "byteLength" | "modifiedAt">>;
  maxConcurrentStats: number;
  truncated?: boolean;
};

export type IdentityBoundDirectoryListingOptions = {
  delayAfterReadyMs?: number;
  hangAfterReady?: boolean;
  timeoutMs?: number;
  maxEntries?: number;
  signal?: AbortSignal;
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
      maxConcurrentStats: number;
      truncated?: boolean;
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
    typeof value.maxConcurrentStats === "number"
  ) {
    const truncated = "truncated" in value ? value.truncated : undefined;
    if (truncated !== undefined && typeof truncated !== "boolean") {
      throw new Error("directory worker の truncated flag が不正だよ。");
    }
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
    return {
      type: "result",
      entries,
      maxConcurrentStats: value.maxConcurrentStats,
      ...(truncated === undefined ? {} : { truncated }),
    };
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
        WITHMATE_IDENTITY_DIRECTORY_MAX_ENTRIES: options.maxEntries === undefined ? "" : String(options.maxEntries),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let identity: Pick<IdentityBoundDirectorySnapshot, "device" | "inode"> | null = null;
    let entries: IdentityBoundDirectorySnapshot["entries"] | null = null;
    let maxConcurrentStats: number | null = null;
    let truncated: boolean | undefined;
    let settled = false;
    let terminalError: Error | null = null;
    let abortHandler: (() => void) | null = null;
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
      if (abortHandler) {
        options.signal?.removeEventListener("abort", abortHandler);
      }
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
          maxConcurrentStats = message.maxConcurrentStats;
          truncated = message.truncated;
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
        settle(new Error(stderr.trim() || `directory worker が code ${code ?? "unknown"} で終了したよ。`));
        return;
      }
      if (!identity || !entries || maxConcurrentStats === null) {
        settle(new Error("directory worker の応答が途中で終了したよ。"));
        return;
      }
      settle(null, { ...identity, entries, maxConcurrentStats, ...(truncated === undefined ? {} : { truncated }) });
    });

    abortHandler = () => {
      terminate(new Error("directory worker がキャンセルされたよ。"));
    };
    if (options.signal?.aborted) {
      abortHandler();
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }
  });
}
